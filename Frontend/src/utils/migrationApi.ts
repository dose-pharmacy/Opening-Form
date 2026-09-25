const API_BASE = 'http://localhost:3001/api';
import { OperationQueue, EntityType, OperationType } from '../sync/queue';
import { SyncManager } from '../sync/syncManager';
import { getDB } from '../local-store/db';
import { v4 as uuidv4 } from 'uuid';
export const migrationApi = {
  // Migrations
  createMigration: async (name: string) => {
    const res = await fetch(`${API_BASE}/migrations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) throw new Error('Failed to create migration');
    return res.json();
  },
  getMigration: async (id: string) => {
    const res = await fetch(`${API_BASE}/migrations/${id}`);
    if (!res.ok) throw new Error('Failed to get migration');
    return res.json();
  },
  getSummary: async (id: string) => {
    const res = await fetch(`${API_BASE}/migrations/${id}/summary`);
    if (!res.ok) throw new Error('Failed to get summary');
    return res.json();
  },
  getChanges: async (id: string, sinceRevision: number = 0) => {
    const res = await fetch(`${API_BASE}/migrations/${id}/changes?sinceRevision=${sinceRevision}`);
    if (!res.ok) throw new Error('Failed to get changes');
    return res.json();
  },
  exportMigration: async (id: string) => {
    const res = await fetch(`${API_BASE}/migrations/${id}/export`);
    if (!res.ok) throw new Error('Failed to export migration');
    return res.json();
  },

  // Groups
  listGroups: async (migrationId: string) => {
    const db = await getDB();
    const local = await db.getAllFromIndex('groups', 'by-migration', migrationId);
    if (local.length > 0) return local;

    const res = await fetch(`${API_BASE}/migrations/${migrationId}/groups`);
    if (!res.ok) throw new Error('Failed to list groups');
    const data = await res.json();
    const tx = db.transaction('groups', 'readwrite');
    for (const item of data) await tx.store.put(item);
    await tx.done;
    return data;
  },
  createGroup: async (migrationId: string, data: any) => {
    const db = await getDB();
    const entityId = data.id || uuidv4();
    const payload = { ...data, id: entityId, migrationId, version: 1 };
    await db.put('groups', payload);
    await OperationQueue.enqueue(migrationId, 'GROUP', entityId, 'CREATE', data);
    SyncManager.triggerSync(migrationId);
    return payload;
  },

  // Locations
  listLocations: async (migrationId: string) => {
    const db = await getDB();
    const local = await db.getAllFromIndex('locations', 'by-migration', migrationId);
    if (local.length > 0) return local;

    const res = await fetch(`${API_BASE}/migrations/${migrationId}/locations`);
    if (!res.ok) throw new Error('Failed to list locations');
    const data = await res.json();
    const tx = db.transaction('locations', 'readwrite');
    for (const item of data) await tx.store.put(item);
    await tx.done;
    return data;
  },
  createLocation: async (migrationId: string, data: any) => {
    const db = await getDB();
    const entityId = data.id || uuidv4();
    const payload = { ...data, id: entityId, migrationId, version: 1 };
    await db.put('locations', payload);
    await OperationQueue.enqueue(migrationId, 'LOCATION', entityId, 'CREATE', data);
    SyncManager.triggerSync(migrationId);
    return payload;
  },

  // Units
  listUnits: async (migrationId: string) => {
    const db = await getDB();
    const local = await db.getAllFromIndex('units', 'by-migration', migrationId);
    if (local.length > 0) return local;

    const res = await fetch(`${API_BASE}/migrations/${migrationId}/units`);
    if (!res.ok) throw new Error('Failed to list units');
    const data = await res.json();
    const tx = db.transaction('units', 'readwrite');
    for (const item of data) await tx.store.put(item);
    await tx.done;
    return data;
  },
  createUnit: async (migrationId: string, data: any) => {
    const db = await getDB();
    const entityId = data.id || uuidv4();
    const payload = { ...data, id: entityId, migrationId, version: 1 };
    await db.put('units', payload);
    await OperationQueue.enqueue(migrationId, 'UNIT', entityId, 'CREATE', data);
    SyncManager.triggerSync(migrationId);
    return payload;
  },

  // Products
  listProducts: async (migrationId: string, page = 1, search = '') => {
    // We should ideally sync the entire migration state. If we do, we can query from IndexedDB.
    // For pagination/search, if we want offline support, we query local indexeddb.
    const db = await getDB();
    let local = await db.getAllFromIndex('products', 'by-migration', migrationId);
    
    if (local.length === 0) {
        const query = new URLSearchParams({ page: '1', limit: '10000' }).toString(); // Fetch all for offline cache
        const res = await fetch(`${API_BASE}/migrations/${migrationId}/products?${query}`);
        if (!res.ok) throw new Error('Failed to list products');
        const resData = await res.json();
        const tx = db.transaction('products', 'readwrite');
        for (const item of resData.data) await tx.store.put(item);
        await tx.done;
        local = resData.data;
    }

    if (search) {
        const s = search.toLowerCase();
        local = local.filter(p => (p.name && p.name.toLowerCase().includes(s)) || (p.sku && p.sku.toLowerCase().includes(s)));
    }

    const start = (page - 1) * 50;
    const paginated = local.slice(start, start + 50);

    return { data: paginated, total: local.length, page, limit: 50 };
  },
  createProduct: async (migrationId: string, data: any) => {
    const db = await getDB();
    const entityId = data.id || uuidv4();
    const payload = { ...data, id: entityId, migrationId, version: 1 };
    await db.put('products', payload);
    await OperationQueue.enqueue(migrationId, 'PRODUCT', entityId, 'CREATE', data);
    SyncManager.triggerSync(migrationId);
    return payload;
  },

  // Product Units
  listProductUnits: async (migrationId: string) => {
    const db = await getDB();
    const local = await db.getAll('productUnits');
    // Note: this should probably be scoped to products in the migration.
    // For now we assume they were pre-fetched or we just load what's there.
    return local;
  },
  createProductUnit: async (migrationId: string, data: any) => {
    const db = await getDB();
    const entityId = data.id || uuidv4();
    const payload = { ...data, id: entityId, version: 1 };
    await db.put('productUnits', payload);
    await OperationQueue.enqueue(migrationId, 'PRODUCT_UNIT', entityId, 'CREATE', data);
    SyncManager.triggerSync(migrationId);
    return payload;
  },

  // Batches
  listBatches: async (migrationId: string) => {
    const db = await getDB();
    const local = await db.getAllFromIndex('batches', 'by-migration', migrationId);
    if (local.length > 0) return local;

    const res = await fetch(`${API_BASE}/migrations/${migrationId}/batches`);
    if (!res.ok) throw new Error('Failed to list batches');
    const data = await res.json();
    const tx = db.transaction('batches', 'readwrite');
    for (const item of data) await tx.store.put(item);
    await tx.done;
    return data;
  },
  createBatch: async (migrationId: string, data: any) => {
    const db = await getDB();
    const entityId = data.id || uuidv4();
    const payload = { ...data, id: entityId, migrationId, version: 1 };
    await db.put('batches', payload);
    await OperationQueue.enqueue(migrationId, 'BATCH', entityId, 'CREATE', data);
    SyncManager.triggerSync(migrationId);
    return payload;
  },

  // Opening Stock
  listOpeningStock: async (migrationId: string) => {
    const db = await getDB();
    const local = await db.getAllFromIndex('openingStock', 'by-migration', migrationId);
    if (local.length > 0) return local;

    const res = await fetch(`${API_BASE}/migrations/${migrationId}/openingStock`);
    if (!res.ok) throw new Error('Failed to list opening stock');
    const data = await res.json();
    const tx = db.transaction('openingStock', 'readwrite');
    for (const item of data) await tx.store.put(item);
    await tx.done;
    return data;
  },
  createOpeningStock: async (migrationId: string, data: any) => {
    const db = await getDB();
    const entityId = data.id || uuidv4();
    const payload = { ...data, id: entityId, migrationId, version: 1 };
    await db.put('openingStock', payload);
    await OperationQueue.enqueue(migrationId, 'OPENING_STOCK', entityId, 'CREATE', data);
    SyncManager.triggerSync(migrationId);
    return payload;
  }
};
