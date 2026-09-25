import React, { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X, AlertCircle, Boxes } from 'lucide-react';
import type { Batch, Product } from '../utils/types';
import { ReusableSelect } from './ReusableSelect';

interface BatchDialogProps {
  product: Product;
  batch?: Batch;
  initialBatchNumber: string;
  suppliers: string[];
  onCreateSupplier: (name: string) => void;
  onSave: (batch: Batch) => void;
  onClose: () => void;
}

const buildBatch = (product: Product, batchNumber: string, existing?: Batch): Batch => ({
  productSku: product.sku,
  batchNumber: existing?.batchNumber ?? batchNumber,
  expiryDate: existing?.expiryDate ?? '',
  manufacturingDate: existing?.manufacturingDate ?? null,
  receivedDate: existing?.receivedDate ?? null,
  supplier: existing?.supplier ?? null,
  supplierReference: existing?.supplierReference ?? null,
});

export const BatchDialog: React.FC<BatchDialogProps> = ({
  product,
  batch,
  initialBatchNumber,
  suppliers,
  onCreateSupplier,
  onSave,
  onClose,
}) => {
  const [form, setForm] = useState<Batch>(() => buildBatch(product, initialBatchNumber, batch));
  const [error, setError] = useState<string | null>(null);

  const patch = (changes: Partial<Batch>) => setForm((prev) => ({ ...prev, ...changes }));

  const handleSave = () => {
    if (!form.batchNumber.trim()) return setError('Batch number is required.');
    if (!form.expiryDate) return setError('Expiry date is required for a batch.');
    if (form.manufacturingDate && form.expiryDate && form.manufacturingDate > form.expiryDate) {
      return setError('Manufacturing date cannot be after the expiry date.');
    }
    setError(null);
    onSave({ ...form, batchNumber: form.batchNumber.trim() });
  };

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[92vh] w-[calc(100vw-2rem)] max-w-xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-primary-mid/20 bg-canvas p-6 shadow-2xl sm:p-8">
          <div className="mb-5 flex items-start justify-between gap-4">
            <div>
              <Dialog.Title className="flex items-center gap-2 font-serif text-xl font-bold text-text-primary">
                <Boxes className="h-5 w-5 text-accent" /> Batch Details
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-xs text-text-secondary">
                {product.name} · <span className="font-mono">{product.sku}</span>
              </Dialog.Description>
            </div>
            <button onClick={onClose} className="rounded-full p-2 transition-colors hover:bg-primary-light" aria-label="Close">
              <X className="h-5 w-5 text-text-secondary" />
            </button>
          </div>

          {error && (
            <div className="mb-4 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Batch Number *">
              <input
                type="text"
                value={form.batchNumber}
                onChange={(e) => patch({ batchNumber: e.target.value })}
                placeholder="AMX001"
                className={`${inputClass} font-mono`}
              />
            </Field>
            <Field label="Expiry Date *">
              <input
                type="date"
                value={form.expiryDate}
                onChange={(e) => patch({ expiryDate: e.target.value })}
                className={inputClass}
              />
            </Field>
            <Field label="Manufacturing Date">
              <input
                type="date"
                value={form.manufacturingDate ?? ''}
                onChange={(e) => patch({ manufacturingDate: e.target.value || null })}
                className={inputClass}
              />
            </Field>
            <Field label="Received Date">
              <input
                type="date"
                value={form.receivedDate ?? ''}
                onChange={(e) => patch({ receivedDate: e.target.value || null })}
                className={inputClass}
              />
            </Field>
            <Field label="Supplier">
              <ReusableSelect
                value={form.supplier ?? ''}
                options={suppliers}
                entityLabel="supplier"
                ariaLabel="Supplier"
                onChange={(value) => patch({ supplier: value || null })}
                onCreate={onCreateSupplier}
                placeholder="Select supplier…"
                className="!text-sm"
              />
            </Field>
            <Field label="Supplier Reference">
              <input
                type="text"
                value={form.supplierReference ?? ''}
                onChange={(e) => patch({ supplierReference: e.target.value || null })}
                placeholder="Invoice / GRN number"
                className={inputClass}
              />
            </Field>
          </div>

          <p className="mt-5 rounded-lg bg-primary-light/40 px-4 py-3 text-[11px] text-text-secondary">
            A batch belongs to a product and can be stocked in several locations — you only enter it once here.
          </p>

          <div className="mt-6 flex justify-end gap-3">
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
              Save Batch
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
