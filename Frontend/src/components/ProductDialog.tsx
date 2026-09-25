import React, { useMemo, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X, Plus, Trash2, Info, AlertCircle } from 'lucide-react';
import type { Product, UnitConfig, UnitDefinition } from '../utils/types';
import { describeConversion, resolveConversionFactors, validateUnitConfiguration } from '../utils/conversions';
import { ReusableSelect } from './ReusableSelect';
import { NumberInput } from './NumberInput';

interface ProductDialogProps {
  product?: Product;
  groups: string[];
  unitCatalogue: UnitDefinition[];
  existingSkus: string[];
  onCreateGroup: (name: string) => void;
  onCreateUnit: (name: string) => void;
  onUpdateUnitSymbol: (name: string, symbol: string) => void;
  onSave: (product: Product) => void;
  onClose: () => void;
}

const emptyUnit = (unit = '', isBaseUnit = false): UnitConfig => ({
  unit,
  isBaseUnit,
  conversionFactor: 1,
  contains: isBaseUnit ? null : 1,
  containedUnit: null,
  purchasePrice: 0,
  sellPrice: 0,
});

const blankProduct = (group: string, catalogue: UnitDefinition[]): Product => {
  const first =
    catalogue.find((u) => u.name.toLowerCase() === 'tablet')?.name || catalogue[0]?.name || '';
  return {
    sku: '',
    name: '',
    genericName: '',
    brand: '',
    productGroup: group,
    description: '',
    minStock: 0,
    reorderPoint: 0,
    isNarcotic: false,
    units: first ? [emptyUnit(first, true)] : [],
  };
};

export const ProductDialog: React.FC<ProductDialogProps> = ({
  product,
  groups,
  unitCatalogue,
  existingSkus,
  onCreateGroup,
  onCreateUnit,
  onUpdateUnitSymbol,
  onSave,
  onClose,
}) => {
  const [formData, setFormData] = useState<Product>(
    product ? { ...product, units: product.units.map((u) => ({ ...u })) } : blankProduct(groups[0] ?? '', unitCatalogue)
  );
  const [error, setError] = useState<string | null>(null);

  const unitNames = useMemo(() => unitCatalogue.map((u) => u.name), [unitCatalogue]);
  const symbolFor = (name: string) => unitCatalogue.find((u) => u.name === name)?.symbol || '';
  const liveUnits = useMemo(() => resolveConversionFactors(formData.units), [formData.units]);
  const unitErrors = validateUnitConfiguration(formData);

  const patch = (changes: Partial<Product>) => setFormData((prev) => ({ ...prev, ...changes }));

  const addUnit = () => {
    const used = new Set(formData.units.map((u) => u.unit));
    const next = unitNames.find((n) => !used.has(n)) || '';
    patch({ units: [...formData.units, emptyUnit(next, formData.units.length === 0)] });
  };

  const updateUnit = (index: number, changes: Partial<UnitConfig>) => {
    const units = formData.units.map((u, i) => (i === index ? { ...u, ...changes } : u));
    if (changes.isBaseUnit === true) {
      units.forEach((u, i) => {
        if (i === index) {
          u.isBaseUnit = true;
          u.conversionFactor = 1;
          u.contains = null;
          u.containedUnit = null;
        } else if (u.isBaseUnit) {
          u.isBaseUnit = false;
        }
      });
    }
    patch({ units });
  };

  const removeUnit = (index: number) => {
    const units = formData.units.filter((_, i) => i !== index);
    if (units.length > 0 && !units.some((u) => u.isBaseUnit)) {
      units[0].isBaseUnit = true;
      units[0].conversionFactor = 1;
      units[0].contains = null;
      units[0].containedUnit = null;
    }
    patch({ units });
  };

  const handleSave = () => {
    if (!formData.name.trim()) return setError('Product name is required.');
    if (!formData.sku.trim()) return setError('SKU is required.');
    if (!formData.productGroup.trim()) return setError('Product group is required.');
    const duplicate = existingSkus.some(
      (sku) => sku.toLowerCase() === formData.sku.trim().toLowerCase() && sku !== product?.sku
    );
    if (duplicate) return setError(`SKU "${formData.sku.trim()}" is already used by another product.`);
    if (unitErrors.length > 0) return setError(unitErrors[0]);

    setError(null);
    onSave({
      ...formData,
      sku: formData.sku.trim(),
      name: formData.name.trim(),
      units: resolveConversionFactors(formData.units).filter((u) => u.unit),
    });
  };

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[92vh] w-[calc(100vw-2rem)] max-w-4xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-primary-mid/20 bg-canvas p-6 shadow-2xl sm:p-8">
          <div className="mb-6 flex items-start justify-between gap-4">
            <div>
              <Dialog.Title className="font-serif text-2xl font-bold text-text-primary">
                {product ? 'Edit Product' : 'New Product'}
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-xs text-text-secondary">
                Product details and packaging units. Purchase prices stay at 0 during migration.
              </Dialog.Description>
            </div>
            <button onClick={onClose} className="rounded-full p-2 transition-colors hover:bg-primary-light" aria-label="Close">
              <X className="h-5 w-5 text-text-secondary" />
            </button>
          </div>

          {error && (
            <div className="mb-5 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div className="mb-8 grid grid-cols-1 gap-x-8 gap-y-4 md:grid-cols-2">
            <Field label="Product Name *">
              <input
                type="text"
                value={formData.name}
                onChange={(e) => patch({ name: e.target.value })}
                placeholder="e.g. Amoxicillin 500mg"
                className={inputClass}
              />
            </Field>
            <Field label="SKU / Item Code *">
              <input
                type="text"
                value={formData.sku}
                onChange={(e) => patch({ sku: e.target.value })}
                placeholder="AMOX-500"
                className={`${inputClass} font-mono`}
              />
            </Field>
            <Field label="Generic Name">
              <input
                type="text"
                value={formData.genericName}
                onChange={(e) => patch({ genericName: e.target.value })}
                placeholder="Amoxicillin"
                className={inputClass}
              />
            </Field>
            <Field label="Brand">
              <input
                type="text"
                value={formData.brand}
                onChange={(e) => patch({ brand: e.target.value })}
                placeholder="ABC Pharma"
                className={inputClass}
              />
            </Field>
            <Field label="Product Group *">
              <ReusableSelect
                value={formData.productGroup}
                options={groups}
                entityLabel="group"
                ariaLabel="Product group"
                onChange={(value) => patch({ productGroup: value })}
                onCreate={onCreateGroup}
                placeholder="Select group…"
                className="!text-sm"
              />
            </Field>
            <Field label="Minimum Stock">
              <NumberInput
                value={formData.minStock}
                onChange={(minStock) => patch({ minStock })}
                className="w-full"
              />
            </Field>
            <Field label="Reorder Point">
              <NumberInput
                value={formData.reorderPoint}
                onChange={(reorderPoint) => patch({ reorderPoint })}
                className="w-full"
              />
            </Field>
            <Field label="Description">
              <input
                type="text"
                value={formData.description}
                onChange={(e) => patch({ description: e.target.value })}
                placeholder="Optional notes"
                className={inputClass}
              />
            </Field>
            <label className="flex items-center gap-3 md:col-span-2">
              <input
                type="checkbox"
                checked={formData.isNarcotic}
                onChange={(e) => patch({ isNarcotic: e.target.checked })}
                className="h-4 w-4 rounded border-primary-mid/40 text-accent focus:ring-accent"
              />
              <span className="text-sm font-medium text-text-primary">Narcotic / controlled substance</span>
            </label>
          </div>

          <div className="mb-8">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-serif text-lg font-bold text-text-primary">Unit Configuration</h3>
              <div className="flex items-center gap-1.5 rounded-full bg-primary-light px-3 py-1 text-[11px] text-text-secondary">
                <Info className="h-3.5 w-3.5" />
                Mark one base unit, then say what each larger unit contains
              </div>
            </div>

            <div className="overflow-x-auto rounded-xl border border-primary-mid/20 bg-white">
              <table className="w-full min-w-[880px] text-left">
                <thead>
                  <tr className="border-b border-primary-mid/20 text-[10px] font-bold uppercase tracking-widest text-text-muted">
                    <th className="px-3 py-2.5">Unit</th>
                    <th className="px-3 py-2.5">Symbol</th>
                    <th className="px-3 py-2.5 text-center">Base</th>
                    <th className="px-3 py-2.5">Packaging (1 … =)</th>
                    <th className="px-3 py-2.5">Purchase</th>
                    <th className="px-3 py-2.5">Sell</th>
                    <th className="px-3 py-2.5">Resolved</th>
                    <th className="px-3 py-2.5" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-primary-mid/10">
                  {formData.units.map((unit, idx) => {
                    const resolved = liveUnits[idx];
                    return (
                      <tr key={idx} className="align-middle">
                        <td className="min-w-[150px] px-3 py-2">
                          <ReusableSelect
                            value={unit.unit}
                            options={unitNames}
                            entityLabel="unit"
                            ariaLabel={`Unit ${idx + 1}`}
                            onChange={(value) => updateUnit(idx, { unit: value })}
                            onCreate={onCreateUnit}
                            placeholder="Select unit…"
                          />
                        </td>
                        <td className="w-24 px-3 py-2">
                          <input
                            type="text"
                            value={symbolFor(unit.unit)}
                            disabled={!unit.unit}
                            onChange={(e) => onUpdateUnitSymbol(unit.unit, e.target.value)}
                            placeholder="tab"
                            className="w-full rounded border border-primary-mid/30 px-2 py-1 text-xs outline-none focus:border-accent disabled:bg-primary-light/30"
                          />
                        </td>
                        <td className="w-16 px-3 py-2 text-center">
                          <input
                            type="radio"
                            name="base-unit"
                            checked={unit.isBaseUnit}
                            onChange={() => updateUnit(idx, { isBaseUnit: true })}
                            className="h-4 w-4 text-accent focus:ring-accent"
                          />
                        </td>
                        <td className="min-w-[220px] px-3 py-2">
                          {unit.isBaseUnit ? (
                            <span className="text-xs text-text-muted">Base unit — conversion 1</span>
                          ) : (
                            <div className="flex items-center gap-1 text-xs text-text-secondary">
                              <span>1 {unit.unit || 'unit'} =</span>
                              <NumberInput
                                value={unit.contains ?? 1}
                                onChange={(contains) => updateUnit(idx, { contains })}
                                className="w-16 px-2 py-1 text-xs"
                              />
                              <select
                                value={unit.containedUnit ?? ''}
                                onChange={(e) =>
                                  updateUnit(idx, { containedUnit: e.target.value || null, contains: unit.contains ?? 1 })
                                }
                                className="min-w-[90px] rounded border border-primary-mid/30 px-1.5 py-1 text-xs outline-none focus:border-accent"
                              >
                                <option value="">—</option>
                                {unitNames
                                  .filter((name) => name !== unit.unit)
                                  .map((name) => (
                                    <option key={name} value={name}>
                                      {name}
                                    </option>
                                  ))}
                              </select>
                            </div>
                          )}
                        </td>
                        <td className="w-20 px-3 py-2">
                          <input
                            type="text"
                            value={0}
                            readOnly
                            title="Purchase prices are configured later in the real purchasing workflow"
                            className="w-full cursor-not-allowed rounded border border-primary-mid/20 bg-primary-light/30 px-2 py-1 text-xs text-text-muted"
                          />
                        </td>
                        <td className="w-32 min-w-[112px] px-3 py-2">
                          <NumberInput
                            value={unit.sellPrice}
                            allowDecimal
                            onChange={(sellPrice) => updateUnit(idx, { sellPrice })}
                            ariaLabel={`Selling price for ${unit.unit || 'unit'}`}
                            className="w-full min-w-[96px] px-2 py-1 text-xs"
                          />
                        </td>
                        <td className="w-44 px-3 py-2 text-xs text-text-secondary">
                          {resolved ? describeConversion({ ...formData, units: liveUnits }, resolved) : '—'}
                        </td>
                        <td className="w-12 px-3 py-2 text-right">
                          <button
                            type="button"
                            onClick={() => removeUnit(idx)}
                            disabled={formData.units.length === 1}
                            className="rounded p-1.5 text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-30"
                            aria-label="Remove unit"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                  {formData.units.length === 0 && (
                    <tr>
                      <td colSpan={8} className="px-3 py-6 text-center text-xs text-text-muted">
                        Add at least one unit.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <button
              type="button"
              onClick={addUnit}
              className="mt-2 flex items-center gap-2 px-2 py-2 text-sm font-medium text-accent transition-colors hover:text-accent-soft"
            >
              <Plus className="h-4 w-4" /> Add packaging level
            </button>

            {unitErrors.length > 0 && (
              <ul className="mt-2 space-y-1">
                {unitErrors.map((message) => (
                  <li key={message} className="flex items-center gap-2 text-xs text-destructive">
                    <AlertCircle className="h-3.5 w-3.5" /> {message}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="flex justify-end gap-3 border-t border-primary-mid/20 pt-5">
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
              Save Product
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
};

const inputClass =
  'w-full rounded-lg border border-primary-mid/30 bg-white px-3 py-2 text-sm outline-none transition-all focus:border-accent focus:ring-2 focus:ring-accent/20';

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div>
    <label className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-text-muted">{label}</label>
    {children}
  </div>
);
