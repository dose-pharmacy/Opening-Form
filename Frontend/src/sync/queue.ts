import { getDB } from '../local-store/db';
import { v4 as uuidv4 } from 'uuid';

export type OperationType = 'CREATE' | 'UPDATE' | 'DELETE';
export type EntityType = 'PRODUCT' | 'GROUP' | 'LOCATION' | 'UNIT' | 'PRODUCT_UNIT' | 'BATCH' | 'OPENING_STOCK';

export interface SyncOperation {
  operationId: string;
  migrationId: string;
  entityType: EntityType;
  entityId: string;
  operationType: OperationType;
  payload: any;
  baseVersion?: number;
  createdAt: number;
  status: 'PENDING' | 'SYNCING' | 'FAILED' | 'CONFLICT';
  retryCount: number;
  lastError?: string;
}

export const OperationQueue = {
  async enqueue(
    migrationId: string,
    entityType: EntityType,
    entityId: string,
    operationType: OperationType,
    payload: any,
    baseVersion?: number
  ): Promise<string> {
    const db = await getDB();
    const operationId = uuidv4();

    const op: SyncOperation = {
      operationId,
      migrationId,
      entityType,
      entityId,
      operationType,
      payload,
      baseVersion,
      createdAt: Date.now(),
      status: 'PENDING',
      retryCount: 0,
    };

    await db.put('operations', op);
    return operationId;
  },

  async getPendingOperations(migrationId: string): Promise<SyncOperation[]> {
    const db = await getDB();
    const allOps = await db.getAllFromIndex('operations', 'by-migration', migrationId);
    return allOps
      .filter((op) => op.status === 'PENDING' || op.status === 'FAILED')
      .sort((a, b) => a.createdAt - b.createdAt);
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

  async markAsFailed(operationId: string, error: string, retryable: boolean): Promise<void> {
    const db = await getDB();
    const op = await db.get('operations', operationId);
    if (op) {
      op.status = retryable ? 'FAILED' : 'CONFLICT'; // Or a separate terminal state
      op.lastError = error;
      op.retryCount += 1;
      await db.put('operations', op);
    }
  },

  async markAsConflict(operationId: string, conflictData: any): Promise<void> {
    const db = await getDB();
    const op = await db.get('operations', operationId);
    if (op) {
      op.status = 'CONFLICT';
      await db.put('operations', op);
      await db.put('conflicts', { operationId, ...conflictData });
    }
  },
  
  async countPending(migrationId: string): Promise<number> {
      const db = await getDB();
      const allOps = await db.getAllFromIndex('operations', 'by-migration', migrationId);
      return allOps.filter((op) => op.status !== 'CONFLICT').length;
  }
};
