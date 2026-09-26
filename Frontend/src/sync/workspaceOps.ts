/**
 * Domain mutations: the only path from a user action to IndexedDB + outbox.
 *
 * Each helper corresponds to one thing the user can do. There is no generic
 * "sync the whole draft" entry point, so it is impossible for a missing row to
 * turn into a delete, and impossible for a half-typed row to reach the server.
 */

import { getDB } from '../local-store/db';
import { newId } from '../utils/ids';
import {
  STORE_FOR_ENTITY,
  deleteLocalEntity,
  getLocalEntity,
  resolveLocalRowId,
} from '../local-store/entities';
import { OperationQueue, type EntityType } from './queue';
import { SyncManager } from './syncManager';
import { createEntity, deleteEntity, updateEntity } from './mutations';
import {
  batchIdFor,
  batchPayload,
  groupPayload,
  locationPayload,
  productPayload,
  productUnitPayloads,
  stockPayload,
  unitPayload,
} from './payloads';
import { groupId, locationId, productId, productUnitId, unitId } from './ids';
import type { Batch, MigrationData, Product, StockEntry, UnitDefinition } from '../utils/types';

export { deleteEntity };

const storeOf = (entityType: EntityType) => STORE_FOR_ENTITY[entityType];

/** True when this workspace already holds the row (tombstones count as held). */
const localExists = async (migrationId: string, entityType: EntityType, id: string): Promise<boolean> => {
  const row = await getLocalEntity(entityType, id);
  return Boolean(row);
};

/**
 * Save one business entity.
 *
 * `businessId` is the deterministic id derived from the entity's natural key
 * (SKU, group name, batch number …). `payload` is what the server stores, and
 * `row` is the full UI entity kept in IndexedDB — a product keeps its unit list
 * and stock limits, which the server columns have no room for.
 */
async function write(
  migrationId: string,
  entityType: EntityType,
  businessId: string,
  payload: Record<string, any>,
  row?: Record<string, any>
) {
  const id = await resolveLocalRowId(entityType, migrationId, businessId);
  return (await localExists(migrationId, entityType, id))
    ? updateEntity(migrationId, entityType, id, payload, row)
    : createEntity(migrationId, entityType, id, payload, row);
}

/** Persist a row without queueing anything (incomplete work-in-progress). */
async function saveLocalRow(
  migrationId: string,
  entityType: EntityType,
  entityId: string,
  row: Record<string, any>
): Promise<void> {
  const db = await getDB();
  const store = storeOf(entityType);
  const existing = (await db.get(store, entityId)) as any;
  await db.put(store, {
    ...(existing ?? {}),
    ...row,
    id: entityId,
    migrationId,
    version: existing?.version ?? 0,
    // A row the server already knows keeps its state while it is being typed;
    // a brand new row is simply "created locally".
    syncState: existing?.syncState ?? 'CREATED_LOCALLY',
  });
}

/** Product groups (reference catalogue). */
export const saveGroup = (migrationId: string, name: string) =>
  write(migrationId, 'GROUP', groupId(migrationId, name), groupPayload(name), { name: name.trim() });

/** Storage locations (reference catalogue). */
export const saveLocation = (migrationId: string, name: string) =>
  write(migrationId, 'LOCATION', locationId(migrationId, name), locationPayload(name), { name: name.trim() });

/** Reusable unit definitions. */
export const saveUnit = (migrationId: string, unit: UnitDefinition) =>
  write(
    migrationId,
    'UNIT',
    unitId(migrationId, unit.name),
    unitPayload(unit),
    { name: unit.name.trim(), symbol: unit.symbol ?? '' }
  );

/**
 * Save a product together with the catalogue rows and unit rows it depends on.
 * Dependencies are queued first so the server never sees a child before its
 * parent.
 */
export async function saveProduct(migrationId: string, product: Product): Promise<void> {
  if (product.productGroup.trim()) {
    await saveGroup(migrationId, product.productGroup.trim());
  }
  for (const unit of product.units) {
    const name = (unit.unit ?? '').trim();
    if (name) await saveUnit(migrationId, { name, symbol: '' });
  }

  await write(
    migrationId,
    'PRODUCT',
    productId(migrationId, product.sku),
    productPayload(migrationId, product),
    // The form needs the unit list, stock levels and flags back after a reload.
    { ...product, sku: product.sku.trim() }
  );

  for (const { entityId, payload } of productUnitPayloads(migrationId, product)) {
    await write(migrationId, 'PRODUCT_UNIT', entityId, payload);
  }
}

/** Save a batch (product SKU + batch number identify it). */
export const saveBatch = (migrationId: string, batch: Batch) =>
  write(
    migrationId,
    'BATCH',
    batchIdFor(migrationId, batch.productSku, batch.batchNumber),
    batchPayload(batch),
    { ...batch }
  );

/**
 * Save an opening-stock row.
 *
 * The row is always written to IndexedDB so the user sees it immediately. A
 * server operation is only queued once the row is actually storable, so a
 * half-typed line never produces a rejected operation.
 *
 * Returns true when a server operation was queued.
 */
export async function saveStockEntry(
  migrationId: string,
  entry: StockEntry,
  product: Product | undefined,
  batch: Batch | undefined
): Promise<boolean> {
  const built = stockPayload(migrationId, entry, product, batch);

  if (!built) {
    // Not (yet) something the server can store: keep the line on this device so
    // the user sees their work, but queue nothing.
    await saveLocalRow(migrationId, 'OPENING_STOCK', entry.id, { ...entry });
    return false;
  }

  const db = await getDB();
  const store = storeOf('OPENING_STOCK');
  const previous = (await db.get(store, entry.id)) as any;

  // The line may have been typed under a temporary key (a work-in-progress) or
  // under a different identity (SKU / batch / location edited). Either way it is
  // not the row we are about to write, so retire it explicitly.
  if (previous && previous.id !== built.entityId) {
    if (isTombstoneRow(previous)) {
      await deleteLocalEntity('OPENING_STOCK', entry.id);
    } else {
      await deleteEntity(migrationId, 'OPENING_STOCK', entry.id);
    }
  }

  await write(migrationId, 'OPENING_STOCK', built.entityId, built.payload, { ...entry });

  return true;
}

const isTombstoneRow = (row: any) => row?.syncState === 'DELETED_LOCALLY';

/** The sort position a brand new line should take: after everything present. */
export function nextStockPosition(entries: StockEntry[]): number {
  return entries.reduce((max, entry) => Math.max(max, Number(entry.position) || 0), 0) + 1;
}

/**
 * Copy an opening-stock line.
 *
 * A copy is a genuinely new line, not an edit of the original, so it gets:
 *  - a new local id, so IndexedDB holds two rows;
 *  - a new `lineKey`, so the derived business id — and therefore the PostgreSQL
 *    row — is different too. Without this the copy would collide with the
 *    original and silently replace it, which is exactly the bug that made the
 *    Duplicate button look broken;
 *  - a position just below the original, so it appears directly underneath.
 *
 * Every counted quantity is copied, because the point of duplicating a line is to
 * get the same numbers again on a second line.
 */
export function duplicateStockEntry(source: StockEntry, entries: StockEntry[] = []): StockEntry {
  const used = new Set(entries.map((entry) => (entry.lineKey ?? '').trim()).filter(Boolean));
  const base = (source.lineKey ?? '').trim();

  let lineKey = '';
  for (let attempt = 1; lineKey === '' || used.has(lineKey); attempt += 1) {
    // Short, stable, and visibly a copy: `~d1`, `~d2`, …
    lineKey = base ? `~${base}.d${attempt}` : `~d${attempt}`;
  }

  const sourcePosition = Number(source.position) || 0;
  // Insert directly below the source. If two lines already share that spot, append
  // after the last line rather than landing on top of a neighbour.
  const collides = entries.some(
    (entry) => Math.abs((Number(entry.position) || 0) - (sourcePosition + 0.5)) < 1e-6
  );
  const position = collides ? nextStockPosition(entries) : sourcePosition + 0.5;

  return {
    ...source,
    id: newId(),
    lineKey,
    position,
    quantities: source.quantities.map((quantity) => ({ ...quantity })),
  };
}

export const deleteStockEntry = (migrationId: string, entry: StockEntry) =>
  deleteEntity(migrationId, 'OPENING_STOCK', entry.id);

/** Delete a row addressed by its local id (tombstone + queued DELETE). */
export const deleteRow = (migrationId: string, entityType: EntityType, id: string) =>
  deleteEntity(migrationId, entityType, id);

/**
 * Replace the workspace with an imported document.
 *
 * Imported rows are written locally and queued like any other user action, so an
 * import survives being offline and reaches the server through the outbox.
 */
export async function importMigrationData(migrationId: string, data: MigrationData): Promise<number> {
  let queued = 0;

  for (const group of data.productGroups) {
    if (group.name?.trim()) {
      await saveGroup(migrationId, group.name.trim());
      queued += 1;
    }
  }
  for (const location of data.locations) {
    if (location.name?.trim()) {
      await saveLocation(migrationId, location.name.trim());
      queued += 1;
    }
  }
  for (const unit of data.units) {
    if (unit.name?.trim()) {
      await saveUnit(migrationId, { name: unit.name.trim(), symbol: unit.symbol ?? '' });
      queued += 1;
    }
  }

  const productsBySku = new Map(
    data.products
      .filter((product) => product.sku?.trim() && product.name?.trim())
      .map((product) => [product.sku.trim().toLowerCase(), product])
  );

  for (const product of productsBySku.values()) {
    await saveProduct(migrationId, product);
    queued += 1;
  }

  for (const batch of data.batches) {
    if (!batch.productSku?.trim() || !batch.batchNumber?.trim() || !batch.expiryDate) continue;
    await saveBatch(migrationId, batch);
    queued += 1;
  }

  for (const entry of data.openingStock) {
    const sku = (entry.productSku ?? '').trim().toLowerCase();
    const product = productsBySku.get(sku);
    const batch = data.batches.find(
      (candidate) =>
        candidate.productSku.trim().toLowerCase() === sku &&
        candidate.batchNumber.trim() === (entry.batchNumber ?? '').trim()
    );
    if (await saveStockEntry(migrationId, entry, product, batch)) queued += 1;
  }

  SyncManager.triggerSync(migrationId);
  return queued;
}

/** Re-exported so callers can reason about the outbox without another import. */
export { productUnitId };
