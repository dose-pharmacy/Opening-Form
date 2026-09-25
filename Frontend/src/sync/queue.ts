import { getDB } from '../local-store/db';
import { v4 as uuidv4 } from 'uuid';

export type OperationType = 'CREATE' | 'UPDATE' | 'UPSERT' | 'DELETE';
export type EntityType =
  | 'PRODUCT'
  | 'GROUP'
  | 'LOCATION'
  | 'UNIT'
  | 'PRODUCT_UNIT'
  | 'BATCH'
  | 'OPENING_STOCK';

/**
 * PENDING/SYNCING/FAILED are "still owed to the server" and can be retried.
 * CONFLICT is a genuine version clash that needs a human decision.
 * ERROR is a terminal rejection (bad payload / unknown reference) — it is NOT a
 * conflict, and it must never be reported to the user as one.
 */
export type OperationStatus = 'PENDING' | 'SYNCING' | 'FAILED' | 'CONFLICT' | 'ERROR';

export interface SyncOperation {
  operationId: string;
  migrationId: string;
  entityType: EntityType;
  entityId: string;
  operationType: OperationType;
  payload: any;
  baseVersion?: number;
  createdAt: number;
  /** Strictly increasing ordinal: guarantees parents are pushed before children. */
  sequence: number;
  status: OperationStatus;
  retryCount: number;
  lastError?: string;
}

export interface ConflictRecord {
  operationId: string;
  entityType?: EntityType;
  entityId?: string;
  /** The row currently on the server, when the server could resolve one. */
  serverData?: unknown;
  currentVersion?: number;
  error?: string;
}

let lastSequence = 0;
const nextSequence = (): number => {
  const candidate = Date.now() * 1000;
  lastSequence = candidate > lastSequence ? candidate : lastSequence + 1;
  return lastSequence;
};

export const OperationQueue = {
  async enqueue(
    migrationId: string,
    entityType: EntityType,
    entityId: string,
    operationType: OperationType,
    payload: any,
    baseVersion?: number
  ): Promise<SyncOperation> {
    const db = await getDB();

    const op: SyncOperation = {
      operationId: uuidv4(),
      migrationId,
      entityType,
      entityId,
      operationType,
      payload,
      baseVersion,
      createdAt: Date.now(),
      sequence: nextSequence(),
      status: 'PENDING',
      retryCount: 0,
    };

    await db.put('operations', op);
    return op;
  },

  /** Operations still owed to the server, oldest (dependency-first) first. */
  async getPendingOperations(migrationId: string): Promise<SyncOperation[]> {
    const db = await getDB();
    const allOps = (await db.getAllFromIndex(
      'operations',
      'by-migration',
      migrationId
    )) as unknown as SyncOperation[];
    return allOps
      .filter((op) => op.status === 'PENDING' || op.status === 'FAILED')
      .sort((a, b) => (a.sequence ?? a.createdAt) - (b.sequence ?? b.createdAt));
  },

  async getOperationsForEntity(migrationId: string, entityId: string): Promise<SyncOperation[]> {
    const db = await getDB();
    const allOps = (await db.getAllFromIndex(
      'operations',
      'by-migration',
      migrationId
    )) as unknown as SyncOperation[];
    return allOps.filter((op) => op.entityId === entityId);
  },

  /**
   * Reclaim operations left behind by an interrupted sync. Without this, an
   * operation stuck in SYNCING is never retried again — the queue silently
   * stalls and nothing ever reaches the server.
   */
  async resetStuckOperations(migrationId?: string): Promise<number> {
    const db = await getDB();
    const allOps = migrationId
      ? await db.getAllFromIndex('operations', 'by-migration', migrationId)
      : await db.getAll('operations');
    let reset = 0;
    for (const op of allOps) {
      if (op.status === 'SYNCING') {
        op.status = 'PENDING';
        await db.put('operations', op);
        reset += 1;
      }
    }
    return reset;
  },

  async markAsSyncing(operationIds: string[]): Promise<void> {
    const db = await getDB();
    const tx = db.transaction('operations', 'readwrite');
    for (const id of operationIds) {
      const op = await tx.store.get(id);
      if (op) {
        op.status = 'SYNCING';
        await tx.store.put(op);
      }
    }
    await tx.done;
  },

  async removeOperation(operationId: string): Promise<void> {
    const db = await getDB();
    await db.delete('operations', operationId);
  },

  /**
   * Network / 5xx: keep the operation (FAILED, retried later).
   * Terminal rejection: ERROR (surfaced as an error, never as a conflict).
   */
  async markAsFailed(operationId: string, error: string, retryable: boolean): Promise<void> {
    const db = await getDB();
    const op = await db.get('operations', operationId);
    if (op) {
      op.status = retryable ? 'FAILED' : 'ERROR';
      op.lastError = error;
      op.retryCount += 1;
      await db.put('operations', op);
    }
  },

  async markAsConflict(operationId: string, conflictData: Partial<ConflictRecord>): Promise<void> {
    const db = await getDB();
    const op = await db.get('operations', operationId);
    if (op) {
      op.status = 'CONFLICT';
      await db.put('operations', op);
      await db.put('conflicts', {
        operationId,
        entityType: op.entityType,
        entityId: op.entityId,
        ...conflictData,
      });
    }
  },

  /** Put a CONFLICT/ERROR operation back on the queue (optionally re-based). */
  async requeue(operationId: string, baseVersion?: number): Promise<void> {
    const db = await getDB();
    const op = await db.get('operations', operationId);
    if (!op) return;
    op.status = 'PENDING';
    op.retryCount = 0;
    op.lastError = undefined;
    if (baseVersion !== undefined) op.baseVersion = baseVersion;
    await db.put('operations', op);
    await db.delete('conflicts', operationId);
  },

  async getConflict(operationId: string): Promise<ConflictRecord | undefined> {
    const db = await getDB();
    return (await db.get('conflicts', operationId)) as ConflictRecord | undefined;
  },

  /** Changes still owed to the server (drives the export gate). */
  async countPending(migrationId: string): Promise<number> {
    const db = await getDB();
    const allOps = await db.getAllFromIndex('operations', 'by-migration', migrationId);
    return allOps.filter(
      (op) => op.status === 'PENDING' || op.status === 'SYNCING' || op.status === 'FAILED'
    ).length;
  },

  /** Conflicts plus terminal errors — the things that need attention. */
  async countIssues(migrationId: string): Promise<{ conflicts: number; errors: number }> {
    const db = await getDB();
    const allOps = await db.getAllFromIndex('operations', 'by-migration', migrationId);
    return {
      conflicts: allOps.filter((op) => op.status === 'CONFLICT').length,
      errors: allOps.filter((op) => op.status === 'ERROR').length,
    };
  },

  /** Drop every queued operation for a migration (used when replacing a draft). */
  async clearMigration(migrationId: string): Promise<void> {
    const db = await getDB();
    const allOps = await db.getAllFromIndex('operations', 'by-migration', migrationId);
    for (const op of allOps) {
      await db.delete('operations', op.operationId);
      await db.delete('conflicts', op.operationId);
    }
  },
};
