/**
 * Duplicated opening-stock lines, end to end on the server.
 *
 * A copy of a line has the same product, batch and location as the original, so
 * that triple used to be the line's whole identity: a "duplicate" matched an
 * existing row and was folded into it. `lineKey` gives each copy its own
 * identity, and `position` puts it back where the user put it.
 *
 * These tests drive the real routes against the in-memory database, because the
 * identity decision is made by the route's own business-key lookup.
 */

import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createPrismaStub, type StubOptions } from './prismaStub';

const MIGRATION = 'migration-1';

/** Build an app with the sync, changes and opening-stock routes mounted. */
const buildApp = async (options: StubOptions = {}) => {
  const stub = createPrismaStub({ migrationId: MIGRATION, ...options });
  vi.resetModules();
  vi.doMock('../db', () => ({ __esModule: true, default: stub.client }));
  // Imported one after another on purpose: parallel dynamic imports can resolve
  // against a partially reset module registry, which binds a route to another
  // test's stub and leaks rows between cases.
  const { default: sync } = await import('../routes/sync');
  const { default: migrations } = await import('../routes/migrations');
  const { default: openingStocks } = await import('../routes/openingStocks');
  const app = express();
  app.use(express.json());
  // Mirrors the mounts in src/routes/index.ts.
  app.use('/api/migrations/:migrationId/sync', sync);
  app.use('/api/migrations', migrations);
  app.use('/api/opening-stocks', openingStocks);
  return { app, stub };
};

const post = (app: express.Express, operations: any[]) =>
  request(app).post(`/api/migrations/${MIGRATION}/sync`).send({ operations });

/** Group, location, unit, product, product unit and batch, which a stock line refers to. */
const prerequisites = () => [
  { operationId: 'op-group', entityType: 'GROUP', entityId: 'group-1', operationType: 'CREATE', payload: { name: 'Analgesics' } },
  { operationId: 'op-location', entityType: 'LOCATION', entityId: 'loc-1', operationType: 'CREATE', payload: { name: 'Main Store' } },
  { operationId: 'op-unit', entityType: 'UNIT', entityId: 'unit-box', operationType: 'CREATE', payload: { name: 'Box', symbol: 'box' } },
  {
    operationId: 'op-product',
    entityType: 'PRODUCT',
    entityId: 'product-1',
    operationType: 'CREATE',
    payload: { sku: 'SKU-1', name: 'Paracetamol 500mg', genericName: 'Paracetamol', brand: 'Acme', groupId: 'group-1', description: '', minStock: 0, reorderPoint: 0, isNarcotic: false },
  },
  {
    operationId: 'op-product-unit',
    entityType: 'PRODUCT_UNIT',
    entityId: 'product-1:unit-box',
    operationType: 'CREATE',
    payload: { productId: 'product-1', unitId: 'unit-box', conversionToBase: 10, isBaseUnit: false },
  },
  { operationId: 'op-batch', entityType: 'BATCH', entityId: 'batch-1', operationType: 'CREATE', payload: { productSku: 'SKU-1', batchNumber: 'B-1', expiryDate: '2027-01-31' } },
];

/** A stock line. `lineKey` is what tells two otherwise identical lines apart. */
const stockOp = (overrides: Partial<any> = {}) => ({
  operationId: 'op-stock-1',
  entityType: 'OPENING_STOCK',
  entityId: 'stock-1',
  operationType: 'CREATE',
  payload: {
    productSku: 'SKU-1',
    batchNumber: 'B-1',
    locationName: 'Main Store',
    lineKey: '',
    position: 1,
    unitBreakdown: [{ unitName: 'Box', quantity: 3 }],
    unitCost: 12,
  },
  ...overrides,
});

/** A ready-to-use migration with one product, batch and location in place. */
const prepared = async () => {
  const built = await buildApp();
  const res = await post(built.app, prerequisites());
  expect(res.body.results.every((r: any) => r.status === 'SYNCED')).toBe(true);
  return built;
};

beforeEach(() => {
  vi.resetModules();
  vi.doUnmock('../db');
});

describe('duplicated opening-stock lines', () => {
  it('keeps two identical lines apart when they carry different line keys', async () => {
    const { app, stub } = await prepared();

    const res = await post(app, [
      stockOp(),
      stockOp({ operationId: 'op-stock-2', entityId: 'stock-2', payload: { ...stockOp().payload, lineKey: '~d1', position: 2 } }),
    ]);

    expect(res.body.results.every((r: any) => r.status === 'SYNCED')).toBe(true);
    // Same product, batch and location; still two lines.
    expect(stub.count('openingStock')).toBe(2);
    expect(stub.rows('openingStock').map((row) => row.lineKey)).toEqual(['', '~d1']);
  });

  it('treats a repeated line key as the same line rather than a second copy', async () => {
    const { app, stub } = await prepared();

    await post(app, [stockOp()]);
    const res = await post(app, [
      stockOp({ operationId: 'op-stock-again', entityId: 'stock-1' }),
    ]);

    expect(res.body.results[0].status).toBe('SYNCED');
    expect(stub.count('openingStock')).toBe(1);
  });

  it('keeps the position of each line', async () => {
    const { app, stub } = await prepared();

    await post(app, [
      stockOp({ payload: { ...stockOp().payload, lineKey: 'a', position: 1 } }),
      stockOp({ operationId: 'op-stock-2', entityId: 'stock-2', payload: { ...stockOp().payload, lineKey: 'b', position: 2.5 } }),
    ]);

    expect(stub.rows('openingStock').map((row) => row.position)).toEqual([1, 2.5]);
  });

  it('defaults an absent line key and position instead of rejecting the write', async () => {
    const { app, stub } = await prepared();
    const { lineKey, position, ...payload } = stockOp().payload;

    const res = await post(app, [stockOp({ payload })]);

    expect(res.body.results[0].status).toBe('SYNCED');
    expect(stub.rows('openingStock')[0]).toMatchObject({ lineKey: '', position: 0 });
  });

  it('updates one duplicated line without touching its twin', async () => {
    const { app, stub } = await prepared();
    await post(app, [
      stockOp(),
      stockOp({ operationId: 'op-stock-2', entityId: 'stock-2', payload: { ...stockOp().payload, lineKey: '~d1', position: 2 } }),
    ]);

    await post(app, [
      stockOp({
        operationId: 'op-stock-2-edit',
        entityId: 'stock-2',
        operationType: 'UPDATE',
        baseVersion: 1,
        payload: { ...stockOp().payload, lineKey: '~d1', position: 2, unitCost: 99 },
      }),
    ]);

    const byId = new Map(stub.rows('openingStock').map((row) => [row.id, row]));
    expect(byId.get('stock-1')?.unitCost).toBe(12);
    expect(byId.get('stock-2')?.unitCost).toBe(99);
  });

  it('deletes one duplicated line and leaves the other', async () => {
    const { app, stub } = await prepared();
    await post(app, [
      stockOp(),
      stockOp({ operationId: 'op-stock-2', entityId: 'stock-2', payload: { ...stockOp().payload, lineKey: '~d1', position: 2 } }),
    ]);

    const res = await post(app, [
      stockOp({ operationId: 'op-stock-2-del', entityId: 'stock-2', operationType: 'DELETE', payload: {} }),
    ]);

    expect(res.body.results[0]).toMatchObject({ status: 'SYNCED', deleted: true });
    expect(stub.count('openingStock')).toBe(1);
    expect(stub.rows('openingStock')[0].id).toBe('stock-1');
  });

  it('replays the copy without creating a third line', async () => {
    const { app, stub } = await prepared();
    const operations = [
      stockOp(),
      stockOp({ operationId: 'op-stock-2', entityId: 'stock-2', payload: { ...stockOp().payload, lineKey: '~d1', position: 2 } }),
    ];

    await post(app, operations);
    const replay = await post(app, operations);

    expect(replay.body.results.every((r: any) => r.replayed)).toBe(true);
    expect(stub.count('openingStock')).toBe(2);
  });
});

describe('GET /migrations/:id/changes', () => {
  it('reports itself as the complete state when asked for everything', async () => {
    const { app } = await prepared();
    await post(app, [stockOp()]);

    const res = await request(app).get(`/api/migrations/${MIGRATION}/changes?sinceRevision=0`);

    expect(res.status).toBe(200);
    expect(res.body.fullState).toBe(true);
    expect(res.body.state.openingStocks).toHaveLength(1);
  });

  it('says it is not a complete state when the client is already current', async () => {
    const { app } = await prepared();
    await post(app, [stockOp()]);

    const current = await request(app).get(`/api/migrations/${MIGRATION}/changes?sinceRevision=0`);
    const res = await request(app).get(
      `/api/migrations/${MIGRATION}/changes?sinceRevision=${current.body.toRevision}`
    );

    // Empty lists, but explicitly *not* authoritative: the client must not read
    // this as "your records were deleted".
    expect(res.body.fullState).toBe(false);
    expect(res.body.state.openingStocks).toEqual([]);
  });

  it('carries the line keys and positions of duplicated lines', async () => {
    const { app } = await prepared();
    await post(app, [
      stockOp(),
      stockOp({ operationId: 'op-stock-2', entityId: 'stock-2', payload: { ...stockOp().payload, lineKey: '~d1', position: 2 } }),
    ]);

    const res = await request(app).get(`/api/migrations/${MIGRATION}/changes?sinceRevision=0`);

    expect(res.body.state.openingStocks.map((row: any) => [row.lineKey, row.position])).toEqual([
      ['', 1],
      ['~d1', 2],
    ]);
  });
});

describe('GET /migrations/:id/export', () => {
  it('exports line keys and positions so a re-import stays two rows', async () => {
    const { app } = await prepared();
    await post(app, [
      stockOp(),
      stockOp({ operationId: 'op-stock-2', entityId: 'stock-2', payload: { ...stockOp().payload, lineKey: '~d1', position: 2 } }),
    ]);

    const res = await request(app).get(`/api/migrations/${MIGRATION}/export`);

    expect(res.status).toBe(200);
    expect(res.body.openingStock.map((row: any) => [row.lineKey, row.position])).toEqual([
      ['', 1],
      ['~d1', 2],
    ]);
  });
});

describe('GET /opening-stocks', () => {
  it('lists lines in the order the user arranged them', async () => {
    const { app } = await prepared();
    await post(app, [
      stockOp({ payload: { ...stockOp().payload, lineKey: 'a', position: 1 } }),
      stockOp({ operationId: 'op-stock-2', entityId: 'stock-2', payload: { ...stockOp().payload, lineKey: 'b', position: 2.5 } }),
    ]);

    const res = await request(app).get('/api/opening-stocks').query({ migrationId: MIGRATION });

    expect(res.status).toBe(200);
    const rows = Array.isArray(res.body) ? res.body : res.body.data ?? res.body.openingStocks ?? [];
    expect(rows.map((row: any) => row.position)).toEqual([1, 2.5]);
  });
});
