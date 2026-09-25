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
  UnitConfig,
  UnitDefinition,
} from '../utils/types';
import { SCHEMA_VERSION } from '../utils/types';
import { resolveConversionFactors } from '../utils/conversions';
import { validateMigration } from '../utils/validation';
import { downloadJson, parseImport } from '../utils/serialize';
import { isStorageAvailable, loadDraft, saveDraft } from '../utils/storage';
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

/** Drop batch records that no stock entry references any more. */
const pruneBatches = (data: MigrationData): MigrationData => {
  const referenced = new Set(
    data.openingStock
      .filter((e) => e.productSku && e.batchNumber)
      .map((e) => `${e.productSku}::${e.batchNumber}`)
  );
  const batches = data.batches.filter((b) => referenced.has(`${b.productSku}::${b.batchNumber}`));
  return batches.length === data.batches.length ? data : { ...data, batches };
};

const addNamed = <T extends { name: string }>(list: T[], name: string, factory: (name: string) => T): T[] => {
  const trimmed = name.trim();
  if (!trimmed || list.some((item) => item.name.toLowerCase() === trimmed.toLowerCase())) return list;
  return [...list, factory(trimmed)];
};

type SaveState = 'saved' | 'saving' | 'error';

const Home: React.FC = () => {
  const [data, setData] = useState<MigrationData>(() => {
    const { data: saved } = loadDraft();
    return saved ?? createInitialData();
  });
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);

  const [productEditor, setProductEditor] = useState<{ mode: 'new' } | { mode: 'edit'; sku: string } | null>(null);
  const [stockEntryId, setStockEntryId] = useState<string | null>(null);
  const [batchEntryId, setBatchEntryId] = useState<string | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [conflictsOpen, setConflictsOpen] = useState(false);
  const [pendingImport, setPendingImport] = useState<MigrationData | null>(null);

  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [focusEntryId, setFocusEntryId] = useState<string | null>(null);
  const [resetFiltersToken, setResetFiltersToken] = useState(0);
  
  // Phase 1 basic integration: get or create a default migrationId
  const [migrationId, setMigrationId] = useState<string | null>(null);

  useEffect(() => {
    migrationApi.createMigration('Default Pharmacy Migration')
      .then(res => setMigrationId(res.id))
      .catch(console.error);
  }, []);

  const firstRun = useRef(true);

  // ── Persistence ────────────────────────────────────────────────────
  useEffect(() => {
    if (!isStorageAvailable()) {
      setStorageError('Local storage is unavailable in this browser — remember to export your JSON to keep your work.');
      return;
    }
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    setSaveState('saving');
    const timer = setTimeout(() => {
      const result = saveDraft(data);
      if (result.ok) {
        setSaveState('saved');
        setSavedAt(result.savedAt);
        setStorageError(null);
      } else {
        setSaveState('error');
        setStorageError(result.error);
      }
    }, 600);
    return () => clearTimeout(timer);
  }, [data]);

  useEffect(() => {
    if (storageError) toast.warn(storageError, { toastId: 'storage-error' });
  }, [storageError]);

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

  // ── Catalogue helpers ──────────────────────────────────────────────
  const createGroup = useCallback((name: string) => {
    setData((prev) => ({ ...prev, productGroups: addNamed(prev.productGroups, name, (n) => ({ name: n })) }));
    if (migrationId) migrationApi.createGroup(migrationId, { name }).catch(console.error);
  }, [migrationId]);

  const createLocation = useCallback((name: string) => {
    setData((prev) => ({ ...prev, locations: addNamed(prev.locations, name, (n) => ({ name: n })) }));
    if (migrationId) migrationApi.createLocation(migrationId, { name }).catch(console.error);
  }, [migrationId]);

  const createSupplier = useCallback((name: string) => {
    setData((prev) => ({ ...prev, suppliers: addNamed(prev.suppliers, name, (n) => ({ name: n })) }));
    // Supplier API might not exist yet based on phase 1, ignore for now
  }, []);

  const createUnit = useCallback((name: string) => {
    setData((prev) => ({
      ...prev,
      units: addNamed(prev.units, name, (n) => ({ name: n, symbol: '' })),
    }));
    if (migrationId) migrationApi.createUnit(migrationId, { name }).catch(console.error);
  }, [migrationId]);

  const updateUnitSymbol = useCallback((name: string, symbol: string) => {
    setData((prev) => ({
      ...prev,
      units: prev.units.map((u) => (u.name === name ? { ...u, symbol } : u)),
    }));
  }, []);

  // ── Row operations ─────────────────────────────────────────────────
  const handleAddRow = useCallback(() => {
    const entry: StockEntry = {
      id: newId(),
      productSku: '',
      batchNumber: '',
      location: '',
      quantities: [],
    };
    setData((prev) => ({
      ...prev,
      openingStock: [
        ...prev.openingStock,
        { ...entry, location: prev.locations[0]?.name ?? '' },
      ],
    }));
    setFocusEntryId(entry.id);
  }, []);

  const handleDuplicateRow = useCallback((id: string) => {
    setData((prev) => {
      const index = prev.openingStock.findIndex((e) => e.id === id);
      if (index < 0) return prev;
      const source = prev.openingStock[index];
      const copy: StockEntry = {
        ...source,
        id: newId(),
        quantities: source.quantities.map((q) => ({ ...q })),
      };
      const openingStock = [...prev.openingStock];
      openingStock.splice(index + 1, 0, copy);
      return { ...prev, openingStock };
    });
  }, []);

  const handleDuplicateRows = useCallback((ids: string[]) => {
    setData((prev) => {
      const copies: StockEntry[] = [];
      ids.forEach((id) => {
        const source = prev.openingStock.find((e) => e.id === id);
        if (source) {
          copies.push({ ...source, id: newId(), quantities: source.quantities.map((q) => ({ ...q })) });
        }
      });
      return { ...prev, openingStock: [...prev.openingStock, ...copies] };
    });
  }, []);

  const handleDeleteRow = useCallback((id: string) => {
    setData((prev) => pruneBatches({ ...prev, openingStock: prev.openingStock.filter((e) => e.id !== id) }));
  }, []);

  const handleDeleteRows = useCallback((ids: string[]) => {
    const set = new Set(ids);
    setData((prev) => pruneBatches({ ...prev, openingStock: prev.openingStock.filter((e) => !set.has(e.id)) }));
  }, []);

  const patchEntry = useCallback((id: string, changes: Partial<StockEntry>) => {
    setData((prev) => ({
      ...prev,
      openingStock: prev.openingStock.map((e) => (e.id === id ? { ...e, ...changes } : e)),
    }));
  }, []);

  const setProduct = useCallback((entryId: string, sku: string) => {
    setData((prev) => {
      const product = prev.products.find((p) => p.sku === sku);
      return {
        ...prev,
        openingStock: prev.openingStock.map((e) =>
          e.id === entryId
            ? {
                ...e,
                productSku: sku,
                batchNumber: sku === e.productSku ? e.batchNumber : '',
                quantities: sku === e.productSku ? e.quantities : [],
              }
            : e
        ),
      };
    });
  }, []);

  const setProductGroup = useCallback((sku: string, group: string) => {
    setData((prev) => ({
      ...prev,
      productGroups: addNamed(prev.productGroups, group, (n) => ({ name: n })),
      products: prev.products.map((p) => (p.sku === sku ? { ...p, productGroup: group } : p)),
    }));
  }, []);

  const upsertBatch = useCallback((batch: Batch) => {
    setData((prev) => {
      const exists = prev.batches.some(
        (b) => b.productSku === batch.productSku && b.batchNumber === batch.batchNumber
      );
      const batches = exists
        ? prev.batches.map((b) =>
            b.productSku === batch.productSku && b.batchNumber === batch.batchNumber ? batch : b
          )
        : [...prev.batches, batch];
      return { ...prev, batches };
    });
  }, []);

  const setBatchNumber = useCallback((entryId: string, batchNumber: string) => {
    patchEntry(entryId, { batchNumber });
  }, [patchEntry]);

  const setExpiry = useCallback(
    (entryId: string, expiryDate: string) => {
      setData((prev) => {
        const entry = prev.openingStock.find((e) => e.id === entryId);
        if (!entry || !entry.productSku || !entry.batchNumber) return prev;
        const key = { productSku: entry.productSku, batchNumber: entry.batchNumber };
        const existing = prev.batches.find(
          (b) => b.productSku === key.productSku && b.batchNumber === key.batchNumber
        );
        const batch: Batch = existing
          ? { ...existing, expiryDate }
          : {
              ...key,
              expiryDate,
              manufacturingDate: null,
              receivedDate: null,
              supplier: null,
              supplierReference: null,
            };
        const batches = existing
          ? prev.batches.map((b) =>
              b.productSku === key.productSku && b.batchNumber === key.batchNumber ? batch : b
            )
          : [...prev.batches, batch];
        return { ...prev, batches };
      });
    },
    []
  );

  // ── Product dialog ─────────────────────────────────────────────────
  const handleSaveProduct = useCallback(
    (product: Product) => {
      const originalSku = productEditor && productEditor.mode === 'edit' ? productEditor.sku : null;
      setData((prev) => {
        let next: MigrationData = { ...prev };

        if (originalSku && originalSku !== product.sku) {
          next = {
            ...next,
            products: next.products.filter((p) => p.sku !== originalSku),
            openingStock: next.openingStock.map((e) =>
              e.productSku === originalSku ? { ...e, productSku: product.sku } : e
            ),
            batches: next.batches.map((b) =>
              b.productSku === originalSku ? { ...b, productSku: product.sku } : b
            ),
          };
        }

        const exists = next.products.some((p) => p.sku === product.sku);
        const products = exists
          ? next.products.map((p) => (p.sku === product.sku ? product : p))
          : [...next.products, product];

        // Drop any stock quantities that reference units removed from the product.
        const validUnits = new Set(product.units.map((u) => u.unit));
        const openingStock = next.openingStock.map((e) =>
          e.productSku === product.sku
            ? { ...e, quantities: e.quantities.filter((q) => validUnits.has(q.unit)) }
            : e
        );

        let units = next.units;
        product.units.forEach((u) => {
          units = addNamed(units, u.unit, (n) => ({ name: n, symbol: '' }));
        });

        return {
          ...next,
          products,
          openingStock,
          units,
          productGroups: addNamed(next.productGroups, product.productGroup, (n) => ({ name: n })),
        };
      });
      setProductEditor(null);
      toast.success(`Product "${product.name}" saved`);
      
      if (migrationId) {
        migrationApi.createProduct(migrationId, {
          sku: product.sku,
          name: product.name,
          brand: product.brand,
          description: product.description,
          isActive: true
        }).catch(console.error);
      }
    },
    [productEditor, migrationId]
  );

  // ── Stock / batch dialogs ──────────────────────────────────────────
  const handleSaveStock = useCallback(
    (quantities: StockQuantity[]) => {
      if (!stockEntryId) return;
      patchEntry(stockEntryId, { quantities });
      setStockEntryId(null);
      toast.success('Opening stock updated');
      
      // Basic API integration
      if (migrationId && stockEntryId) {
        const entry = data.openingStock.find(e => e.id === stockEntryId);
        if (entry && entry.productSku && entry.batchNumber && entry.location) {
           migrationApi.createOpeningStock(migrationId, {
             productId: entry.productSku, // Assuming backend expects SKU or resolved ID
             batchId: entry.batchNumber,
             locationId: entry.location,
             unitBreakdown: quantities.map(q => ({ unitId: q.unit, quantity: q.value }))
           }).catch(console.error);
        }
      }
    },
    [patchEntry, stockEntryId, data.openingStock, migrationId]
  );

  const handleSaveBatch = useCallback(
    (batch: Batch) => {
      if (!batchEntry) return;
      const original = batchEntry.batchNumber;
      setData((prev) => {
        let batches = prev.batches;
        if (original && original !== batch.batchNumber) {
          batches = batches.filter(
            (b) => !(b.productSku === batch.productSku && b.batchNumber === original)
          );
        }
        const exists = batches.some(
          (b) => b.productSku === batch.productSku && b.batchNumber === batch.batchNumber
        );
        batches = exists
          ? batches.map((b) =>
              b.productSku === batch.productSku && b.batchNumber === batch.batchNumber ? batch : b
            )
          : [...batches, batch];

        const openingStock = prev.openingStock.map((e) =>
          e.id === batchEntry.id ? { ...e, batchNumber: batch.batchNumber } : e
        );

        return pruneBatches({ ...prev, batches, openingStock });
      });
      setBatchEntryId(null);
      toast.success('Batch details saved');
      
      if (migrationId) {
        migrationApi.createBatch(migrationId, {
          productId: batch.productSku,
          batchNumber: batch.batchNumber,
          expiryDate: batch.expiryDate,
        }).catch(console.error);
      }
    },
    [batchEntry, migrationId]
  );

  // ── Import / export ────────────────────────────────────────────────
  const handleExport = useCallback(async () => {
    if (!validation.canExport) {
      toast.error(`Cannot export: ${validation.errors.length} blocking error(s) found.`);
      setReviewOpen(true);
      return;
    }
    
    // Final sync check
    const pendingOps = await import('../sync/queue').then(m => m.OperationQueue.countPending(migrationId!));
    if (pendingOps > 0 || !navigator.onLine) {
        toast.error('Cannot export until all changes are safely synchronized with the server.');
        return;
    }

    try {
      if (migrationId) {
        const canonicalJson = await migrationApi.exportMigration(migrationId);
        const name = `opening-inventory-export-${new Date().toISOString().split('T')[0]}.json`;
        
        // Trigger download
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
      } else {
         toast.error("Migration ID not found");
      }
    } catch {
      toast.error('Export failed — could not fetch canonical JSON from server.');
    }
  }, [data, validation, migrationId]);

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

  const applyImport = useCallback((imported: MigrationData) => {
    setData(imported);
    setPendingImport(null);
    setStatusFilter('all');
    setResetFiltersToken((t) => t + 1);
    toast.success('Migration draft imported — review it before exporting.');
  }, []);

  const navigateToEntry = useCallback((entryId: string) => {
    setStatusFilter('all');
    setResetFiltersToken((t) => t + 1);
    setFocusEntryId(entryId);
  }, []);

  const { counts } = validation;
  const saveLabel =
    saveState === 'saving'
      ? 'Saving…'
      : saveState === 'error'
        ? 'Not saved locally'
        : savedAt
          ? `Saved locally · ${new Date(savedAt).toLocaleTimeString()}`
          : 'Saved locally';

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
                <span
                  className={`h-1.5 w-1.5 rounded-full ${
                    saveState === 'saving'
                      ? 'animate-pulse bg-amber-400'
                      : saveState === 'error'
                        ? 'bg-destructive'
                        : 'bg-accent'
                  }`}
                />
                {saveLabel}
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

      <main className="mx-auto flex w-full max-w-[1500px] flex-1 flex-col gap-4 p-4 sm:p-8">
        {/* Compact status strip */}
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border border-primary-mid/20 bg-white px-5 py-3 text-sm shadow-sm">
          <Metric label="Products" value={counts.products} />
          <Metric label="Stock entries" value={counts.rows} />
          <Metric label="Valid" value={counts.valid} tone="ok" />
          <Metric label="Warnings" value={counts.warnings} tone="warn" />
          <Metric label="Errors" value={counts.errors} tone="bad" />
          <div className="ml-auto flex items-center gap-4 text-xs">
            <SyncStatusIndicator migrationId={migrationId} onReviewConflicts={() => setConflictsOpen(true)} />
            {isStorageAvailable() ? (
              <div className="flex items-center gap-1">
                <HardDriveDownload className="h-3.5 w-3.5 text-accent" />
                <span className="text-text-secondary">Draft auto-saves</span>
              </div>
            ) : (
              <div className="flex items-center gap-1">
                <AlertTriangle className="h-3.5 w-3.5 text-destructive" />
                <span className="text-destructive">Local storage unavailable</span>
              </div>
            )}
          </div>
        </div>

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

      {stockEntry && stockEntry.productSku && data.products.find((p) => p.sku === stockEntry.productSku) && (
        <StockDialog
          product={data.products.find((p) => p.sku === stockEntry.productSku) as Product}
          entry={stockEntry}
          onSave={handleSaveStock}
          onClose={() => setStockEntryId(null)}
        />
      )}

      {batchEntry && batchEntry.productSku && data.products.find((p) => p.sku === batchEntry.productSku) && (
        <BatchDialog
          product={data.products.find((p) => p.sku === batchEntry.productSku) as Product}
          batch={data.batches.find(
            (b) => b.productSku === batchEntry.productSku && b.batchNumber === batchEntry.batchNumber
          )}
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
        <ConflictDialog 
          migrationId={migrationId}
          onClose={() => setConflictsOpen(false)}
        />
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
