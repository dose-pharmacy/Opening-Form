/**
 * In-memory stand-in for the Prisma client.
 *
 * The sync route is the interesting part of the backend: it decides, in memory,
 * what a change means and then performs exactly one write per accepted change.
 * These tests therefore drive the real Express route and only swap the database
 * for this stub, so the idempotency ledger and the create/update/delete decisions
 * are exercised as they ship.
 */

export interface Row {
  [key: string]: any;
}

const matches = (row: Row, where: Row = {}): boolean =>
  Object.entries(where).every(([key, value]) => {
    if (value === undefined) return true;
    if (key === 'product') return row.productId === (value as any)?.migrationId || row.__productMigrationId === (value as any)?.migrationId;
    return row[key] === value;
  });

/**
 * Models that carry a `version` column defaulted by the schema. Without this the
 * stub would return rows with no version and every optimistic-concurrency check
 * would be vacuous.
 */
const VERSIONED = new Set(['productGroup', 'location', 'unit', 'product', 'productUnit', 'batch', 'openingStock']);

export class Table {
  rows: Row[] = [];
  name = '';

  get versioned(): boolean {
    return VERSIONED.has(this.name);
  }

  async findMany(args: any = {}) {
    let result = this.rows.filter((row) => matches(row, args.where));
    if (args.where?.product) {
      // Relation filter: keep only rows whose parent belongs to the migration.
      const parentIds = (this as any).productIdsByMigration ?? new Map();
      result = this.rows.filter((row) => parentIds.get(row.productId) === args.where.product.migrationId);
    }
    return result.map((row) => ({ ...row }));
  }

  async findUnique(args: any) {
    const row = this.rows.find((candidate) => matches(candidate, args.where));
    return row ? { ...row } : null;
  }

  async create(args: any) {
    const row: Row = { id: args.data.id, ...args.data };
    // Schema defaults the stub has to reproduce.
    if (this.versioned && typeof row.version !== 'number') row.version = 1;
    if (!('createdAt' in row)) row.createdAt = new Date();
    row.updatedAt = new Date();
    this.rows.push(row);
    return { ...row };
  }

  async update(args: any) {
    const index = this.rows.findIndex((candidate) => matches(candidate, args.where));
    if (index < 0) throw Object.assign(new Error('Record not found'), { code: 'P2025' });
    this.rows[index] = { ...this.rows[index], ...args.data, updatedAt: new Date() };
    return { ...this.rows[index] };
  }

  async delete(args: any) {
    const index = this.rows.findIndex((candidate) => matches(candidate, args.where));
    if (index < 0) throw Object.assign(new Error('Record not found'), { code: 'P2025' });
    const [row] = this.rows.splice(index, 1);
    return row;
  }
}

export interface StubOptions {
  migrationId?: string;
  /** Omit the migration row, as if the database was reset while offline. */
  withoutMigration?: boolean;
  /** Simulate a database that predates the ProcessedOperation table. */
  withoutLedger?: boolean;
  /** Make writes fail with this Prisma code. */
  writeError?: string;
  /** Fail the ledger write with an error the route must not tolerate. */
  ledgerWriteFails?: boolean;
}

export function createPrismaStub(options: StubOptions = {}) {
  const migrationId = options.migrationId ?? 'migration-1';
  const productIdsByMigration = new Map<string, string>();

  const tables: Record<string, Table> = {};
  for (const name of [
    'migration',
    'productGroup',
    'location',
    'unit',
    'product',
    'productUnit',
    'batch',
    'openingStock',
    'processedOperation',
  ]) {
    const table = new Table();
    table.name = name;
    tables[name] = table;
  }
  (tables.productUnit as any).productIdsByMigration = productIdsByMigration;

  if (!options.withoutMigration) {
    tables.migration.rows.push({ id: migrationId, name: 'Opening Inventory Migration', revision: 1, lastActivityAt: new Date() });
  }

  /** Every write the route performed, for counting assertions. */
  const writes: { table: string; op: string; id: string }[] = [];
  const record = (table: string, op: string, id: string) => {
    writes.push({ table, op, id });
    if (options.writeError) throw Object.assign(new Error('write failed'), { code: options.writeError });
  };

  const guard = <T>(table: string, op: string, id: string, run: () => T): T => {
    record(table, op, id);
    return run();
  };

  /** Run `fn` atomically: if it throws, every table and the write log roll back. */
  const $transaction = async (fn: (tx: any) => Promise<any>) => {
    const snapshot = new Map<string, Row[]>();
    for (const [name, table] of Object.entries(tables)) snapshot.set(name, table.rows.map((row) => ({ ...row })));
    const writeCount = writes.length;
    try {
      return await fn(delegates);
    } catch (error) {
      for (const [name, table] of Object.entries(tables)) table.rows = snapshot.get(name) ?? [];
      writes.length = writeCount;
      throw error;
    }
  };

  const delegates: Record<string, any> = {
    $transaction,
    migration: {
      findUnique: (args: any) => tables.migration.findUnique(args),
      create: (args: any) => guard('migration', 'create', args.data.id, () => tables.migration.create(args)),
      update: (args: any) =>
        guard('migration', 'update', args.where.id, () => {
          const current = tables.migration.rows.find((row) => row.id === args.where.id);
          if (!current) throw Object.assign(new Error('not found'), { code: 'P2025' });
          const data = { ...args.data };
          if (data.revision?.increment !== undefined) {
            data.revision = (current.revision ?? 0) + data.revision.increment;
            delete data.revision.increment;
          }
          return tables.migration.update({ where: args.where, data });
        }),
    },
    processedOperation: {
      findUnique: async (args: any) => {
        if (options.withoutLedger) throw Object.assign(new Error('no table'), { code: 'P2021' });
        return tables.processedOperation.findUnique(args);
      },
      create: async (args: any) => {
        if (options.withoutLedger) throw Object.assign(new Error('no table'), { code: 'P2021' });
        if (options.ledgerWriteFails) throw new Error('ledger unavailable');
        if (tables.processedOperation.rows.some((row) => row.operationId === args.data.operationId)) {
          throw Object.assign(new Error('duplicate'), { code: 'P2002' });
        }
        return tables.processedOperation.create({ data: { ...args.data, id: args.data.operationId } });
      },
    },
  };

  for (const name of ['productGroup', 'location', 'unit', 'product', 'productUnit', 'batch', 'openingStock']) {
    const table = tables[name];
    const delegate: Record<string, any> = {
      findMany: (args: any) => table.findMany(args),
      findUnique: (args: any) => table.findUnique(args),
      create: (args: any) => guard(name, 'create', args.data.id, () => table.create(args)),
      update: (args: any) => guard(name, 'update', args.where.id, () => table.update(args)),
      delete: (args: any) => guard(name, 'delete', args.where.id, () => table.delete(args)),
    };

    // `where: { product: { migrationId } }` is how the route scopes units and
    // stock to a migration, so products have to be indexed by migration for that
    // filter to mean anything.
    if (name === 'product') {
      const remember = async (args: any) => {
        const row = await guard(name, 'create', args.data.id, () => table.create(args));
        productIdsByMigration.set(row.id, row.migrationId);
        return row;
      };
      delegate.create = remember;
      delegate.update = async (args: any) => {
        const row = await guard(name, 'update', args.where.id, () => table.update(args));
        productIdsByMigration.set(row.id, row.migrationId);
        return row;
      };
    }

    delegates[name] = delegate;
  }

  return {
    migrationId,
    productIdsByMigration,
    writes,
    count: (name: string) => tables[name].rows.length,
    rows: (name: string) => tables[name].rows.map((row) => ({ ...row })),
    client: delegates as any,
    _tables: tables,
  };
}
