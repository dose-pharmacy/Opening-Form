import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Download,
  Upload,
  FileJson,
  AlertTriangle,
  CheckCircle,
  ListChecks,
  HardDriveDownload,
} from 'lucide-react';
import { toast } from 'react-toastify';
import type {
  Batch,
  MigrationData,
  Product,
  StatusFilter,
  StockEntry,
  StockQuantity,
  UnitDefinition,
} from '../utils/types';
import { SCHEMA_VERSION } from '../utils/types';
import { validateMigration } from '../utils/validation';
import { parseImport } from '../utils/serialize';
import {
  isStorageAvailable,
  getActiveMigrationId,
  setSetupStatus,
} from '../utils/storage';
import { loadWorkspace } from '../local-store/entities';
import { batchIdFor } from '../sync/payloads';
import { OperationQueue } from '../sync/queue';
import {
  deleteRow,
  deleteStockEntry,
  importMigrationData,
  saveBatch,
  saveGroup,
  saveLocation,
  saveProduct,
  saveStockEntry,
  saveUnit,
} from '../sync/workspaceOps';
import { newId } from '../utils/ids';
import { InventoryTable } from '../components/InventoryTable';
import { migrationApi } from '../utils/migrationApi';
import { ProductDialog } from '../components/ProductDialog';
import { StockDialog } from '../components/StockDialog';
import { BatchDialog } from '../components/BatchDialog';
import { ReviewDialog } from '../components/ReviewDialog';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { SyncStatusIndicator } from '../components/SyncStatusIndicator';
import { ConflictDialog } from '../components/ConflictDialog';

import { hydrateWorkspace, resolveMigrationId } from '../sync/hydrate';
import { SyncManager } from '../sync/syncManager';

const DEFAULT_UNITS: UnitDefinition[] = [
  { name: 'Tablet', symbol: 'tab' },
  { name: 'Capsule', symbol: 'cap' },
  { name: 'Strip', symbol: 'strip' },
  { name: 'Box', symbol: 'box' },
  { name: 'Bottle', symbol: 'btl' },
  { name: 'Sachet', symbol: 'sach' },
  { name: 'Tube', symbol: 'tube' },
  { name: 'Vial', symbol: 'vial' },
  { name: 'Ampoule', symbol: 'amp' },
  { name: 'Piece', symbol: 'pc' },
];

const createInitialData = (): MigrationData => ({
  schemaVersion: SCHEMA_VERSION,
  productGroups: [],
  locations: [],
  suppliers: [],
  units: DEFAULT_UNITS,
  products: [],
  batches: [],
  openingStock: [],
});

const draftIsEmpty = (data: MigrationData): boolean =>
  data.openingStock.length === 0 && data.products.length === 0 && data.batches.length === 0;

/** Hydration gate. Mutations and sync are forbidden until this is READY. */
type HydrationStatus = 'LOADING' | 'READY' | 'ERROR';
/** Runtime connection state, kept separate from hydration. */
type SyncStatus = 'READY' | 'SYNCING' | 'OFFLINE' | 'SYNC_ERROR';

const Home: React.FC = () => {
  const [data, setData] = useState<MigrationData>(createInitialData);
  const [hydration, setHydration] = useState<HydrationStatus>('LOADING');
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('READY');
  const [storageError, setStorageError] = useState<string | null>(null);
  const [hydratedFrom, setHydratedFrom] = useState<'LOCAL' | 'SERVER' | 'EMPTY' | 'OFFLINE' | null>(null);

  const [productEditor, setProductEditor] = useState<{ mode: 'new' } | { mode: 'edit'; sku: string } | null>(null);
  const [stockEntryId, setStockEntryId] = useState<string | null>(null);
  const [batchEntryId, setBatchEntryId] = useState<string | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [conflictsOpen, setConflictsOpen] = useState(false);
  const [pendingImport, setPendingImport] = useState<MigrationData | null>(null);

  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [focusEntryId, setFocusEntryId] = useState<string | null>(null);
  const [resetFiltersToken, setResetFiltersToken] = useState(0);

  // ── Server migration identity ──────────────────────────────────────
  const [migrationId, setMigrationId] = useState<string | null>(getActiveMigrationId);
  const [syncToken, setSyncToken] = useState(0);
  /** Bumped by "Retry"; hydration cannot depend on the id alone (it may be null). */
  const [hydrationToken, setHydrationToken] = useState(0);

  /** Reload the UI from the IndexedDB workspace (the only local source). */
  const reloadWorkspace = useCallback(async (mid: string) => {
    setData(await loadWorkspace(mid));
  }, []);

  const retryHydration = useCallback(() => {
    setHydratedFrom(null);
    setSyncStatus(SyncManager.isOnline() ? 'READY' : 'OFFLINE');
    setHydration('LOADING');
    setMigrationId(getActiveMigrationId());
    setHydrationToken((token) => token + 1);
  }, []);

  /**
   * Hydration. Runs whenever the migration identity changes and is the only
   * place that decides whether the form may be edited.
   *
   * Nothing below may read `data` as "the user's truth" before this resolves —
   * that is exactly what used to turn an empty list into DELETEs.
   */
  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      setHydration('LOADING');
      setData(createInitialData());

      const resolution = await resolveMigrationId();
      if (cancelled) return;

      if (!resolution.migrationId) {
        // No identity and no reachable server: show the offline/loading state
        // instead of pretending the migration is empty.
        setSyncStatus('OFFLINE');
        setHydratedFrom('OFFLINE');
        setHydration('ERROR');
        return;
      }

      const id = resolution.migrationId;
      if (resolution.migrationId !== migrationId) setMigrationId(id);

      try {
        const result = await hydrateWorkspace(id, { offline: resolution.offline });
        if (cancelled) return;

        setHydratedFrom(result.source);
        setSyncStatus(result.offline ? 'OFFLINE' : 'READY');

        if (result.source === 'OFFLINE' && draftIsEmpty(result.data)) {
          // Nothing local, nothing from the server: this is not an empty
          // migration, it is an unreachable one.
          setHydration('ERROR');
          return;
        }

        setData(result.data);
        setHydration('READY');
        setSetupStatus(draftIsEmpty(result.data) ? 'not_started' : 'in_progress');

        if (result.offline) return;

        // Background sync: push the outbox, then reconcile the server copy.
        void SyncManager.flushMigration(id).then((summary) => {
          if (cancelled) return;
          if (summary.unreachable) setSyncStatus('OFFLINE');
          else if (summary.errors > 0) setSyncStatus('SYNC_ERROR');
          return reloadWorkspace(id);
        });
      } catch (error) {
        console.error('Hydration failed', error);
        if (!cancelled) setHydration('ERROR');
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
    // Intentionally runs for the identity only: hydration must not restart
    // because React re-rendered. `hydrationToken` is the explicit retry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [migrationId, hydrationToken, reloadWorkspace]);

  /** Track connectivity so the UI can distinguish offline from failed. */
  useEffect(() => {
    const goOnline = () => {
      if (!migrationId) {
        retryHydration();
        return;
      }
      setSyncStatus('SYNCING');
      void SyncManager.flushMigration(migrationId)
        .then((summary) => {
          setSyncStatus(summary.unreachable ? 'OFFLINE' : summary.errors > 0 ? 'SYNC_ERROR' : 'READY');
          return reloadWorkspace(migrationId);
        })
        .catch(() => setSyncStatus('SYNC_ERROR'));
    };
    const goOffline = () => setSyncStatus('OFFLINE');

    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    if (!navigator.onLine) setSyncStatus('OFFLINE');
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, [migrationId, reloadWorkspace, retryHydration]);

  // ── Persistence ────────────────────────────────────────────────────
  useEffect(() => {
    if (!isStorageAvailable()) {
      setStorageError('Local storage is unavailable in this browser — you cannot use this form.');
    }
  }, []);

  useEffect(() => {
    if (storageError) toast.warn(storageError, { toastId: 'storage-error' });
  }, [storageError]);

  /** Every mutation goes through here: one write, one reload from IndexedDB. */
  const apply = useCallback(
    async (action: () => Promise<unknown>) => {
      if (hydration !== 'READY' || !migrationId) return;
      try {
        setSyncStatus('SYNCING');
        await action();
        await reloadWorkspace(migrationId);
        // Push right away so the header reflects reality instead of waiting for
        // the background timer.
        const summary = await SyncManager.flushMigration(migrationId);
        await reloadWorkspace(migrationId);
        setSyncToken((token) => token + 1);
        setSyncStatus(
          summary.unreachable ? 'OFFLINE' : summary.errors > 0 ? 'SYNC_ERROR' : 'READY'
        );
      } catch (error) {
        console.error('Local change could not be stored', error);
        setSyncStatus('SYNC_ERROR');
        toast.error('That change could not be saved locally. Nothing was lost — please retry.');
      }
    },
    [hydration, migrationId, reloadWorkspace]
  );

  // ── Derived ────────────────────────────────────────────────────────
  const validation = useMemo(() => validateMigration(data), [data]);

  const activeProduct = useMemo(() => {
    if (!productEditor || productEditor.mode === 'new') return undefined;
    return data.products.find((p) => p.sku === productEditor.sku);
  }, [productEditor, data.products]);

  const stockEntry = useMemo(
    () => data.openingStock.find((e) => e.id === stockEntryId) ?? null,
    [data.openingStock, stockEntryId]
  );

  const batchEntry = useMemo(
    () => data.openingStock.find((e) => e.id === batchEntryId) ?? null,
    [data.openingStock, batchEntryId]
  );

  const productFor = useCallback(
    (sku?: string | null) => data.products.find((p) => p.sku === sku),
    [data.products]
  );

  const batchFor = useCallback(
    (sku?: string | null, batchNumber?: string | null) =>
      data.batches.find((b) => b.productSku === sku && b.batchNumber === batchNumber),
    [data.batches]
  );

  // ── Catalogue helpers ──────────────────────────────────────────────
  const createGroup = useCallback(
    (name: string) => {
      const trimmed = name.trim();
      if (!trimmed || data.productGroups.some((item) => item.name.toLowerCase() === trimmed.toLowerCase())) return;
      void apply(() => saveGroup(migrationId!, trimmed));
    },
    [data.productGroups, migrationId, apply]
  );

  const createLocation = useCallback(
    (name: string) => {
      const trimmed = name.trim();
      if (!trimmed || data.locations.some((item) => item.name.toLowerCase() === trimmed.toLowerCase())) return;
      void apply(() => saveLocation(migrationId!, trimmed));
    },
    [data.locations, migrationId, apply]
  );

  const createSupplier = useCallback((name: string) => {
    const trimmed = name.trim();
    setData((prev) =>
      prev.suppliers.some((item) => item.name.toLowerCase() === trimmed.toLowerCase())
        ? prev
        : { ...prev, suppliers: [...prev.suppliers, { name: trimmed }] }
    );
  }, []);

  const createUnit = useCallback(
    (name: string) => {
      const trimmed = name.trim();
      if (!trimmed || data.units.some((item) => item.name.toLowerCase() === trimmed.toLowerCase())) return;
      void apply(() => saveUnit(migrationId!, { name: trimmed, symbol: '' }));
    },
    [data.units, migrationId, apply]
  );

  const updateUnitSymbol = useCallback(
    (name: string, symbol: string) => {
      const existing = data.units.find((u) => u.name === name);
      if (!existing) return;
      void apply(() => saveUnit(migrationId!, { ...existing, symbol }));
    },
    [data.units, migrationId, apply]
  );

  // ── Row operations ─────────────────────────────────────────────────
  const handleAddRow = useCallback(() => {
    const entry: StockEntry = {
      id: newId(),
      productSku: '',
      batchNumber: '',
      location: data.locations[0]?.name ?? '',
      quantities: [],
    };
    void apply(async () => {
      await saveStockEntry(migrationId!, entry, undefined, undefined);
      setFocusEntryId(entry.id);
    });
  }, [data.locations, migrationId, apply]);

  const duplicateStockEntry = useCallback(
    (source: StockEntry): StockEntry => ({
      ...source,
      id: newId(),
      quantities: source.quantities.map((q) => ({ ...q })),
    }),
    []
  );

  const handleDuplicateRow = useCallback(
    (id: string) => {
      const source = data.openingStock.find((e) => e.id === id);
      if (!source) return;
      const copy = duplicateStockEntry(source);
      void apply(() =>
        saveStockEntry(migrationId!, copy, productFor(copy.productSku), batchFor(copy.productSku, copy.batchNumber))
      );
    },
    [data.openingStock, duplicateStockEntry, migrationId, productFor, batchFor, apply]
  );

  const handleDuplicateRows = useCallback(
    (ids: string[]) => {
      const copies = ids
        .map((id) => data.openingStock.find((e) => e.id === id))
        .filter((entry): entry is StockEntry => Boolean(entry))
        .map(duplicateStockEntry);
      if (copies.length === 0) return;
      void apply(async () => {
        for (const copy of copies) {
          await saveStockEntry(
            migrationId!,
            copy,
            productFor(copy.productSku),
            batchFor(copy.productSku, copy.batchNumber)
          );
        }
      });
    },
    [data.openingStock, duplicateStockEntry, migrationId, productFor, batchFor, apply]
  );

  const handleDeleteRow = useCallback(
    (id: string) => {
      const entry = data.openingStock.find((e) => e.id === id);
      if (!entry) return;
      void apply(() => deleteStockEntry(migrationId!, entry));
    },
    [data.openingStock, migrationId, apply]
  );

  const handleDeleteRows = useCallback(
    (ids: string[]) => {
      const entries = ids
        .map((id) => data.openingStock.find((e) => e.id === id))
        .filter((entry): entry is StockEntry => Boolean(entry));
      if (entries.length === 0) return;
      void apply(async () => {
        for (const entry of entries) {
          await deleteStockEntry(migrationId!, entry);
        }
      });
    },
    [data.openingStock, migrationId, apply]
  );

  const persistEntry = useCallback(
    (entry: StockEntry) =>
      apply(() =>
        saveStockEntry(migrationId!, entry, productFor(entry.productSku), batchFor(entry.productSku, entry.batchNumber))
      ),
    [migrationId, productFor, batchFor, apply]
  );

  const patchEntry = useCallback(
    (id: string, changes: Partial<StockEntry>) => {
      const entry = data.openingStock.find((e) => e.id === id);
      if (!entry) return;
      void persistEntry({ ...entry, ...changes });
    },
    [data.openingStock, persistEntry]
  );

  const setProduct = useCallback(
    (entryId: string, sku: string) => {
      const entry = data.openingStock.find((e) => e.id === entryId);
      if (!entry) return;
      void persistEntry({
        ...entry,
        productSku: sku,
        batchNumber: sku === entry.productSku ? entry.batchNumber : '',
        quantities: sku === entry.productSku ? entry.quantities : [],
      });
    },
    [data.openingStock, persistEntry]
  );

  const setProductGroup = useCallback(
    (sku: string, group: string) => {
      const product = data.products.find((p) => p.sku === sku);
      if (!product) return;
      void apply(() => saveProduct(migrationId!, { ...product, productGroup: group }));
    },
    [data.products, migrationId, apply]
  );

  const setBatchNumber = useCallback(
    (entryId: string, batchNumber: string) => {
      const entry = data.openingStock.find((e) => e.id === entryId);
      if (!entry) return;
      void persistEntry({ ...entry, batchNumber });
    },
    [data.openingStock, persistEntry]
  );

  const setExpiry = useCallback(
    (entryId: string, expiryDate: string) => {
      const entry = data.openingStock.find((e) => e.id === entryId);
      if (!entry || !entry.productSku || !entry.batchNumber) return;
      const existing = batchFor(entry.productSku, entry.batchNumber);
      const batch: Batch = existing
        ? { ...existing, expiryDate }
        : {
            productSku: entry.productSku,
            batchNumber: entry.batchNumber,
            expiryDate,
            manufacturingDate: null,
            receivedDate: null,
            supplier: null,
            supplierReference: null,
          };
      void apply(async () => {
        await saveBatch(migrationId!, batch);
        // The row may only now be storable on the server.
        await saveStockEntry(migrationId!, entry, productFor(entry.productSku), batch);
      });
    },
    [migrationId, batchFor, productFor, apply]
  );

  // ── Product dialog ─────────────────────────────────────────────────
  const handleSaveProduct = useCallback(
    async (product: Product) => {
      if (!migrationId || hydration !== 'READY') return;
      await apply(() => saveProduct(migrationId, product));
      setProductEditor(null);
      toast.success(`Product "${product.name}" saved`);
    },
    [migrationId, hydration, apply]
  );

  // ── Stock / batch dialogs ──────────────────────────────────────────
  const handleSaveStock = useCallback(
    async (quantities: StockQuantity[]) => {
      if (!stockEntryId || !migrationId) return;
      const entry = data.openingStock.find((e) => e.id === stockEntryId);
      if (!entry) return;
      await persistEntry({ ...entry, quantities });
      setStockEntryId(null);
      toast.success('Opening stock updated');
    },
    [stockEntryId, migrationId, data.openingStock, persistEntry]
  );

  const handleSaveBatch = useCallback(
    async (batch: Batch) => {
      if (!batchEntry || !migrationId) return;
      const originalBatchNumber = batchEntry.batchNumber;
      const renamed = Boolean(originalBatchNumber) && originalBatchNumber !== batch.batchNumber;

      await apply(async () => {
        await saveBatch(migrationId!, batch);
        if (renamed) {
          // A renamed batch is a different server row: retire the old one.
          await deleteRow(migrationId!, 'BATCH', batchIdFor(migrationId!, batch.productSku, originalBatchNumber));
          await saveStockEntry(
            migrationId!,
            { ...batchEntry, batchNumber: batch.batchNumber },
            productFor(batch.productSku),
            batch
          );
        }
      });

      setBatchEntryId(null);
      toast.success('Batch details saved');
    },
    [batchEntry, migrationId, productFor, apply]
  );

  // ── Import / export ────────────────────────────────────────────────
  const handleExport = useCallback(async () => {
    if (!validation.canExport) {
      toast.error(`Cannot export: ${validation.errors.length} blocking error(s) found.`);
      setReviewOpen(true);
      return;
    }

    if (!migrationId) {
      toast.error('The migration service is unreachable — the server copy cannot be exported yet.');
      return;
    }

    // The export is produced from the server copy, so everything must be pushed first.
    const summary = await SyncManager.flushMigration(migrationId);
    setSyncToken((token) => token + 1);
    if (summary.unreachable) {
      setSyncStatus('OFFLINE');
      toast.error('The migration service is unreachable — your changes are safe on this device and will sync automatically.');
      return;
    }
    if (summary.remaining > 0) {
      setSyncStatus('SYNC_ERROR');
      toast.error(
        `Cannot export yet: ${summary.remaining} change(s) have not reached the server. Resolve the sync issues first.`
      );
      return;
    }
    if (summary.conflicts > 0 || summary.errors > 0) {
      setSyncStatus('SYNC_ERROR');
      toast.error('Resolve the sync issues before exporting.');
      setConflictsOpen(true);
      return;
    }

    try {
      const canonicalJson = await migrationApi.exportMigration(migrationId);
      const name = `opening-inventory-export-${new Date().toISOString().split('T')[0]}.json`;
      const blob = new Blob([JSON.stringify(canonicalJson, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast.success(`Exported ${name}`);
    } catch {
      toast.error('Export failed — could not fetch canonical JSON from server.');
    }
  }, [validation, migrationId]);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleImportFile = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (loadEvent) => {
      const result = parseImport((loadEvent.target?.result as string) ?? '');
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      setPendingImport(result.data);
    };
    reader.onerror = () => toast.error('The file could not be read.');
    reader.readAsText(file);
  }, []);

  const applyImport = useCallback(
    (imported: MigrationData) => {
      if (!migrationId) return;
      setPendingImport(null);
      void apply(async () => {
        const queued = await importMigrationData(migrationId, imported);
        toast.success(`Imported ${queued} change(s) — review, then export.`);
      });
      setStatusFilter('all');
      setResetFiltersToken((t) => t + 1);
    },
    [migrationId, apply]
  );

  const navigateToEntry = useCallback((entryId: string) => {
    setStatusFilter('all');
    setResetFiltersToken((t) => t + 1);
    setFocusEntryId(entryId);
  }, []);

  const { counts } = validation;
  const { counts: idbCounts } = useOutboxCounts(migrationId, syncToken);

  const statusLabel =
    hydration === 'LOADING'
      ? 'Loading existing opening data…'
      : hydration === 'ERROR'
        ? 'Waiting for the migration service'
        : syncStatus === 'OFFLINE'
          ? 'Offline — changes will sync when the connection returns'
          : syncStatus === 'SYNC_ERROR'
            ? 'Sync failed — your local changes are safe'
            : syncStatus === 'SYNCING'
              ? 'Saving…'
              : 'Ready · changes sync automatically';

  const statusDotClass =
    hydration !== 'READY'
      ? 'animate-pulse bg-amber-400'
      : syncStatus === 'OFFLINE'
        ? 'bg-amber-500'
        : syncStatus === 'SYNC_ERROR'
          ? 'bg-destructive'
          : syncStatus === 'SYNCING'
            ? 'animate-pulse bg-blue-500'
            : 'bg-accent';

  return (
    <div className="flex min-h-screen flex-col bg-canvas">
      <header className="sticky top-0 z-30 border-b border-primary-mid/20 bg-white/95 px-4 py-3 shadow-sm backdrop-blur sm:px-8">
        <div className="mx-auto flex max-w-[1500px] flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent shadow-md">
              <FileJson className="h-5 w-5 text-white" />
            </div>
            <div>
              <h1 className="font-serif text-lg font-bold leading-tight text-text-primary">
                Opening Inventory Setup
              </h1>
              <div className="flex items-center gap-1.5 text-[11px] text-text-muted">
                <span className={`h-1.5 w-1.5 rounded-full ${statusDotClass}`} />
                {statusLabel}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setReviewOpen(true)}
              className="flex items-center gap-2 rounded-lg border border-primary-mid/40 px-3.5 py-2 text-sm font-medium text-text-secondary transition-colors hover:border-accent hover:text-accent"
            >
              <ListChecks className="h-4 w-4" />
              Review
              {validation.errors.length > 0 && (
                <span className="rounded-full bg-destructive px-1.5 text-[10px] font-bold text-white">
                  {validation.errors.length}
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium text-text-secondary transition-colors hover:bg-primary-light"
            >
              <Upload className="h-4 w-4" />
              Import JSON
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={handleImportFile}
            />
            <button
              type="button"
              onClick={handleExport}
              className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white shadow-md transition-all hover:bg-accent-soft hover:shadow-lg"
            >
              <Download className="h-4 w-4" />
              Export JSON
            </button>
          </div>
        </div>
      </header>

      {hydration === 'LOADING' ? (
        <main className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-text-secondary">
          <span className="h-6 w-6 animate-spin rounded-full border-2 border-primary-mid border-t-accent" />
          <p className="text-sm font-medium">Loading existing opening data...</p>
          <p className="text-xs text-text-muted">Checking this device first, then the server.</p>
        </main>
      ) : hydration === 'ERROR' ? (
        <main className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
          <AlertTriangle className="h-8 w-8 text-amber-500" />
          <p className="text-sm font-medium text-text-primary">
            {hydratedFrom === 'OFFLINE' || syncStatus === 'OFFLINE'
              ? 'Offline — the existing opening data could not be loaded.'
              : 'Failed to load migration data.'}
          </p>
          <p className="max-w-md text-xs text-text-muted">
            {hydratedFrom === 'OFFLINE' || syncStatus === 'OFFLINE'
              ? 'This device has no local copy and the migration service is unreachable, so an empty form would be misleading. Reconnect and retry — nothing has been changed.'
              : 'The migration workspace could not be prepared. Retry in a moment.'}
          </p>
          <button
            type="button"
            onClick={retryHydration}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white shadow-md transition-colors hover:bg-accent-soft"
          >
            Retry
          </button>
        </main>
      ) : (
        <main className="mx-auto flex w-full max-w-[1500px] flex-1 flex-col gap-4 p-4 sm:p-8">
          {/* Compact status strip */}
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border border-primary-mid/20 bg-white px-5 py-3 text-sm shadow-sm">
            <Metric label="Products" value={counts.products} />
            <Metric label="Stock entries" value={counts.rows} />
            <Metric label="Valid" value={counts.valid} tone="ok" />
            <Metric label="Warnings" value={counts.warnings} tone="warn" />
            <Metric label="Errors" value={counts.errors} tone="bad" />
            <div className="ml-auto flex items-center gap-4 text-xs">
              <SyncStatusIndicator
                migrationId={migrationId}
                refreshToken={syncToken}
                syncStatus={syncStatus}
                pendingCount={idbCounts.pending}
                conflictCount={idbCounts.conflicts}
                errorCount={idbCounts.errors}
                onReviewConflicts={() => setConflictsOpen(true)}
              />
              {isStorageAvailable() ? (
                <div className="flex items-center gap-1">
                  <HardDriveDownload className="h-3.5 w-3.5 text-accent" />
                  <span className="text-text-secondary">Saved on this device</span>
                </div>
              ) : (
                <div className="flex items-center gap-1">
                  <AlertTriangle className="h-3.5 w-3.5 text-destructive" />
                  <span className="text-destructive">Local storage unavailable</span>
                </div>
              )}
            </div>
          </div>

          {syncStatus === 'OFFLINE' && (
            <div className="flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-4 py-2.5 text-sm text-amber-800">
              <AlertTriangle className="h-4 w-4" />
              <span>
                Offline — {idbCounts.pending > 0 ? `${idbCounts.pending} change(s) will sync when the connection returns.` : 'your saved changes are safe on this device.'}
              </span>
            </div>
          )}

          {syncStatus === 'SYNC_ERROR' && (
            <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-2.5 text-sm text-destructive">
              <AlertTriangle className="h-4 w-4" />
              <span>
                Sync failed — your local changes are still safe.{' '}
                <button type="button" onClick={() => setConflictsOpen(true)} className="font-semibold underline">
                  Retry
                </button>
              </span>
            </div>
          )}

          {validation.errors.length > 0 && (
            <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                {validation.errors.length} blocking error(s) — export is disabled until they are fixed.{' '}
                <button type="button" onClick={() => setReviewOpen(true)} className="font-semibold underline">
                  Review now
                </button>
              </span>
            </div>
          )}

          {validation.errors.length === 0 && counts.rows > 0 && (
            <div className="flex items-center gap-2 rounded-lg border border-primary-mid/30 bg-primary-light/40 px-4 py-2.5 text-sm text-accent">
              <CheckCircle className="h-4 w-4" />
              <span>All rows are valid — ready to export.</span>
            </div>
          )}

          <div className="min-h-[560px] flex-1">
            <InventoryTable
              data={data}
              validation={validation}
              statusFilter={statusFilter}
              onStatusFilterChange={setStatusFilter}
              focusEntryId={focusEntryId}
              onFocusHandled={() => setFocusEntryId(null)}
              resetFiltersToken={resetFiltersToken}
              onUpdateStock={(entry) => setStockEntryId(entry.id)}
              onAddRow={handleAddRow}
              onAddProduct={() => setProductEditor({ mode: 'new' })}
              onDuplicateRow={handleDuplicateRow}
              onDeleteRow={handleDeleteRow}
              onDuplicateRows={handleDuplicateRows}
              onDeleteRows={handleDeleteRows}
              onEditProduct={(sku) => setProductEditor(sku ? { mode: 'edit', sku } : { mode: 'new' })}
              onOpenBatch={(entryId) => setBatchEntryId(entryId)}
              onSetProduct={setProduct}
              onSetBatchNumber={setBatchNumber}
              onSetExpiry={setExpiry}
              onSetLocation={(entryId, location) => patchEntry(entryId, { location })}
              onSetProductGroup={setProductGroup}
              onCreateGroup={createGroup}
              onCreateLocation={createLocation}
            />
          </div>
        </main>
      )}

      <footer className="border-t border-primary-mid/20 bg-primary-light/30 px-4 py-3 sm:px-8">
        <div className="mx-auto flex max-w-[1500px] flex-wrap items-center justify-between gap-2 text-[11px] text-text-secondary">
          <span>
            Enter stock in the physical units you counted — totals are previewed only. The production importer
            performs the authoritative conversion.
          </span>
          <span>Opening Inventory Migration Tool · schema {SCHEMA_VERSION}</span>
        </div>
      </footer>

      {/* Dialogs */}
      {productEditor && (
        <ProductDialog
          product={activeProduct}
          groups={data.productGroups.map((g) => g.name)}
          unitCatalogue={data.units}
          existingSkus={data.products.map((p) => p.sku)}
          onCreateGroup={createGroup}
          onCreateUnit={createUnit}
          onUpdateUnitSymbol={updateUnitSymbol}
          onSave={handleSaveProduct}
          onClose={() => setProductEditor(null)}
        />
      )}

      {stockEntry && stockEntry.productSku && productFor(stockEntry.productSku) && (
        <StockDialog
          product={productFor(stockEntry.productSku) as Product}
          entry={stockEntry}
          onSave={handleSaveStock}
          onClose={() => setStockEntryId(null)}
        />
      )}

      {batchEntry && batchEntry.productSku && productFor(batchEntry.productSku) && (
        <BatchDialog
          product={productFor(batchEntry.productSku) as Product}
          batch={batchFor(batchEntry.productSku, batchEntry.batchNumber)}
          initialBatchNumber={batchEntry.batchNumber}
          suppliers={data.suppliers.map((s) => s.name)}
          onCreateSupplier={createSupplier}
          onSave={handleSaveBatch}
          onClose={() => setBatchEntryId(null)}
        />
      )}

      {reviewOpen && (
        <ReviewDialog
          data={data}
          validation={validation}
          onNavigate={navigateToEntry}
          onExport={handleExport}
          onClose={() => setReviewOpen(false)}
        />
      )}

      {conflictsOpen && migrationId && (
        <ConflictDialog migrationId={migrationId} onClose={() => setConflictsOpen(false)} />
      )}

      {pendingImport && (
        <ConfirmDialog
          title="Replace the current draft?"
          message={
            draftIsEmpty(data)
              ? `Load "${pendingImport.products.length} product(s) and ${pendingImport.openingStock.length} stock entr(ies)" into the workspace?`
              : `Your current work (${data.products.length} product(s), ${data.openingStock.length} stock entr(ies)) will be replaced by the imported file. Export it first if you want to keep a copy.`
          }
          confirmLabel="Import & replace"
          cancelLabel="Keep current work"
          destructive={!draftIsEmpty(data)}
          onConfirm={() => applyImport(pendingImport)}
          onCancel={() => setPendingImport(null)}
        />
      )}
    </div>
  );
};

/** Poll the outbox so the indicator reflects queued work without a re-render storm. */
function useOutboxCounts(migrationId: string | null, refreshToken: number) {
  const [counts, setCounts] = useState({ pending: 0, conflicts: 0, errors: 0 });

  useEffect(() => {
    if (!migrationId) return;
    let cancelled = false;

    const read = async () => {
      const next = await OperationQueue.counts(migrationId);
      if (!cancelled) setCounts(next);
    };

    void read();
    const interval = setInterval(read, 1500);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [migrationId, refreshToken]);

  return { counts };
}

const Metric: React.FC<{ label: string; value: number; tone?: 'ok' | 'warn' | 'bad' }> = ({
  label,
  value,
  tone,
}) => (
  <div className="flex items-baseline gap-2">
    <span className="text-[10px] font-bold uppercase tracking-widest text-text-muted">{label}</span>
    <span
      className={`text-base font-bold ${
        tone === 'ok' ? 'text-accent' : tone === 'warn' ? 'text-amber-500' : tone === 'bad' ? 'text-destructive' : 'text-text-primary'
      }`}
    >
      {value}
    </span>
  </div>
);

export default Home;
