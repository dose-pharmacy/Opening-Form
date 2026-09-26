/**
 * IndexedDB workspace: the UI's real local source of truth.
 *
 * Responsibilities (and nothing else):
 *  - hold the working copy of every entity for a migration;
 *  - remember *how* each row differs from the server through `syncState`;
 *  - keep a tombstone (`DELETED_LOCALLY`) until the server confirms the delete,
 *    so a server refresh can never resurrect an intentional deletion.
 *
 * The server is authoritative, this store is the local working copy, and the
 * outbox (`sync/queue.ts`) is what still has to reach the server. localStorage
 * never holds any of this data — only small metadata.
 */

import { getDB } from './db';
import type { EntityType } from '../sync/queue';
import { buildMigrationData } from '../sync/uiData';
import type { MigrationData } from '../utils/types';

export type EntityStore =
  | 'products'
  | 'groups'
  | 'locations'
  | 'units'
  | 'productUnits'
  | 'batches'
  | 'openingStock';

export const STORE_FOR_ENTITY: Record<EntityType, EntityStore> = {
  PRODUCT: 'products',
  GROUP: 'groups',
  LOCATION: 'locations',
  UNIT: 'units',
  PRODUCT_UNIT: 'productUnits',
  BATCH: 'batches',
  OPENING_STOCK: 'openingStock',
};

/** Every store that can be refreshed from the server, in parent-first order. */
export const ALL_STORES: EntityStore[] = [
  'groups',
  'locations',
  'units',
  'products',
  'productUnits',
  'batches',
  'openingStock',
];

export type SyncState = 'SYNCED' | 'CREATED_LOCALLY' | 'UPDATED_LOCALLY' | 'DELETED_LOCALLY' | 'SYNC_ERROR';

/** Local, unsynced intent. Rows in these states are never overwritten by a pull. */
export const PENDING_STATES: SyncState[] = ['CREATED_LOCALLY', 'UPDATED_LOCALLY', 'DELETED_LOCALLY'];

export interface LocalEntityRow {
  id: string;
  migrationId: string;
  /** Server version this row mirrors (0 when it has never reached the server). */
  version: number;
  syncState: SyncState;
  /** Server id when it differs from the local one. */
  serverId?: string;
  /** The outbox operation that currently owns this row's change. */
  operationId?: string;
  [key: string]: any;
}

export const isPending = (row?: LocalEntityRow | null): boolean =>
  Boolean(row) && PENDING_STATES.includes(row!.syncState);

export const isTombstone = (row?: LocalEntityRow | null): boolean => row?.syncState === 'DELETED_LOCALLY';

export async function getLocalEntity(
  entityType: EntityType,
  id: string
): Promise<LocalEntityRow | undefined> {
  const db = await getDB();
  return (await db.get(STORE_FOR_ENTITY[entityType], id)) as LocalEntityRow | undefined;
}

export async function getLocalRows(
  store: EntityStore,
  migrationId: string,
  options: { includeDeleted?: boolean } = {}
): Promise<LocalEntityRow[]> {
  const db = await getDB();
  const rows = (await db.getAllFromIndex(store, 'by-migration', migrationId)) as LocalEntityRow[];
  if (options.includeDeleted) return rows;
  return rows.filter((row) => !isTombstone(row));
}

export async function putLocalEntity(entityType: EntityType, row: LocalEntityRow): Promise<void> {
  const db = await getDB();
  await db.put(STORE_FOR_ENTITY[entityType], row);
}

export async function deleteLocalEntity(entityType: EntityType, id: string): Promise<void> {
  const db = await getDB();
  await db.delete(STORE_FOR_ENTITY[entityType], id);
}

export async function countLocalRows(store: EntityStore, migrationId: string): Promise<number> {
  const db = await getDB();
  return db.countFromIndex(store, 'by-migration', migrationId);
}

/**
 * Build the UI-facing workspace.
 *
 * Rows are read from IndexedDB and then rendered into the entities the form
 * understands: a product with its units, a batch that knows its SKU, a stock line
 * that knows its product/batch/location. Tombstones are filtered out and rows
 * carrying pending local intent are passed through untouched, so a reload never
 * discards unsynced work.
 */
export async function loadWorkspace(migrationId: string): Promise<MigrationData> {
  const [products, groups, locations, units, productUnits, batches, openingStock] = await Promise.all([
    getLocalRows('products', migrationId),
    getLocalRows('groups', migrationId),
    getLocalRows('locations', migrationId),
    getLocalRows('units', migrationId),
    getLocalRows('productUnits', migrationId),
    getLocalRows('batches', migrationId),
    getLocalRows('openingStock', migrationId),
  ]);

  return buildMigrationData({ products, groups, locations, units, productUnits, batches, openingStock });
}

/** Every raw row of a store, tombstones included (used by reconciliation/tests). */
export async function getRawRows(store: EntityStore, migrationId: string): Promise<LocalEntityRow[]> {
  const db = await getDB();
  return (await db.getAllFromIndex(store, 'by-migration', migrationId)) as LocalEntityRow[];
}

/** True when this migration already has a workspace on this device. */
export async function hasLocalWorkspace(migrationId: string): Promise<boolean> {
  for (const store of ALL_STORES) {
    if ((await countLocalRows(store, migrationId)) > 0) return true;
  }
  return false;
}

/**
 * Mark a row as fully mirrored by the server.
 *
 * When the server adopted the row under a different id the local row is moved
 * across, so later operations address the id the server actually uses.
 *
 * A confirmation only counts for the operation that asked for it. If the row has
 * since been given new intent — most importantly a DELETE tombstone that arrived
 * while this operation was still in flight — the row is left alone, so an older
 * CREATE can never resurrect something the user removed.
 */
export async function markEntitySynced(
  migrationId: string,
  entityType: EntityType,
  requestedId: string,
  actualId: string,
  version: number,
  operationId?: string
): Promise<void> {
  const store = STORE_FOR_ENTITY[entityType];
  const db = await getDB();
  const existing = (await db.get(store, requestedId)) as LocalEntityRow | undefined;

  if (operationId && existing?.operationId && existing.operationId !== operationId) {
    // Newer local work owns this row; leave it exactly as the user left it.
    return;
  }

  if (existing && actualId !== requestedId) {
    await db.delete(store, requestedId);
    // Anything still pointing at the old id must follow the rename.
    const operations = (await db.getAllFromIndex('operations', 'by-migration', migrationId)) as any[];
    for (const op of operations) {
      if (op?.entityId === requestedId) {
        await db.put('operations', { ...op, entityId: actualId });
      }
    }
  }

  const row: LocalEntityRow = {
    ...(existing as LocalEntityRow | undefined),
    id: actualId,
    migrationId: (existing as LocalEntityRow | undefined)?.migrationId ?? migrationId,
    version: Number.isFinite(version) ? version : 0,
    syncState: 'SYNCED',
    operationId: undefined,
  };
  // Keep the business-derived id so a later edit still finds this row even when
  // the server adopted it under a different key.
  row.businessId = requestedId;
  if (actualId !== requestedId) row.serverId = actualId;
  await db.put(store, row);
}

/**
 * The key this business entity is stored under right now.
 *
 * Normally the deterministic business id, but a row the server adopted under a
 * different id is stored under that id instead — so look it up by `businessId`
 * before concluding it does not exist yet.
 */
export async function resolveLocalRowId(
  entityType: EntityType,
  migrationId: string,
  businessId: string
): Promise<string> {
  const direct = await getLocalEntity(entityType, businessId);
  if (direct) return businessId;

  const rows = await getRawRows(STORE_FOR_ENTITY[entityType], migrationId);
  const adopted = rows.find((row) => row.businessId === businessId);
  return adopted ? adopted.id : businessId;
}

/** Flag a row whose operation the server refused, keeping it visible locally. */
export async function markEntitySyncError(
  entityType: EntityType,
  id: string,
  _message?: string
): Promise<void> {
  const existing = await getLocalEntity(entityType, id);
  if (!existing || isTombstone(existing)) return;
  await putLocalEntity(entityType, { ...existing, syncState: 'SYNC_ERROR' });
}

/**
 * Drop a tombstone once the server confirmed the delete.
 * A tombstone whose delete is still queued is left untouched.
 */
export async function clearTombstone(entityType: EntityType, id: string): Promise<void> {
  const existing = await getLocalEntity(entityType, id);
  if (!isTombstone(existing)) return;
  await deleteLocalEntity(entityType, id);
}
