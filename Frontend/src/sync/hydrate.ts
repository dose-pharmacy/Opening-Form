/**
 * Hydration: getting the form from "just mounted" to "safe to edit".
 *
 * The order below is the whole point of this module and must not change:
 *
 *   1. resolve the migration identity (explicit `activeMigrationId` first)
 *   2. read the local IndexedDB workspace
 *   3. if there is a local workspace, the form is immediately editable
 *   4. otherwise ask the server, and only then treat the form as editable
 *   5. reconcile server rows into IndexedDB (pending local work wins)
 *   6. build the UI state from IndexedDB
 *
 * Nothing in the app may push or diff data before hydration resolves, which is
 * what used to turn an empty React state into a DELETE storm.
 */

import { getDB } from '../local-store/db';
import {
  ALL_STORES,
  ENTITY_FOR_STORE,
  STORE_FOR_ENTITY,
  hasLocalWorkspace,
  isPending,
  isTombstone,
  loadWorkspace,
  pruneLocalRows,
  putLocalEntity,
} from '../local-store/entities';
import { OperationQueue, type EntityType } from './queue';
import { migrationApi } from '../utils/migrationApi';
import {
  getActiveMigrationId,
  getMigrationRevision,
  setActiveMigrationId,
  setMigrationRevision,
  setSetupStatus,
} from '../utils/storage';
import type { MigrationData } from '../utils/types';

export interface ServerState {
  groups?: any[];
  locations?: any[];
  units?: any[];
  products?: any[];
  productUnits?: any[];
  batches?: any[];
  openingStocks?: any[];
}

export type HydrationSource = 'LOCAL' | 'SERVER' | 'EMPTY' | 'OFFLINE';

export interface HydrationResult {
  migrationId: string;
  data: MigrationData;
  source: HydrationSource;
  revision: number;
  /** True when the server could not be reached and there is no local copy. */
  offline: boolean;
}

export interface MigrationResolution {
  migrationId: string | null;
  /** True when the id came from persisted metadata rather than the server. */
  fromMetadata: boolean;
  /** True when the server could not be reached. */
  offline: boolean;
  /** The server reported the stored migration is gone. */
  stale: boolean;
}

/**
 * Decide which migration this workspace belongs to.
 *
 * The persisted `activeMigrationId` is the identity — never "the migration with
 * the most rows". A stored id is only discarded when the server explicitly says
 * it does not exist (404), which is a real, confirmed fact. Any other failure is
 * treated as offline and the stored id is kept.
 */
export async function resolveMigrationId(): Promise<MigrationResolution> {
  const stored = getActiveMigrationId();

  if (stored) {
    try {
      await migrationApi.getMigration(stored);
      return { migrationId: stored, fromMetadata: true, offline: false, stale: false };
    } catch (error: any) {
      if (error?.status === 404) {
        // Confirmed gone: forget it and look for a replacement below.
        setActiveMigrationId(null);
      } else {
        // Offline / server down: keep trusting the stored identity so offline
        // work can continue against the workspace it was written for.
        return { migrationId: stored, fromMetadata: true, offline: true, stale: false };
      }
    }
  }

  // No stored identity: ask the server what exists. A *successful* empty list
  // means this is genuinely a first use and a migration must be created, but a
  // failed list is just an unreachable server — creating then could duplicate a
  // migration that already exists.
  let listFailed = false;
  try {
    const list = await migrationApi.listMigrations();
    if (list.length > 0) {
      // Most recently active wins. "Most rows" is not an identity rule.
      const active = [...list].sort((a, b) => {
        const left = a.lastActivityAt ? Date.parse(a.lastActivityAt) : 0;
        const right = b.lastActivityAt ? Date.parse(b.lastActivityAt) : 0;
        return right - left;
      })[0];
      setActiveMigrationId(active.id);
      setMigrationRevision(active.revision ?? 0);
      return { migrationId: active.id, fromMetadata: false, offline: false, stale: false };
    }
  } catch {
    listFailed = true;
  }

  if (listFailed) {
    // Offline without an identity: the workspace must not be created speculatively.
    return { migrationId: null, fromMetadata: false, offline: true, stale: false };
  }

  try {
    const created = await migrationApi.createMigration('Opening Inventory Migration');
    setActiveMigrationId(created.id);
    setMigrationRevision(created.revision ?? 0);
    return { migrationId: created.id, fromMetadata: false, offline: false, stale: false };
  } catch (error) {
    console.warn('Could not reach the migration service yet.', error);
    return { migrationId: null, fromMetadata: false, offline: true, stale: false };
  }
}

/** True when the local workspace holds anything at all for this migration. */
export async function hasLocalData(migrationId: string): Promise<boolean> {
  return hasLocalWorkspace(migrationId);
}

/**
 * Write server rows into IndexedDB without touching local intent, and remove the
 * rows the server no longer has.
 *
 * `authoritative` must only be true when `state` really is the complete server
 * state for the migration; anything less and the absence of a row proves nothing.
 */
export async function reconcileServerState(
  migrationId: string,
  state: ServerState,
  options: { authoritative?: boolean } = {}
): Promise<{ written: number; removed: string[] }> {
  const db = await getDB();
  const pendingOps = await OperationQueue.getOperationsForMigration(migrationId);
  const pendingEntityIds = new Set(pendingOps.map((op) => op.entityId));
  const authoritative = options.authoritative ?? true;
  let written = 0;
  const removed: string[] = [];

  for (const store of ALL_STORES) {
    const serverKey = store === 'openingStock' ? 'openingStocks' : store;
    const entityType = ENTITY_FOR_STORE[store];
    const rows: any[] = state[serverKey] ?? [];

    for (const serverRow of rows) {
      const local = (await db.get(STORE_FOR_ENTITY[entityType], serverRow.id)) as any;

      // Preserve local pending mutations (scenario H):
      //   server confirmed state + local CREATE + local UPDATE − local DELETE
      if (isPending(local)) continue;
      if (isTombstone(local)) continue;
      if (pendingEntityIds.has(serverRow.id)) continue;
      if ((local?.version ?? -1) >= (serverRow.version ?? 0)) continue;

      await putLocalEntity(entityType, {
        ...(local ?? {}),
        ...serverRow,
        id: serverRow.id,
        migrationId,
        version: serverRow.version ?? 0,
        syncState: 'SYNCED',
      });
      written += 1;
    }

    // Rows the server has dropped are removed here, so a delete made on another
    // device does not stay visible on this one.
    removed.push(
      ...(await pruneLocalRows(store, migrationId, new Set(rows.map((row) => row.id)), {
        pendingEntityIds,
        authoritative,
      }))
    );
  }

  return { written, removed };
}

/**
 * Fetch the complete server state for a migration.
 *
 * `sinceRevision: 0` is what makes the response authoritative, and the server
 * says so explicitly with `fullState`; the flag is passed back so the caller only
 * prunes local rows when it really is holding everything.
 */
async function fetchServerState(
  migrationId: string
): Promise<{ state: ServerState; authoritative: boolean } | null> {
  try {
    const changes = await migrationApi.getChanges(migrationId, 0);
    const state = (changes?.state ?? null) as ServerState | null;
    if (!state) return null;
    if (typeof changes.toRevision === 'number') setMigrationRevision(changes.toRevision);
    return { state, authoritative: changes.fullState !== false };
  } catch (error) {
    console.warn('Could not fetch the existing migration from the server.', error);
    return null;
  }
}

/**
 * Full initial load. The caller must keep the form non-editable until this
 * resolves.
 *
 * `offline` carries the outcome of the identity lookup: a workspace that is
 * already on this device is perfectly editable without the server, but the UI
 * still has to say so.
 */
export async function hydrateWorkspace(
  migrationId: string,
  options: { offline?: boolean } = {}
): Promise<HydrationResult> {
  const db = await getDB();
  const localExists = await hasLocalWorkspace(migrationId);

  // Step 2/3: a local workspace is enough to render — but the server copy still
  // gets pulled in the background so a second device's work shows up.
  if (localExists) {
    const data = await loadWorkspace(migrationId);
    return {
      migrationId,
      data,
      source: 'LOCAL',
      revision: getMigrationRevision(),
      offline: options.offline ?? false,
    };
  }

  // Step 4: nothing local, so the server is the only source of truth. If it
  // cannot be reached we must NOT show an empty, editable migration.
  const fetched = await fetchServerState(migrationId);

  if (!fetched) {
    const data = await loadWorkspace(migrationId);
    return {
      migrationId,
      data,
      source: 'OFFLINE',
      revision: getMigrationRevision(),
      offline: true,
    };
  }

  // Step 5: populate IndexedDB from the server response.
  await reconcileServerState(migrationId, fetched.state, { authoritative: fetched.authoritative });

  // Step 6: the UI reads from IndexedDB, never from the raw response.
  const data = await loadWorkspace(migrationId);
  const empty =
    data.products.length === 0 && data.openingStock.length === 0 && data.batches.length === 0;

  setSetupStatus(empty ? 'not_started' : 'in_progress');

  const migrationDoc = await db.get('migrations', migrationId);
  await db.put('migrations', {
    ...(migrationDoc ?? { id: migrationId, name: 'Opening Inventory Migration' }),
    id: migrationId,
    revision: getMigrationRevision(),
  });

  return {
    migrationId,
    data,
    source: empty ? 'EMPTY' : 'SERVER',
    revision: getMigrationRevision(),
    offline: false,
  };
}
