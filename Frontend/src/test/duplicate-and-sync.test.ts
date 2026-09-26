/**
 * Duplicating rows, and keeping the local cache honest about the server.
 *
 * Three separate promises are checked here:
 *
 *  1. "Duplicate row" produces a *second* row. It used to appear to do nothing,
 *     because a copy of a line has the same product, batch and location as the
 *     original — and that triple was the line's entire identity, on both sides of
 *     the wire. The fix gives each copy its own line key.
 *  2. A record deleted in PostgreSQL disappears from IndexedDB. Otherwise a device
 *     keeps showing rows another device removed.
 *  3. A user-requested full sync really is a full sync, and says so.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetDB } from '../local-store/db';
import { getLocalEntity, getRawRows, loadWorkspace } from '../local-store/entities';
import { OperationQueue } from '../sync/queue';
import { SyncManager } from '../sync/syncManager';
import { hydrateWorkspace, reconcileServerState } from '../sync/hydrate';
import {
  deleteStockEntry,
  duplicateStockEntry,
  nextStockPosition,
  saveBatch,
  saveGroup,
  saveLocation,
  saveProduct,
  saveStockEntry,
  saveUnit,
} from '../sync/workspaceOps';
import { stockId } from '../sync/ids';
import type { StockEntry } from '../utils/types';
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
  await settle();
  await resetDB();
});

/** A workspace the server and IndexedDB both know about. */
const prepared = async () => {
  const server = new FakeSyncServer({ migrationId: MIGRATION });
  installFetch(server);

  await saveGroup(MIGRATION, 'Analgesics');
  await saveLocation(MIGRATION, 'Main Store');
  await saveUnit(MIGRATION, { name: 'Tablet', symbol: 'tab' });
  await saveUnit(MIGRATION, { name: 'Box', symbol: 'box' });
  const product = sampleProduct('SKU-1', 'Paracetamol 500mg');
  await saveProduct(MIGRATION, product);
  await saveBatch(MIGRATION, sampleBatch('SKU-1', 'B-1'));

  await settle();
  return { server, product };
};

const entry = (overrides: Partial<StockEntry> = {}): StockEntry =>
  sampleEntry('local-1', 'SKU-1', 'B-1', 'Main Store', overrides);

/**
 * The row as the UI sees it.
 *
 * `saveStockEntry` files a row under the id derived from product/batch/location/
 * lineKey, while a delete is addressed by the id the UI holds. Reading the row
 * back is what guarantees the test deletes the row it just created.
 */
const firstRow = async (predicate: (row: StockEntry) => boolean = () => true) => {
  const rows = (await loadWorkspace(MIGRATION)).openingStock;
  const row = rows.find(predicate);
  if (!row) throw new Error('no matching stock row');
  return row;
};

/** Push everything that is still queued, so a test starts from a quiet queue. */
const drain = () => SyncManager.syncNow(MIGRATION);

describe('I. Duplicate row', () => {
  it('copies every field but the identity', () => {
    const source = entry({ id: 'a', lineKey: '', position: 1 });
    const copy = duplicateStockEntry(source, [source]);

    expect(copy.id).not.toBe(source.id);
    expect(copy.lineKey).not.toBe('');
    expect(copy.productSku).toBe(source.productSku);
    expect(copy.batchNumber).toBe(source.batchNumber);
    expect(copy.location).toBe(source.location);
    expect(copy.quantities).toEqual(source.quantities);
    // A deep copy, not a shared reference: editing one must not edit the other.
    expect(copy.quantities[0]).not.toBe(source.quantities[0]);
  });

  it('inserts the copy directly below the original', () => {
    const first = entry({ id: 'a', position: 1 });
    const second = entry({ id: 'b', position: 2 });
    const copy = duplicateStockEntry(first, [first, second]);

    expect(copy.position).toBeGreaterThan(first.position!);
    expect(copy.position).toBeLessThan(second.position!);
  });

  it('never reuses a line key, so three copies stay three rows', () => {
    const source = entry({ id: 'a', position: 1 });
    const first = duplicateStockEntry(source, [source]);
    const second = duplicateStockEntry(source, [source, first]);
    const third = duplicateStockEntry(source, [source, first, second]);

    expect(new Set([first.lineKey, second.lineKey, third.lineKey]).size).toBe(3);
  });

  it('appends instead of colliding when the gap below is taken', () => {
    const source = entry({ id: 'a', position: 1 });
    const squatter = entry({ id: 'b', position: 1.5 });
    const copy = duplicateStockEntry(source, [source, squatter]);

    expect(copy.position).toBe(nextStockPosition([source, squatter]));
    expect(copy.position).not.toBe(1.5);
  });

  it('gives the copy a different business id, so it is not an update', () => {
    const source = entry({ id: 'a', lineKey: '' });
    const copy = duplicateStockEntry(source, [source]);

    expect(stockId(MIGRATION, 'SKU-1', 'B-1', 'Main Store', copy.lineKey)).not.toBe(
      stockId(MIGRATION, 'SKU-1', 'B-1', 'Main Store', source.lineKey)
    );
  });

  it('stores the copy as a second row in IndexedDB, leaving the original intact', async () => {
    await prepared();
    const source = entry();
    await saveStockEntry(MIGRATION, source, sampleProduct('SKU-1'), sampleBatch('SKU-1', 'B-1'));
    await settle();

    const copy = duplicateStockEntry(source, [source]);
    await saveStockEntry(MIGRATION, copy, sampleProduct('SKU-1'), sampleBatch('SKU-1', 'B-1'));
    await settle();

    const rows = await getRawRows('openingStock', MIGRATION);
    expect(rows).toHaveLength(2);

    const data = await loadWorkspace(MIGRATION);
    expect(data.openingStock).toHaveLength(2);
    // Same line, twice — which is the whole point of duplicating it.
    expect(data.openingStock.map((e) => e.quantities)).toEqual([
      [{ unit: 'Box', quantity: 3, unitCost: 12 }],
      [{ unit: 'Box', quantity: 3, unitCost: 12 }],
    ]);
    expect(new Set(data.openingStock.map((e) => e.id)).size).toBe(2);
  });

  it('sends the copy to the server as its own record', async () => {
    const { server } = await prepared();
    const product = sampleProduct('SKU-1');

    const source = entry();
    await saveStockEntry(MIGRATION, source, product, sampleBatch('SKU-1', 'B-1'));
    await settle();

    const copy = duplicateStockEntry(source, [source]);
    await saveStockEntry(MIGRATION, copy, product, sampleBatch('SKU-1', 'B-1'));
    await settle();

    expect(server.count('OPENING_STOCK')).toBe(2);
  });

  it('queues the copy while offline and sends it when the connection returns', async () => {
    const { server } = await prepared();
    const product = sampleProduct('SKU-1');

    const source = entry();
    await saveStockEntry(MIGRATION, source, product, sampleBatch('SKU-1', 'B-1'));
    await settle();

    server.online = false;
    const copy = duplicateStockEntry(source, [source]);
    await saveStockEntry(MIGRATION, copy, product, sampleBatch('SKU-1', 'B-1'));
    await settle();

    // Visible on this device straight away, still owed to the server.
    expect((await loadWorkspace(MIGRATION)).openingStock).toHaveLength(2);
    expect(await OperationQueue.countPending(MIGRATION)).toBe(1);
    expect(server.count('OPENING_STOCK')).toBe(1);

    server.online = true;
    const summary = await SyncManager.syncNow(MIGRATION);

    expect(summary.unreachable).toBe(false);
    expect(summary.remaining).toBe(0);
    expect(server.count('OPENING_STOCK')).toBe(2);
  });

  it('keeps both rows after a reload, in order', async () => {
    const { server } = await prepared();
    const product = sampleProduct('SKU-1');
    const batch = sampleBatch('SKU-1', 'B-1');

    const source = entry({ position: 1 });
    await saveStockEntry(MIGRATION, source, product, batch);
    await settle();
    const copy = duplicateStockEntry(source, [source]);
    await saveStockEntry(MIGRATION, copy, product, batch);
    await settle();

    // Reload from scratch: order and distinctness must come from storage.
    await resetDB();
    const rehydrated = await hydrateWorkspace(MIGRATION);
    await settle();

    expect(rehydrated.data.openingStock).toHaveLength(2);
    expect(rehydrated.data.openingStock[0].lineKey).toBe('');
    expect(rehydrated.data.openingStock[1].lineKey).toBe(copy.lineKey);
    expect(server.count('OPENING_STOCK')).toBe(2);
  });
});

describe('J. Stale data: the server is the source of truth', () => {
  it('drops a row deleted in PostgreSQL', async () => {
    const { server } = await prepared();
    const product = sampleProduct('SKU-1');
    const batch = sampleBatch('SKU-1', 'B-1');

    // Two genuinely different lines: same product, batch and location, which is
    // why the line key exists.
    await saveStockEntry(MIGRATION, entry({ lineKey: 'line-a', position: 1 }), product, batch);
    await saveStockEntry(MIGRATION, entry({ lineKey: 'line-b', position: 2 }), product, batch);
    await settle();
    expect((await loadWorkspace(MIGRATION)).openingStock).toHaveLength(2);

    const doomed = await firstRow((row) => row.lineKey === 'line-a');

    // Another device deletes one of them.
    expect(server.removeOnServer('OPENING_STOCK', doomed.id)).toBe(true);

    const summary = await SyncManager.syncNow(MIGRATION);
    expect(summary.unreachable).toBe(false);

    const rows = await getRawRows('openingStock', MIGRATION);
    expect(rows).toHaveLength(1);
    expect((await loadWorkspace(MIGRATION)).openingStock[0].lineKey).toBe('line-b');
  });

  it('overwrites a stale local version with the server copy', async () => {
    const { server } = await prepared();
    const product = sampleProduct('SKU-1');
    await saveStockEntry(MIGRATION, entry({ id: 'a' }), product, sampleBatch('SKU-1', 'B-1'));
    await settle();

    const id = stockId(MIGRATION, 'SKU-1', 'B-1', 'Main Store');
    server.openingStocks[id] = {
      ...server.openingStocks[id],
      unitBreakdown: [{ unitId: `${MIGRATION}:unit:Box`, unitName: 'Box', quantity: 99 }],
      baseQuantity: 990,
      version: 7,
    };
    server.revision += 1;

    await SyncManager.syncNow(MIGRATION);

    const [row] = await loadWorkspace(MIGRATION).then((d) => d.openingStock);
    expect(row.quantities[0].quantity).toBe(99);
    expect((await getLocalEntity('OPENING_STOCK', id))?.version).toBe(7);
  });

  it('inserts a row that only exists on the server', async () => {
    const { server } = await prepared();
    await settle();
    expect((await loadWorkspace(MIGRATION)).openingStock).toHaveLength(0);

    // Another device added a line. The local revision is deliberately left
    // alone: a full sync has to apply the server's state on its own merit, not
    // because the revision happens to have moved.
    seedServer(server);

    await SyncManager.syncNow(MIGRATION);

    expect((await loadWorkspace(MIGRATION)).openingStock).toHaveLength(1);
  });

  it('leaves no duplicates behind after synchronising', async () => {
    const { server } = await prepared();
    const product = sampleProduct('SKU-1');
    const batch = sampleBatch('SKU-1', 'B-1');

    const source = entry({ id: 'a' });
    await saveStockEntry(MIGRATION, source, product, batch);
    await settle();
    await saveStockEntry(MIGRATION, duplicateStockEntry(source, [source]), product, batch);
    await settle();

    await SyncManager.syncNow(MIGRATION);
    // Idempotent: a second full sync must not add anything.
    await SyncManager.syncNow(MIGRATION);

    const rows = await getRawRows('openingStock', MIGRATION);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.id)).size).toBe(2);
  });

  it('never prunes a row this device has not sent yet', async () => {
    const { server } = await prepared();
    server.online = false;

    await saveStockEntry(MIGRATION, entry({ id: 'a' }), sampleProduct('SKU-1'), sampleBatch('SKU-1', 'B-1'));
    await settle();

    // The server has never seen it, so its absence proves nothing.
    await reconcileServerState(MIGRATION, { groups: [], locations: [], units: [], products: [], productUnits: [], batches: [], openingStocks: [] });

    expect((await loadWorkspace(MIGRATION)).openingStock).toHaveLength(1);
  });

  it('never prunes a queued delete before the server confirms it', async () => {
    const { server } = await prepared();
    const product = sampleProduct('SKU-1');
    const batch = sampleBatch('SKU-1', 'B-1');

    await saveStockEntry(MIGRATION, entry({ lineKey: 'line-a' }), product, batch);
    await settle();

    const target = await firstRow();

    server.online = false;
    await deleteStockEntry(MIGRATION, target);
    await settle();

    const state = {
      groups: Object.values(server.groups),
      locations: Object.values(server.locations),
      units: Object.values(server.units),
      products: Object.values(server.products),
      productUnits: Object.values(server.productUnits),
      batches: Object.values(server.batches),
      // The server still has it: the delete has not been delivered.
      openingStocks: Object.values(server.openingStocks),
    };
    await reconcileServerState(MIGRATION, state);

    // Still a tombstone, waiting to be delivered. Had the pull overwritten it,
    // the queued delete would lose its race with the row it removes.
    const tombstone = await getLocalEntity('OPENING_STOCK', target.id);
    expect(tombstone?.syncState).toBe('DELETED_LOCALLY');
  });
});

describe('K. Manual sync', () => {
  it('drains the outbox and reports success', async () => {
    const { server } = await prepared();
    // Start from a quiet queue so the count below is only the new work.
    await drain();
    server.online = false;

    await saveStockEntry(MIGRATION, entry({ lineKey: 'line-a' }), sampleProduct('SKU-1'), sampleBatch('SKU-1', 'B-1'));
    await settle();
    expect(await OperationQueue.countPending(MIGRATION)).toBe(1);

    server.online = true;
    const summary = await SyncManager.syncNow(MIGRATION);

    expect(summary.synced).toBe(1);
    expect(summary.remaining).toBe(0);
    expect(summary.errors).toBe(0);
    expect(summary.unreachable).toBe(false);
  });

  it('reports "offline" without touching the queue when the service is unreachable', async () => {
    await prepared();
    await drain();
    // A different, unreachable service stands in for the real one.
    const server = new FakeSyncServer({ migrationId: MIGRATION });
    installFetch(server);
    server.online = false;

    await saveStockEntry(MIGRATION, entry({ lineKey: 'line-a' }), sampleProduct('SKU-1'), sampleBatch('SKU-1', 'B-1'));
    await settle();
    const before = await OperationQueue.countPending(MIGRATION);
    expect(before).toBe(1);

    const summary = await SyncManager.syncNow(MIGRATION);

    expect(summary.unreachable).toBe(true);
    // The work is still owed to the server, not lost.
    expect(await OperationQueue.countPending(MIGRATION)).toBe(before);
  });

  it('is safe to run twice in a row', async () => {
    const { server } = await prepared();
    await saveStockEntry(MIGRATION, entry({ lineKey: 'line-a' }), sampleProduct('SKU-1'), sampleBatch('SKU-1', 'B-1'));
    await settle();

    const first = await SyncManager.syncNow(MIGRATION);
    const second = await SyncManager.syncNow(MIGRATION);

    expect(first.unreachable).toBe(false);
    expect(second.unreachable).toBe(false);
    expect(second.synced).toBe(0);
    expect(server.count('OPENING_STOCK')).toBe(1);
  });

  it('pushes more than one batch worth of work', async () => {
    const { server } = await prepared();
    const product = sampleProduct('SKU-1');
    const batch = sampleBatch('SKU-1', 'B-1');
    await drain();
    server.online = false;

    // 45 lines is more than two full batches of 20. Each needs its own line key,
    // otherwise they are the same line forty-five times over.
    for (let index = 0; index < 45; index += 1) {
      await saveStockEntry(
        MIGRATION,
        entry({ lineKey: `line-${index}`, position: index + 1 }),
        product,
        batch
      );
    }
    await settle();
    expect(await OperationQueue.countPending(MIGRATION)).toBe(45);
    server.online = true;

    const summary = await SyncManager.syncNow(MIGRATION);

    expect(summary.remaining).toBe(0);
    expect(server.count('OPENING_STOCK')).toBe(45);
  });
});
