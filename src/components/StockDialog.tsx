import React, { useMemo, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X, Info, Package } from 'lucide-react';
import type { Product, StockEntry, StockQuantity } from '../utils/types';
import { getBaseUnit, isPositiveNumber, round } from '../utils/conversions';
import { NumberInput } from './NumberInput';

interface StockDialogProps {
  product: Product;
  entry: StockEntry;
  onSave: (quantities: StockQuantity[]) => void;
  onClose: () => void;
}

interface LineState {
  unit: string;
  conversionFactor: number;
  quantity: number;
  unitCost: number;
  isBaseUnit: boolean;
}

export const StockDialog: React.FC<StockDialogProps> = ({ product, entry, onSave, onClose }) => {
  const baseUnit = getBaseUnit(product);

  const [lines, setLines] = useState<LineState[]>(() =>
    product.units.map((unit) => {
      const existing = entry.quantities.find((q) => q.unit === unit.unit);
      return {
        unit: unit.unit,
        conversionFactor: unit.isBaseUnit ? 1 : unit.conversionFactor,
        quantity: existing ? Number(existing.quantity) || 0 : 0,
        unitCost: existing ? Number(existing.unitCost) || 0 : 0,
        isBaseUnit: unit.isBaseUnit,
      };
    })
  );

  const totalBase = useMemo(
    () => lines.reduce((sum, line) => sum + (Number(line.quantity) || 0) * line.conversionFactor, 0),
    [lines]
  );
  const totalCost = useMemo(
    () => lines.reduce((sum, line) => sum + (Number(line.quantity) || 0) * (Number(line.unitCost) || 0), 0),
    [lines]
  );

  const updateLine = (index: number, changes: Partial<LineState>) => {
    setLines((prev) => prev.map((line, i) => (i === index ? { ...line, ...changes } : line)));
  };

  const handleSave = () => {
    const quantities: StockQuantity[] = lines
      .filter((line) => (Number(line.quantity) || 0) !== 0 || (Number(line.unitCost) || 0) !== 0)
      .map((line) => ({
        unit: line.unit,
        quantity: Number(line.quantity) || 0,
        unitCost: Number(line.unitCost) || 0,
      }));
    onSave(quantities);
  };

  const physicalBreakdown = lines
    .filter((line) => isPositiveNumber(Number(line.quantity)))
    .map((line) => `${line.quantity} ${line.unit}`)
    .join(' + ');

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[92vh] w-[calc(100vw-2rem)] max-w-2xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-primary-mid/20 bg-canvas p-6 shadow-2xl sm:p-8">
          <div className="mb-5 flex items-start justify-between gap-4">
            <div>
              <Dialog.Title className="flex items-center gap-2 font-serif text-xl font-bold text-text-primary">
                <Package className="h-5 w-5 text-accent" /> Opening Stock
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-xs text-text-secondary">
                {product.name} · <span className="font-mono">{product.sku}</span>
                {entry.location ? ` · ${entry.location}` : ''}
                {entry.batchNumber ? ` · Batch ${entry.batchNumber}` : ''}
              </Dialog.Description>
            </div>
            <button onClick={onClose} className="rounded-full p-2 transition-colors hover:bg-primary-light" aria-label="Close">
              <X className="h-5 w-5 text-text-secondary" />
            </button>
          </div>

          <div className="mb-5 overflow-x-auto rounded-xl border border-primary-mid/20 bg-white">
            <table className="w-full min-w-[520px] text-left">
              <thead>
                <tr className="border-b border-primary-mid/20 text-[10px] font-bold uppercase tracking-widest text-text-muted">
                  <th className="px-4 py-2.5">Unit</th>
                  <th className="px-4 py-2.5">Conversion</th>
                  <th className="px-4 py-2.5">Quantity</th>
                  <th className="px-4 py-2.5">Unit Cost</th>
                  <th className="px-4 py-2.5 text-right">In {baseUnit?.unit || 'base'}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-primary-mid/10">
                {lines.map((line, idx) => (
                  <tr key={line.unit}>
                    <td className="px-4 py-2.5 text-sm font-medium text-text-primary">
                      {line.unit}
                      {line.isBaseUnit && <span className="ml-2 text-[10px] uppercase text-text-muted">base</span>}
                    </td>
                    <td className="px-4 py-2.5 text-xs text-text-secondary">×{round(line.conversionFactor, 6)}</td>
                    <td className="w-32 px-4 py-2.5">
                      <NumberInput
                        value={line.quantity}
                        onChange={(quantity) => updateLine(idx, { quantity })}
                        ariaLabel={`Quantity in ${line.unit}`}
                        className="w-full px-2 py-1"
                      />
                    </td>
                    <td className="w-32 px-4 py-2.5">
                      <NumberInput
                        value={line.unitCost}
                        allowDecimal
                        onChange={(unitCost) => updateLine(idx, { unitCost })}
                        ariaLabel={`Unit cost for ${line.unit}`}
                        className="w-full px-2 py-1"
                      />
                    </td>
                    <td className="px-4 py-2.5 text-right text-xs text-text-secondary">
                      {round((Number(line.quantity) || 0) * line.conversionFactor)}
                    </td>
                  </tr>
                ))}
                {lines.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-4 py-6 text-center text-xs text-text-muted">
                      This product has no units configured yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="mb-4 space-y-1 rounded-lg bg-primary-light/50 p-4">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-text-secondary">Total stock</span>
              <span className="text-lg font-bold text-accent">
                {round(totalBase)} {baseUnit?.unit}
              </span>
            </div>
            {physicalBreakdown && (
              <div className="text-xs text-text-muted">
                Entered as {physicalBreakdown}
              </div>
            )}
            <div className="flex items-center justify-between pt-1 text-xs text-text-secondary">
              <span>Total opening cost</span>
              <span>{round(totalCost).toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
            </div>
          </div>

          <div className="mb-6 flex items-start gap-2 rounded-lg border border-primary-mid/20 bg-white px-4 py-3 text-[11px] text-text-secondary">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />
            <span>
              Count stock in the physical units you actually have — no need to convert by hand. Unit Cost is the cost
              of one of that unit and defaults to 0 when unknown. The original physical quantities are what gets
              exported.
            </span>
          </div>

          <div className="flex justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg px-6 py-2.5 text-sm font-medium text-text-secondary transition-colors hover:bg-primary-light"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              className="rounded-lg bg-accent px-6 py-2.5 text-sm font-medium text-white shadow-md transition-all hover:bg-accent-soft hover:shadow-lg"
            >
              Confirm Stock
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
};
