/**
 * Local rows → the shape the form actually renders.
 *
 * IndexedDB holds *rows*: flat records that carry the server's columns plus local
 * bookkeeping (`version`, `syncState`, tombstones). The form needs *entities*:
 * a product with its unit hierarchy, a batch that knows its SKU, a stock line
 * that knows its product, batch, location and physical quantities.
 *
 * Both a row the user just typed and a row that came back from the server pass
 * through here, so a workspace is rendered the same way no matter which side it
 * was written by. The reference catalogues (groups, locations, units, products,
 * batches) provide the name lookups the relational server rows only reference by
 * id.
 */

import type { LocalEntityRow } from '../local-store/entities';
import {
  SCHEMA_VERSION,
  type Batch,
  type MigrationData,
  type NamedRef,
  type Product,
  type StockEntry,
  type StockQuantity,
  type UnitConfig,
  type UnitDefinition,
} from '../utils/types';

export interface LocalRowSets {
  products: LocalEntityRow[];
  groups: LocalEntityRow[];
  locations: LocalEntityRow[];
  units: LocalEntityRow[];
  productUnits: LocalEntityRow[];
  batches: LocalEntityRow[];
  openingStock: LocalEntityRow[];
}

const text = (value: unknown): string => (typeof value === 'string' ? value : value == null ? '' : String(value));

const optionalText = (value: unknown): string | null => {
  const result = text(value).trim();
  return result ? result : null;
};

const number = (value: unknown, fallback = 0): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

/**
 * Dates only, in the shape a date input needs.
 *
 * The server stores `DateTime` and hands back an ISO timestamp
 * (`2027-01-31T00:00:00.000Z`); the form works in calendar days
 * (`2027-01-31`). Rendering the timestamp directly makes every expiry look
 * unparseable and silently invalid.
 */
const dateOnly = (value: unknown): string => {
  const raw = text(value).trim();
  if (!raw) return '';
  const iso = /^(\d{4}-\d{2}-\d{2})T/.exec(raw);
  return iso ? iso[1] : raw;
};

const optionalDate = (value: unknown): string | null => {
  const result = dateOnly(value);
  return result ? result : null;
};

const names = (rows: LocalEntityRow[]): NamedRef[] => {
  const seen = new Set<string>();
  const result: NamedRef[] = [];
  for (const row of rows) {
    const name = text(row.name).trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ name });
  }
  return result;
};

const unitDefinitions = (rows: LocalEntityRow[]): UnitDefinition[] =>
  names(rows).map(({ name }) => {
    const row = rows.find((candidate) => text(candidate.name).trim() === name);
    return { name, symbol: text(row?.symbol ?? '') };
  });

/**
 * Rebuild the packaging hierarchy from the factors.
 *
 * The server stores one canonical factor per unit (`conversionToBase`) and has no
 * place for "1 Box contains 10 Strip". The form does, so it is derived: the unit
 * directly below is the one with the largest factor below this unit's own.
 */
const unitHierarchy = (
  units: { name: string; factor: number; isBase: boolean; purchasePrice: number; sellPrice: number }[]
): UnitConfig[] => {
  const ordered = [...units].sort((a, b) => a.factor - b.factor);

  return ordered.map((unit) => {
    const config: UnitConfig = {
      unit: unit.name,
      isBaseUnit: unit.isBase,
      conversionFactor: unit.factor,
      contains: null,
      containedUnit: null,
      purchasePrice: unit.purchasePrice,
      sellPrice: unit.sellPrice,
    };

    if (unit.isBase) return config;

    let lower: (typeof ordered)[number] | undefined;
    for (const candidate of ordered) {
      if (candidate.factor >= unit.factor) continue;
      if (!lower || candidate.factor > lower.factor) lower = candidate;
    }

    if (lower && lower.factor > 0) {
      config.containedUnit = lower.name;
      config.contains = Math.round((unit.factor / lower.factor) * 1e6) / 1e6;
    }
    return config;
  });
};

export function buildMigrationData(rows: LocalRowSets): MigrationData {
  const groupNames = new Map<string, string>();
  for (const row of rows.groups) groupNames.set(row.id, text(row.name));

  const locationNames = new Map<string, string>();
  for (const row of rows.locations) locationNames.set(row.id, text(row.name));

  const unitNames = new Map<string, string>();
  for (const row of rows.units) unitNames.set(row.id, text(row.name));

  const productSkus = new Map<string, string>();
  for (const row of rows.products) productSkus.set(row.id, text(row.sku));

  const batchNumbers = new Map<string, string>();
  for (const row of rows.batches) batchNumbers.set(row.id, text(row.batchNumber));

  // Unit rows grouped by the product they belong to.
  const unitsByProduct = new Map<string, LocalEntityRow[]>();
  for (const row of rows.productUnits) {
    const productId = text(row.productId);
    const list = unitsByProduct.get(productId);
    if (list) list.push(row);
    else unitsByProduct.set(productId, [row]);
  }

  const products: Product[] = rows.products.map((row) => {
    const units = unitHierarchy(
      (unitsByProduct.get(row.id) ?? []).map((unitRow) => ({
        name: text(unitRow.unit ?? unitRow.unitName ?? unitNames.get(text(unitRow.unitId))).trim(),
        factor: number(unitRow.conversionFactor ?? unitRow.conversionToBase, 1) || 1,
        isBase: Boolean(unitRow.isBaseUnit),
        purchasePrice: number(unitRow.purchasePrice, 0),
        sellPrice: number(unitRow.sellPrice, 0),
      })).filter((unit) => unit.name)
    );

    return {
      sku: text(row.sku),
      name: text(row.name),
      genericName: text(row.genericName),
      brand: text(row.brand),
      productGroup: text(row.productGroup ?? groupNames.get(text(row.groupId))),
      description: text(row.description),
      minStock: number(row.minStock, 0),
      reorderPoint: number(row.reorderPoint, 0),
      isNarcotic: Boolean(row.isNarcotic),
      units,
    };
  });

  const baseUnitByProduct = new Map<string, string>();
  for (const product of products) {
    const base = product.units.find((unit) => unit.isBaseUnit) ?? product.units[product.units.length - 1];
    if (base) baseUnitByProduct.set(product.sku.trim().toLowerCase(), base.unit);
  }

  const batches: Batch[] = rows.batches.map((row) => {
    const productId = text(row.productId);
    return {
      productSku: text(row.productSku ?? productSkus.get(productId)),
      batchNumber: text(row.batchNumber),
      expiryDate: dateOnly(row.expiryDate),
      manufacturingDate: optionalDate(row.manufacturingDate),
      receivedDate: optionalDate(row.receivedDate),
      supplier: optionalText(row.supplier),
      supplierReference: optionalText(row.supplierReference),
    };
  });

  const openingStock: StockEntry[] = rows.openingStock.map((row) => {
    const productId = text(row.productId);
    const batchId = text(row.batchId);
    const productSku = text(row.productSku ?? productSkus.get(productId));
    const unitCost = number(row.unitCost, 0);

    // A row the user just typed keeps its lines in `quantities`; a row that came
    // back from the server keeps them in `unitBreakdown`. Accept either, and fall
    // back to the base figure so a line is never silently blank.
    const toLines = (lines: any[], unitKey: 'unit' | 'unitName') =>
      lines
        .map((line) => ({
          unit: text(line[unitKey] ?? line.unit ?? line.unitName ?? unitNames.get(text(line.unitId))).trim(),
          quantity: number(line.quantity, 0),
          unitCost: number(line.unitCost, unitCost),
        }))
        .filter((line) => line.unit);

    let quantities: StockQuantity[] = Array.isArray(row.unitBreakdown)
      ? toLines(row.unitBreakdown, 'unitName')
      : [];
    if (quantities.length === 0 && Array.isArray(row.quantities)) {
      quantities = toLines(row.quantities, 'unit');
    }
    if (quantities.length === 0) {
      const baseQuantity = number(row.baseQuantity, 0);
      if (baseQuantity > 0) {
        const unit = baseUnitByProduct.get(productSku.trim().toLowerCase()) ?? '';
        if (unit) quantities = [{ unit, quantity: baseQuantity, unitCost }];
      }
    }

    return {
      id: row.id,
      productSku,
      batchNumber: text(row.batchNumber ?? batchNumbers.get(batchId)),
      location: text(row.location ?? row.locationName ?? locationNames.get(text(row.locationId))),
      quantities,
    };
  });

  return {
    schemaVersion: SCHEMA_VERSION,
    productGroups: names(rows.groups),
    locations: names(rows.locations),
    // Suppliers are not migration-scoped on the server, so they stay per-session.
    suppliers: [],
    units: unitDefinitions(rows.units),
    products,
    batches,
    openingStock,
  };
}
