import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Search,
  Filter,
  Plus,
  Copy,
  Trash2,
  AlertCircle,
  CheckCircle2,
  AlertTriangle,
  Pencil,
  ArrowUpDown,
  X,
} from 'lucide-react';
import { differenceInCalendarDays, isValid, parseISO } from 'date-fns';
import type {
  MigrationData,
  MigrationValidation,
  Product,
  StatusFilter,
  StockEntry,
} from '../utils/types';
import { calculateStockSummary, formatCost, isPositiveNumber } from '../utils/conversions';
import { ReusableSelect } from './ReusableSelect';

type SortKey = 'sku' | 'product' | 'group' | 'location' | 'batch' | 'expiry' | 'stock' | 'cost';
type ExpiryFilter = 'all' | 'expired' | 'soon' | 'missing';

interface InventoryTableProps {
  data: MigrationData;
  validation: MigrationValidation;
  statusFilter: StatusFilter;
  onStatusFilterChange: (status: StatusFilter) => void;
  focusEntryId: string | null;
  onFocusHandled: () => void;
  /** Bump this to clear the table's internal search/filter/sort state. */
  resetFiltersToken: number;
  onUpdateStock: (entry: StockEntry) => void;
  onAddRow: () => void;
  onAddProduct: () => void;
  onDuplicateRow: (id: string) => void;
  onDeleteRow: (id: string) => void;
  onDuplicateRows: (ids: string[]) => void;
  onDeleteRows: (ids: string[]) => void;
  onEditProduct: (sku: string) => void;
  onOpenBatch: (entryId: string) => void;
  onSetProduct: (entryId: string, sku: string) => void;
  onSetBatchNumber: (entryId: string, batchNumber: string) => void;
  onSetExpiry: (entryId: string, expiryDate: string) => void;
  onSetLocation: (entryId: string, location: string) => void;
  onSetProductGroup: (sku: string, group: string) => void;
  onCreateGroup: (name: string) => void;
  onCreateLocation: (name: string) => void;
}

interface RowView {
  entry: StockEntry;
  index: number;
  product: Product | undefined;
  batchLabel: string;
  expiry: string;
  stockLabel: string;
  stockValue: number;
  costValue: number;
  status: 'valid' | 'warning' | 'error';
  statusMessage: string;
}

const COL = {
  product: 0,
  group: 1,
  location: 2,
  batch: 3,
  expiry: 4,
  stock: 5,
} as const;

const STATUS_LABEL: Record<StatusFilter, string> = {
  all: 'All statuses',
  valid: 'Valid only',
  warning: 'Warnings only',
  error: 'Errors only',
};

export const InventoryTable: React.FC<InventoryTableProps> = ({
  data,
  validation,
  statusFilter,
  onStatusFilterChange,
  focusEntryId,
  onFocusHandled,
  resetFiltersToken,
  onUpdateStock,
  onAddRow,
  onAddProduct,
  onDuplicateRow,
  onDeleteRow,
  onDuplicateRows,
  onDeleteRows,
  onEditProduct,
  onOpenBatch,
  onSetProduct,
  onSetBatchNumber,
  onSetExpiry,
  onSetLocation,
  onSetProductGroup,
  onCreateGroup,
  onCreateLocation,
}) => {
  const [search, setSearch] = useState('');
  const [filterGroup, setFilterGroup] = useState('all');
  const [filterLocation, setFilterLocation] = useState('all');
  const [expiryFilter, setExpiryFilter] = useState<ExpiryFilter>('all');
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [flashId, setFlashId] = useState<string | null>(null);
  const clipboardRef = useRef<{ col: number; value: string } | null>(null);
  const tableRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (resetFiltersToken === 0) return;
    setSearch('');
    setFilterGroup('all');
    setFilterLocation('all');
    setExpiryFilter('all');
    setSort(null);
  }, [resetFiltersToken]);

  const productsBySku = useMemo(() => {
    const map = new Map<string, Product>();
    data.products.forEach((p) => map.set(p.sku, p));
    return map;
  }, [data.products]);

  const groupNames = useMemo(() => data.productGroups.map((g) => g.name), [data.productGroups]);
  const locationNames = useMemo(() => data.locations.map((l) => l.name), [data.locations]);
  const productOptions = useMemo(
    () => [...data.products].sort((a, b) => a.name.localeCompare(b.name)),
    [data.products]
  );

  const firstIssueByEntry = useMemo(() => {
    const map = new Map<string, string>();
    validation.issues.forEach((issue) => {
      if (issue.entryId && !map.has(issue.entryId)) map.set(issue.entryId, issue.message);
    });
    return map;
  }, [validation.issues]);

  const rows = useMemo<RowView[]>(() => {
    const needle = search.trim().toLowerCase();
    const views = data.openingStock.map((entry, index) => {
      const product = productsBySku.get(entry.productSku);
      const batch = data.batches.find(
        (b) => b.productSku === entry.productSku && b.batchNumber === entry.batchNumber
      );
      const summary = calculateStockSummary(product, entry.quantities);
      return {
        entry,
        index,
        product,
        batchLabel: entry.batchNumber,
        expiry: batch?.expiryDate || '',
        stockLabel: product
          ? `${summary.totalBaseQuantity} ${summary.baseUnitName}`.trim()
          : 'Enter stock',
        stockValue: summary.totalBaseQuantity,
        costValue: summary.totalCost,
        status: validation.rowStatus[entry.id] ?? 'valid',
        statusMessage: firstIssueByEntry.get(entry.id) || '',
      } satisfies RowView;
    });

    const matchesSearch = (row: RowView) => {
      if (!needle) return true;
      const haystack = [
        row.product?.sku,
        row.product?.name,
        row.product?.genericName,
        row.product?.brand,
        row.product?.productGroup,
        row.entry.batchNumber,
        row.entry.location,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(needle);
    };

    const matchesExpiry = (row: RowView) => {
      if (expiryFilter === 'all') return true;
      if (!row.expiry) return expiryFilter === 'missing';
      const date = parseISO(row.expiry);
      if (!isValid(date)) return expiryFilter === 'missing';
      const days = differenceInCalendarDays(date, new Date());
      if (expiryFilter === 'expired') return days < 0;
      if (expiryFilter === 'soon') return days >= 0 && days <= 90;
      return false;
    };

    let filtered = views.filter(
      (row) =>
        matchesSearch(row) &&
        matchesExpiry(row) &&
        (filterGroup === 'all' || row.product?.productGroup === filterGroup) &&
        (filterLocation === 'all' || row.entry.location === filterLocation) &&
        (statusFilter === 'all' || row.status === statusFilter)
    );

    if (sort) {
      const direction = sort.dir === 'asc' ? 1 : -1;
      filtered = [...filtered].sort((a, b) => {
        const value = (row: RowView): string | number => {
          switch (sort.key) {
            case 'sku':
              return row.product?.sku?.toLowerCase() ?? '';
            case 'product':
              return row.product?.name?.toLowerCase() ?? '';
            case 'group':
              return row.product?.productGroup?.toLowerCase() ?? '';
            case 'location':
              return row.entry.location.toLowerCase();
            case 'batch':
              return row.entry.batchNumber.toLowerCase();
            case 'expiry':
              return row.expiry || '9999-99-99';
            case 'stock':
              return row.stockValue;
            case 'cost':
              return row.costValue;
            default:
              return '';
          }
        };
        const aVal = value(a);
        const bVal = value(b);
        if (typeof aVal === 'number' && typeof bVal === 'number') return (aVal - bVal) * direction;
        return String(aVal).localeCompare(String(bVal)) * direction;
      });
    }

    return filtered;
  }, [
    data.openingStock,
    data.batches,
    productsBySku,
    search,
    expiryFilter,
    filterGroup,
    filterLocation,
    statusFilter,
    sort,
    validation.rowStatus,
    firstIssueByEntry,
  ]);

  // Scroll to and highlight a row requested from the review step.
  useEffect(() => {
    if (!focusEntryId) return;
    const node = tableRef.current?.querySelector<HTMLElement>(`[data-entry-id="${focusEntryId}"]`);
    if (node) {
      node.scrollIntoView({ block: 'center', behavior: 'smooth' });
      setFlashId(focusEntryId);
      const timer = setTimeout(() => setFlashId(null), 1800);
      onFocusHandled();
      return () => clearTimeout(timer);
    }
    onFocusHandled();
    return undefined;
  }, [focusEntryId, rows, onFocusHandled]);

  const toggleSort = (key: SortKey) => {
    setSort((prev) => {
      if (!prev || prev.key !== key) return { key, dir: 'asc' };
      if (prev.dir === 'asc') return { key, dir: 'desc' };
      return null;
    });
  };

  const visibleIds = rows.map((r) => r.entry.id);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));

  const toggleRow = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    setSelected((prev) => {
      if (visibleIds.every((id) => prev.has(id)) && visibleIds.length > 0) {
        const next = new Set(prev);
        visibleIds.forEach((id) => next.delete(id));
        return next;
      }
      return new Set([...prev, ...visibleIds]);
    });
  };

  const selectedIds = [...selected];

  const focusCell = (rowIndex: number, col: number) => {
    const node = tableRef.current?.querySelector<HTMLElement>(`[data-nav="${rowIndex}:${col}"]`);
    node?.focus();
  };

  const handleNavKeys = (
    event: React.KeyboardEvent<HTMLElement>,
    rowIndex: number,
    col: number
  ) => {
    const target = event.target as HTMLElement;
    const isSelect = target.tagName === 'SELECT';

    if (event.key === 'Enter') {
      event.preventDefault();
      if (isSelect) target.blur();
      focusCell(rowIndex + 1, col);
      return;
    }
    if (event.key === 'ArrowDown' && !isSelect) {
      event.preventDefault();
      focusCell(rowIndex + 1, col);
      return;
    }
    if (event.key === 'ArrowUp' && !isSelect) {
      event.preventDefault();
      focusCell(rowIndex - 1, col);
      return;
    }
    if (event.key === 'Escape') {
      target.blur();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'd') {
      event.preventDefault();
      onDuplicateRow(rows[rowIndex].entry.id);
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c' && target.tagName === 'INPUT') {
      clipboardRef.current = { col, value: (target as HTMLInputElement).value };
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v') {
      const clip = clipboardRef.current;
      if (!clip || clip.col !== col) return;
      event.preventDefault();
      const entryId = rows[rowIndex].entry.id;
      if (col === COL.batch) onSetBatchNumber(entryId, clip.value);
      if (col === COL.expiry && /^\d{4}-\d{2}-\d{2}$/.test(clip.value)) onSetExpiry(entryId, clip.value);
    }
  };

  const hasEntries = data.openingStock.length > 0;
  const hasActiveFilters =
    !!search || filterGroup !== 'all' || filterLocation !== 'all' || expiryFilter !== 'all' || statusFilter !== 'all';

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-xl border border-primary-mid/20 bg-white shadow-sm">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3 border-b border-primary-mid/10 bg-canvas/50 p-4">
        <div className="relative min-w-[220px] flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search SKU, product, generic, brand, group, batch, location…"
            className="w-full rounded-lg border border-primary-mid/30 bg-white py-2 pl-10 pr-9 text-sm outline-none transition-all focus:border-accent focus:ring-2 focus:ring-accent/20"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-text-muted hover:text-text-secondary"
              aria-label="Clear search"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Filter className="h-4 w-4 text-text-secondary" />
          <select
            value={filterGroup}
            onChange={(e) => setFilterGroup(e.target.value)}
            className="rounded-lg border border-primary-mid/30 bg-white px-3 py-2 text-xs outline-none"
          >
            <option value="all">All groups</option>
            {groupNames.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>
          <select
            value={filterLocation}
            onChange={(e) => setFilterLocation(e.target.value)}
            className="rounded-lg border border-primary-mid/30 bg-white px-3 py-2 text-xs outline-none"
          >
            <option value="all">All locations</option>
            {locationNames.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
          <select
            value={expiryFilter}
            onChange={(e) => setExpiryFilter(e.target.value as ExpiryFilter)}
            className="rounded-lg border border-primary-mid/30 bg-white px-3 py-2 text-xs outline-none"
          >
            <option value="all">Any expiry</option>
            <option value="expired">Expired</option>
            <option value="soon">Expiring ≤ 90 days</option>
            <option value="missing">Missing expiry</option>
          </select>
          <select
            value={statusFilter}
            onChange={(e) => onStatusFilterChange(e.target.value as StatusFilter)}
            className="rounded-lg border border-primary-mid/30 bg-white px-3 py-2 text-xs outline-none"
          >
            <option value="all">{STATUS_LABEL.all}</option>
            <option value="valid">{STATUS_LABEL.valid}</option>
            <option value="warning">{STATUS_LABEL.warning}</option>
            <option value="error">{STATUS_LABEL.error}</option>
          </select>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onAddRow}
            className="flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-white shadow-sm transition-all hover:bg-accent-soft"
          >
            <Plus className="h-4 w-4" /> Add Row
          </button>
          <button
            type="button"
            onClick={onAddProduct}
            className="flex items-center gap-1.5 rounded-lg border border-primary-mid/40 bg-white px-3.5 py-2 text-sm font-medium text-text-secondary transition-all hover:border-accent hover:text-accent"
          >
            <Plus className="h-4 w-4" /> Add Product
          </button>
        </div>
      </div>

      {/* Bulk actions */}
      {selectedIds.length > 0 && (
        <div className="flex items-center justify-between gap-3 border-b border-accent/20 bg-primary-light/60 px-4 py-2 text-xs">
          <span className="font-medium text-accent">{selectedIds.length} row(s) selected</span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                onDuplicateRows(selectedIds);
                setSelected(new Set());
              }}
              className="flex items-center gap-1.5 rounded border border-primary-mid/40 bg-white px-2.5 py-1 font-medium text-text-secondary hover:text-accent"
            >
              <Copy className="h-3.5 w-3.5" /> Duplicate
            </button>
            <button
              type="button"
              onClick={() => {
                onDeleteRows(selectedIds);
                setSelected(new Set());
              }}
              className="flex items-center gap-1.5 rounded border border-destructive/30 bg-white px-2.5 py-1 font-medium text-destructive hover:bg-destructive/10"
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </button>
            <button
              type="button"
              onClick={() => setSelected(new Set())}
              className="rounded px-2 py-1 font-medium text-text-muted hover:text-text-secondary"
            >
              Clear
            </button>
          </div>
        </div>
      )}

      {/* Table */}
      <div ref={tableRef} className="flex-1 overflow-auto">
        <table className="w-full min-w-[1180px] border-collapse text-left">
          <thead className="sticky top-0 z-10 bg-primary-light/40 backdrop-blur-sm">
            <tr className="border-b border-primary-mid/20 text-[10px] font-bold uppercase tracking-widest text-text-muted">
              <th className="w-10 px-3 py-3">
                <input
                  type="checkbox"
                  checked={allVisibleSelected}
                  onChange={toggleAll}
                  aria-label="Select all visible rows"
                  className="h-4 w-4 rounded border-primary-mid/40 text-accent focus:ring-accent"
                />
              </th>
              <th className="w-10 px-2 py-3" title="Validation status">
                !
              </th>
              <th className="px-3 py-3">
                <SortHeader label="SKU" active={sort?.key === 'sku'} onClick={() => toggleSort('sku')} />
              </th>
              <th className="px-3 py-3">
                <SortHeader label="Product" active={sort?.key === 'product'} onClick={() => toggleSort('product')} />
              </th>
              <th className="px-3 py-3">
                <SortHeader label="Group" active={sort?.key === 'group'} onClick={() => toggleSort('group')} />
              </th>
              <th className="px-3 py-3">
                <SortHeader label="Location" active={sort?.key === 'location'} onClick={() => toggleSort('location')} />
              </th>
              <th className="px-3 py-3">
                <SortHeader label="Batch" active={sort?.key === 'batch'} onClick={() => toggleSort('batch')} />
              </th>
              <th className="px-3 py-3">
                <SortHeader label="Expiry" active={sort?.key === 'expiry'} onClick={() => toggleSort('expiry')} />
              </th>
              <th className="px-3 py-3">
                <SortHeader label="Stock" active={sort?.key === 'stock'} onClick={() => toggleSort('stock')} />
              </th>
              <th className="px-3 py-3">
                <SortHeader label="Cost" active={sort?.key === 'cost'} onClick={() => toggleSort('cost')} />
              </th>
              <th className="w-20 px-3 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-primary-mid/10">
            {rows.map((row, rowIndex) => {
              const { entry, product, status } = row;
              const StatusIcon =
                status === 'error' ? AlertCircle : status === 'warning' ? AlertTriangle : CheckCircle2;
              const statusColor =
                status === 'error'
                  ? 'text-destructive'
                  : status === 'warning'
                    ? 'text-amber-500'
                    : 'text-accent';

              return (
                <tr
                  key={entry.id}
                  data-entry-id={entry.id}
                  className={`group transition-colors hover:bg-primary-light/15 ${
                    flashId === entry.id ? 'bg-primary-light/70' : ''
                  } ${selected.has(entry.id) ? 'bg-primary-light/40' : ''}`}
                >
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                      checked={selected.has(entry.id)}
                      onChange={() => toggleRow(entry.id)}
                      aria-label={`Select row ${rowIndex + 1}`}
                      className="h-4 w-4 rounded border-primary-mid/40 text-accent focus:ring-accent"
                    />
                  </td>
                  <td className="px-2 py-2" title={row.statusMessage}>
                    <StatusIcon className={`h-4 w-4 ${statusColor}`} />
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-text-secondary">
                    {product?.sku || <span className="text-text-muted">—</span>}
                  </td>
                  <td className="min-w-[220px] px-3 py-2">
                    <div className="flex items-center gap-1">
                      <select
                        data-nav={`${rowIndex}:${COL.product}`}
                        value={entry.productSku}
                        onChange={(e) => {
                          if (e.target.value === '__new__') {
                            onEditProduct('');
                            return;
                          }
                          onSetProduct(entry.id, e.target.value);
                        }}
                        onKeyDown={(e) => handleNavKeys(e, rowIndex, COL.product)}
                        className="min-w-0 flex-1 cursor-pointer rounded border border-transparent bg-transparent py-1 text-sm text-text-primary outline-none hover:border-primary-mid/40 focus:border-accent focus:bg-white"
                      >
                        <option value="">Select product…</option>
                        {productOptions.map((p) => (
                          <option key={p.sku} value={p.sku}>
                            {p.name} ({p.sku})
                          </option>
                        ))}
                        <option value="__new__">+ New product…</option>
                      </select>
                      {product && (
                        <button
                          type="button"
                          onClick={() => onEditProduct(entry.productSku)}
                          title="Configure product & units"
                          className="rounded p-1 text-text-muted opacity-0 transition-opacity hover:bg-primary-light hover:text-accent group-hover:opacity-100 focus:opacity-100"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    {product ? (
                      <ReusableSelect
                        value={product.productGroup}
                        options={groupNames}
                        entityLabel="group"
                        ariaLabel="Product group"
                        onChange={(value) => onSetProductGroup(product.sku, value)}
                        onCreate={onCreateGroup}
                        placeholder="Set group…"
                      />
                    ) : (
                      <span className="text-xs text-text-muted">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <ReusableSelect
                      value={entry.location}
                      options={locationNames}
                      entityLabel="location"
                      ariaLabel="Location"
                      onChange={(value) => onSetLocation(entry.id, value)}
                      onCreate={onCreateLocation}
                      placeholder="Set location…"
                    />
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-1">
                      <input
                        type="text"
                        data-nav={`${rowIndex}:${COL.batch}`}
                        value={entry.batchNumber}
                        placeholder="Batch #"
                        onChange={(e) => onSetBatchNumber(entry.id, e.target.value)}
                        onKeyDown={(e) => handleNavKeys(e, rowIndex, COL.batch)}
                        className="w-24 rounded border border-transparent bg-transparent px-1 py-1 font-mono text-xs text-text-secondary outline-none hover:border-primary-mid/40 focus:border-accent focus:bg-white"
                      />
                      <button
                        type="button"
                        onClick={() => onOpenBatch(entry.id)}
                        title="Batch details"
                        className="rounded p-1 text-text-muted hover:bg-primary-light hover:text-accent"
                      >
                        <Pencil className="h-3 w-3" />
                      </button>
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <input
                      type="date"
                      data-nav={`${rowIndex}:${COL.expiry}`}
                      value={row.expiry}
                      onChange={(e) => onSetExpiry(entry.id, e.target.value)}
                      onKeyDown={(e) => handleNavKeys(e, rowIndex, COL.expiry)}
                      className="w-32 rounded border border-transparent bg-transparent px-1 py-1 text-xs text-text-secondary outline-none hover:border-primary-mid/40 focus:border-accent focus:bg-white"
                    />
                  </td>
                  <td className="px-3 py-2">
                    <button
                      type="button"
                      data-nav={`${rowIndex}:${COL.stock}`}
                      onClick={() => onUpdateStock(entry)}
                      disabled={!product}
                      onKeyDown={(e) => handleNavKeys(e, rowIndex, COL.stock)}
                      className={`rounded px-2 py-1 text-xs font-bold transition-colors ${
                        product
                          ? 'bg-primary-light/60 text-accent hover:bg-primary-light'
                          : 'cursor-not-allowed text-text-muted'
                      }`}
                      title={product ? 'Edit opening stock by physical unit' : 'Select a product first'}
                    >
                      {row.stockLabel}
                    </button>
                  </td>
                  <td className="px-3 py-2 text-xs text-text-secondary">
                    {row.costValue > 0 ? formatCost(row.costValue) : <span className="text-text-muted">0</span>}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center justify-end gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                      <button
                        type="button"
                        onClick={() => onDuplicateRow(entry.id)}
                        title="Duplicate row (Ctrl+D)"
                        className="rounded p-1.5 text-text-muted transition-all hover:bg-primary-light hover:text-accent"
                      >
                        <Copy className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => onDeleteRow(entry.id)}
                        title="Delete row"
                        className="rounded p-1.5 text-text-muted transition-all hover:bg-destructive/10 hover:text-destructive"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}

            {rows.length === 0 && (
              <tr>
                <td colSpan={11} className="px-6 py-20 text-center">
                  <div className="flex flex-col items-center gap-3 text-text-muted">
                    <Search className="h-10 w-10 opacity-20" />
                    {hasEntries || hasActiveFilters ? (
                      <>
                        <p className="text-sm">No rows match your search or filters.</p>
                        <button
                          type="button"
                          onClick={() => {
                            setSearch('');
                            setFilterGroup('all');
                            setFilterLocation('all');
                            setExpiryFilter('all');
                            onStatusFilterChange('all');
                          }}
                          className="font-medium text-accent hover:underline"
                        >
                          Clear all filters
                        </button>
                      </>
                    ) : (
                      <>
                        <p className="text-sm font-medium text-text-secondary">Your migration is empty.</p>
                        <p className="max-w-md text-xs">
                          Configure a product first (name, SKU, units), then add a row to record its opening stock.
                        </p>
                        <div className="flex items-center gap-3 pt-1">
                          <button
                            type="button"
                            onClick={onAddProduct}
                            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-soft"
                          >
                            + Add Product
                          </button>
                          <button
                            type="button"
                            onClick={onAddRow}
                            className="rounded-lg border border-primary-mid/40 px-4 py-2 text-sm font-medium text-text-secondary hover:border-accent hover:text-accent"
                          >
                            Add Row
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-primary-mid/10 bg-canvas/50 px-4 py-2 text-[11px] text-text-muted">
        <span>
          Showing {rows.length} of {data.openingStock.length} row(s)
          {hasActiveFilters ? ' (filtered)' : ''}
        </span>
        <span>Keys: Tab / Shift+Tab navigate · Enter &amp; ↓ move down · Esc cancel · Ctrl+D duplicate · Ctrl+C/V copy batch &amp; expiry</span>
      </div>
    </div>
  );
};

const SortHeader: React.FC<{ label: string; active: boolean; onClick: () => void }> = ({
  label,
  active,
  onClick,
}) => (
  <button
    type="button"
    onClick={onClick}
    className={`flex items-center gap-1 uppercase tracking-widest transition-colors hover:text-accent ${
      active ? 'text-accent' : ''
    }`}
  >
    {label}
    <ArrowUpDown className={`h-3 w-3 ${active ? 'opacity-100' : 'opacity-30'}`} />
  </button>
);
