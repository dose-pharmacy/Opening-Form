/**
 * Server payload builders.
 *
 * The UI works in business identifiers ("1 Box + 10 Tablets", SKU, location
 * name). The sync endpoint works in database-shaped payloads. These pure
 * functions are the only place that translation happens, so every explicit
 * mutation sends something the backend can actually apply.
 *
 * Ids are derived from the business keys via `sync/ids.ts`, which keeps a
 * reload, another tab and an imported file pointing at the same rows.
 */

import { calculateBaseQuantity, resolveConversionFactors } from '../utils/conversions';
import type { Batch, Product, StockEntry, UnitConfig, UnitDefinition } from '../utils/types';
import { batchId, groupId, locationId, productId, productUnitId, stockId, unitId } from './ids';

const clean = (value: unknown): string | null => {
  const text = typeof value === 'string' ? value.trim() : '';
  return text ? text : null;
};

const positiveFactor = (unit: UnitConfig): number => {
  if (unit.isBaseUnit) return 1;
  const factor = Number(unit.conversionFactor);
  return Number.isFinite(factor) && factor > 0 ? factor : 1;
};

export const groupPayload = (name: string) => ({ name: name.trim() });

export const groupIdFor = (migrationId: string, name: string) => groupId(migrationId, name);

export const locationPayload = (name: string) => ({ name: name.trim(), description: null });

export const unitPayload = (unit: UnitDefinition) => ({
  name: unit.name.trim(),
  symbol: clean(unit.symbol),
});

export function productPayload(migrationId: string, product: Product) {
  const group = clean(product.productGroup);
  return {
    sku: product.sku.trim(),
    name: product.name.trim(),
    genericName: clean(product.genericName),
    brand: clean(product.brand),
    productGroup: group,
    groupId: group ? groupId(migrationId, group) : null,
    description: clean(product.description),
    isActive: true,
  };
}

export function productUnitPayloads(migrationId: string, product: Product) {
  const pid = productId(migrationId, product.sku);
  return resolveConversionFactors(product.units)
    .filter((unit) => Boolean(clean(unit.unit)))
    .map((unit) => {
      const unitName = unit.unit.trim();
      return {
        entityId: productUnitId(migrationId, product.sku, unitName),
        payload: {
          productId: pid,
          productSku: product.sku.trim(),
          unitId: unitId(migrationId, unitName),
          unitName,
          conversionToBase: positiveFactor(unit),
          isBaseUnit: Boolean(unit.isBaseUnit),
          sellPrice: Number(unit.sellPrice) > 0 ? Number(unit.sellPrice) : null,
          purchasePrice: 0,
        },
      };
    });
}

export function batchPayload(batch: Batch) {
  return {
    batchNumber: batch.batchNumber.trim(),
    expiryDate: batch.expiryDate,
    manufacturingDate: batch.manufacturingDate ?? null,
    receivedDate: batch.receivedDate ?? null,
    supplierReference: clean(batch.supplierReference),
    productSku: batch.productSku.trim(),
  };
}

export const batchIdFor = (migrationId: string, productSku: string, batchNumber: string) =>
  batchId(migrationId, productSku, batchNumber);

export const stockIdFor = (
  migrationId: string,
  productSku: string,
  batchNumber: string,
  location: string
) => stockId(migrationId, productSku, batchNumber, location);

export interface StockPayloadResult {
  entityId: string;
  payload: Record<string, unknown>;
}

/**
 * Build the opening-stock payload.
 *
 * Returns `null` when the row is not (yet) something the server can store: no
 * product, no batch, no location, or no counted quantity. A half-typed row stays
 * a local work-in-progress instead of being rejected by the server.
 */
export function stockPayload(
  migrationId: string,
  entry: StockEntry,
  product: Product | undefined,
  batch: Batch | undefined
): StockPayloadResult | null {
  const sku = clean(entry.productSku);
  const batchNumber = clean(entry.batchNumber);
  const location = clean(entry.location);
  if (!sku || !batchNumber || !location || !product || !batch) return null;
  if (!clean(batch.expiryDate)) return null;

  const lines = entry.quantities.filter((line) => Number(line.quantity) > 0 && clean(line.unit));
  if (lines.length === 0) return null;

  const bid = batchId(migrationId, sku, batchNumber);

  return {
    entityId: stockId(migrationId, sku, batchNumber, location),
    payload: {
      productId: productId(migrationId, sku),
      productSku: sku,
      batchId: bid,
      batchNumber,
      locationId: locationId(migrationId, location),
      locationName: location,
      // Preview only: the server recomputes and owns the base conversion.
      baseQuantity: calculateBaseQuantity(product, lines),
      unitBreakdown: lines.map((line) => ({
        unitId: unitId(migrationId, (line.unit ?? '').trim()),
        unitName: (line.unit ?? '').trim(),
        quantity: Number(line.quantity),
      })),
      unitCost: Number(lines.find((l) => Number(l.unitCost) > 0)?.unitCost) || 0,
    },
  };
}
