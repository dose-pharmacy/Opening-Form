/**
 * Shared test harness.
 *
 * The fake sync service, the fetch shim that talks to it, and a complete
 * server-shaped workspace. Kept in one place so a test file only has to describe
 * the behaviour it is checking.
 */

import { vi } from 'vitest';

import { batchId, groupId, productId, stockId, unitId } from '../sync/ids';
import type { Batch, Product, StockEntry } from '../utils/types';
import { FakeSyncServer } from './fakeServer';

export const MIGRATION = 'migration-1';
export const api = 'http://localhost:3001/api';

/** Route fetch through the fake service. */
export const installFetch = (server: FakeSyncServer) => {
  const fetchMock = vi.fn(async (input: any, init: any = {}) => {
    const url = String(input);
    const path = url.startsWith(api) ? url.slice(api.length) : url;
    const { status, body } = server.handle({
      method: init.method ?? 'GET',
      path,
      body: init.body ? JSON.parse(init.body) : undefined,
    });

    // status 0 is "the port is closed" — the shape the client actually sees.
    if (status === 0) throw new TypeError('Failed to fetch');

    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as any;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

export const sampleProduct = (sku: string, name = `Product ${sku}`): Product => ({
  sku,
  name,
  genericName: '',
  brand: '',
  productGroup: 'Analgesics',
  description: '',
  minStock: 5,
  reorderPoint: 2,
  isNarcotic: false,
  units: [
    { unit: 'Tablet', isBaseUnit: true, conversionFactor: 1, contains: null, containedUnit: null, purchasePrice: 0, sellPrice: 0 },
    { unit: 'Box', isBaseUnit: false, conversionFactor: 10, contains: 10, containedUnit: 'Tablet', purchasePrice: 0, sellPrice: 0 },
  ],
});

export const sampleBatch = (sku: string, batchNumber: string): Batch => ({
  productSku: sku,
  batchNumber,
  expiryDate: '2027-01-31',
  manufacturingDate: null,
  receivedDate: null,
  supplier: null,
  supplierReference: null,
});

export const sampleEntry = (
  id: string,
  sku: string,
  batchNumber: string,
  location: string,
  overrides: Partial<StockEntry> = {}
): StockEntry => ({
  id,
  productSku: sku,
  batchNumber,
  location,
  quantities: [{ unit: 'Box', quantity: 3, unitCost: 12 }],
  ...overrides,
});

/** Seed the fake service with a complete, server-shaped workspace. */
export const seedServer = (server: FakeSyncServer) => {
  const sku = 'SKU-1';
  const product = productId(MIGRATION, sku);
  const batch = batchId(MIGRATION, sku, 'B-1');
  const location = groupId(MIGRATION, 'Main Store');
  const tablet = unitId(MIGRATION, 'Tablet');
  const box = unitId(MIGRATION, 'Box');

  server.groups[groupId(MIGRATION, 'Analgesics')] = { id: groupId(MIGRATION, 'Analgesics'), name: 'Analgesics', version: 1 };
  server.locations[location] = { id: location, name: 'Main Store', version: 1 };
  server.units[tablet] = { id: tablet, name: 'Tablet', version: 1 };
  server.units[box] = { id: box, name: 'Box', version: 1 };
  server.products[product] = {
    id: product,
    sku,
    name: 'Paracetamol 500mg',
    genericName: 'Paracetamol',
    brand: 'Acme',
    groupId: groupId(MIGRATION, 'Analgesics'),
    description: '',
    isActive: true,
    version: 1,
  };
  server.productUnits[`${product}:${tablet}`] = { id: `${product}:${tablet}`, productId: product, unitId: tablet, conversionToBase: 1, isBaseUnit: true, sellPrice: null, purchasePrice: 0, version: 1 };
  server.productUnits[`${product}:${box}`] = { id: `${product}:${box}`, productId: product, unitId: box, conversionToBase: 10, isBaseUnit: false, sellPrice: 0, purchasePrice: 0, version: 1 };
  server.batches[batch] = { id: batch, productId: product, batchNumber: 'B-1', expiryDate: '2027-01-31T00:00:00.000Z', version: 1 };
  server.openingStocks[stockId(MIGRATION, sku, 'B-1', 'Main Store')] = {
    id: stockId(MIGRATION, sku, 'B-1', 'Main Store'),
    productId: product,
    batchId: batch,
    locationId: location,
    lineKey: '',
    position: 0,
    baseQuantity: 30,
    unitBreakdown: [{ unitId: box, unitName: 'Box', quantity: 3 }],
    unitCost: 12,
    version: 1,
  };
  server.revision = 4;
  return { sku, product, batch, location, tablet, box };
};

/** Let a deliberately un-awaited background push finish before teardown. */
export const settle = () => new Promise((resolve) => setTimeout(resolve, 25));
