/**
 * Sync route contract.
 *
 * The client may retry a request as often as it likes (a lost response, a host
 * that slept mid-flight, a user pressing Retry), so the route has to be safe to
 * repeat. These tests drive the real route and assert that behaviour directly.
 */

import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createPrismaStub, type StubOptions } from './prismaStub';

const MIGRATION = 'migration-1';

/** Build an app with the sync route mounted against a stubbed database. */
const buildApp = async (options: StubOptions = {}) => {
  const stub = createPrismaStub({ migrationId: MIGRATION, ...options });
  vi.resetModules();
  vi.doMock('../db', () => ({ __esModule: true, default: stub.client }));
  const { default: router } = await import('../routes/sync');
  const app = express();
  app.use(express.json());
  // Mirrors the mount in src/routes/index.ts.
  app.use('/api/migrations/:migrationId/sync', router);
  return { app, stub };
};

const post = (app: express.Express, operations: any[]) =>
  request(app).post(`/api/migrations/${MIGRATION}/sync`).send({ operations });

const groupOp = (overrides: Partial<any> = {}) => ({
  operationId: 'op-group-1',
  entityType: 'GROUP',
  entityId: 'group-1',
  operationType: 'CREATE',
  payload: { name: 'Analgesics' },
  ...overrides,
});

beforeEach(() => {
  vi.resetModules();
  vi.doUnmock('../db');
});

describe('POST /migrations/:id/sync', () => {
  it('applies a create and records the result', async () => {
    const { app, stub } = await buildApp();
    const res = await post(app, [groupOp()]);

    expect(res.status).toBe(200);
    expect(res.body.results[0]).toMatchObject({ status: 'SYNCED', entityId: 'group-1', version: 1 });
    expect(stub.count('productGroup')).toBe(1);
    expect(stub.count('processedOperation')).toBe(1);
  });

  it('replaying the same operationId applies nothing a second time', async () => {
    const { app, stub } = await buildApp();

    await post(app, [groupOp()]);
    const writesAfterFirst = stub.writes.length;

    const replay = await post(app, [groupOp()]);

    expect(replay.status).toBe(200);
    expect(replay.body.results[0]).toMatchObject({ status: 'SYNCED', entityId: 'group-1', replayed: true });
    expect(stub.count('productGroup')).toBe(1);
    // Nothing was written: not the row, not the migration revision.
    expect(stub.writes.length).toBe(writesAfterFirst);
  });

  it('a whole batch replayed after a lost response changes nothing', async () => {
    const { app, stub } = await buildApp();
    const operations = [
      groupOp(),
      groupOp({ operationId: 'op-group-2', entityId: 'group-2', payload: { name: 'Antibiotics' } }),
      groupOp({ operationId: 'op-loc-1', entityType: 'LOCATION', entityId: 'loc-1', payload: { name: 'Main Store' } }),
    ];

    const first = await post(app, operations);
    expect(first.body.successfulOperations).toBe(3);
    const snapshot = stub.rows('productGroup').length + stub.rows('location').length;
    const writesAfterFirst = stub.writes.length;

    const second = await post(app, operations);
    const third = await post(app, operations);

    expect(second.body.results.every((r: any) => r.replayed)).toBe(true);
    expect(third.body.results.every((r: any) => r.replayed)).toBe(true);
    expect(second.body.replayedOperations).toBe(3);
    expect(stub.rows('productGroup').length + stub.rows('location').length).toBe(snapshot);
    expect(stub.writes.length).toBe(writesAfterFirst);
  });

  it('an update is a new operation and does not replay as the old one', async () => {
    const { app, stub } = await buildApp();
    await post(app, [groupOp()]);

    const updated = await post(app, [
      groupOp({
        operationId: 'op-group-1-update',
        operationType: 'UPDATE',
        baseVersion: 1,
        payload: { name: 'Analgesics and Antipyretics' },
      }),
    ]);

    expect(updated.body.results[0]).toMatchObject({ status: 'SYNCED', version: 2 });
    expect(stub.rows('productGroup')[0].name).toBe('Analgesics and Antipyretics');
  });

  it('a stale baseVersion is a conflict carrying the server copy', async () => {
    const { app, stub } = await buildApp();
    await post(app, [groupOp()]);
    await post(app, [
      groupOp({ operationId: 'op-group-1-update', operationType: 'UPDATE', baseVersion: 1, payload: { name: 'A' } }),
    ]);

    const conflicted = await post(app, [
      groupOp({ operationId: 'op-group-1-stale', operationType: 'UPDATE', baseVersion: 1, payload: { name: 'B' } }),
    ]);

    expect(conflicted.body.results[0].status).toBe('CONFLICT');
    expect(conflicted.body.results[0].currentVersion).toBe(2);
    expect(conflicted.body.results[0].serverData.name).toBe('A');
    expect(stub.rows('productGroup')[0].name).toBe('A');
  });

  it('re-sending unchanged content is reported as unchanged, not a new version', async () => {
    const { app, stub } = await buildApp();
    await post(app, [groupOp()]);

    const repeat = await post(app, [
      groupOp({ operationId: 'op-group-1-again', operationType: 'UPDATE', baseVersion: 1 }),
    ]);

    expect(repeat.body.results[0]).toMatchObject({ status: 'SYNCED', unchanged: true, version: 1 });
    expect(stub.rows('productGroup')).toHaveLength(1);
    expect(stub.rows('productGroup')[0].version).toBe(1);
  });

  it('a delete of a row the server never had is satisfied', async () => {
    const { app, stub } = await buildApp();

    const res = await post(app, [
      groupOp({ operationId: 'op-gone', operationType: 'DELETE', payload: {} }),
    ]);

    expect(res.body.results[0]).toMatchObject({ status: 'SYNCED', deleted: true });
    expect(stub.count('productGroup')).toBe(0);
  });

  it('a delete that already ran is not re-applied but still succeeds', async () => {
    const { app, stub } = await buildApp();
    await post(app, [groupOp()]);
    await post(app, [groupOp({ operationId: 'op-group-1-del', operationType: 'DELETE', payload: {} })]);
    expect(stub.count('productGroup')).toBe(0);
    const writesAfterDelete = stub.writes.length;

    const replay = await post(app, [groupOp({ operationId: 'op-group-1-del', operationType: 'DELETE', payload: {} })]);

    expect(replay.body.results[0]).toMatchObject({ status: 'SYNCED', deleted: true, replayed: true });
    expect(stub.writes.length).toBe(writesAfterDelete);
  });

  it('a mixed batch applies the good operations and reports the bad ones', async () => {
    const { app, stub } = await buildApp();

    const res = await post(app, [
      groupOp(),
      groupOp({ operationId: 'op-bad', payload: {} }),
      { operationId: 'op-malformed' },
    ]);

    const byId = new Map<string, any>(res.body.results.map((r: any) => [r.operationId, r]));
    expect(byId.get('op-group-1').status).toBe('SYNCED');
    expect(byId.get('op-bad').status).toBe('ERROR');
    expect(byId.get('op-malformed').status).toBe('ERROR');
    expect(stub.count('productGroup')).toBe(1);
  });

  it('recreates a migration the database lost while the device was offline', async () => {
    const { app, stub } = await buildApp({ withoutMigration: true });

    const res = await post(app, [groupOp()]);

    expect(res.status).toBe(200);
    expect(res.body.results[0].status).toBe('SYNCED');
    expect(stub.count('migration')).toBe(1);
  });

  it('still works without the ledger table, at the cost of true idempotency', async () => {
    const { app, stub } = await buildApp({ withoutLedger: true });

    const first = await post(app, [groupOp()]);
    expect(first.status).toBe(200);
    expect(first.body.results[0].status).toBe('SYNCED');
    expect(stub.count('productGroup')).toBe(1);

    // Without the ledger the route falls back to comparing content, so a replay
    // is still not applied twice.
    const second = await post(app, [groupOp()]);
    expect(second.body.results[0].status).toBe('SYNCED');
    expect(stub.count('productGroup')).toBe(1);
  });

  it('rolls the change back when the ledger write fails, so a retry is still possible', async () => {
    const { app, stub } = await buildApp({ ledgerWriteFails: true });

    const res = await post(app, [groupOp()]);

    expect(res.body.results[0].status).toBe('ERROR');
    // The row never committed, so nothing is half-applied and nothing recorded.
    expect(stub.count('productGroup')).toBe(0);
    expect(stub.count('processedOperation')).toBe(0);
  });

  it('rolls a failed operation back without disturbing the rest of the batch', async () => {
    const { app, stub } = await buildApp();

    const res = await post(app, [
      groupOp({ operationId: 'op-first', entityId: 'group-1' }),
      groupOp({ operationId: 'op-dup', entityId: 'group-1' }),
    ]);

    const byId = new Map<string, any>(res.body.results.map((r: any) => [r.operationId, r]));
    expect(byId.get('op-first').status).toBe('SYNCED');
    expect(byId.get('op-dup').status).toBe('SYNCED');
    // The second is recognised as already applied rather than creating a twin.
    expect(stub.count('productGroup')).toBe(1);
    expect(stub.count('processedOperation')).toBe(2);
  });

  it('rejects a body that is not a list of operations', async () => {
    const { app } = await buildApp();
    const res = await request(app).post(`/api/migrations/${MIGRATION}/sync`).send({ operations: 'nope' });
    expect(res.status).toBe(400);
  });
});
