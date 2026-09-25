import { getDB } from './db';
import type { EntityType } from '../sync/queue';

/**
 * The local IndexedDB stores double as the sync mirror: each row keeps the
 * server `version` it was last in sync with plus a snapshot of the payload that
 * produced that state, so we only enqueue work when something actually changed.
 */

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

export interface LocalEntityRow {
  id: string;
  migrationId: string;
  version: number;
  synced: boolean;
  /** Server id when it differs from ours (adopted natural-key record). */
  serverId?: string;
  /** JSON of the payload the server last accepted for this row. */
  lastSyncedPayload?: string | null;
  managedByDraft?: boolean;
  [key: string]: any;
}

export async function getLocalEntity(
  entityType: EntityType,
  id: string
): Promise<LocalEntityRow | undefined> {
  const db = await getDB();
  return (await db.get(STORE_FOR_ENTITY[entityType], id)) as LocalEntityRow | undefined;
}

export async function getLocalRows(
  store: EntityStore,
  migrationId: string
): Promise<LocalEntityRow[]> {
  const db = await getDB();
  return (await db.getAllFromIndex(store, 'by-migration', migrationId)) as LocalEntityRow[];
}

export async function putLocalEntity(entityType: EntityType, row: LocalEntityRow): Promise<void> {
  const db = await getDB();
  await db.put(STORE_FOR_ENTITY[entityType], row);
}

export async function deleteLocalEntity(entityType: EntityType, id: string): Promise<void> {
  const db = await getDB();
  await db.delete(STORE_FOR_ENTITY[entityType], id);
}

/** Record a successful push: adopt the version (and id) the server returned. */
export async function markEntitySynced(
  migrationId: string,
  entityType: EntityType,
  requestedId: string,
  actualId: string,
  version: number,
  payloadJson: string
): Promise<void> {
  const existing = await getLocalEntity(entityType, requestedId);
  const row: LocalEntityRow = {
    ...(existing ?? {}),
    id: actualId,
    migrationId: existing?.migrationId ?? migrationId,
    version,
    synced: true,
    lastSyncedPayload: payloadJson,
  };
  if (actualId !== requestedId) row.serverId = actualId;
  if (existing && actualId !== requestedId) await deleteLocalEntity(entityType, requestedId);
  await putLocalEntity(entityType, row);
}
