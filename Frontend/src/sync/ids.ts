/**
 * Deterministic, migration-scoped server ids.
 *
 * The draft only knows business identifiers (SKU, batch number, location name,
 * unit name). To sync without a lookup round-trip we derive the server id from
 * those identifiers, so the same draft always produces the same ids — on reload,
 * in another tab, or from an imported file.
 *
 * Ids are prefixed with the migration id so a record can never be confused
 * across migrations, and so the local mirror can tell which rows it manages.
 */

export type EntityKind =
  | 'group'
  | 'location'
  | 'unit'
  | 'product'
  | 'productunit'
  | 'batch'
  | 'stock';

export function sid(migrationId: string, kind: EntityKind, key: string): string {
  return `${migrationId}:${kind}:${encodeURIComponent(key.trim())}`;
}

/** True when an id was produced by `sid` for this migration. */
export function isManagedId(migrationId: string, id: string): boolean {
  return typeof id === 'string' && id.startsWith(`${migrationId}:`);
}

export const productId = (migrationId: string, sku: string) => sid(migrationId, 'product', sku);
export const groupId = (migrationId: string, name: string) => sid(migrationId, 'group', name);
export const locationId = (migrationId: string, name: string) => sid(migrationId, 'location', name);
export const unitId = (migrationId: string, name: string) => sid(migrationId, 'unit', name);
export const productUnitId = (migrationId: string, sku: string, unit: string) =>
  sid(migrationId, 'productunit', `${sku}::${unit}`);
export const batchId = (migrationId: string, sku: string, batchNumber: string) =>
  sid(migrationId, 'batch', `${sku}::${batchNumber}`);
export const stockId = (migrationId: string, sku: string, batchNumber: string, location: string) =>
  sid(migrationId, 'stock', `${sku}::${batchNumber}::${location}`);
