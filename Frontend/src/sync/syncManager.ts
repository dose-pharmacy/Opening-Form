/**
 * Sync engine: pushes the explicit outbox and reconciles server state back into
 * the IndexedDB workspace.
 *
 * Rules that matter here:
 *  - an operation is removed only after the server confirms it, or confirms it
 *    had already been processed (a lost response must not cause a duplicate);
 *  - a failed request never loses the operation — it goes back on the queue;
 *  - a pull never overwrites a row with pending local intent.
 */

import { getDB } from '../local-store/db';
import {
  ALL_STORES,
  STORE_FOR_ENTITY,
  clearTombstone,
  isPending,
  isTombstone,
  markEntitySynced,
  markEntitySyncError,
  putLocalEntity,
} from '../local-store/entities';
import { OperationQueue, type EntityType, type SyncOperation } from './queue';
import { migrationApi } from '../utils/migrationApi';
import { API_BASE } from '../utils/apiBase';
import { setMigrationRevision } from '../utils/storage';

/** Kept small: each change is a round trip, and the database may be remote. */
const BATCH_SIZE = 20;

let isSyncing = false;
/** The push currently in flight, so concurrent callers share one request. */
let inflightSync: Promise<void> | null = null;

const isBrowserOnline = (): boolean => (typeof navigator === 'undefined' ? true : navigator.onLine);

const ENTITY_FOR_STORE: Record<string, EntityType> = {
  products: 'PRODUCT',
  groups: 'GROUP',
  locations: 'LOCATION',
  units: 'UNIT',
  productUnits: 'PRODUCT_UNIT',
  batches: 'BATCH',
  openingStock: 'OPENING_STOCK',
};

export interface SyncSummary {
  synced: number;
  conflicts: number;
  errors: number;
  remaining: number;
  /** True when the server could not be reached, so the UI can say "offline". */
  unreachable: boolean;
}

if (typeof window !== 'undefined') {
  // Nothing may be lost while offline: keep retrying the outbox in the
  // background so a change always reaches the server eventually.
  window.addEventListener('online', () => {
    void SyncManager.triggerSync();
  });
  window.setInterval(() => {
    void SyncManager.triggerSync();
  }, 30_000);
}

export const SyncManager = {
  isOnline(): boolean {
    return isBrowserOnline();
  },

  isBusy(): boolean {
    return isSyncing;
  },

  /**
   * Push everything that is still owed to the server, optionally for one migration.
   *
   * A mutation, the 30s timer and an `online` event can all fire at once; they
   * share the single in-flight request instead of racing each other over the same
   * operations.
   */
  async triggerSync(migrationId?: string): Promise<void> {
    if (inflightSync) return inflightSync;
    if (!isBrowserOnline()) return;

    isSyncing = true;
    inflightSync = (async () => {
      let ids = migrationId ? [migrationId] : [];
      if (!migrationId) {
        const db = await getDB();
        const allOps = await db.getAll('operations');
        ids = Array.from(new Set(allOps.map((op: any) => op.migrationId)));
      }
      for (const mid of ids) {
        await this.syncMigration(mid);
      }
    })();

    try {
      await inflightSync;
    } finally {
      inflightSync = null;
      isSyncing = false;
    }
  },

  /** Push the outbox then pull server state. Used by the export gate too. */
  async flushMigration(migrationId: string): Promise<SyncSummary> {
    // Let the push a mutation just kicked off finish first.
    if (inflightSync) await inflightSync.catch(() => undefined);

    const before = await OperationQueue.countPending(migrationId);
    const pushed = await this.syncMigration(migrationId);
    const pulled = await this.pullChanges(migrationId);
    const { conflicts, errors } = await OperationQueue.countIssues(migrationId);
    const remaining = await OperationQueue.countPending(migrationId);
    return {
      synced: Math.max(0, before - remaining),
      conflicts,
      errors,
      remaining,
      // The browser may be "online" while the service is down, so reachability
      // is what the server actually told us — not navigator.onLine.
      unreachable: !pushed || !pulled,
    };
  },

  /** Returns true when the server answered. */
  async syncMigration(migrationId: string): Promise<boolean> {
    if (!isBrowserOnline()) return false;

    // Anything a previous run left mid-flight (a sleeping host never got to
    // release its claim) becomes available again. Retrying is safe: the
    // operationId is stable, so the server recognises the replay.
    await OperationQueue.resetStuckOperations(migrationId);

    const ops = await OperationQueue.getPendingOperations(migrationId);
    if (ops.length === 0) return true;

    const batch = ops.slice(0, BATCH_SIZE);
    await OperationQueue.markAsSyncing(batch.map((op) => op.operationId));

    // Parents must land before children: the outbox is already dependency-ordered.
    const ordered = [...batch].sort((a, b) => a.sequence - b.sequence);

    let response: Response;
    try {
      response = await fetch(`${API_BASE}/migrations/${migrationId}/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          operations: ordered.map((op) => ({
            operationId: op.operationId,
            entityType: op.entityType,
            entityId: op.entityId,
            operationType: op.operationType,
            baseVersion: op.baseVersion,
            payload: op.payload,
          })),
        }),
      });
    } catch (error: any) {
      // Offline or the service is down: keep every change queued for retry.
      for (const op of ordered) {
        await OperationQueue.markAsFailed(op.operationId, error?.message ?? 'Network error', true);
      }
      return false;
    }

    if (!response.ok) {
      const retryable = response.status >= 500 || response.status === 429;
      for (const op of ordered) {
        await OperationQueue.markAsFailed(op.operationId, `Server responded ${response.status}`, retryable);
      }
      return false;
    }

    const body = await response.json().catch(() => null);
    const results: any[] = Array.isArray(body?.results) ? body.results : [];
    const byOperation = new Map<string, SyncOperation>(ordered.map((op) => [op.operationId, op]));

    for (const result of results) {
      const op = byOperation.get(result.operationId);
      if (!op) continue;

      if (result.status === 'SYNCED') {
        if (result.deleted) {
          // The server confirmed the delete (or that there was nothing to
          // delete): the tombstone has served its purpose and can go.
          await clearTombstone(op.entityType, op.entityId);
        } else {
          await markEntitySynced(
            migrationId,
            op.entityType,
            op.entityId,
            result.entityId ?? op.entityId,
            result.version ?? op.baseVersion ?? 0,
            op.operationId
          );
        }
        await OperationQueue.removeOperation(op.operationId);
      } else if (result.status === 'CONFLICT') {
        await OperationQueue.markAsConflict(op.operationId, {
          serverData: result.serverData ?? null,
          currentVersion: result.currentVersion ?? null,
          error: result.error ?? 'The record changed on the server.',
        });
      } else {
        await markEntitySyncError(op.entityType, op.entityId, result.error);
        await OperationQueue.markAsFailed(
          op.operationId,
          result.error || result.message || 'The server rejected this change.',
          false
        );
      }
    }

    // Results missing from the response stay queued: the request may have been
    // committed even though the response never arrived.
    const returned = new Set(results.map((r) => r.operationId));
    for (const op of ordered) {
      if (!returned.has(op.operationId)) {
        await OperationQueue.markAsFailed(op.operationId, 'No response for this change', true);
      }
    }

    await this.recordLocalRevision(migrationId, body?.revision);

    if (ops.length > batch.length) {
      setTimeout(() => {
        void this.triggerSync(migrationId);
      }, 50);
    }

    return true;
  },

  async recordLocalRevision(migrationId: string, revision?: number): Promise<void> {
    if (typeof revision !== 'number') return;
    setMigrationRevision(revision);
    const db = await getDB();
    const doc = await db.get('migrations', migrationId);
    if (doc) {
      await db.put('migrations', { ...doc, revision });
    } else {
      await db.put('migrations', { id: migrationId, name: 'Migration', revision });
    }
  },

  /**
   * Pull server state into the local workspace. Returns true when the server
   * answered.
   *
   * Rows with pending local intent (create/update/tombstone) and rows the outbox
   * still owns are skipped, so a refresh cannot resurrect a deletion or discard
   * offline work.
   */
  async pullChanges(migrationId: string): Promise<boolean> {
    if (!isBrowserOnline()) return false;
    try {
      const db = await getDB();
      const migrationDoc = await db.get('migrations', migrationId);
      const currentRevision = migrationDoc?.revision || 0;

      const changes = await migrationApi.getChanges(migrationId, currentRevision);
      if (!changes || typeof changes.toRevision !== 'number') return false;
      if (changes.toRevision <= currentRevision) return true;

      const state = changes.state ?? {};
      const pendingOps = await OperationQueue.getOperationsForMigration(migrationId);
      const pendingEntityIds = new Set(pendingOps.map((op) => op.entityId));

      for (const store of ALL_STORES) {
        const serverKey = store === 'openingStock' ? 'openingStocks' : store;
        const serverEntities: any[] = state[serverKey] ?? [];
        const entityType = ENTITY_FOR_STORE[store];

        for (const serverEntity of serverEntities) {
          const local = await db.get(STORE_FOR_ENTITY[entityType], serverEntity.id);
          const localRow = local as any;
          if (isPending(localRow)) continue;
          if (isTombstone(localRow)) continue;
          if (pendingEntityIds.has(serverEntity.id)) continue;
          if ((localRow?.version ?? -1) >= (serverEntity.version ?? 0)) continue;

          await putLocalEntity(entityType, {
            ...(localRow ?? {}),
            ...serverEntity,
            id: serverEntity.id,
            migrationId,
            version: serverEntity.version ?? 0,
            syncState: 'SYNCED',
          });
        }
      }

      await this.recordLocalRevision(migrationId, changes.toRevision);
      return true;
    } catch (error) {
      console.error('Failed to pull changes', error);
      return false;
    }
  },
};
