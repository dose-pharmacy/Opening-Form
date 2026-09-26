/**
 * Workspace lifecycle tests.
 *
 * Each case is one of the situations the refactor had to get right: a first run
 * against existing server data, a reload, an unreachable service, offline edits,
 * deletes, retries, imports, and a server refresh arriving while local work is
 * still queued.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetDB } from '../local-store/db';
import {
  getLocalEntity,
  getRawRows,
  hasLocalWorkspace,
  isTombstone,
  loadWorkspace,
} from '../local-store/entities';
import { OperationQueue } from '../sync/queue';
import { deleteEntity } from '../sync/mutations';
import { SyncManager } from '../sync/syncManager';
import { hydrateWorkspace, resolveMigrationId, reconcileServerState } from '../sync/hydrate';
import {
  deleteStockEntry,
  importMigrationData,
  saveBatch,
  saveGroup,
  saveProduct,
  saveStockEntry,
  saveUnit,
} from '../sync/workspaceOps';
import { batchId, groupId, productId, stockId, unitId } from '../sync/ids';
import { getActiveMigrationId } from '../utils/storage';
import type { Batch, MigrationData, Product, StockEntry } from '../utils/types';
import { FakeSyncServer } from './fakeServer';

import {
  MIGRATION,
  installFetch,
  sampleBatch,
  sampleEntry,
  sampleProduct,
  seedServer,
  settle,
} from './harness';

beforeEach(async () => {
  await resetDB();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  // A mutation triggers a background push that is deliberately not awaited; let
  // it finish before the database is torn down, or it writes into a closed
  // connection and fails the next test.
  await settle();
  await resetDB();
});

describe('A. First use: server data becomes the local workspace', () => {
  it('hydrates IndexedDB from the server and renders the full entity graph', async () => {
    const server = new FakeSyncServer({ migrationId: MIGRATION });
    const seeded = seedServer(server);
    installFetch(server);

    const resolution = await resolveMigrationId();
    expect(resolution.migrationId).toBe(MIGRATION);
    expect(resolution.offline).toBe(false);

    const result = await hydrateWorkspace(MIGRATION);
    expect(result.source).toBe('SERVER');
    expect(result.offline).toBe(false);
    expect(await hasLocalWorkspace(MIGRATION)).toBe(true);

    const data = await loadWorkspace(MIGRATION);

    // The form needs product, unit hierarchy, batch and stock — not raw columns.
    expect(data.products).toHaveLength(1);
    expect(data.products[0].sku).toBe(seeded.sku);
    expect(data.products[0].productGroup).toBe('Analgesics');
    expect(data.products[0].units.map((u) => u.unit).sort()).toEqual(['Box', 'Tablet']);
    expect(data.batches).toEqual([
      expect.objectContaining({ productSku: seeded.sku, batchNumber: 'B-1', expiryDate: '2027-01-31' }),
    ]);
    expect(data.openingStock).toHaveLength(1);
    expect(data.openingStock[0]).toEqual({
      id: seeded.location && stockId(MIGRATION, seeded.sku, 'B-1', 'Main Store'),
      productSku: seeded.sku,
      batchNumber: 'B-1',
      location: 'Main Store',
      // Identity and placement of the line, so a duplicate can be told apart.
      lineKey: '',
      position: 0,
      quantities: [{ unit: 'Box', quantity: 3, unitCost: 12 }],
    });
    expect(data.locations).toEqual([{ name: 'Main Store' }]);
    expect(data.units.map((u) => u.name).sort()).toEqual(['Box', 'Tablet']);
  });

  it('pushes nothing to the server while hydrating', async () => {
    const server = new FakeSyncServer({ migrationId: MIGRATION });
    seedServer(server);
    installFetch(server);

    await resolveMigrationId();
    await hydrateWorkspace(MIGRATION);

    const writes = server.requests.filter((r) => r.method === 'POST');
    expect(writes).toHaveLength(0);
  });
});

describe('B. Reload uses the local workspace and never deletes', () => {
  it('serves the form from IndexedDB and issues no DELETE', async () => {
    const server = new FakeSyncServer({ migrationId: MIGRATION });
    const seeded = seedServer(server);
    installFetch(server);

    await resolveMigrationId();
    await hydrateWorkspace(MIGRATION);

    // Second visit: a local workspace exists, so the server is not even needed.
    server.online = false;
    const second = await hydrateWorkspace(MIGRATION, { offline: true });
    expect(second.source).toBe('LOCAL');
    expect(second.data.products).toHaveLength(1);
    expect(second.data.openingStock).toHaveLength(1);

    server.online = true;
    await SyncManager.flushMigration(MIGRATION);

    const deletes = server.requests
      .filter((r) => r.method === 'POST')
      .flatMap((r) => r.body?.operations ?? [])
      .filter((op: any) => op.operationType === 'DELETE');
    expect(deletes).toHaveLength(0);
    expect(server.count('OPENING_STOCK')).toBe(1);
    expect(server.openingStocks[stockId(MIGRATION, seeded.sku, 'B-1', 'Main Store')]).toBeTruthy();
  });

  it('an empty server plus a populated local workspace is not a delete', async () => {
    const server = new FakeSyncServer({ migrationId: MIGRATION });
    seedServer(server);
    installFetch(server);

    await resolveMigrationId();
    await hydrateWorkspace(MIGRATION);
    await SyncManager.flushMigration(MIGRATION);

    // Everything was hydrated, so nothing is queued and nothing is pushed.
    expect(await OperationQueue.countPending(MIGRATION)).toBe(0);
  });
});

describe('C. No local data and an unreachable service is not an empty form', () => {
  it('reports offline instead of hydrating an editable empty migration', async () => {
    const server = new FakeSyncServer({ online: false });
    installFetch(server);

    const resolution = await resolveMigrationId();
    expect(resolution.migrationId).toBeNull();
    expect(resolution.offline).toBe(true);
    // A failed lookup must never invent an identity.
    expect(getActiveMigrationId()).toBeNull();

    const pendingWrites = server.requests.filter((r) => r.method === 'POST');
    expect(pendingWrites).toHaveLength(0);
  });

  it('creates a migration only after a successful empty listing', async () => {
    const server = new FakeSyncServer({ migrationId: '' });
    installFetch(server);

    const resolution = await resolveMigrationId();
    // Nothing exists yet, so the service is asked to create one.
    expect(resolution.migrationId).toBeTruthy();
    expect(resolution.offline).toBe(false);
  });

  it('keeps the stored identity when the service is down', async () => {
    const server = new FakeSyncServer({ migrationId: MIGRATION });
    seedServer(server);
    installFetch(server);
    await resolveMigrationId();

    server.online = false;
    const resolution = await resolveMigrationId();
    expect(resolution.migrationId).toBe(MIGRATION);
    expect(resolution.offline).toBe(true);
    expect(getActiveMigrationId()).toBe(MIGRATION);
  });
});

describe('D. Offline edits survive a reload and reach the server later', () => {
  it('queues explicit operations, keeps them through a reload, then pushes them', async () => {
    const server = new FakeSyncServer({ migrationId: MIGRATION });
    seedServer(server);
    installFetch(server);
    await resolveMigrationId();
    await hydrateWorkspace(MIGRATION);
    await SyncManager.flushMigration(MIGRATION);

    // The service goes away and the user keeps working.
    server.online = false;
    const sku = 'SKU-OFFLINE';
    const product = sampleProduct(sku, 'Offline Product');
    await saveProduct(MIGRATION, product);
    const batch = sampleBatch(sku, 'B-9');
    await saveBatch(MIGRATION, batch);
    const entry = sampleEntry('row-1', sku, 'B-9', 'Main Store');
    await saveStockEntry(MIGRATION, entry, product, batch);

    const queued = await OperationQueue.getPendingOperations(MIGRATION);
    expect(queued.length).toBeGreaterThan(0);
    // The row is on the device, fully formed, even though nothing reached the server.
    const reloaded = await loadWorkspace(MIGRATION);
    expect(reloaded.products.map((p) => p.sku)).toContain(sku);
    expect(reloaded.products.find((p) => p.sku === sku)?.units).toHaveLength(2);

    // Back online: the same operationIds go up and everything is applied.
    server.online = true;
    const before = queued.map((op) => op.operationId);
    const summary = await SyncManager.flushMigration(MIGRATION);
    expect(summary.unreachable).toBe(false);
    expect(summary.remaining).toBe(0);

    expect(server.count('PRODUCT')).toBe(2);
    expect(server.count('OPENING_STOCK')).toBe(2);
    const after = await OperationQueue.getOperationsForMigration(MIGRATION);
    expect(after.filter((op) => before.includes(op.operationId))).toHaveLength(0);
  });

  it('keeps the local UI row intact while the server payload stays trimmed', async () => {
    const server = new FakeSyncServer({ migrationId: MIGRATION });
    seedServer(server);
    installFetch(server);
    await resolveMigrationId();
    await hydrateWorkspace(MIGRATION);
    await SyncManager.flushMigration(MIGRATION);

    server.online = false;
    const product = sampleProduct('SKU-2', 'Trimmed Payload');
    await saveProduct(MIGRATION, product);

    const row = await getLocalEntity('PRODUCT', productId(MIGRATION, 'SKU-2'));
    expect(row?.units).toHaveLength(2);
    expect(row?.minStock).toBe(5);

    const ops = await OperationQueue.getOperationsForEntity(MIGRATION, productId(MIGRATION, 'SKU-2'));
    const create = ops.find((op) => op.operationType === 'CREATE');
    expect(create).toBeTruthy();
    // The outbox carries server columns only.
    expect(create?.payload).not.toHaveProperty('units');
    expect(create?.payload).not.toHaveProperty('minStock');
    expect(create?.payload.sku).toBe('SKU-2');
  });
});

describe('E. Deletes are explicit, tombstoned, and not resurrected', () => {
  it('tombstones the row, queues a DELETE, and survives a server refresh', async () => {
    const server = new FakeSyncServer({ migrationId: MIGRATION });
    const seeded = seedServer(server);
    installFetch(server);
    await resolveMigrationId();
    await hydrateWorkspace(MIGRATION);
    await SyncManager.flushMigration(MIGRATION);

    const id = stockId(MIGRATION, seeded.sku, 'B-1', 'Main Store');
    const entry: StockEntry = {
      id,
      productSku: seeded.sku,
      batchNumber: 'B-1',
      location: 'Main Store',
      quantities: [{ unit: 'Box', quantity: 3, unitCost: 12 }],
    };

    // Deleting while the service is down must not be undone by the next pull.
    server.online = false;
    await deleteStockEntry(MIGRATION, entry);

    const tombstone = await getLocalEntity('OPENING_STOCK', id);
    expect(isTombstone(tombstone)).toBe(true);
    const hidden = await loadWorkspace(MIGRATION);
    expect(hidden.openingStock).toHaveLength(0);

    const ops = await OperationQueue.getOperationsForEntity(MIGRATION, id);
    expect(ops.map((op) => op.operationType)).toContain('DELETE');

    // A refresh while the delete is still pending must not bring the row back.
    server.online = true;
    await SyncManager.pullChanges(MIGRATION);
    const stillHidden = await loadWorkspace(MIGRATION);
    expect(stillHidden.openingStock).toHaveLength(0);

    // Once the service accepts it, the tombstone is cleaned up for good.
    await SyncManager.flushMigration(MIGRATION);
    expect(server.count('OPENING_STOCK')).toBe(0);
    expect(await getLocalEntity('OPENING_STOCK', id)).toBeUndefined();
    expect((await loadWorkspace(MIGRATION)).openingStock).toHaveLength(0);
  });

  it('deleting a row whose create may still be in flight leaves nothing behind', async () => {
    const server = new FakeSyncServer({ migrationId: MIGRATION });
    installFetch(server);
    await resolveMigrationId();
    await hydrateWorkspace(MIGRATION);

    // The save kicked off a push; the delete happens while the service is down.
    server.online = false;
    const group = groupId(MIGRATION, 'Throwaway');
    await saveGroup(MIGRATION, 'Throwaway');
    expect(await OperationQueue.countPending(MIGRATION)).toBe(1);
    expect((await getLocalEntity('GROUP', group))?.syncState).toBe('CREATED_LOCALLY');

    await deleteEntity(MIGRATION, 'GROUP', group);

    // Hidden from the form, but the intent to remove it is still recorded so an
    // in-flight CREATE cannot survive as a phantom row. The CREATE stays queued
    // because the push had already claimed it; the outbox orders the pair so the
    // delete lands last.
    const tombstone = await getLocalEntity('GROUP', group);
    expect(isTombstone(tombstone)).toBe(true);
    expect((await loadWorkspace(MIGRATION)).productGroups).toHaveLength(0);
    const ops = await OperationQueue.getOperationsForEntity(MIGRATION, group);
    expect(ops.map((op) => op.operationType)).toEqual(['CREATE', 'DELETE']);
    expect(ops.map((op) => op.sequence)).toEqual([...ops.map((op) => op.sequence)].sort((a, b) => a - b));

    // The server applies the pair in order and ends up with nothing.
    server.online = true;
    const summary = await SyncManager.flushMigration(MIGRATION);
    expect(summary.remaining).toBe(0);
    expect(server.count('GROUP')).toBe(0);
    expect(await getLocalEntity('GROUP', group)).toBeUndefined();
  });
});

describe('F. Retries are idempotent', () => {
  it('re-sending the same operationId never duplicates a row', async () => {
    const server = new FakeSyncServer({ migrationId: MIGRATION });
    installFetch(server);
    await resolveMigrationId();
    await hydrateWorkspace(MIGRATION);

    server.online = false;
    await saveProduct(MIGRATION, sampleProduct('SKU-IDEM', 'Idempotent'));
    const before = await OperationQueue.getPendingOperations(MIGRATION);

    server.online = true;
    await SyncManager.syncMigration(MIGRATION);
    expect(server.count('PRODUCT')).toBe(1);

    // The host slept before the response arrived: the same operations go again.
    const first = server.requests.filter((r) => r.method === 'POST').at(-1)!.body.operations;
    server.sync(first);
    server.sync(first);

    expect(server.count('PRODUCT')).toBe(1);
    expect(server.count('PRODUCT_UNIT')).toBe(2);
    expect(before.length).toBeGreaterThan(0);
  });

  it('recovers an operation left claiming by a run that never finished', async () => {
    const server = new FakeSyncServer({ migrationId: MIGRATION });
    installFetch(server);
    await resolveMigrationId();
    await hydrateWorkspace(MIGRATION);

    server.online = false;
    await saveProduct(MIGRATION, sampleProduct('SKU-STUCK', 'Stuck Run'));
    const [op] = await OperationQueue.getPendingOperations(MIGRATION);
    await OperationQueue.markAsSyncing([op.operationId]);

    // A claim older than the timeout belonged to a run that died.
    const stale = Date.now() + 10 * 60_000;
    expect(await OperationQueue.resetStuckOperations(MIGRATION, stale)).toBe(1);
    const pending = await OperationQueue.getPendingOperations(MIGRATION);
    expect(pending.map((o) => o.operationId)).toContain(op.operationId);
  });
});

describe('G. Imports go through the same explicit path', () => {
  it('writes every imported entity and queues parents before children', async () => {
    const server = new FakeSyncServer({ migrationId: MIGRATION });
    installFetch(server);
    await resolveMigrationId();
    await hydrateWorkspace(MIGRATION);
    await SyncManager.flushMigration(MIGRATION);

    const imported: MigrationData = {
      schemaVersion: '1.0',
      productGroups: [{ name: 'Antibiotics' }],
      locations: [{ name: 'Warehouse' }],
      suppliers: [],
      units: [{ name: 'Sachet', symbol: 'sach' }],
      products: [sampleProduct('SKU-IMP', 'Imported Product')],
      batches: [sampleBatch('SKU-IMP', 'B-7')],
      openingStock: [sampleEntry('imp-1', 'SKU-IMP', 'B-7', 'Warehouse')],
    };

    const queued = await importMigrationData(MIGRATION, imported);
    expect(queued).toBeGreaterThan(0);

    const summary = await SyncManager.flushMigration(MIGRATION);
    expect(summary.remaining).toBe(0);
    expect(summary.conflicts).toBe(0);
    expect(server.count('PRODUCT')).toBe(1);
    expect(server.count('BATCH')).toBe(1);
    expect(server.count('OPENING_STOCK')).toBe(1);

    const data = await loadWorkspace(MIGRATION);
    expect(data.products.map((p) => p.sku)).toEqual(['SKU-IMP']);
    expect(data.openingStock[0].location).toBe('Warehouse');
    expect(data.openingStock[0].quantities[0].unit).toBe('Box');
  });

  it('an incomplete stock line stays on the device without an operation', async () => {
    const server = new FakeSyncServer({ migrationId: MIGRATION });
    installFetch(server);
    await resolveMigrationId();
    await hydrateWorkspace(MIGRATION);
    await SyncManager.flushMigration(MIGRATION);

    const entry: StockEntry = { id: 'draft-1', productSku: '', batchNumber: '', location: '', quantities: [] };
    const queued = await saveStockEntry(MIGRATION, entry, undefined, undefined);
    expect(queued).toBe(false);

    const data = await loadWorkspace(MIGRATION);
    expect(data.openingStock.map((e) => e.id)).toContain('draft-1');
    const ops = await OperationQueue.getOperationsForEntity(MIGRATION, 'draft-1');
    expect(ops).toHaveLength(0);
  });
});

describe('H. A server refresh never destroys pending local work', () => {
  it('keeps local CREATE, UPDATE and DELETE rows while merging the rest', async () => {
    const server = new FakeSyncServer({ migrationId: MIGRATION });
    const seeded = seedServer(server);
    installFetch(server);
    await resolveMigrationId();
    await hydrateWorkspace(MIGRATION);
    await SyncManager.flushMigration(MIGRATION);

    server.online = false;
    const data = await loadWorkspace(MIGRATION);

    // Local create, local update, local delete — all still pending.
    const created = sampleProduct('SKU-PENDING', 'Pending Create');
    await saveProduct(MIGRATION, created);
    await saveProduct(MIGRATION, { ...sampleProduct(seeded.sku, 'Locally Renamed') });
    const entry = data.openingStock[0];
    await deleteStockEntry(MIGRATION, entry);

    // The service comes back and the server copy arrives.
    server.online = true;
    const summary = await SyncManager.flushMigration(MIGRATION);
    expect(summary.unreachable).toBe(false);
    expect(summary.remaining).toBe(0);

    const after = await loadWorkspace(MIGRATION);
    expect(after.products.map((p) => p.sku).sort()).toEqual([seeded.sku, 'SKU-PENDING']);
    expect(after.products.find((p) => p.sku === seeded.sku)?.name).toBe('Locally Renamed');
    expect(after.openingStock).toHaveLength(0);
    expect(server.count('OPENING_STOCK')).toBe(0);
  });

  it('reconcileServerState skips pending rows and tombstones', async () => {
    const server = new FakeSyncServer({ migrationId: MIGRATION });
    const seeded = seedServer(server);
    installFetch(server);
    await resolveMigrationId();
    await hydrateWorkspace(MIGRATION);
    await SyncManager.flushMigration(MIGRATION);

    server.online = false;
    await saveProduct(MIGRATION, sampleProduct('SKU-LOCAL', 'Local Only'));
    const entry = (await loadWorkspace(MIGRATION)).openingStock[0];
    await deleteStockEntry(MIGRATION, entry);

    const localOnly = (await getRawRows('products', MIGRATION)).find((r) => r.sku === 'SKU-LOCAL');
    expect(localOnly?.syncState).toBe('CREATED_LOCALLY');

    await reconcileServerState(MIGRATION, server.state());
    expect((await getLocalEntity('PRODUCT', productId(MIGRATION, 'SKU-LOCAL')))?.syncState).toBe('CREATED_LOCALLY');
    expect(isTombstone(await getLocalEntity('OPENING_STOCK', stockId(MIGRATION, seeded.sku, 'B-1', 'Main Store')))).toBe(true);
  });
});
