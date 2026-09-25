import { OperationQueue, SyncOperation } from './queue';
import { getDB } from '../local-store/db';
import { migrationApi } from '../utils/migrationApi';

let isSyncing = false;
let onlineStatus = navigator.onLine;

window.addEventListener('online', () => {
    onlineStatus = true;
    SyncManager.triggerSync();
});

window.addEventListener('offline', () => {
    onlineStatus = false;
});

export const SyncManager = {
  async triggerSync(migrationId?: string) {
    if (isSyncing || !onlineStatus) return;
    isSyncing = true;

    try {
        let migrationIdsToSync = migrationId ? [migrationId] : [];
        if (!migrationId) {
            // Find all migrations that have pending operations
            const db = await getDB();
            const allOps = await db.getAll('operations');
            const uniqueMigrations = new Set(allOps.map(op => op.migrationId));
            migrationIdsToSync = Array.from(uniqueMigrations);
        }

        for (const mid of migrationIdsToSync) {
            await this.syncMigration(mid);
        }
    } finally {
        isSyncing = false;
    }
  },

  async syncMigration(migrationId: string) {
      const ops = await OperationQueue.getPendingOperations(migrationId);
      
      // Before pushing, let's pull server changes
      await this.pullChanges(migrationId);
      
      if (ops.length === 0) return;

      const opsToSync = ops.slice(0, 50); // batch size
      const opIds = opsToSync.map(op => op.operationId);
      
      await OperationQueue.markAsSyncing(opIds);

      try {
          const response = await fetch(`http://localhost:3001/api/migrations/${migrationId}/sync`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ operations: opsToSync })
          });

          if (!response.ok) {
              const status = response.status;
              const retryable = status >= 500 || status === 429;
              for (const op of opsToSync) {
                  await OperationQueue.markAsFailed(op.operationId, `HTTP ${status}`, retryable);
              }
              return;
          }

          const { results } = await response.json();

          for (const result of results) {
              if (result.status === 'SYNCED') {
                  await OperationQueue.removeOperation(result.operationId);
                  // Update local entity version
                  await this.updateLocalVersion(migrationId, result.entityId, result.version);
              } else if (result.status === 'CONFLICT') {
                  await OperationQueue.markAsConflict(result.operationId, result);
              } else {
                  await OperationQueue.markAsFailed(result.operationId, result.error || 'Unknown error', false);
              }
          }

          // If there are more operations, trigger sync again
          if (ops.length > 50) {
              setTimeout(() => this.triggerSync(migrationId), 100);
          }
      } catch (error: any) {
          // Network error - retryable
          for (const op of opsToSync) {
              await OperationQueue.markAsFailed(op.operationId, error.message, true);
          }
      }
  },

  async updateLocalVersion(migrationId: string, entityId: string, version: number) {
      // Find the entity in all stores and update its version.
      // This is a bit brute force but avoids needing to pass entityType in results right now
      const db = await getDB();
      const stores: (keyof typeof db['objectStoreNames'])[] = ['products', 'groups', 'locations', 'units', 'productUnits', 'batches', 'openingStock'];
      for (const storeName of stores) {
          const tx = db.transaction(storeName, 'readwrite');
          const entity = await tx.store.get(entityId as any);
          if (entity && (entity as any).version) {
              (entity as any).version = version;
              await tx.store.put(entity as any);
              await tx.done;
              break;
          }
      }
  },

  async pullChanges(migrationId: string) {
      if (!onlineStatus) return;
      try {
          const db = await getDB();
          let migrationDoc = await db.get('migrations', migrationId);
          const currentRevision = migrationDoc?.revision || 0;
          
          const changes = await migrationApi.getChanges(migrationId, currentRevision);
          if (!changes || changes.fromRevision === changes.toRevision) return;

          // Process incoming changes
          // The endpoint returns { state: { groups, products, ... } }
          const state = changes.state;
          if (state) {
             const stores: (keyof typeof state)[] = ['groups', 'locations', 'units', 'products', 'productUnits', 'batches', 'openingStocks'];
             for (const storeName of stores) {
                 const idbStore = storeName === 'openingStocks' ? 'openingStock' : storeName;
                 const serverEntities = state[storeName] || [];
                 
                 for (const serverEntity of serverEntities) {
                     const tx = db.transaction(idbStore as any, 'readwrite');
                     const localEntity = await tx.store.get(serverEntity.id);
                     
                     // Check if local is missing or older
                     if (!localEntity || (localEntity as any).version < serverEntity.version) {
                         // Check if there is a pending operation for this entity
                         const pendingOps = await db.getAllFromIndex('operations', 'by-migration', migrationId);
                         const hasPending = pendingOps.some(op => op.entityId === serverEntity.id && op.status === 'PENDING');
                         
                         if (hasPending) {
                             // We have a pending operation for an entity that also changed on the server.
                             // We don't overwrite local yet, it will result in a conflict on push.
                             // Or we can proactively mark it as CONFLICT here!
                         } else {
                             // No pending local edit, safe to update!
                             await tx.store.put(serverEntity as any);
                         }
                     }
                     await tx.done;
                 }
             }
          }

          if (migrationDoc) {
             migrationDoc.revision = changes.toRevision;
             await db.put('migrations', migrationDoc);
          } else {
             await db.put('migrations', { id: migrationId, name: 'Migration', revision: changes.toRevision });
          }
      } catch (error) {
          console.error("Failed to pull changes", error);
      }
  }
};
