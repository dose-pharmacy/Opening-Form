import React from 'react';
import { Cloud, CloudOff, RefreshCw, AlertCircle, CheckCircle2 } from 'lucide-react';

export type SyncStatus = 'READY' | 'SYNCING' | 'OFFLINE' | 'SYNC_ERROR';

/**
 * Outbox/connection indicator.
 *
 * Counts are polled by the parent so this component stays a pure view of the
 * current state: queued work, offline, failing, or fully synced.
 */
export const SyncStatusIndicator: React.FC<{
  migrationId: string | null;
  onReviewConflicts: () => void;
  refreshToken?: number;
  syncStatus?: SyncStatus;
  pendingCount?: number;
  conflictCount?: number;
  errorCount?: number;
}> = ({
  migrationId,
  onReviewConflicts,
  syncStatus = 'READY',
  pendingCount = 0,
  conflictCount = 0,
  errorCount = 0,
}) => {
  if (!migrationId) {
    return (
      <div className="flex items-center gap-2 rounded-full border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-600 shadow-sm">
        <CloudOff className="h-4 w-4" />
        <span>Not connected to a migration yet</span>
      </div>
    );
  }

  if (conflictCount > 0 || errorCount > 0) {
    const parts = [
      conflictCount > 0 ? `${conflictCount} conflict(s)` : null,
      errorCount > 0 ? `${errorCount} rejected` : null,
    ].filter(Boolean);
    return (
      <button
        type="button"
        onClick={onReviewConflicts}
        className="flex cursor-pointer items-center gap-2 rounded-full border border-red-300 bg-red-50 px-3 py-1.5 text-xs font-bold text-red-600 shadow-sm transition-all hover:bg-red-100"
      >
        <AlertCircle className="h-4 w-4" />
        <span>{parts.join(' · ')} — review</span>
      </button>
    );
  }

  if (syncStatus === 'OFFLINE') {
    return (
      <div className="flex items-center gap-2 rounded-full border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-600 shadow-sm">
        <CloudOff className="h-4 w-4" />
        <span>
          Offline ·{' '}
          {pendingCount > 0 ? `${pendingCount} change(s) pending` : 'changes will sync when connection returns'}
        </span>
      </div>
    );
  }

  if (syncStatus === 'SYNC_ERROR') {
    return (
      <button
        type="button"
        onClick={onReviewConflicts}
        className="flex cursor-pointer items-center gap-2 rounded-full border border-red-300 bg-red-50 px-3 py-1.5 text-xs font-bold text-red-600 shadow-sm transition-all hover:bg-red-100"
      >
        <AlertCircle className="h-4 w-4" />
        <span>Sync failed · local changes are safe</span>
      </button>
    );
  }

  if (syncStatus === 'SYNCING' || pendingCount > 0) {
    return (
      <div className="flex items-center gap-2 rounded-full border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs font-medium text-blue-600 shadow-sm">
        <RefreshCw className="h-4 w-4 animate-spin" />
        <span>Saving… {pendingCount > 0 ? `${pendingCount} change(s) pending` : 'sending changes'}</span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-600 shadow-sm transition-all duration-500">
      {syncStatus === 'READY' ? <CheckCircle2 className="h-4 w-4" /> : <Cloud className="h-4 w-4" />}
      <span>Ready · saved to server</span>
    </div>
  );
};

export default SyncStatusIndicator;
