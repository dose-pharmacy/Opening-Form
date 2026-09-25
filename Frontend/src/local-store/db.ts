import { openDB, DBSchema, IDBPDatabase } from 'idb';

export interface MigrationDB extends DBSchema {
  migrations: {
    key: string;
    value: { id: string; name: string; revision: number; [key: string]: any };
  };
  products: {
    key: string;
    value: any;
    indexes: { 'by-migration': string };
  };
  groups: {
    key: string;
    value: any;
    indexes: { 'by-migration': string };
  };
  locations: {
    key: string;
    value: any;
    indexes: { 'by-migration': string };
  };
  units: {
    key: string;
    value: any;
    indexes: { 'by-migration': string };
  };
  productUnits: {
    key: string;
    value: any;
    indexes: { 'by-migration': string }; // actually might not have migrationId, maybe we index by productId
  };
  batches: {
    key: string;
    value: any;
    indexes: { 'by-migration': string };
  };
  openingStock: {
    key: string;
    value: any;
    indexes: { 'by-migration': string };
  };
  operations: {
    key: string;
    value: {
      operationId: string;
      migrationId: string;
      entityType: string;
      entityId: string;
      operationType: 'CREATE' | 'UPDATE' | 'DELETE';
      payload: any;
      baseVersion?: number;
      createdAt: number;
      status: 'PENDING' | 'SYNCING' | 'FAILED' | 'CONFLICT';
      retryCount: number;
      lastError?: string;
    };
    indexes: { 'by-migration': string; 'by-status': string };
  };
  conflicts: {
      key: string;
      value: any;
  }
}

const DB_NAME = 'PharmacyMigrationDB';
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase<MigrationDB>> | null = null;

export function getDB() {
  if (!dbPromise) {
    dbPromise = openDB<MigrationDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        db.createObjectStore('migrations', { keyPath: 'id' });
        
        const productsStore = db.createObjectStore('products', { keyPath: 'id' });
        productsStore.createIndex('by-migration', 'migrationId');
        
        const groupsStore = db.createObjectStore('groups', { keyPath: 'id' });
        groupsStore.createIndex('by-migration', 'migrationId');
        
        const locationsStore = db.createObjectStore('locations', { keyPath: 'id' });
        locationsStore.createIndex('by-migration', 'migrationId');
        
        const unitsStore = db.createObjectStore('units', { keyPath: 'id' });
        unitsStore.createIndex('by-migration', 'migrationId');
        
        // productUnits don't necessarily have migrationId directly, but we can store them and maybe just query all for offline use, or index by productId
        const productUnitsStore = db.createObjectStore('productUnits', { keyPath: 'id' });
        productUnitsStore.createIndex('by-migration', 'migrationId'); 

        const batchesStore = db.createObjectStore('batches', { keyPath: 'id' });
        batchesStore.createIndex('by-migration', 'migrationId');
        
        const openingStockStore = db.createObjectStore('openingStock', { keyPath: 'id' });
        openingStockStore.createIndex('by-migration', 'migrationId');
        
        const operationsStore = db.createObjectStore('operations', { keyPath: 'operationId' });
        operationsStore.createIndex('by-migration', 'migrationId');
        operationsStore.createIndex('by-status', 'status');

        db.createObjectStore('conflicts', { keyPath: 'operationId' });
      },
    });
  }
  return dbPromise;
}
