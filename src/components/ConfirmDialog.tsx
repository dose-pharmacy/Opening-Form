import React from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { AlertTriangle, X } from 'lucide-react';

interface ConfirmDialogProps {
  title: string;
  message: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive,
  onConfirm,
  onCancel,
}) => (
  <Dialog.Root open onOpenChange={(open) => !open && onCancel()}>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-[60] bg-black/40 backdrop-blur-sm" />
      <Dialog.Content className="fixed left-1/2 top-1/2 z-[60] w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border border-primary-mid/20 bg-canvas p-6 shadow-2xl">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-amber-100">
              <AlertTriangle className="h-4.5 w-4.5 text-amber-600" />
            </span>
            <div>
              <Dialog.Title className="font-serif text-lg font-bold text-text-primary">{title}</Dialog.Title>
              <Dialog.Description className="mt-1 text-sm text-text-secondary">{message}</Dialog.Description>
            </div>
          </div>
          <button onClick={onCancel} className="rounded-full p-1.5 transition-colors hover:bg-primary-light" aria-label="Close">
            <X className="h-4 w-4 text-text-muted" />
          </button>
        </div>
        <div className="flex justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg px-5 py-2.5 text-sm font-medium text-text-secondary transition-colors hover:bg-primary-light"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={`rounded-lg px-5 py-2.5 text-sm font-medium text-white shadow-md transition-all ${
              destructive ? 'bg-destructive hover:opacity-90' : 'bg-accent hover:bg-accent-soft'
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
);
