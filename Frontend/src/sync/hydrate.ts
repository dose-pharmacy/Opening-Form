/**
 * Server -> draft hydration.
 *
 * The draft (localStorage) is the editable working copy, but it is not the only
 * place rows live: every accepted change is stored in the database. Without
 * hydration a fresh browser/device started from an empty draft and only ever
 * showed what that one browser had in localStorage — the saved products,
 * batches and stock were invisible.
 *
 * This module rebuilds a draft from the server's change feed and merges it with
 * the local draft (local values win, so unsynced edits and offline work are
 * never lost). It also reports which rows exist *only* on the server so the
 * sync layer can mirror them as already-synced instead of re-uploading the
 * whole inventory on every load.
 */

import { migrationApi } from '../utils/migrationApi';
import {
  SCHEMA_VERSION,
  type Batch,
  type MigrationData,
  type Product,
  type StockEntry,
  type StockQuantity,
  type UnitConfig,
} from '../utils/types';
import { batchId, groupId, locationId, productId, productUnitId, stockId, unitId } from './ids';

type AnyRow = Record<string, any>;

export interface ServerState {
  groups?: AnyRow[];
  locations?: AnyRow[];
  units?: AnyRow[];
  products?: AnyRow[];
  productUnits?: AnyRow[];
  batches?: AnyRow[];
  openingStocks?: AnyRow[];
}

export interface ServerDraft {
  /** Draft rebuilt from the server only (no local edits). */
  draft: MigrationData;
  /** Plan-level entity ids that exist on the server but not in the local draft. */
  serverOnlyIds: Set<string>;
  /** Server version per plan-level entity id, used for conflict detection. */
  versions: Map<string, number>;
}

const lower = (value: unknown): string => String(value ?? '').trim().toLowerCase();

const productKeyOf = (p: { sku: string }): string => lower(p.sku);
const batchKeyOf = (b: { productSku: string; batchNumber: string }): string =>
  `${lower(b.productSku)}::${lower(b.batchNumber)}`;
const stockKeyOf = (e: { productSku: string; batchNumber: string; location: string }): string =>
  `${lower(e.productSku)}::${lower(e.batchNumber)}::${lower(e.location)}`;

/** Server timestamps are full ISO strings; date inputs want `YYYY-MM-DD`. */
const dateOnly = (value: unknown): string =>
  typeof value === 'string' ? value.slice(0, 10) : value ? new Date(value as string).toISOString().slice(0, 10) : '';

const optionalDateOnly = (value: unknown): string | null => {
  if (value === null || value === undefined || value === '') return null;
  return dateOnly(value);
};

interface MergeResult<T> {
  merged: T[];
  serverOnlyKeys: Set<string>;
}

/** Merge two lists by business key; local values win over server values. */
function mergeRows<T>(server: T[], local: T[], keyOf: (item: T) => string): MergeResult<T> {
  const localKeys = new Set(local.map(keyOf));
  const serverOnlyKeys = new Set<string>();
  const byKey = new Map<string, T>();
  server.forEach((item) => {
    const key = keyOf(item);
    byKey.set(key, item);
    if (!localKeys.has(key)) serverOnlyKeys.add(key);
  });
  local.forEach((item) => byKey.set(keyOf(item), item));
  return { merged: [...byKey.values()], serverOnlyKeys };
}

/**
 * Rebuild a draft from the server state. The returned `draft` is server-only;
 * merge it with the latest local draft via `mergeDraftData`.
 */
export function buildDraftFromState(
  migrationId: string,
  state: ServerState,
  local: MigrationData
): ServerDraft {
  const groupsById = new Map((state.groups ?? []).map((g) => [g.id, g]));
  const unitsById = new Map((state.units ?? []).map((u) => [u.id, u]));
  const locationsById = new Map((state.locations ?? []).map((l) => [l.id, l]));
  const productsById = new Map((state.products ?? []).map((p) => [p.id, p]));
  const batchesById = new Map((state.batches ?? []).map((b) => [b.id, b]));

  const unitsByProduct = new Map<string, AnyRow[]>();
  (state.productUnits ?? []).forEach((pu) => {
    unitsByProduct.set(pu.productId, [...(unitsByProduct.get(pu.productId) ?? []), pu]);
  });

  const products: Product[] = (state.products ?? []).map((p) => {
    const units: UnitConfig[] = (unitsByProduct.get(p.id) ?? [])
      .map((pu) => {
        const unit = unitsById.get(pu.unitId);
        const config: UnitConfig = {
          unit: String(unit?.name ?? ''),
          isBaseUnit: Boolean(pu.isBaseUnit),
          conversionFactor: Number(pu.conversionToBase) || 1,
          contains: null,
          containedUnit: null,
          purchasePrice: Number(pu.purchasePrice) || 0,
          sellPrice: Number(pu.sellPrice) || 0,
        };
        return config;
      })
      .filter((unit) => unit.unit);
    return {
      sku: String(p.sku ?? ''),
      name: String(p.name ?? ''),
      genericName: String(p.genericName ?? ''),
      brand: String(p.brand ?? ''),
      productGroup: p.groupId ? String(groupsById.get(p.groupId)?.name ?? '') : '',
      description: String(p.description ?? ''),
      minStock: 0,
      reorderPoint: 0,
      isNarcotic: false,
      units,
    };
  });

  const batches: Batch[] = (state.batches ?? []).map((b) => ({
    productSku: String(productsById.get(b.productId)?.sku ?? ''),
    batchNumber: String(b.batchNumber ?? ''),
    expiryDate: dateOnly(b.expiryDate),
    manufacturingDate: optionalDateOnly(b.manufacturingDate),
    receivedDate: optionalDateOnly(b.receivedDate),
    supplier: null,
    supplierReference: b.supplierReference ?? null,
  }));

  const openingStock: StockEntry[] = (state.openingStocks ?? []).map((os) => {
    const product = productsById.get(os.productId);
    const batch = batchesById.get(os.batchId);
    const location = locationsById.get(os.locationId);
    const breakdown: AnyRow[] = Array.isArray(os.unitBreakdown) ? os.unitBreakdown : [];
    const unitCost = Number(os.unitCost) || 0;
    const quantities: StockQuantity[] = breakdown
      .map((line) => ({
        unit: String(unitsById.get(line.unitId)?.name ?? ''),
        quantity: Number(line.quantity) || 0,
        unitCost,
      }))
      .filter((line) => line.unit);
    const sku = String(product?.sku ?? '');
    const batchNumber = String(batch?.batchNumber ?? '');
    const locationName = String(location?.name ?? '');
    return {
      id: stockId(migrationId, sku, batchNumber, locationName),
      productSku: sku,
      batchNumber,
      location: locationName,
      quantities,
    };
  });

  const serverGroups = (state.groups ?? []).map((g) => ({ name: String(g.name ?? '') }));
  const serverLocations = (state.locations ?? []).map((l) => ({ name: String(l.name ?? '') }));
  const serverUnits = (state.units ?? []).map((u) => ({
    name: String(u.name ?? ''),
    symbol: String(u.symbol ?? ''),
  }));

  const groupsMerge = mergeRows(serverGroups, local.productGroups, (g) => lower(g.name));
  const locationsMerge = mergeRows(serverLocations, local.locations, (l) => lower(l.name));
  const unitsMerge = mergeRows(serverUnits, local.units, (u) => lower(u.name));
  const productsMerge = mergeRows(products, local.products, productKeyOf);
  const batchesMerge = mergeRows(batches, local.batches, batchKeyOf);
  const stocksMerge = mergeRows(openingStock, local.openingStock, stockKeyOf);

  const serverOnlyIds = new Set<string>();
  const versions = new Map<string, number>();
  const putVersion = (id: string, version: unknown) => {
    if (typeof version === 'number') versions.set(id, version);
  };

  (state.groups ?? []).forEach((g) => {
    const id = groupId(migrationId, String(g.name ?? ''));
    putVersion(id, g.version);
    if (groupsMerge.serverOnlyKeys.has(lower(g.name))) serverOnlyIds.add(id);
  });
  (state.locations ?? []).forEach((l) => {
    const id = locationId(migrationId, String(l.name ?? ''));
    putVersion(id, l.version);
    if (locationsMerge.serverOnlyKeys.has(lower(l.name))) serverOnlyIds.add(id);
  });
  (state.units ?? []).forEach((u) => {
    const id = unitId(migrationId, String(u.name ?? ''));
    putVersion(id, u.version);
    if (unitsMerge.serverOnlyKeys.has(lower(u.name))) serverOnlyIds.add(id);
  });
  (state.products ?? []).forEach((p) => {
    const id = productId(migrationId, String(p.sku ?? ''));
    putVersion(id, p.version);
    if (productsMerge.serverOnlyKeys.has(lower(p.sku))) serverOnlyIds.add(id);
  });
  (state.productUnits ?? []).forEach((pu) => {
    const product = productsById.get(pu.productId);
    const unit = unitsById.get(pu.unitId);
    if (!product || !unit) return;
    const id = productUnitId(migrationId, String(product.sku), String(unit.name));
    putVersion(id, pu.version);
    if (productsMerge.serverOnlyKeys.has(lower(product.sku))) serverOnlyIds.add(id);
  });
  (state.batches ?? []).forEach((b) => {
    const product = productsById.get(b.productId);
    if (!product) return;
    const id = batchId(migrationId, String(product.sku), String(b.batchNumber));
    putVersion(id, b.version);
    if (batchesMerge.serverOnlyKeys.has(`${lower(product.sku)}::${lower(b.batchNumber)}`)) {
      serverOnlyIds.add(id);
    }
  });
  (state.openingStocks ?? []).forEach((os) => {
    const product = productsById.get(os.productId);
    const batch = batchesById.get(os.batchId);
    const location = locationsById.get(os.locationId);
    if (!product || !batch || !location) return;
    const id = stockId(migrationId, String(product.sku), String(batch.batchNumber), String(location.name));
    putVersion(id, os.version);
    if (
      stocksMerge.serverOnlyKeys.has(
        `${lower(product.sku)}::${lower(batch.batchNumber)}::${lower(location.name)}`
      )
    ) {
      serverOnlyIds.add(id);
    }
  });

  return {
    draft: {
      schemaVersion: SCHEMA_VERSION,
      productGroups: serverGroups,
      locations: serverLocations,
      suppliers: [],
      units: serverUnits,
      products,
      batches,
      openingStock,
    },
    serverOnlyIds,
    versions,
  };
}

/** Merge a server draft with the local draft; local values win. */
export function mergeDraftData(server: MigrationData, local: MigrationData): MigrationData {
  return {
    schemaVersion: SCHEMA_VERSION,
    productGroups: mergeRows(server.productGroups, local.productGroups, (g) => lower(g.name)).merged,
    locations: mergeRows(server.locations, local.locations, (l) => lower(l.name)).merged,
    suppliers: server.suppliers.length ? server.suppliers : local.suppliers,
    units: mergeRows(server.units, local.units, (u) => lower(u.name)).merged,
    products: mergeRows(server.products, local.products, productKeyOf).merged,
    batches: mergeRows(server.batches, local.batches, batchKeyOf).merged,
    openingStock: mergeRows(server.openingStock, local.openingStock, stockKeyOf).merged,
  };
}

/**
 * Fetch the whole server state for a migration and rebuild a draft from it.
 * Returns `null` when the endpoint/section is unavailable (older backend), so
 * the caller can keep working from the local draft.
 */
export async function fetchServerDraft(
  migrationId: string,
  local: MigrationData
): Promise<ServerDraft | null> {
  const changes = await migrationApi.getChanges(migrationId, 0);
  const state = changes?.state as ServerState | undefined;
  if (!state) return null;
  return buildDraftFromState(migrationId, state, local);
}
