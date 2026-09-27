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
  ENTITY_FOR_STORE,
  STORE_FOR_ENTITY,
  clearTombstone,
  isPending,
  isTombstone,
  markEntitySynced,
  markEntitySyncError,
  pruneLocalRows,
  putLocalEntity,
} from '../local-store/entities';
import { OperationQueue, type SyncOperation } from './queue';
import { migrationApi } from '../utils/migrationApi';
import { API_BASE } from '../utils/apiBase';
import { setMigrationRevision } from '../utils/storage';

/** Kept small: each change is a round trip, and the database may be remote. */
const BATCH_SIZE = 20;

/**
 * How many push rounds a user-requested full sync will make.
 *
 * One request only carries `BATCH_SIZE` operations, so a large queued import needs
 * several rounds. The cap stops a server that keeps rejecting work from turning a
 * button press into an endless loop.
 */
const MAX_PUSH_ROUNDS = 20;

let isSyncing = false;
/** The push currently in flight, so concurrent callers share one request. */
let inflightSync: Promise<void> | null = null;

const isBrowserOnline = (): boolean => (typeof navigator === 'undefined' ? true : navigator.onLine);

export interface SyncSummary {
  synced: number;
  conflicts: number;
  errors: number;
  remaining: number;
  /** True when the server could not be reached, so the UI can say "offline". */
  unreachable: boolean;
}

/** A full sync reports the same shape, so callers need only one code path. */
export type FullSyncSummary = SyncSummary;

const emptySummary = (): SyncSummary => ({
  synced: 0,
  conflicts: 0,
  errors: 0,
  remaining: 0,
  unreachable: false,
});

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
   * offline work. When the server says it is sending its complete state
   * (`fullState`), local rows it no longer lists are removed — that is what makes
   * a delete performed on another device disappear here too.
   */
  async pullChanges(migrationId: string, options: { full?: boolean } = {}): Promise<boolean> {
    if (!isBrowserOnline()) return false;
    try {
      const db = await getDB();
      const migrationDoc = await db.get('migrations', migrationId);
      const currentRevision = migrationDoc?.revision || 0;

      const changes = await migrationApi.getChanges(
        migrationId,
        options.full ? 0 : currentRevision
      );
      if (!changes || typeof changes.toRevision !== 'number') return false;
      // "Nothing new since your revision" is only a reason to stop when a delta
      // was asked for. A full pull was requested precisely because the local copy
      // cannot be trusted to match the server, so its state is applied even when
      // the revision looks unchanged.
      if (!options.full && changes.toRevision <= currentRevision) return true;

      const state = changes.state ?? {};
      // The server states whether this payload is everything it has. An
      // "up to date" response carries empty lists and must never be read as
      // "all your records were deleted".
      const authoritative = changes.fullState === true;
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

        await pruneLocalRows(store, migrationId, serverEntities, {
          pendingEntityIds,
          authoritative,
        });
      }

      await this.recordLocalRevision(migrationId, changes.toRevision);
      return true;
    } catch (error) {
      console.error('Failed to pull changes', error);
      return false;
    }
  },

  /**
   * A user-requested full synchronisation ("Sync Latest Data").
   *
   * Pushes everything the outbox holds, then pulls the server's *complete* state
   * so the local cache is rebuilt from the source of truth: updated rows
   * overwrite local copies, new rows are inserted, and rows deleted on the server
   * are pruned.
   *
   * The returned summary distinguishes "we are offline" from "the server refused
   * something", because the two need different messages and different recovery.
   */
  async syncNow(migrationId: string): Promise<FullSyncSummary> {
    if (!isBrowserOnline()) {
      return { ...emptySummary(), unreachable: true };
    }

    const before = await OperationQueue.countPending(migrationId);

    // Drain the outbox completely: a single batch is not enough when a large
    // import is queued, and a full sync that leaves work behind is not a full sync.
    let pushed = true;
    for (let attempt = 0; attempt < MAX_PUSH_ROUNDS; attempt += 1) {
      const round = await this.syncMigration(migrationId);
      if (!round) {
        pushed = false;
        break;
      }
      if ((await OperationQueue.countPending(migrationId)) === 0) break;
    }

    // `full: true` asks for everything, not a delta, so nothing the server has
    // can be missed and pruning is safe.
    const pulled = await this.pullChanges(migrationId, { full: true });

    const { conflicts, errors } = await OperationQueue.countIssues(migrationId);
    const remaining = await OperationQueue.countPending(migrationId);

    return {
      synced: Math.max(0, before - remaining),
      conflicts,
      errors,
      remaining,
      unreachable: !pushed || !pulled,
    };
  },
};
