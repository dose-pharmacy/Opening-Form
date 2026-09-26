/**
 * An in-memory stand-in for the sync service.
 *
 * It reproduces the parts of the real backend the client depends on:
 *  - `GET /migrations/:id/changes?sinceRevision=` returns the current state;
 *  - `POST /migrations/:id/sync` applies explicit operations, keyed by the id the
 *    client sent, and resolves the client's business keys into ids;
 *  - `ProcessedOperation` makes a replayed `operationId` return the stored
 *    result instead of applying the work twice.
 *
 * The point of the suite is the *client* contract (what reaches IndexedDB, what
 * is queued, what survives a refresh), so the fake only has to be faithful, not
 * production code.
 */

export interface FakeServerOptions {
  /** Start the service "down" so every request fails like a closed port. */
  online?: boolean;
  migrationId?: string;
  revision?: number;
}

export interface ServerTable {
  [key: string]: any;
}

const now = () => new Date().toISOString();

export class FakeSyncServer {
  online: boolean;
  migrationId: string;
  revision: number;
  exists: boolean;

  groups: ServerTable = {};
  locations: ServerTable = {};
  units: ServerTable = {};
  products: ServerTable = {};
  productUnits: ServerTable = {};
  batches: ServerTable = {};
  openingStocks: ServerTable = {};

  /** operationId → the result it produced (the ProcessedOperation ledger). */
  processed = new Map<string, any>();

  /** How many migrations this instance has handed out, to keep ids unique. */
  private created = 1;

  /** Every request the client made, for asserting that nothing was pushed early. */
  requests: { method: string; path: string; body?: any }[] = [];

  constructor(options: FakeServerOptions = {}) {
    this.online = options.online ?? true;
    this.migrationId = options.migrationId ?? 'migration-1';
    this.revision = options.revision ?? 1;
    this.exists = this.migrationId.length > 0;
  }

  private table(entityType: string): ServerTable | undefined {
    switch (entityType) {
      case 'GROUP':
        return this.groups;
      case 'LOCATION':
        return this.locations;
      case 'UNIT':
        return this.units;
      case 'PRODUCT':
        return this.products;
      case 'PRODUCT_UNIT':
        return this.productUnits;
      case 'BATCH':
        return this.batches;
      case 'OPENING_STOCK':
        return this.openingStocks;
      default:
        return undefined;
    }
  }

  private findBy(table: ServerTable, key: string, field: string, value: unknown): any {
    const wanted = String(value ?? '').toLowerCase();
    return Object.values(table).find((row: any) => String(row[field] ?? '').toLowerCase() === wanted);
  }

  state() {
    return {
      groups: Object.values(this.groups),
      locations: Object.values(this.locations),
      units: Object.values(this.units),
      products: Object.values(this.products),
      productUnits: Object.values(this.productUnits),
      batches: Object.values(this.batches),
      openingStocks: Object.values(this.openingStocks),
    };
  }

  /** One stored row per column set: the count is what "no duplicates" means. */
  count(entityType: string): number {
    return Object.keys(this.table(entityType) ?? {}).length;
  }

  handle(request: { method: string; path: string; body?: any }): { status: number; body: any } {
    this.requests.push(request);
    if (!this.online) return { status: 0, body: null };

    const path = request.path.split('?')[0];

    if (request.method === 'POST' && path === '/migrations') {
      this.migrationId = `migration-${this.created}`;
      this.created += 1;
      this.revision = 1;
      this.exists = true;
      return { status: 201, body: { id: this.migrationId, name: request.body?.name ?? 'Migration', revision: this.revision } };
    }

    if (request.method === 'GET' && path === '/migrations') {
      return {
        status: 200,
        body: this.exists
          ? [{ id: this.migrationId, name: 'Opening Inventory Migration', revision: this.revision, lastActivityAt: now() }]
          : [],
      };
    }

    if (request.method === 'GET' && /^\/migrations\/[^/]+$/.test(path)) {
      if (!this.exists) return { status: 404, body: { error: 'Migration not found' } };
      return { status: 200, body: { id: this.migrationId, revision: this.revision } };
    }

    if (request.method === 'GET' && /\/changes$/.test(path)) {
      if (!this.exists) return { status: 404, body: { error: 'Migration not found' } };
      const since = Number(new URLSearchParams(request.path.split('?')[1] ?? '').get('sinceRevision')) || 0;
      if (this.revision <= since) {
        return { status: 200, body: { migrationId: this.migrationId, fromRevision: since, toRevision: this.revision, changes: [] } };
      }
      return {
        status: 200,
        body: { migrationId: this.migrationId, fromRevision: since, toRevision: this.revision, state: this.state() },
      };
    }

    if (request.method === 'POST' && /\/sync$/.test(path)) {
      return this.sync(request.body?.operations ?? []);
    }

    return { status: 404, body: { error: 'Not found' } };
  }

  /** Mirrors `processOperation` in Backend/src/routes/sync.ts. */
  sync(operations: any[]): { status: number; body: any } {
    const results: any[] = [];
    let applied = 0;

    for (const op of operations) {
      const { operationId, entityType, entityId, operationType } = op ?? {};
      if (!operationId || !entityType || !entityId || !operationType) {
        results.push({ operationId: operationId ?? 'unknown', status: 'ERROR', error: 'Malformed operation.' });
        continue;
      }

      // Idempotency: a retry returns the original result and applies nothing.
      if (this.processed.has(operationId)) {
        results.push({ ...this.processed.get(operationId), replayed: true });
        continue;
      }

      const table = this.table(entityType);
      if (!table) {
        results.push({ operationId, status: 'ERROR', error: `Unknown entity type "${entityType}".` });
        continue;
      }

      if (operationType === 'DELETE') {
        const row = table[entityId];
        if (row) delete table[entityId];
        const result = { operationId, status: 'SYNCED', entityType, entityId, version: 0, deleted: true };
        this.processed.set(operationId, result);
        results.push(result);
        applied += 1;
        continue;
      }

      const payload = op.payload ?? {};
      const data: any = { id: entityId, migrationId: this.migrationId, version: 1, ...payload };

      // Resolve the client's business keys the way the real route does.
      if (entityType === 'PRODUCT') {
        data.groupId = this.findBy(this.groups, 'id', 'name', payload.productGroup)?.id ?? null;
      }
      if (entityType === 'PRODUCT_UNIT') {
        const product = this.findBy(this.products, 'id', 'sku', payload.productSku);
        const unit = this.findBy(this.units, 'id', 'name', payload.unitName);
        if (!product || !unit) {
          results.push({ operationId, status: 'ERROR', entityType, entityId, error: 'Unknown product or unit.' });
          continue;
        }
        data.productId = product.id;
        data.unitId = unit.id;
      }
      if (entityType === 'BATCH') {
        const product = this.findBy(this.products, 'id', 'sku', payload.productSku);
        if (!product) {
          results.push({ operationId, status: 'ERROR', entityType, entityId, error: 'Unknown product.' });
          continue;
        }
        data.productId = product.id;
      }
      if (entityType === 'OPENING_STOCK') {
        const product = this.findBy(this.products, 'id', 'sku', payload.productSku);
        const batch = this.findBy(this.batches, 'id', 'batchNumber', payload.batchNumber);
        const location = this.findBy(this.locations, 'id', 'name', payload.locationName);
        if (!product || !batch || !location) {
          results.push({ operationId, status: 'ERROR', entityType, entityId, error: 'Unknown reference.' });
          continue;
        }
        data.productId = product.id;
        data.batchId = batch.id;
        data.locationId = location.id;
      }

      const existing = table[entityId];
      if (existing) {
        const unchanged = Object.entries(data).every(([key, value]) => String(existing[key]) === String(value));
        if (unchanged) {
          const result = { operationId, status: 'SYNCED', entityType, entityId, version: existing.version, unchanged: true };
          this.processed.set(operationId, result);
          results.push(result);
          continue;
        }
        if (typeof op.baseVersion === 'number' && op.baseVersion !== existing.version) {
          results.push({
            operationId,
            status: 'CONFLICT',
            entityType,
            entityId,
            currentVersion: existing.version,
            serverData: existing,
            error: 'The record changed on the server.',
          });
          continue;
        }
        const updated = { ...existing, ...data, version: existing.version + 1 };
        table[entityId] = updated;
        const result = { operationId, status: 'SYNCED', entityType, entityId, version: updated.version };
        this.processed.set(operationId, result);
        results.push(result);
        applied += 1;
        continue;
      }

      // Only the columns the real schema keeps.
      const stored: any = { id: entityId, migrationId: this.migrationId, version: 1, createdAt: now(), updatedAt: now() };
      for (const [key, value] of Object.entries(data)) {
        if (['sku', 'name', 'genericName', 'brand', 'description', 'isActive', 'groupId', 'productId', 'unitId',
             'conversionToBase', 'isBaseUnit', 'sellPrice', 'purchasePrice', 'batchNumber', 'expiryDate',
             'manufacturingDate', 'receivedDate', 'supplierReference', 'baseQuantity', 'unitBreakdown',
             'unitCost', 'locationId', 'batchId'].includes(key)) {
          stored[key] = value;
        }
      }
      table[entityId] = stored;
      const result = { operationId, status: 'SYNCED', entityType, entityId, version: 1 };
      this.processed.set(operationId, result);
      results.push(result);
      applied += 1;
    }

    if (applied > 0) {
      this.revision += 1;
      this.exists = true;
    }
    return { status: 200, body: { results, revision: applied > 0 ? this.revision : undefined, successfulOperations: applied } };
  }
}
