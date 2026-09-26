/**
 * The outbox: explicit operations that still owe the server something.
 *
 * The queue is the *only* thing that produces deletes — nothing is ever
 * inferred from a row disappearing from an array. Every operation carries a
 * stable `operationId` so a retry (offline, lost response, a sleeping host that
 * woke up mid-flight) is recognised by the backend instead of being applied
 * twice.
 */

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
  /** When this run claimed the operation; used to reclaim abandoned work. */
  claimedAt?: number;
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

export interface OutboxCounts {
  pending: number;
  conflicts: number;
  errors: number;
}

/** A claim older than this belonged to a run that never finished (host slept). */
export const CLAIM_TIMEOUT_MS = 60_000;

let lastSequence = 0;
const nextSequence = (): number => {
  const candidate = Date.now() * 1000;
  lastSequence = candidate > lastSequence ? candidate : lastSequence + 1;
  return lastSequence;
};

export const OperationQueue = {
  /** Add an operation to the outbox and return it (with its operationId). */
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

  /**
   * Replace the queued payload for an entity instead of stacking a new
   * operation on top of it.
   *
   * Editing a row ten times offline must still send one request that carries the
   * final state, while keeping the operationId the server already knows about.
   */
  async upsertPending(
    migrationId: string,
    entityType: EntityType,
    entityId: string,
    operationType: OperationType,
    payload: any,
    baseVersion?: number
  ): Promise<SyncOperation> {
    const db = await getDB();
    const existing = (await db.getAllFromIndex('operations', 'by-migration', migrationId)) as
      | SyncOperation[]
      | undefined;

    const coalescible = (existing ?? [])
      .filter((op) => op.entityId === entityId && (op.status === 'PENDING' || op.status === 'FAILED'))
      .sort((a, b) => a.sequence - b.sequence)[0];

    if (coalescible) {
      // A create that never reached the server stays a create.
      const nextType: OperationType =
        coalescible.operationType === 'CREATE' && operationType === 'UPDATE' ? 'CREATE' : operationType;
      const updated: SyncOperation = {
        ...coalescible,
        operationType: nextType,
        payload,
        baseVersion: baseVersion ?? coalescible.baseVersion,
        status: 'PENDING',
        lastError: undefined,
      };
      await db.put('operations', updated);
      return updated;
    }

    return this.enqueue(migrationId, entityType, entityId, operationType, payload, baseVersion);
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
      .sort((a, b) => a.sequence - b.sequence);
  },

  async getOperationsForEntity(migrationId: string, entityId: string): Promise<SyncOperation[]> {
    const db = await getDB();
    const allOps = (await db.getAllFromIndex(
      'operations',
      'by-migration',
      migrationId
    )) as unknown as SyncOperation[];
    return allOps.filter((op) => op.entityId === entityId).sort((a, b) => a.sequence - b.sequence);
  },

  async getOperationsForMigration(migrationId: string): Promise<SyncOperation[]> {
    const db = await getDB();
    return (await db.getAllFromIndex('operations', 'by-migration', migrationId)) as unknown as SyncOperation[];
  },

  /**
   * Reclaim operations left behind by an interrupted run.
   *
   * When the host sleeps mid-request the browser may never come back to release
   * the claim, and an operation stuck in SYNCING would be invisible to the queue
   * forever. Anything claimed longer than CLAIM_TIMEOUT_MS goes back to PENDING —
   * retrying it is safe because the operationId is stable.
   */
  async resetStuckOperations(migrationId?: string, now: number = Date.now()): Promise<number> {
    const db = await getDB();
    const allOps = migrationId
      ? ((await db.getAllFromIndex('operations', 'by-migration', migrationId)) as unknown as SyncOperation[])
      : ((await db.getAll('operations')) as unknown as SyncOperation[]);

    let reset = 0;
    for (const op of allOps) {
      if (op.status !== 'SYNCING') continue;
      const claimedAt = op.claimedAt ?? 0;
      if (now - claimedAt < CLAIM_TIMEOUT_MS) continue;
      await db.put('operations', { ...op, status: 'PENDING', claimedAt: undefined });
      reset += 1;
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
        op.claimedAt = Date.now();
        await tx.store.put(op);
      }
    }
    await tx.done;
  },

  /** Release a claim without counting it as a failure (host went to sleep). */
  async releaseClaim(operationId: string): Promise<void> {
    const db = await getDB();
    const op = await db.get('operations', operationId);
    if (!op) return;
    op.status = 'PENDING';
    op.claimedAt = undefined;
    await db.put('operations', op);
  },

  async removeOperation(operationId: string): Promise<void> {
    const db = await getDB();
    await db.delete('operations', operationId);
    await db.delete('conflicts', operationId);
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
      op.claimedAt = undefined;
      await db.put('operations', op);
    }
  },

  async markAsConflict(operationId: string, conflictData: Partial<ConflictRecord>): Promise<void> {
    const db = await getDB();
    const op = await db.get('operations', operationId);
    if (op) {
      op.status = 'CONFLICT';
      op.claimedAt = undefined;
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
    op.claimedAt = undefined;
    if (baseVersion !== undefined) op.baseVersion = baseVersion;
    await db.put('operations', op);
    await db.delete('conflicts', operationId);
  },

  async getConflict(operationId: string): Promise<ConflictRecord | undefined> {
    const db = await getDB();
    return (await db.get('conflicts', operationId)) as ConflictRecord | undefined;
  },

  /** Changes still owed to the server (drives the export gate and the UI). */
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

  async counts(migrationId: string): Promise<OutboxCounts> {
    const [pending, issues] = await Promise.all([
      this.countPending(migrationId),
      this.countIssues(migrationId),
    ]);
    return { pending, conflicts: issues.conflicts, errors: issues.errors };
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
