import type {
  Batch,
  MigrationData,
  NamedRef,
  Product,
  StockEntry,
  StockQuantity,
  UnitConfig,
  UnitDefinition,
} from './types';
import { SCHEMA_VERSION } from './types';
import { resolveConversionFactors, round } from './conversions';
import { newId } from './ids';

const SUPPORTED_MAJOR_VERSIONS = ['1'];

/**
 * Normalize the migration document for export:
 * - strips client-only ids
 * - resolves the canonical conversionFactor for every unit
 * - guarantees explicit nulls for optional batch fields
 * - keeps only business identifiers (no database ids anywhere)
 */
export function buildExportPayload(data: MigrationData): Record<string, unknown> {
  const referencedBatches = new Set(
    data.openingStock
      .filter((e) => e.productSku && e.batchNumber)
      .map((e) => `${e.productSku}::${e.batchNumber}`)
  );

  return {
    schemaVersion: SCHEMA_VERSION,
    productGroups: data.productGroups.map((g) => ({ name: g.name })),
    locations: data.locations.map((l) => ({ name: l.name })),
    suppliers: data.suppliers.map((s) => ({ name: s.name })),
    units: data.units.map((u) => ({ name: u.name, symbol: u.symbol })),
    products: data.products.map((product) => ({
      sku: product.sku.trim(),
      name: product.name.trim(),
      genericName: product.genericName.trim(),
      brand: product.brand.trim(),
      productGroup: product.productGroup,
      description: product.description,
      minStock: product.minStock,
      reorderPoint: product.reorderPoint,
      isNarcotic: product.isNarcotic,
      units: resolveConversionFactors(product.units).map((u) => ({
        unit: u.unit,
        isBaseUnit: u.isBaseUnit,
        contains: u.contains,
        containedUnit: u.containedUnit,
        conversionFactor: round(u.conversionFactor, 6),
        purchasePrice: 0,
        sellPrice: u.sellPrice,
      })),
    })),
    batches: data.batches
      .filter((batch) => referencedBatches.has(`${batch.productSku}::${batch.batchNumber}`))
      .map((batch) => ({
      productSku: batch.productSku,
      batchNumber: batch.batchNumber,
      expiryDate: batch.expiryDate,
      manufacturingDate: batch.manufacturingDate ?? null,
      receivedDate: batch.receivedDate ?? null,
      supplier: batch.supplier ?? null,
      supplierReference: batch.supplierReference ?? null,
      })),
    openingStock: data.openingStock.map((entry) => ({
      productSku: entry.productSku,
      batchNumber: entry.batchNumber,
      location: entry.location,
      quantities: entry.quantities
        .filter((q) => q.unit)
        .map((q) => ({
          unit: q.unit,
          quantity: Number(q.quantity) || 0,
          unitCost: Number(q.unitCost) || 0,
        })),
    })),
  };
}

export function serializeMigration(data: MigrationData): string {
  return JSON.stringify(buildExportPayload(data), null, 2);
}

export function downloadJson(data: MigrationData, filename?: string): string {
  const name =
    filename ?? `pharmacy-opening-inventory-${new Date().toISOString().split('T')[0]}.json`;
  const blob = new Blob([serializeMigration(data)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  // Give the browser a tick before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return name;
}

export type ParseResult =
  | { ok: true; data: MigrationData }
  | { ok: false; error: string };

const asArray = <T,>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);

const asString = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : value == null ? fallback : String(value);

const asNumber = (value: unknown, fallback = 0): number => {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const asNullableString = (value: unknown): string | null =>
  value == null || value === '' ? null : String(value);

const toNamedRefs = (value: unknown): NamedRef[] => {
  const seen = new Set<string>();
  const refs: NamedRef[] = [];
  asArray<unknown>(value).forEach((item) => {
    const name = typeof item === 'string' ? item : asString((item as NamedRef)?.name);
    if (name && !seen.has(name)) {
      seen.add(name);
      refs.push({ name });
    }
  });
  return refs;
};

function normalizeUnits(value: unknown): UnitConfig[] {
  const units = asArray<unknown>(value).map((raw) => {
    const u = raw as Partial<UnitConfig>;
    const isBaseUnit = Boolean(u.isBaseUnit);
    return {
      unit: asString(u.unit ?? (u as Record<string, unknown>).name),
      isBaseUnit,
      conversionFactor: isBaseUnit ? 1 : asNumber(u.conversionFactor, 1) || 1,
      contains: isBaseUnit ? null : (u.contains == null ? null : asNumber(u.contains, 0)),
      containedUnit: isBaseUnit ? null : (asNullableString(u.containedUnit) ?? null),
      purchasePrice: asNumber(u.purchasePrice, 0),
      sellPrice: asNumber(u.sellPrice, 0),
    } satisfies UnitConfig;
  }).filter((u) => u.unit);

  if (units.length > 0 && !units.some((u) => u.isBaseUnit)) {
    units[0].isBaseUnit = true;
    units[0].conversionFactor = 1;
    units[0].contains = null;
    units[0].containedUnit = null;
  }
  return resolveConversionFactors(units);
}

export function normalizeMigration(raw: unknown): MigrationData {
  const source = (raw ?? {}) as Record<string, unknown>;

  const products: Product[] = asArray<unknown>(source.products).map((rawProduct) => {
    const p = rawProduct as Record<string, unknown>;
    return {
      sku: asString(p.sku),
      name: asString(p.name),
      genericName: asString(p.genericName),
      brand: asString(p.brand),
      productGroup: asString(p.productGroup ?? p.group),
      description: asString(p.description),
      minStock: asNumber(p.minStock, 0),
      reorderPoint: asNumber(p.reorderPoint, 0),
      isNarcotic: Boolean(p.isNarcotic),
      units: normalizeUnits(p.units),
    };
  });

  const batches: Batch[] = asArray<unknown>(source.batches).map((rawBatch) => {
    const b = rawBatch as Record<string, unknown>;
    return {
      productSku: asString(b.productSku),
      batchNumber: asString(b.batchNumber),
      expiryDate: asString(b.expiryDate),
      manufacturingDate: asNullableString(b.manufacturingDate),
      receivedDate: asNullableString(b.receivedDate),
      supplier: asNullableString(b.supplier),
      supplierReference: asNullableString(b.supplierReference),
    };
  });

  const openingStock: StockEntry[] = asArray<unknown>(source.openingStock).map((rawEntry) => {
    const e = rawEntry as Record<string, unknown>;
    const quantities: StockQuantity[] = asArray<unknown>(e.quantities).map((rawQ) => {
      const q = rawQ as Record<string, unknown>;
      return {
        unit: asString(q.unit),
        quantity: asNumber(q.quantity, 0),
        unitCost: asNumber(q.unitCost, 0),
      };
    });
    return {
      id: asString(e.id) || newId(),
      productSku: asString(e.productSku),
      batchNumber: asString(e.batchNumber),
      location: asString(e.location),
      quantities: quantities.filter((q) => q.unit),
    };
  });

  const unitCatalogue: UnitDefinition[] = asArray<unknown>(source.units).map((rawUnit) => {
    const u = rawUnit as Record<string, unknown>;
    return { name: asString(u.name ?? u.unit), symbol: asString(u.symbol) };
  }).filter((u) => u.name);

  return {
    schemaVersion: SCHEMA_VERSION,
    productGroups: toNamedRefs(source.productGroups),
    locations: toNamedRefs(source.locations),
    suppliers: toNamedRefs(source.suppliers),
    units: unitCatalogue,
    products,
    batches,
    openingStock,
  };
}

/** Parse + schema-validate an imported JSON file. */
export function parseImport(text: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: 'That file is not valid JSON.' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'The migration file must be a JSON object.' };
  }

  const source = parsed as Record<string, unknown>;
  const version = asString(source.schemaVersion);
  if (!version) {
    return { ok: false, error: 'Missing "schemaVersion" — this does not look like a migration file.' };
  }
  const major = version.split('.')[0];
  if (!SUPPORTED_MAJOR_VERSIONS.includes(major)) {
    return { ok: false, error: `Unsupported schema version "${version}". This tool supports 1.x.` };
  }
  const hasContent = ['products', 'batches', 'openingStock'].some((key) => Array.isArray(source[key]));
  if (!hasContent) {
    return { ok: false, error: 'The file has no products, batches or opening stock sections.' };
  }

  return { ok: true, data: normalizeMigration(source) };
}
