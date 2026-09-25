import type { Product, StockQuantity, UnitConfig } from './types';

/**
 * Authoritative client-side conversion utility.
 *
 * This exists ONLY to preview/validate what the user entered. The production
 * importer will re-implement this with its own authoritative rules.
 */

const EPSILON = 1e-9;

/** True when the value is a usable positive number. */
export const isPositiveNumber = (value: unknown): boolean =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

/**
 * Resolve every unit's canonical `conversionFactor` (in base units) from the
 * packaging hierarchy. Base unit is always 1.
 *
 * Tablet(1) <- Strip(10) <- Box(10 Strips) => Box = 100
 */
export function resolveConversionFactors(units: UnitConfig[]): UnitConfig[] {
  const byUnit = new Map<string, UnitConfig>();
  units.forEach((u) => {
    if (u.unit) byUnit.set(u.unit, u);
  });

  const resolved = new Map<string, number>();
  const visiting = new Set<string>();

  const factorOf = (unitName: string): number => {
    if (resolved.has(unitName)) return resolved.get(unitName) as number;
    const config = byUnit.get(unitName);
    if (!config) return 1;
    if (config.isBaseUnit) {
      resolved.set(unitName, 1);
      return 1;
    }
    if (visiting.has(unitName)) return Number.NaN; // cycle guard
    visiting.add(unitName);

    let factor: number;
    if (config.containedUnit && byUnit.has(config.containedUnit)) {
      const parentFactor = factorOf(config.containedUnit);
      factor = (Number.isFinite(parentFactor) ? parentFactor : 1) * (config.contains ?? 1);
    } else {
      factor = config.conversionFactor ?? 1;
    }

    visiting.delete(unitName);
    resolved.set(unitName, factor);
    return factor;
  };

  return units.map((u) => ({
    ...u,
    conversionFactor: u.isBaseUnit ? 1 : factorOf(u.unit),
  }));
}

export function getBaseUnit(product: Product): UnitConfig | undefined {
  return product.units.find((u) => u.isBaseUnit) || product.units[0];
}

export function getUnitConfig(product: Product, unitName: string): UnitConfig | undefined {
  return product.units.find((u) => u.unit === unitName);
}

export function getConversionFactor(product: Product, unitName: string): number {
  const config = getUnitConfig(product, unitName);
  if (!config) return 0;
  if (config.isBaseUnit) return 1;
  const factor = config.conversionFactor;
  return Number.isFinite(factor) ? factor : 0;
}

/** Total quantity expressed in the product's base unit. */
export function calculateBaseQuantity(product: Product, quantities: StockQuantity[]): number {
  return quantities.reduce((total, q) => {
    const factor = getConversionFactor(product, q.unit);
    const qty = Number(q.quantity);
    if (!Number.isFinite(qty) || factor <= 0) return total;
    return total + qty * factor;
  }, 0);
}

export interface StockSummaryLine {
  unit: string;
  conversionFactor: number;
  quantity: number;
  baseQuantity: number;
  unitCost: number;
}

export interface StockSummary {
  lines: StockSummaryLine[];
  totalBaseQuantity: number;
  totalCost: number;
  baseUnitName: string;
}

/** Breakdown of opening stock for display in the dialog and the spreadsheet. */
export function calculateStockSummary(
  product: Product | undefined,
  quantities: StockQuantity[]
): StockSummary {
  const baseUnit = product ? getBaseUnit(product) : undefined;
  const lines: StockSummaryLine[] = quantities.map((q) => {
    const factor = product ? getConversionFactor(product, q.unit) : 0;
    const qty = Number(q.quantity) || 0;
    const unitCost = Number(q.unitCost) || 0;
    return {
      unit: q.unit,
      conversionFactor: factor,
      quantity: qty,
      baseQuantity: qty * factor,
      unitCost,
    };
  });

  return {
    lines,
    totalBaseQuantity: lines.reduce((sum, l) => sum + l.baseQuantity, 0),
    totalCost: lines.reduce((sum, l) => sum + l.quantity * l.unitCost, 0),
    baseUnitName: baseUnit?.unit || '',
  };
}

export function formatStockDisplay(
  product: Product | undefined,
  quantities: StockQuantity[]
): string {
  if (!product) return '—';
  const summary = calculateStockSummary(product, quantities);
  if (summary.lines.every((l) => !isPositiveNumber(l.quantity))) return '0 ' + (summary.baseUnitName || '');
  return `${round(summary.totalBaseQuantity)} ${summary.baseUnitName}`.trim();
}

export function formatCost(total: number): string {
  return round(total).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

export function round(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

/**
 * Validate a product's unit configuration.
 * Returns an empty array when the configuration is usable.
 */
export function validateUnitConfiguration(product: Product): string[] {
  const errors: string[] = [];
  const units = product.units;

  if (!units || units.length === 0) {
    errors.push('At least one unit must be configured');
    return errors;
  }

  const names = units.map((u) => u.unit.trim());
  if (names.some((n) => !n)) errors.push('Every unit needs a name');

  const duplicates = names.filter((n, i) => n && names.indexOf(n) !== i);
  if (duplicates.length > 0) {
    errors.push(`Duplicate unit${duplicates.length > 1 ? 's' : ''}: ${[...new Set(duplicates)].join(', ')}`);
  }

  const baseUnits = units.filter((u) => u.isBaseUnit);
  if (baseUnits.length === 0) errors.push('A base unit must be selected');
  if (baseUnits.length > 1) errors.push('Only one base unit is allowed');

  const base = baseUnits[0];
  if (base && Math.abs(base.conversionFactor - 1) > EPSILON) {
    errors.push('The base unit conversion must be 1');
  }

  // Cycle detection across the packaging chain.
  const byUnit = new Map(units.map((u) => [u.unit, u]));
  units.forEach((u) => {
    if (u.isBaseUnit) return;
    const seen = new Set<string>([u.unit]);
    let cursor = u.containedUnit;
    while (cursor) {
      if (seen.has(cursor)) {
        errors.push(`Circular packaging chain detected around "${u.unit}"`);
        break;
      }
      seen.add(cursor);
      const parent = byUnit.get(cursor);
      if (!parent || parent.isBaseUnit) break;
      cursor = parent.containedUnit;
    }
  });

  units.forEach((u) => {
    if (u.isBaseUnit) return;
    const hasHierarchy = u.containedUnit && byUnit.has(u.containedUnit);
    if (hasHierarchy) {
      if (!isPositiveNumber(u.contains ?? 0)) {
        errors.push(`"${u.unit}" must contain a positive quantity`);
      }
    } else if (!isPositiveNumber(u.conversionFactor)) {
      errors.push(`"${u.unit}" needs a conversion greater than 0`);
    }
    if (u.sellPrice < 0) errors.push(`"${u.unit}" has an invalid selling price`);
    if (u.purchasePrice < 0) errors.push(`"${u.unit}" has an invalid purchase price`);
  });

  return [...new Set(errors)];
}

/**
 * Human readable conversion text for a unit, e.g. "1 Box = 100 Tablet".
 */
export function describeConversion(product: Product, unit: UnitConfig): string {
  const base = getBaseUnit(product);
  if (!base || unit.isBaseUnit) return 'Base unit (1)';
  const factor = getConversionFactor(product, unit.unit);
  if (!Number.isFinite(factor) || !isPositiveNumber(factor)) return 'Not resolved';
  const showChain =
    unit.containedUnit &&
    unit.containedUnit !== base.unit &&
    isPositiveNumber(unit.contains ?? 0);
  const chain = showChain ? ` (1 ${unit.unit} = ${unit.contains} ${unit.containedUnit})` : '';
  return `= ${round(factor)} ${base.unit}${chain}`;
}
