import { OperationQueue, type SyncOperation } from './queue';
import { getDB } from '../local-store/db';
import { markEntitySynced, type EntityStore } from '../local-store/entities';
import { migrationApi } from '../utils/migrationApi';
import { API_BASE } from '../utils/apiBase';

/** Kept small: each change is a round trip, and the database may be remote. */
const BATCH_SIZE = 20;

let isSyncing = false;

/** The browser's live connectivity is the authority, not a cached flag. */
const isBrowserOnline = (): boolean => (typeof navigator === 'undefined' ? true : navigator.onLine);

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    SyncManager.triggerSync();
  });

  // Nothing may be lost while offline: keep retrying the outbox in the
  // background so a change always reaches the server eventually.
  window.setInterval(() => {
    SyncManager.triggerSync();
  }, 30000);
}

export interface SyncSummary {
  synced: number;
  conflicts: number;
  errors: number;
  remaining: number;
}

export const SyncManager = {
  isOnline(): boolean {
    return isBrowserOnline();
  },

  isBusy(): boolean {
    return isSyncing;
  },

  /** Push everything that is still owed to the server across all migrations. */
  async triggerSync(migrationId?: string): Promise<void> {
    if (isSyncing || !isBrowserOnline()) return;
    isSyncing = true;

    try {
      let migrationIdsToSync = migrationId ? [migrationId] : [];
      if (!migrationId) {
        const db = await getDB();
        const allOps = await db.getAll('operations');
        migrationIdsToSync = Array.from(new Set(allOps.map((op) => op.migrationId)));
      }

      for (const mid of migrationIdsToSync) {
        await this.syncMigration(mid);
      }
    } finally {
      isSyncing = false;
    }
  },

  /** Push the outbox then pull server state. Used by the export gate too. */
  async flushMigration(migrationId: string): Promise<SyncSummary> {
    const before = await OperationQueue.countPending(migrationId);
    await this.syncMigration(migrationId);
    await this.pullChanges(migrationId);
    const { conflicts, errors } = await OperationQueue.countIssues(migrationId);
    const remaining = await OperationQueue.countPending(migrationId);
    return { synced: Math.max(0, before - remaining), conflicts, errors, remaining };
  },

  async syncMigration(migrationId: string): Promise<void> {
    if (!isBrowserOnline()) return;

    // Reclaim anything a previous interrupted run left mid-flight: an operation
    // stuck in SYNCING used to be invisible to the queue forever.
    await OperationQueue.resetStuckOperations(migrationId);

    const ops = await OperationQueue.getPendingOperations(migrationId);
    if (ops.length === 0) return;

    const batch = ops.slice(0, BATCH_SIZE);
    await OperationQueue.markAsSyncing(batch.map((op) => op.operationId));

    // Parents must land before children: the outbox is already dependency-ordered.
    const ordered = [...batch].sort(
      (a, b) => (a.sequence ?? a.createdAt) - (b.sequence ?? b.createdAt)
    );

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
      return;
    }

    if (!response.ok) {
      const retryable = response.status >= 500 || response.status === 429;
      for (const op of ordered) {
        await OperationQueue.markAsFailed(
          op.operationId,
          `Server responded ${response.status}`,
          retryable
        );
      }
      return;
    }

    const body = await response.json().catch(() => null);
    const results: any[] = Array.isArray(body?.results) ? body.results : [];
    const byOperation = new Map<string, SyncOperation>(ordered.map((op) => [op.operationId, op]));

    for (const result of results) {
      const op = byOperation.get(result.operationId);
      if (!op) continue;

      if (result.status === 'SYNCED') {
        await markEntitySynced(
          migrationId,
          op.entityType,
          op.entityId,
          result.entityId ?? op.entityId,
          result.version ?? op.baseVersion ?? 1,
          JSON.stringify(op.payload)
        );
        await OperationQueue.removeOperation(op.operationId);
      } else if (result.status === 'CONFLICT') {
        await OperationQueue.markAsConflict(op.operationId, {
          serverData: result.serverData ?? null,
          currentVersion: result.currentVersion ?? null,
          error: result.error ?? 'The record changed on the server.',
        });
      } else {
        await OperationQueue.markAsFailed(
          op.operationId,
          result.error || result.message || 'The server rejected this change.',
          false
        );
      }
    }

    // Results missing from the response stay SYNCING until the next run reclaims them.
    const returned = new Set(results.map((r) => r.operationId));
    for (const op of ordered) {
      if (!returned.has(op.operationId)) {
        await OperationQueue.markAsFailed(op.operationId, 'No response for this change', true);
      }
    }

    await this.recordLocalRevision(migrationId, body?.revision);

    if (ops.length > batch.length) {
      setTimeout(() => {
        this.triggerSync(migrationId);
      }, 50);
    }
  },

  async recordLocalRevision(migrationId: string, revision?: number): Promise<void> {
    if (typeof revision !== 'number') return;
    const db = await getDB();
    const doc = await db.get('migrations', migrationId);
    if (doc) {
      await db.put('migrations', { ...doc, revision });
    } else {
      await db.put('migrations', { id: migrationId, name: 'Migration', revision });
    }
  },

  /**
   * Pull server state into the local mirror.
   *
   * Anything still sitting in the outbox is left alone: an unsynced local edit
   * must never be silently replaced by the server copy.
   */
  async pullChanges(migrationId: string): Promise<void> {
    if (!isBrowserOnline()) return;
    try {
      const db = await getDB();
      const migrationDoc = await db.get('migrations', migrationId);
      const currentRevision = migrationDoc?.revision || 0;

      const changes = await migrationApi.getChanges(migrationId, currentRevision);
      if (!changes || changes.fromRevision === changes.toRevision) return;

      const state = changes.state;
      if (state) {
        const pendingOps = await db.getAllFromIndex('operations', 'by-migration', migrationId);
        const pendingEntityIds = new Set(pendingOps.map((op) => op.entityId));

        const stores = [
          'groups',
          'locations',
          'units',
          'products',
          'productUnits',
          'batches',
          'openingStocks',
        ] as const;

        for (const storeName of stores) {
          const idbStore: EntityStore = storeName === 'openingStocks' ? 'openingStock' : storeName;
          const serverEntities: any[] = state[storeName] || [];

          for (const serverEntity of serverEntities) {
            if (pendingEntityIds.has(serverEntity.id)) continue;

            const tx = db.transaction(idbStore, 'readwrite');
            const localEntity = await tx.store.get(serverEntity.id);
            const localVersion = (localEntity as any)?.version ?? -1;
            if (localVersion < serverEntity.version) {
              await tx.store.put({ ...serverEntity, synced: true });
            }
            await tx.done;
          }
        }
      }

      await this.recordLocalRevision(migrationId, changes.toRevision);
    } catch (error) {
      console.error('Failed to pull changes', error);
    }
  },
};
