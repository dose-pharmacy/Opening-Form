import type {
  MigrationData,
  MigrationValidation,
  Product,
  ValidationIssue,
  ValidationStatus,
} from './types';
import { isPositiveNumber, validateUnitConfiguration } from './conversions';

/**
 * Client-side validation run before export.
 *
 * Errors block export. Warnings never block export but are surfaced in the
 * review step so the user can decide.
 */
export function validateMigration(data: MigrationData): MigrationValidation {
  const issues: ValidationIssue[] = [];
  const productBySku = new Map<string, Product>();
  data.products.forEach((p) => {
    if (p.sku) productBySku.set(p.sku, p);
  });

  // ── Product level ────────────────────────────────────────────────
  const skuCounts = new Map<string, number>();
  data.products.forEach((p) => {
    const sku = p.sku.trim();
    skuCounts.set(sku, (skuCounts.get(sku) || 0) + 1);
  });

  data.products.forEach((product) => {
    if (!product.name.trim()) {
      issues.push({ entryId: null, severity: 'error', message: `Product "${product.sku || '(no SKU)'}": missing product name` });
    }
    if (!product.sku.trim()) {
      issues.push({ entryId: null, severity: 'error', message: `Product "${product.name || '(no name)'}": missing SKU` });
    } else if ((skuCounts.get(product.sku.trim()) || 0) > 1) {
      issues.push({ entryId: null, severity: 'error', message: `Duplicate SKU "${product.sku}"` });
    }
    if (!product.productGroup.trim()) {
      issues.push({ entryId: null, severity: 'error', message: `Product "${product.sku}": missing group` });
    }
    validateUnitConfiguration(product).forEach((message) => {
      issues.push({ entryId: null, severity: 'error', message: `Product "${product.sku}": ${message}` });
    });

    if (!isPositiveNumber(product.reorderPoint)) {
      issues.push({ entryId: null, severity: 'warning', message: `Product "${product.sku}": no reorder point set` });
    }
    if (!isPositiveNumber(product.minStock)) {
      issues.push({ entryId: null, severity: 'warning', message: `Product "${product.sku}": no minimum stock set` });
    }
    if (!product.units.some((u) => isPositiveNumber(u.sellPrice))) {
      issues.push({ entryId: null, severity: 'warning', message: `Product "${product.sku}": selling price is missing` });
    }
    if (product.units.some((u) => u.purchasePrice !== 0)) {
      issues.push({ entryId: null, severity: 'warning', message: `Product "${product.sku}": purchase price is not 0` });
    }
  });

  // ── Batch level ──────────────────────────────────────────────────
  // Only batches actually used by opening stock matter for the migration.
  const referencedBatches = new Set(
    data.openingStock
      .filter((e) => e.productSku && e.batchNumber)
      .map((e) => `${e.productSku}::${e.batchNumber}`)
  );
  data.batches
    .filter((batch) => referencedBatches.has(`${batch.productSku}::${batch.batchNumber}`))
    .forEach((batch) => {
    const label = `${batch.productSku || '(no SKU)'} / ${batch.batchNumber || '(no batch)'}`;
    if (!productBySku.has(batch.productSku)) {
      issues.push({ entryId: null, severity: 'error', message: `Batch ${label}: unknown product SKU` });
    }
    if (!batch.batchNumber.trim()) {
      issues.push({ entryId: null, severity: 'error', message: `Batch ${label}: missing batch number` });
    }
    if (!batch.expiryDate) {
      issues.push({ entryId: null, severity: 'error', message: `Batch ${label}: missing expiry date` });
    }
    if (!batch.supplier) {
      issues.push({ entryId: null, severity: 'warning', message: `Batch ${label}: supplier information missing` });
    }
  });

  // ── Stock entry level ────────────────────────────────────────────
  const rowStatus: Record<string, ValidationStatus> = {};
  const entryIssues = new Map<string, ValidationIssue[]>();

  const addEntryIssue = (entryId: string, severity: 'error' | 'warning', message: string) => {
    const list = entryIssues.get(entryId) || [];
    list.push({ entryId, severity, message });
    entryIssues.set(entryId, list);
    issues.push({ entryId, severity, message });
  };

  data.openingStock.forEach((entry, index) => {
    const rowLabel = `Row ${index + 1}`;
    const product = productBySku.get(entry.productSku);

    if (!entry.productSku) {
      addEntryIssue(entry.id, 'error', `${rowLabel}: missing product`);
    } else if (!product) {
      addEntryIssue(entry.id, 'error', `${rowLabel}: product "${entry.productSku}" is not configured`);
    }

    if (!entry.batchNumber?.trim()) {
      addEntryIssue(entry.id, 'error', `${rowLabel}: missing batch`);
    } else if (product) {
      const batch = data.batches.find(
        (b) => b.productSku === entry.productSku && b.batchNumber === entry.batchNumber
      );
      if (!batch) {
        addEntryIssue(
          entry.id,
          'error',
          `${rowLabel}: batch "${entry.batchNumber}" has no details recorded — open its batch details to set an expiry`
        );
      } else if (!batch.expiryDate) {
        addEntryIssue(entry.id, 'error', `${rowLabel}: batch "${entry.batchNumber}" is missing an expiry date`);
      }
    }

    if (!entry.location?.trim()) {
      addEntryIssue(entry.id, 'error', `${rowLabel}: missing location`);
    }

    const validQuantities = entry.quantities.filter((q) => q.unit);
    if (validQuantities.length === 0) {
      addEntryIssue(entry.id, 'error', `${rowLabel}: no opening stock entered`);
    } else {
      validQuantities.forEach((q) => {
        if (!Number.isFinite(Number(q.quantity)) || Number(q.quantity) < 0) {
          addEntryIssue(entry.id, 'error', `${rowLabel}: invalid quantity for ${q.unit}`);
        }
        if (product && !product.units.some((u) => u.unit === q.unit)) {
          addEntryIssue(entry.id, 'error', `${rowLabel}: unit "${q.unit}" is not configured on ${entry.productSku}`);
        }
      });
      if (validQuantities.every((q) => !isPositiveNumber(Number(q.quantity)))) {
        addEntryIssue(entry.id, 'error', `${rowLabel}: opening stock must be greater than 0`);
      }
      if (validQuantities.every((q) => !isPositiveNumber(Number(q.unitCost)))) {
        addEntryIssue(entry.id, 'warning', `${rowLabel}: opening cost is 0`);
      }
    }

    if (product && validateUnitConfiguration(product).length > 0) {
      addEntryIssue(entry.id, 'error', `${rowLabel}: product "${entry.productSku}" has an invalid unit configuration`);
    }

    const own = entryIssues.get(entry.id) || [];
    rowStatus[entry.id] = own.some((i) => i.severity === 'error')
      ? 'error'
      : own.some((i) => i.severity === 'warning')
        ? 'warning'
        : 'valid';
  });

  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');

  const rows = data.openingStock.length;
  const valid = Object.values(rowStatus).filter((s) => s === 'valid').length;
  const warningRows = Object.values(rowStatus).filter((s) => s === 'warning').length;
  const errorRows = Object.values(rowStatus).filter((s) => s === 'error').length;

  return {
    issues,
    errors,
    warnings,
    rowStatus,
    counts: {
      rows,
      valid,
      warnings: warningRows,
      errors: errorRows,
      products: data.products.length,
      batches: data.batches.length,
      locations: data.locations.length,
    },
    canExport: errors.length === 0,
  };
}
