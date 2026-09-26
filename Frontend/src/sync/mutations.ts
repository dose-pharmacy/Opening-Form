/**
 * Explicit local mutations.
 *
 * A user action is the only thing that may create an operation. Nothing here
 * diffs the UI against the database, so an entity can never be deleted because
 * it happened to be missing from an array.
 *
 *   create → write row (CREATED_LOCALLY) + CREATE in the outbox
 *   update → write row (UPDATED_LOCALLY) + UPDATE in the outbox
 *   delete → tombstone row (DELETED_LOCALLY) + DELETE in the outbox
 *
 * A tombstone is only dropped once the server confirms the delete, so an
 * interrupted push can never leave a deleted row behind on the server or bring
 * it back on the next refresh.
 */

import { getDB } from '../local-store/db';
import {
  STORE_FOR_ENTITY,
  getLocalEntity,
  isTombstone,
  putLocalEntity,
  type LocalEntityRow,
} from '../local-store/entities';
import { OperationQueue, type EntityType, type OperationType, type SyncOperation } from './queue';
import { SyncManager } from './syncManager';

export interface MutationResult {
  operation: SyncOperation | null;
  /** The row as it now stands locally (tombstones included). */
  row: Record<string, any>;
}

/**
 * Apply a create/update to IndexedDB and queue the matching operation.
 *
 * `payload` is the server-shaped document, and `row` is what the form actually
 * needs. They are deliberately separate arguments: a product row keeps its unit
 * list, stock limits and flags, while the server only ever receives the columns
 * it knows about. Passing the payload for both would quietly strip the UI fields
 * and corrupt the workspace on the next reload.
 */
async function writeAndQueue(
  migrationId: string,
  entityType: EntityType,
  entityId: string,
  operationType: OperationType,
  payload: Record<string, any>,
  row?: Record<string, any>
): Promise<MutationResult> {
  const existing = await getLocalEntity(entityType, entityId);
  const isFirstWrite = !existing || existing.syncState === 'CREATED_LOCALLY';

  const operation = await OperationQueue.upsertPending(
    migrationId,
    entityType,
    entityId,
    isFirstWrite ? 'CREATE' : 'UPDATE',
    payload,
    isFirstWrite ? undefined : existing?.version
  );

  const localRow: LocalEntityRow = {
    ...(existing ?? {}),
    ...(row ?? payload),
    id: entityId,
    migrationId,
    version: existing?.version ?? 0,
    syncState: isFirstWrite ? 'CREATED_LOCALLY' : 'UPDATED_LOCALLY',
    operationId: operation.operationId,
  };
  await putLocalEntity(entityType, localRow);

  SyncManager.triggerSync(migrationId);
  return { operation, row: localRow };
}

export const createEntity = (
  migrationId: string,
  entityType: EntityType,
  entityId: string,
  payload: Record<string, any>,
  row?: Record<string, any>
): Promise<MutationResult> =>
  writeAndQueue(migrationId, entityType, entityId, 'CREATE', payload, row);

export const updateEntity = (
  migrationId: string,
  entityType: EntityType,
  entityId: string,
  payload: Record<string, any>,
  row?: Record<string, any>
): Promise<MutationResult> =>
  writeAndQueue(migrationId, entityType, entityId, 'UPDATE', payload, row);

/**
 * Create or update depending on what the workspace already holds.
 * Used where the UI genuinely does not know (e.g. a product unit that may or may
 * not exist yet) — the decision still comes from the local row, never from a diff.
 */
export const upsertEntity = async (
  migrationId: string,
  entityType: EntityType,
  entityId: string,
  payload: Record<string, any>,
  row?: Record<string, any>
): Promise<MutationResult> => {
  const existing = await getLocalEntity(entityType, entityId);
  return writeAndQueue(
    migrationId,
    entityType,
    entityId,
    existing && existing.syncState === 'SYNCED' ? 'UPDATE' : 'CREATE',
    payload,
    row
  );
};

export const deleteEntity = async (
  migrationId: string,
  entityType: EntityType,
  entityId: string
): Promise<MutationResult> => {
  const db = await getDB();
  const existing = await getLocalEntity(entityType, entityId);

  if (!existing) {
    // Nothing to delete: the user asked to remove a row we do not have.
    return { operation: null, row: {} };
  }

  if (isTombstone(existing)) {
    return { operation: null, row: existing };
  }

  // Tombstone the row and queue a DELETE either way.
  //
  // A row that only ever existed locally still gets an operation: its CREATE may
  // already be in flight (the push the user triggered when they saved it), and
  // simply dropping the queued work would leave that row on the server forever
  // with nothing left to remove it. The server treats a delete of a row it never
  // received as satisfied, so the operation is harmless in that case and
  // necessary in the other one.
  const operation = await OperationQueue.upsertPending(
    migrationId,
    entityType,
    entityId,
    'DELETE',
    {},
    existing.syncState === 'CREATED_LOCALLY' ? undefined : existing.version
  );

  const row: LocalEntityRow = {
    ...existing,
    syncState: 'DELETED_LOCALLY',
    operationId: operation.operationId,
  };
  await putLocalEntity(entityType, row);

  SyncManager.triggerSync(migrationId);
  return { operation, row: row as Record<string, any> };
};

/**
 * Backwards-compatible entry point used by the dialogs.
 * `UPSERT` resolves to CREATE/UPDATE from the local row, never from a diff.
 */
export async function mutateEntity(
  migrationId: string,
  entityType: EntityType,
  entityId: string,
  operationType: OperationType,
  payload: any,
  row?: Record<string, any>
): Promise<void> {
  if (operationType === 'DELETE') {
    await deleteEntity(migrationId, entityType, entityId);
    return;
  }
  if (operationType === 'UPSERT') {
    await upsertEntity(migrationId, entityType, entityId, payload, row);
    return;
  }
  await writeAndQueue(migrationId, entityType, entityId, operationType, payload, row);
}

/** Re-exported so callers can talk about stores without importing db internals. */
export { STORE_FOR_ENTITY };
