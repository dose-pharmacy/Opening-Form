/**
 * Migration data model.
 *
 * This is the *migration representation* the user actually enters
 * (e.g. "1 Box + 10 Tablets"). It intentionally contains no database IDs —
 * only business identifiers (SKU, product name, group, unit, location, batch).
 *
 * The production backend is responsible for the authoritative conversion of
 * these physical-unit quantities into base units.
 */

export const SCHEMA_VERSION = '1.0';

/** A simple named reference used by the reusable value catalogues. */
export interface NamedRef {
  name: string;
}

/** A reusable unit definition (the top-level `units` catalogue). */
export interface UnitDefinition {
  name: string;
  symbol: string;
}

/**
 * A unit as configured on a specific product.
 *
 * `contains` + `containedUnit` describe the packaging hierarchy the user types
 * in (e.g. Box contains 10 Strip). `conversionFactor` is the *canonical*
 * resolved value in base units and is what gets exported.
 */
export interface UnitConfig {
  unit: string;
  isBaseUnit: boolean;
  /** Canonical factor to the base unit. Derived; never edited directly. */
  conversionFactor: number;
  /** How many `containedUnit` make up this unit (null for the base unit). */
  contains: number | null;
  /** The immediate lower unit in the hierarchy (null for the base unit). */
  containedUnit: string | null;
  /** Kept at 0 for migration; real prices are configured later. */
  purchasePrice: number;
  sellPrice: number;
}

export interface Product {
  sku: string;
  name: string;
  genericName: string;
  brand: string;
  productGroup: string;
  description: string;
  minStock: number;
  reorderPoint: number;
  isNarcotic: boolean;
  units: UnitConfig[];
}

export interface Batch {
  productSku: string;
  batchNumber: string;
  expiryDate: string;
  manufacturingDate: string | null;
  receivedDate: string | null;
  supplier: string | null;
  supplierReference: string | null;
}

/** One physical-unit line of opening stock, e.g. `{ unit: 'Box', quantity: 1 }`. */
export interface StockQuantity {
  unit: string;
  quantity: number;
  unitCost: number;
}

/**
 * One stock entry = product + batch + location, holding the original
 * physical-unit quantities. `id` is client-only and stripped on export.
 */
export interface StockEntry {
  id: string;
  productSku: string;
  batchNumber: string;
  location: string;
  quantities: StockQuantity[];
}

export interface MigrationData {
  schemaVersion: string;
  productGroups: NamedRef[];
  locations: NamedRef[];
  suppliers: NamedRef[];
  units: UnitDefinition[];
  products: Product[];
  batches: Batch[];
  openingStock: StockEntry[];
}

export type ValidationStatus = 'valid' | 'warning' | 'error';
export type StatusFilter = 'all' | 'valid' | 'warning' | 'error';

export interface ValidationIssue {
  /** Stock entry the issue belongs to, or null for document/product-level issues. */
  entryId: string | null;
  severity: 'error' | 'warning';
  message: string;
}

export interface MigrationValidation {
  issues: ValidationIssue[];
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  /** Status keyed by stock entry id. */
  rowStatus: Record<string, ValidationStatus>;
  counts: {
    rows: number;
    valid: number;
    warnings: number;
    errors: number;
    products: number;
    batches: number;
    locations: number;
  };
  canExport: boolean;
}
