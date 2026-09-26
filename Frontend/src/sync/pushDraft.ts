import { getDB } from '../local-store/db';
import {
  deleteLocalEntity,
  getLocalEntity,
  getLocalRows,
  putLocalEntity,
  type EntityStore,
  type LocalEntityRow,
} from '../local-store/entities';
import type { MigrationData, Product, UnitConfig } from '../utils/types';
import { calculateBaseQuantity, resolveConversionFactors } from '../utils/conversions';
import { OperationQueue, type EntityType, type SyncOperation } from './queue';
import { SyncManager } from './syncManager';
import {
  batchId,
  groupId,
  isManagedId,
  locationId,
  productId,
  productUnitId,
  stockId,
  unitId,
} from './ids';

export interface PlannedOperation {
  entityType: EntityType;
  entityId: string;
  payload: Record<string, unknown>;
}

export interface SyncPlanResult {
  queued: number;
  skipped: number;
  pruned: number;
}

/** Child-first order, so a deleted product can never be removed before its rows. */
const PRUNE_ORDER: { store: EntityStore; entityType: EntityType }[] = [
  { store: 'openingStock', entityType: 'OPENING_STOCK' },
  { store: 'batches', entityType: 'BATCH' },
  { store: 'productUnits', entityType: 'PRODUCT_UNIT' },
  { store: 'products', entityType: 'PRODUCT' },
];

const clean = (value: unknown): string | null => {
  const text = typeof value === 'string' ? value.trim() : '';
  return text ? text : null;
};

const positiveFactor = (unit: UnitConfig): number => {
  if (unit.isBaseUnit) return 1;
  const factor = Number(unit.conversionFactor);
  return Number.isFinite(factor) && factor > 0 ? factor : 1;
};

const usableUnits = (product: Product): UnitConfig[] =>
  resolveConversionFactors(product.units).filter((u) => Boolean(u.unit && u.unit.trim()));

/**
 * Translate the migration draft into server operations.
 *
 * Everything is keyed by business identifier (SKU, batch number, location,
 * unit) and resolved to the deterministic server id — the previous version of
 * this code sent SKUs and names in the database-id fields, so every write was
 * rejected by the database and reported to the user as a bogus conflict.
 */
export function planMigrationOperations(
  migrationId: string,
  data: MigrationData
): PlannedOperation[] {
  if (!migrationId) return [];

  const ops: PlannedOperation[] = [];

  // ── Reference catalogues (server requires these rows to exist first) ──
  const unitNames = new Set<string>();
  data.units.forEach((u) => {
    const name = clean(u.name);
    if (name) unitNames.add(name);
  });
  data.products.forEach((p) =>
    p.units.forEach((u) => {
      const name = clean(u.unit);
      if (name) unitNames.add(name);
    })
  );
  [...unitNames].sort().forEach((name) => {
    const definition = data.units.find((u) => clean(u.name) === name);
    ops.push({
      entityType: 'UNIT',
      entityId: unitId(migrationId, name),
      payload: { name, symbol: clean(definition?.symbol) },
    });
  });

  data.productGroups.forEach((g) => {
    const name = clean(g.name);
    if (name) {
      ops.push({ entityType: 'GROUP', entityId: groupId(migrationId, name), payload: { name } });
    }
  });

  data.locations.forEach((l) => {
    const name = clean(l.name);
    if (name) {
      ops.push({
        entityType: 'LOCATION',
        entityId: locationId(migrationId, name),
        payload: { name, description: null },
      });
    }
  });

  // ── Products and their units ──
  const products = data.products.filter((p) => clean(p.sku) && clean(p.name));
  const batchPlans = new Map<string, PlannedOperation>();
  const stockPlans: PlannedOperation[] = [];

  products.forEach((product) => {
    const sku = product.sku.trim();
    const pid = productId(migrationId, sku);
    const group = clean(product.productGroup);

    ops.push({
      entityType: 'PRODUCT',
      entityId: pid,
      payload: {
        sku,
        name: product.name.trim(),
        genericName: clean(product.genericName),
        brand: clean(product.brand),
        // The name is sent too: the server resolves the group by business key as
        // well as by id, so a record created by an older client is still found.
        productGroup: group,
        groupId: group ? groupId(migrationId, group) : null,
        description: clean(product.description),
        isActive: true,
      },
    });

    usableUnits(product).forEach((unit) => {
      const unitName = unit.unit.trim();
      ops.push({
        entityType: 'PRODUCT_UNIT',
        entityId: productUnitId(migrationId, sku, unitName),
        payload: {
          productId: pid,
          productSku: sku,
          unitId: unitId(migrationId, unitName),
          unitName,
          conversionToBase: positiveFactor(unit),
          isBaseUnit: Boolean(unit.isBaseUnit),
          sellPrice: Number(unit.sellPrice) > 0 ? Number(unit.sellPrice) : null,
          purchasePrice: 0,
        },
      });
    });

    // ── Batches + opening stock for this product ──
    data.openingStock
      .filter((entry) => entry.productSku === product.sku)
      .forEach((entry) => {
        const batchNumber = clean(entry.batchNumber);
        const location = clean(entry.location);
        if (!batchNumber || !location) return;

        const batch = data.batches.find(
          (b) => b.productSku === product.sku && clean(b.batchNumber) === batchNumber
        );
        // Expiry is a required, non-nullable column on the server.
        if (!batch || !clean(batch.expiryDate)) return;

        const lines = entry.quantities.filter((q) => Number(q.quantity) > 0 && clean(q.unit));
        if (lines.length === 0) return;

        const bid = batchId(migrationId, sku, batchNumber);
        if (!batchPlans.has(bid)) {
          batchPlans.set(bid, {
            entityType: 'BATCH',
            entityId: bid,
            payload: {
              productId: pid,
              productSku: sku,
              batchNumber,
              expiryDate: new Date(batch.expiryDate).toISOString(),
              manufacturingDate: batch.manufacturingDate
                ? new Date(batch.manufacturingDate).toISOString()
                : null,
              receivedDate: batch.receivedDate ? new Date(batch.receivedDate).toISOString() : null,
              supplierReference: clean(batch.supplierReference),
            },
          });
        }

        stockPlans.push({
          entityType: 'OPENING_STOCK',
          entityId: stockId(migrationId, sku, batchNumber, location),
          payload: {
            productId: pid,
            productSku: sku,
            batchId: bid,
            batchNumber,
            locationId: locationId(migrationId, location),
            locationName: location,
            // Base quantity is recomputed (and trusted) on the server.
            baseQuantity: calculateBaseQuantity(product, lines),
            unitBreakdown: lines.map((line) => ({
              unitId: unitId(migrationId, line.unit.trim()),
              unitName: line.unit.trim(),
              quantity: Number(line.quantity),
            })),
            unitCost: Number(lines.find((l) => Number(l.unitCost) > 0)?.unitCost) || 0,
          },
        });
      });
  });

  return [...ops, ...batchPlans.values(), ...stockPlans];
}

/**
 * Diff the draft against the local mirror and the outbox, then queue the work.
 * Safe to call on every change: unchanged entities produce no operations.
 */
export async function syncDraft(
  migrationId: string,
  data: MigrationData
): Promise<SyncPlanResult> {
  if (!migrationId) return { queued: 0, skipped: 0, pruned: 0 };

  const planned = planMigrationOperations(migrationId, data);
  const db = await getDB();
  const allOps = (await db.getAllFromIndex('operations', 'by-migration', migrationId)) as
    | SyncOperation[]
    | undefined;
  const byEntity = new Map<string, SyncOperation[]>();
  (allOps ?? []).forEach((op) => {
    byEntity.set(op.entityId, [...(byEntity.get(op.entityId) ?? []), op]);
  });

  let queued = 0;
  let skipped = 0;
  let pruned = 0;

  for (const plan of planned) {
    const payloadJson = JSON.stringify(plan.payload);
    const row = await getLocalEntity(plan.entityType, plan.entityId);
    const ops = byEntity.get(plan.entityId) ?? [];

    // Never pile more work behind a conflict or a rejection the user must see.
    if (ops.some((op) => op.status === 'CONFLICT' || op.status === 'ERROR')) {
      skipped += 1;
      continue;
    }
    if (
      ops.some(
        (op) =>
          (op.status === 'PENDING' || op.status === 'SYNCING' || op.status === 'FAILED') &&
          JSON.stringify(op.payload) === payloadJson
      )
    ) {
      skipped += 1;
      continue;
    }
    if (row?.synced && row.lastSyncedPayload === payloadJson) {
      skipped += 1;
      continue;
    }

    const operation = await OperationQueue.enqueue(
      migrationId,
      plan.entityType,
      plan.entityId,
      'UPSERT',
      plan.payload,
      row?.synced ? row.version : undefined
    );
    byEntity.set(plan.entityId, [...ops, operation]);

    const mirror: LocalEntityRow = {
      ...(row ?? {}),
      ...(plan.payload as Record<string, unknown>),
      id: plan.entityId,
      migrationId,
      version: row?.version ?? 0,
      synced: row?.synced ?? false,
      serverId: row?.serverId,
      lastSyncedPayload: row?.lastSyncedPayload ?? null,
      managedByDraft: true,
    };
    await putLocalEntity(plan.entityType, mirror);
    queued += 1;
  }

  // ── Rows deleted from the draft must be deleted on the server too ──
  const plannedIds = new Set(planned.map((p) => p.entityId));
  for (const { store, entityType } of PRUNE_ORDER) {
    const rows = await getLocalRows(store, migrationId);
    for (const row of rows) {
      // Only ever touch rows this sync layer created.
      if (!isManagedId(migrationId, row.id) || plannedIds.has(row.id)) continue;
      const ops = byEntity.get(row.id) ?? [];
      if (ops.some((op) => op.status === 'CONFLICT' || op.status === 'ERROR')) continue;

      await OperationQueue.enqueue(
        migrationId,
        entityType,
        row.serverId ?? row.id,
        'DELETE',
        {},
        row.synced ? row.version : undefined
      );
      await deleteLocalEntity(entityType, row.id);
      pruned += 1;
    }
  }

  if (queued > 0 || pruned > 0) {
    SyncManager.triggerSync(migrationId).catch(() => undefined);
  }

  return { queued, skipped, pruned };
}

/**
 * Record server rows that do not exist locally as already-synced.
 *
 * Hydration loads the server inventory into the draft. Without this, the very
 * next `syncDraft` would diff those rows against an empty local mirror and push
 * the whole database back to the server on every new device. Rows with queued
 * work are never touched, so unsynced local edits are still pushed.
 */
export async function mirrorServerEntities(
  migrationId: string,
  serverDraft: MigrationData,
  serverOnlyIds: Set<string>,
  versions: Map<string, number>
): Promise<void> {
  if (!migrationId || serverOnlyIds.size === 0) return;

  const db = await getDB();
  const ops = (await db.getAllFromIndex('operations', 'by-migration', migrationId)) as SyncOperation[];
  const busy = new Set(ops.map((op) => op.entityId));

  const planned = planMigrationOperations(migrationId, serverDraft);
  for (const plan of planned) {
    if (!serverOnlyIds.has(plan.entityId) || busy.has(plan.entityId)) continue;

    const existing = await getLocalEntity(plan.entityType, plan.entityId);
    const row: LocalEntityRow = {
      ...(existing ?? {}),
      ...(plan.payload as Record<string, unknown>),
      id: plan.entityId,
      migrationId,
      version: versions.get(plan.entityId) ?? existing?.version ?? 1,
      synced: true,
      serverId: existing?.serverId,
      lastSyncedPayload: JSON.stringify(plan.payload),
      managedByDraft: true,
    };
    await putLocalEntity(plan.entityType, row);
  }
}
