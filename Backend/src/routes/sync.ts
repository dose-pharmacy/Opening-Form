import { Router } from 'express';
import prisma from '../db';

const router = Router({ mergeParams: true });

/**
 * Sync endpoint.
 *
 * Design notes (the database may be remote, so round trips are the scarce
 * resource here):
 *  - the whole migration is loaded once per request into an in-memory catalogue;
 *  - every change is then resolved and version-checked in memory;
 *  - each accepted change costs exactly one write;
 *  - operations are UPSERTs keyed by business identifier, so re-sending a draft
 *    never produces a bogus conflict.
 */

type EntityType =
  | 'PRODUCT'
  | 'GROUP'
  | 'LOCATION'
  | 'UNIT'
  | 'PRODUCT_UNIT'
  | 'BATCH'
  | 'OPENING_STOCK';

class OperationError extends Error {}

const text = (value: unknown, field: string): string => {
  const result = typeof value === 'string' ? value.trim() : '';
  if (!result) throw new OperationError(`"${field}" is required.`);
  return result;
};

const optionalText = (value: unknown): string | null => {
  const result = typeof value === 'string' ? value.trim() : '';
  return result ? result : null;
};

const optionalDate = (value: unknown, field: string): Date | null => {
  if (value === null || value === undefined || value === '') return null;
  const date = new Date(value as string);
  if (Number.isNaN(date.getTime())) throw new OperationError(`"${field}" is not a valid date.`);
  return date;
};

const requiredDate = (value: unknown, field: string): Date => {
  const date = optionalDate(value, field);
  if (!date) throw new OperationError(`"${field}" is required.`);
  return date;
};

const numberOr = (value: unknown, fallback: number): number => {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

type AnyRow = Record<string, any>;

interface Catalogue {
  migrationId: string;
  groups: Map<string, AnyRow>;
  groupsByName: Map<string, AnyRow>;
  locations: Map<string, AnyRow>;
  locationsByName: Map<string, AnyRow>;
  units: Map<string, AnyRow>;
  unitsByName: Map<string, AnyRow>;
  products: Map<string, AnyRow>;
  productsBySku: Map<string, AnyRow>;
  productUnits: Map<string, AnyRow>;
  productUnitsByKey: Map<string, AnyRow>;
  batches: Map<string, AnyRow>;
  batchesByKey: Map<string, AnyRow>;
  openingStocks: Map<string, AnyRow>;
  openingStocksByKey: Map<string, AnyRow>;
}

const productUnitKey = (productId: string, unitId: string) => `${productId}::${unitId}`;
const batchKey = (productId: string, batchNumber: string) => `${productId}::${batchNumber}`;
const stockKey = (batchId: string, locationId: string) => `${batchId}::${locationId}`;

type StoreKey =
  | 'groups'
  | 'locations'
  | 'units'
  | 'products'
  | 'productUnits'
  | 'batches'
  | 'openingStocks';

/** Which tables each entity needs before it can be resolved. */
const REQUIRED_STORES: Record<EntityType, StoreKey[]> = {
  UNIT: ['units'],
  GROUP: ['groups'],
  LOCATION: ['locations'],
  PRODUCT: ['products', 'groups'],
  PRODUCT_UNIT: ['products', 'units', 'productUnits'],
  BATCH: ['products', 'batches'],
  OPENING_STOCK: ['products', 'locations', 'units', 'productUnits', 'batches', 'openingStocks'],
};

const loadRows = (key: StoreKey, migrationId: string): Promise<AnyRow[]> => {
  switch (key) {
    case 'groups':
      return prisma.productGroup.findMany({ where: { migrationId } });
    case 'locations':
      return prisma.location.findMany({ where: { migrationId } });
    case 'units':
      return prisma.unit.findMany({ where: { migrationId } });
    case 'products':
      return prisma.product.findMany({ where: { migrationId } });
    case 'productUnits':
      return prisma.productUnit.findMany({ where: { product: { migrationId } } });
    case 'batches':
      return prisma.batch.findMany({ where: { migrationId } });
    default:
      return prisma.openingStock.findMany({ where: { migrationId } });
  }
};

/**
 * Load the tables this batch actually needs — on a remote database every
 * avoided query is worth several hundred milliseconds.
 */
async function loadCatalogue(migrationId: string, needed: Set<StoreKey>): Promise<Catalogue> {
  const keys = [...needed];
  const loaded = await Promise.all(keys.map((key) => loadRows(key, migrationId)));

  const byKey = new Map<StoreKey, AnyRow[]>();
  keys.forEach((key, index) => byKey.set(key, loaded[index]));

  const groups = byKey.get('groups') ?? [];
  const locations = byKey.get('locations') ?? [];
  const units = byKey.get('units') ?? [];
  const products = byKey.get('products') ?? [];
  const productUnits = byKey.get('productUnits') ?? [];
  const batches = byKey.get('batches') ?? [];
  const openingStocks = byKey.get('openingStocks') ?? [];

  const catalogue: Catalogue = {
    migrationId,
    groups: new Map(),
    groupsByName: new Map(),
    locations: new Map(),
    locationsByName: new Map(),
    units: new Map(),
    unitsByName: new Map(),
    products: new Map(),
    productsBySku: new Map(),
    productUnits: new Map(),
    productUnitsByKey: new Map(),
    batches: new Map(),
    batchesByKey: new Map(),
    openingStocks: new Map(),
    openingStocksByKey: new Map(),
  };

  groups.forEach((row) => {
    catalogue.groups.set(row.id, row);
    catalogue.groupsByName.set(row.name.toLowerCase(), row);
  });
  locations.forEach((row) => {
    catalogue.locations.set(row.id, row);
    catalogue.locationsByName.set(row.name.toLowerCase(), row);
  });
  units.forEach((row) => {
    catalogue.units.set(row.id, row);
    catalogue.unitsByName.set(row.name.toLowerCase(), row);
  });
  products.forEach((row) => {
    catalogue.products.set(row.id, row);
    catalogue.productsBySku.set(row.sku.toLowerCase(), row);
  });
  productUnits.forEach((row) => {
    catalogue.productUnits.set(row.id, row);
    catalogue.productUnitsByKey.set(productUnitKey(row.productId, row.unitId), row);
  });
  batches.forEach((row) => {
    catalogue.batches.set(row.id, row);
    catalogue.batchesByKey.set(batchKey(row.productId, row.batchNumber), row);
  });
  openingStocks.forEach((row) => {
    catalogue.openingStocks.set(row.id, row);
    catalogue.openingStocksByKey.set(stockKey(row.batchId, row.locationId), row);
  });

  return catalogue;
}

const indexRow = (catalogue: Catalogue, store: string, row: AnyRow) => {
  switch (store) {
    case 'productGroup':
      catalogue.groups.set(row.id, row);
      catalogue.groupsByName.set(row.name.toLowerCase(), row);
      break;
    case 'location':
      catalogue.locations.set(row.id, row);
      catalogue.locationsByName.set(row.name.toLowerCase(), row);
      break;
    case 'unit':
      catalogue.units.set(row.id, row);
      catalogue.unitsByName.set(row.name.toLowerCase(), row);
      break;
    case 'product':
      catalogue.products.set(row.id, row);
      catalogue.productsBySku.set(row.sku.toLowerCase(), row);
      break;
    case 'productUnit':
      catalogue.productUnits.set(row.id, row);
      catalogue.productUnitsByKey.set(productUnitKey(row.productId, row.unitId), row);
      break;
    case 'batch':
      catalogue.batches.set(row.id, row);
      catalogue.batchesByKey.set(batchKey(row.productId, row.batchNumber), row);
      break;
    case 'openingStock':
      catalogue.openingStocks.set(row.id, row);
      catalogue.openingStocksByKey.set(stockKey(row.batchId, row.locationId), row);
      break;
    default:
      break;
  }
};

const unindexRow = (catalogue: Catalogue, store: string, row: AnyRow) => {
  switch (store) {
    case 'productGroup':
      catalogue.groups.delete(row.id);
      if (catalogue.groupsByName.get(row.name.toLowerCase())?.id === row.id) {
        catalogue.groupsByName.delete(row.name.toLowerCase());
      }
      break;
    case 'location':
      catalogue.locations.delete(row.id);
      if (catalogue.locationsByName.get(row.name.toLowerCase())?.id === row.id) {
        catalogue.locationsByName.delete(row.name.toLowerCase());
      }
      break;
    case 'unit':
      catalogue.units.delete(row.id);
      if (catalogue.unitsByName.get(row.name.toLowerCase())?.id === row.id) {
        catalogue.unitsByName.delete(row.name.toLowerCase());
      }
      break;
    case 'product':
      catalogue.products.delete(row.id);
      if (catalogue.productsBySku.get(row.sku.toLowerCase())?.id === row.id) {
        catalogue.productsBySku.delete(row.sku.toLowerCase());
      }
      break;
    case 'productUnit':
      catalogue.productUnits.delete(row.id);
      catalogue.productUnitsByKey.delete(productUnitKey(row.productId, row.unitId));
      break;
    case 'batch':
      catalogue.batches.delete(row.id);
      catalogue.batchesByKey.delete(batchKey(row.productId, row.batchNumber));
      break;
    case 'openingStock':
      catalogue.openingStocks.delete(row.id);
      catalogue.openingStocksByKey.delete(stockKey(row.batchId, row.locationId));
      break;
    default:
      break;
  }
};

interface EntityDefinition {
  /** Prisma delegate name. */
  store: string;
  /** Whether the table carries its own migrationId column. */
  migrationScoped: boolean;
  /** Which payload keys may be written (everything else is ignored). */
  fields: (payload: AnyRow) => AnyRow;
  /** Resolve foreign keys in memory; the client may only know business keys. */
  resolve?: (catalogue: Catalogue, data: AnyRow, payload: AnyRow) => void;
  /** Existing row addressed by our id. */
  byId?: (catalogue: Catalogue, id: string) => AnyRow | undefined;
  /** Existing row addressed by its business key (legacy rows live under other ids). */
  byKey?: (catalogue: Catalogue, data: AnyRow) => AnyRow | undefined;
}

const ENTITIES: Record<EntityType, EntityDefinition> = {
  GROUP: {
    store: 'productGroup',
    migrationScoped: true,
    fields: (payload) => ({ name: text(payload.name, 'name') }),
    byId: (c, id) => c.groups.get(id),
    byKey: (c, data) => c.groupsByName.get(String(data.name).toLowerCase()),
  },

  LOCATION: {
    store: 'location',
    migrationScoped: true,
    fields: (payload) => ({
      name: text(payload.name, 'name'),
      description: optionalText(payload.description),
    }),
    byId: (c, id) => c.locations.get(id),
    byKey: (c, data) => c.locationsByName.get(String(data.name).toLowerCase()),
  },

  UNIT: {
    store: 'unit',
    migrationScoped: true,
    fields: (payload) => ({
      name: text(payload.name, 'name'),
      symbol: optionalText(payload.symbol),
      description: optionalText(payload.description),
    }),
    byId: (c, id) => c.units.get(id),
    byKey: (c, data) => c.unitsByName.get(String(data.name).toLowerCase()),
  },

  PRODUCT: {
    store: 'product',
    migrationScoped: true,
    fields: (payload) => ({
      sku: text(payload.sku, 'sku'),
      name: text(payload.name, 'name'),
      genericName: optionalText(payload.genericName),
      brand: optionalText(payload.brand),
      description: optionalText(payload.description),
      isActive: payload.isActive === undefined ? true : Boolean(payload.isActive),
      groupId: null,
    }),
    resolve: (catalogue, data, payload) => {
      const groupName = optionalText(payload.productGroup ?? payload.groupName);
      const groupId = optionalText(payload.groupId);
      if (!groupName && !groupId) return;
      const group =
        (groupId && catalogue.groups.get(groupId)) ||
        (groupName && catalogue.groupsByName.get(groupName.toLowerCase()));
      data.groupId = group?.id ?? null;
    },
    byId: (c, id) => c.products.get(id),
    byKey: (c, data) => c.productsBySku.get(String(data.sku).toLowerCase()),
  },

  PRODUCT_UNIT: {
    store: 'productUnit',
    migrationScoped: false,
    fields: (payload) => ({
      conversionToBase: numberOr(payload.conversionToBase, 1),
      isBaseUnit: Boolean(payload.isBaseUnit),
      sellPrice:
        payload.sellPrice === null || payload.sellPrice === undefined
          ? null
          : numberOr(payload.sellPrice, 0),
      purchasePrice: numberOr(payload.purchasePrice, 0),
      productId: '',
      unitId: '',
    }),
    resolve: (catalogue, data, payload) => {
      const product =
        (payload.productId && catalogue.products.get(payload.productId)) ||
        (optionalText(payload.productSku) &&
          catalogue.productsBySku.get(String(payload.productSku).toLowerCase()));
      if (!product) {
        throw new OperationError(`Unknown product "${payload.productSku ?? payload.productId}".`);
      }
      const unit =
        (payload.unitId && catalogue.units.get(payload.unitId)) ||
        (optionalText(payload.unitName) &&
          catalogue.unitsByName.get(String(payload.unitName).toLowerCase()));
      if (!unit) {
        throw new OperationError(`Unknown unit "${payload.unitName ?? payload.unitId}".`);
      }
      data.productId = product.id;
      data.unitId = unit.id;
    },
    byId: (c, id) => c.productUnits.get(id),
    byKey: (c, data) => c.productUnitsByKey.get(productUnitKey(data.productId, data.unitId)),
  },

  BATCH: {
    store: 'batch',
    migrationScoped: true,
    fields: (payload) => ({
      batchNumber: text(payload.batchNumber, 'batchNumber'),
      expiryDate: requiredDate(payload.expiryDate, 'expiryDate'),
      manufacturingDate: optionalDate(payload.manufacturingDate, 'manufacturingDate'),
      receivedDate: optionalDate(payload.receivedDate, 'receivedDate'),
      supplierReference: optionalText(payload.supplierReference),
      productId: '',
    }),
    resolve: (catalogue, data, payload) => {
      const product =
        (payload.productId && catalogue.products.get(payload.productId)) ||
        (optionalText(payload.productSku) &&
          catalogue.productsBySku.get(String(payload.productSku).toLowerCase()));
      if (!product) {
        throw new OperationError(`Unknown product "${payload.productSku ?? payload.productId}".`);
      }
      data.productId = product.id;
    },
    byId: (c, id) => c.batches.get(id),
    byKey: (c, data) => c.batchesByKey.get(batchKey(data.productId, data.batchNumber)),
  },

  OPENING_STOCK: {
    store: 'openingStock',
    migrationScoped: true,
    fields: (payload) => ({
      unitCost: numberOr(payload.unitCost, 0),
      unitBreakdown: [],
      baseQuantity: 0,
      productId: '',
      batchId: '',
      locationId: '',
    }),
    resolve: (catalogue, data, payload) => {
      const product =
        (payload.productId && catalogue.products.get(payload.productId)) ||
        (optionalText(payload.productSku) &&
          catalogue.productsBySku.get(String(payload.productSku).toLowerCase()));
      if (!product) {
        throw new OperationError(`Unknown product "${payload.productSku ?? payload.productId}".`);
      }

      const location =
        (payload.locationId && catalogue.locations.get(payload.locationId)) ||
        (optionalText(payload.locationName) &&
          catalogue.locationsByName.get(String(payload.locationName).toLowerCase()));
      if (!location) {
        throw new OperationError(`Unknown location "${payload.locationName ?? payload.locationId}".`);
      }

      const batchNumber = optionalText(payload.batchNumber);
      const batch =
        (payload.batchId && catalogue.batches.get(payload.batchId)) ||
        (batchNumber && catalogue.batchesByKey.get(batchKey(product.id, batchNumber)));
      if (!batch) {
        throw new OperationError(`Unknown batch "${batchNumber ?? payload.batchId}".`);
      }
      if (batch.productId !== product.id) {
        throw new OperationError('That batch belongs to a different product.');
      }

      const breakdown: AnyRow[] = Array.isArray(payload.unitBreakdown)
        ? payload.unitBreakdown
        : [];
      if (breakdown.length === 0) {
        throw new OperationError('At least one unit quantity is required.');
      }

      const resolvedBreakdown: { unitId: string; quantity: number }[] = [];
      let baseQuantity = 0;

      for (const line of breakdown) {
        const unit =
          (line.unitId && catalogue.units.get(line.unitId)) ||
          (optionalText(line.unitName) &&
            catalogue.unitsByName.get(String(line.unitName).toLowerCase()));
        if (!unit) throw new OperationError(`Unknown unit "${line.unitName ?? line.unitId}".`);

        const productUnit = catalogue.productUnitsByKey.get(productUnitKey(product.id, unit.id));
        if (!productUnit) {
          throw new OperationError(`Unit "${unit.name}" is not configured for this product.`);
        }

        const quantity = numberOr(line.quantity, 0);
        if (quantity < 0) throw new OperationError('Quantity cannot be negative.');

        resolvedBreakdown.push({ unitId: unit.id, quantity });
        baseQuantity += quantity * productUnit.conversionToBase;
      }

      data.productId = product.id;
      data.batchId = batch.id;
      data.locationId = location.id;
      // The server owns the conversion — never trust a derived client total.
      data.unitBreakdown = resolvedBreakdown;
      data.baseQuantity = baseQuantity;
    },
    byId: (c, id) => c.openingStocks.get(id),
    byKey: (c, data) => c.openingStocksByKey.get(stockKey(data.batchId, data.locationId)),
  },
};

/** Value comparison that survives Dates and JSON columns. */
const sameValue = (left: unknown, right: unknown): boolean => {
  if (left instanceof Date || right instanceof Date) {
    const a = left instanceof Date ? left.getTime() : new Date(left as string).getTime();
    const b = right instanceof Date ? right.getTime() : new Date(right as string).getTime();
    return a === b;
  }
  if (left === null || left === undefined) return right === null || right === undefined;
  if (typeof left === 'object' || typeof right === 'object') {
    return JSON.stringify(left) === JSON.stringify(right);
  }
  return left === right;
};

/**
 * A re-sent operation whose content already matches the stored row is a no-op —
 * this is what makes retries (lost response, offline replay) safe without a
 * heavyweight transaction.
 */
const isAlreadyApplied = (data: AnyRow, current: AnyRow): boolean =>
  Object.keys(data).every((key) => sameValue(data[key], current[key]));

async function processOperation(catalogue: Catalogue, op: AnyRow) {
  const { operationId, entityType, operationType, baseVersion } = op;
  const definition = ENTITIES[entityType as EntityType];

  if (!definition) {
    return { operationId, status: 'ERROR', error: `Unknown entity type "${entityType}".` };
  }

  const delegate = (prisma as any)[definition.store];
  const payload: AnyRow = op.payload ?? {};

  if (operationType === 'DELETE') {
    const row = definition.byId?.(catalogue, op.entityId);
    if (!row) {
      return { operationId, status: 'SYNCED', entityType, entityId: op.entityId, version: 0 };
    }
    await delegate.delete({ where: { id: row.id } });
    unindexRow(catalogue, definition.store, row);
    return {
      operationId,
      status: 'SYNCED',
      entityType,
      entityId: row.id,
      version: 0,
      deleted: true,
    };
  }

  const data = definition.fields(payload);
  if (definition.resolve) definition.resolve(catalogue, data, payload);
  if (definition.migrationScoped) data.migrationId = catalogue.migrationId;

  // Resolve by our id first, then by the business key: an older client stored a
  // random id per save, so the same record can exist under a different id.
  let current = definition.byId?.(catalogue, op.entityId);
  if (
    current &&
    definition.store === 'productUnit' &&
    (current.productId !== data.productId || current.unitId !== data.unitId)
  ) {
    current = undefined;
  }
  if (!current) current = definition.byKey?.(catalogue, data);

  if (current) {
    if (isAlreadyApplied(data, current)) {
      return {
        operationId,
        status: 'SYNCED',
        entityType,
        entityId: current.id,
        version: current.version,
        unchanged: true,
      };
    }

    if (typeof baseVersion === 'number' && current.version !== baseVersion) {
      // A genuine clash: always hand back the server copy so the user can see it.
      return {
        operationId,
        status: 'CONFLICT',
        entityType,
        entityId: current.id,
        currentVersion: current.version,
        serverData: current,
      };
    }

    const updated = await delegate.update({
      where: { id: current.id },
      data: { ...data, version: current.version + 1 },
    });
    indexRow(catalogue, definition.store, updated);
    return {
      operationId,
      status: 'SYNCED',
      entityType,
      entityId: updated.id,
      version: updated.version,
      adopted: current.id !== op.entityId,
    };
  }

  if (operationType === 'UPDATE') {
    return {
      operationId,
      status: 'ERROR',
      entityType,
      entityId: op.entityId,
      error: `Nothing to update: this ${entityType.toLowerCase().replace('_', ' ')} is not on the server.`,
    };
  }

  const created = await delegate.create({ data: { ...data, id: op.entityId } });
  indexRow(catalogue, definition.store, created);
  return {
    operationId,
    status: 'SYNCED',
    entityType,
    entityId: created.id,
    version: created.version ?? 1,
  };
}

router.post('/', async (req, res) => {
  const { migrationId } = req.params as any;
  const { operations } = req.body ?? {};

  if (!migrationId) {
    return res.status(400).json({ error: 'migrationId is required' });
  }
  if (!Array.isArray(operations)) {
    return res.status(400).json({ error: 'Operations must be an array' });
  }

  const needed = new Set<StoreKey>();
  for (const op of operations) {
    (REQUIRED_STORES[op?.entityType as EntityType] ?? []).forEach((key) => needed.add(key));
  }

  let catalogue: Catalogue;
  try {
    const migration = await prisma.migration.findUnique({ where: { id: migrationId } });
    if (!migration) {
      // A stale migration id (offline across a database reset) must not turn
      // every operation into a foreign-key error.
      await prisma.migration.create({
        data: { id: migrationId, name: 'Opening Inventory Migration' },
      });
    }
    catalogue = await loadCatalogue(migrationId, needed);
  } catch (error) {
    console.error('Could not load migration state', error);
    return res.status(500).json({ error: 'Could not load migration state' });
  }

  const results: any[] = [];
  let successfulOperations = 0;

  for (const op of operations) {
    const { operationId, entityType, entityId, operationType } = op ?? {};

    if (!operationId || !entityType || !entityId || !operationType) {
      results.push({
        operationId: operationId ?? 'unknown',
        status: 'ERROR',
        error:
          'Malformed operation: operationId, entityType, entityId and operationType are required.',
      });
      continue;
    }

    try {
      const result = await processOperation(catalogue, op);
      if (result.status === 'SYNCED') successfulOperations += 1;
      results.push(result);
    } catch (error: any) {
      if (error instanceof OperationError) {
        results.push({ operationId, status: 'ERROR', entityType, entityId, error: error.message });
        continue;
      }

      if (error?.code === 'P2002') {
        // Unique clash: hand back the existing row so the client can show a real
        // conflict instead of an empty "Server version {}".
        try {
          const definition = ENTITIES[entityType as EntityType];
          const data = definition.fields(op.payload ?? {});
          if (definition.resolve) definition.resolve(catalogue, data, op.payload ?? {});
          const existing = definition.byKey?.(catalogue, data);
          if (existing) {
            results.push({
              operationId,
              status: 'CONFLICT',
              entityType,
              entityId: existing.id,
              currentVersion: existing.version,
              serverData: existing,
              error: 'A record with the same business key already exists.',
            });
            continue;
          }
        } catch {
          /* fall through to the generic error below */
        }
      }

      results.push({
        operationId,
        status: 'ERROR',
        entityType,
        entityId,
        error: error?.message ?? 'The server could not apply this change.',
      });
    }
  }

  // One revision per accepted batch: the client pulls straight after a push.
  let revision: number | undefined;
  if (successfulOperations > 0) {
    try {
      const migration = await prisma.migration.update({
        where: { id: migrationId },
        data: { revision: { increment: 1 }, lastActivityAt: new Date() },
      });
      revision = migration.revision;
    } catch (error) {
      console.error('Could not bump migration revision', error);
    }
  }

  res.json({ results, revision, successfulOperations });
});

export default router;
