import React, { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X, AlertCircle, AlertTriangle, CheckCircle2, Download, ArrowRight } from 'lucide-react';
import type { MigrationData, MigrationValidation } from '../utils/types';

interface ReviewDialogProps {
  data: MigrationData;
  validation: MigrationValidation;
  onNavigate: (entryId: string) => void;
  onExport: () => void;
  onClose: () => void;
}

type Tab = 'errors' | 'warnings';

export const ReviewDialog: React.FC<ReviewDialogProps> = ({
  data,
  validation,
  onNavigate,
  onExport,
  onClose,
}) => {
  const [tab, setTab] = useState<Tab>(validation.errors.length > 0 ? 'errors' : 'warnings');
  const { counts } = validation;

  const rowNumberFor = (entryId: string | null) => {
    if (!entryId) return null;
    const index = data.openingStock.findIndex((e) => e.id === entryId);
    return index >= 0 ? index + 1 : null;
  };

  const issues = tab === 'errors' ? validation.errors : validation.warnings;

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[92vh] w-[calc(100vw-2rem)] max-w-3xl -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-primary-mid/20 bg-canvas shadow-2xl">
          <div className="flex items-start justify-between gap-4 border-b border-primary-mid/15 p-6">
            <div>
              <Dialog.Title className="font-serif text-2xl font-bold text-text-primary">Migration Review</Dialog.Title>
              <Dialog.Description className="mt-1 text-xs text-text-secondary">
                Check everything before exporting the JSON file.
              </Dialog.Description>
            </div>
            <button onClick={onClose} className="rounded-full p-2 transition-colors hover:bg-primary-light" aria-label="Close">
              <X className="h-5 w-5 text-text-secondary" />
            </button>
          </div>

          <div className="overflow-y-auto p-6">
            <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Products" value={counts.products} />
              <Stat label="Batches" value={counts.batches} />
              <Stat label="Locations" value={counts.locations} />
              <Stat label="Stock Entries" value={counts.rows} />
            </div>

            <div className="mb-6 grid grid-cols-3 gap-3">
              <Stat label="Valid rows" value={counts.valid} tone="ok" />
              <Stat label="Warning rows" value={counts.warnings} tone="warn" />
              <Stat label="Error rows" value={counts.errors} tone="bad" />
            </div>

            <div className="mb-3 flex items-center gap-2">
              <TabButton
                active={tab === 'errors'}
                onClick={() => setTab('errors')}
                tone="bad"
                icon={<AlertCircle className="h-3.5 w-3.5" />}
                label={`Errors (${validation.errors.length})`}
              />
              <TabButton
                active={tab === 'warnings'}
                onClick={() => setTab('warnings')}
                tone="warn"
                icon={<AlertTriangle className="h-3.5 w-3.5" />}
                label={`Warnings (${validation.warnings.length})`}
              />
            </div>

            <div className="max-h-72 overflow-y-auto rounded-xl border border-primary-mid/20 bg-white">
              {issues.length === 0 ? (
                <div className="flex flex-col items-center gap-2 px-6 py-10 text-center text-sm text-text-muted">
                  <CheckCircle2 className="h-8 w-8 text-accent opacity-60" />
                  {tab === 'errors' ? 'No blocking errors. You are ready to export.' : 'No warnings.'}
                </div>
              ) : (
                <ul className="divide-y divide-primary-mid/10">
                  {issues.map((issue, index) => {
                    const rowNumber = rowNumberFor(issue.entryId);
                    return (
                      <li key={`${issue.message}-${index}`} className="flex items-center justify-between gap-3 px-4 py-2.5">
                        <span className="text-xs text-text-secondary">
                          {rowNumber != null && (
                            <span className="mr-2 rounded bg-primary-light px-1.5 py-0.5 font-mono text-[10px] text-accent">
                              Row {rowNumber}
                            </span>
                          )}
                          {issue.message}
                        </span>
                        {issue.entryId && rowNumber != null && (
                          <button
                            type="button"
                            onClick={() => {
                              onNavigate(issue.entryId as string);
                              onClose();
                            }}
                            className="flex shrink-0 items-center gap-1 rounded border border-primary-mid/40 px-2 py-1 text-[11px] font-medium text-text-secondary transition-colors hover:border-accent hover:text-accent"
                          >
                            Fix <ArrowRight className="h-3 w-3" />
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-primary-mid/15 bg-white px-6 py-4">
            <p className="text-xs text-text-muted">
              {validation.canExport
                ? 'No blocking errors — export is available.'
                : `${validation.errors.length} blocking error(s) must be fixed before export.`}
            </p>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg px-5 py-2.5 text-sm font-medium text-text-secondary transition-colors hover:bg-primary-light"
              >
                Keep editing
              </button>
              <button
                type="button"
                onClick={onExport}
                disabled={!validation.canExport}
                className="flex items-center gap-2 rounded-lg bg-accent px-5 py-2.5 text-sm font-medium text-white shadow-md transition-all hover:bg-accent-soft disabled:cursor-not-allowed disabled:bg-primary-mid disabled:text-text-muted disabled:shadow-none"
              >
                <Download className="h-4 w-4" /> Export JSON
              </button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
};

const Stat: React.FC<{ label: string; value: number; tone?: 'ok' | 'warn' | 'bad' }> = ({
  label,
  value,
  tone,
}) => (
  <div className="rounded-lg border border-primary-mid/20 bg-white px-4 py-3">
    <div className="text-[10px] font-bold uppercase tracking-widest text-text-muted">{label}</div>
    <div
      className={`text-xl font-bold ${
        tone === 'ok' ? 'text-accent' : tone === 'warn' ? 'text-amber-500' : tone === 'bad' ? 'text-destructive' : 'text-text-primary'
      }`}
    >
      {value}
    </div>
  </div>
);

const TabButton: React.FC<{
  active: boolean;
  onClick: () => void;
  tone: 'warn' | 'bad';
  icon: React.ReactNode;
  label: string;
}> = ({ active, onClick, tone, icon, label }) => (
  <button
    type="button"
    onClick={onClick}
    className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
      active
        ? tone === 'bad'
          ? 'bg-destructive/10 text-destructive'
          : 'bg-amber-100 text-amber-700'
        : 'text-text-secondary hover:bg-primary-light'
    }`}
  >
    {icon}
    {label}
  </button>
);
