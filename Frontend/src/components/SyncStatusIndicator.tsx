import React, { useEffect, useState } from 'react';
import { OperationQueue } from '../sync/queue';
import { Cloud, CloudOff, RefreshCw, AlertCircle } from 'lucide-react';

export const SyncStatusIndicator: React.FC<{
  migrationId: string | null;
  onReviewConflicts: () => void;
  refreshToken?: number;
}> = ({ migrationId, onReviewConflicts, refreshToken }) => {
  const [pendingCount, setPendingCount] = useState(0);
  const [conflictCount, setConflictCount] = useState(0);
  const [errorCount, setErrorCount] = useState(0);
  const [isOnline, setIsOnline] = useState(navigator.onLine);

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  useEffect(() => {
    if (!migrationId) return;

    let cancelled = false;

    // Poll the outbox: a change is queued/dequeued outside React's control.
    const interval = setInterval(async () => {
      const pending = await OperationQueue.countPending(migrationId);
      const { conflicts, errors } = await OperationQueue.countIssues(migrationId);
      if (cancelled) return;
      setPendingCount(pending);
      setConflictCount(conflicts);
      setErrorCount(errors);
    }, 1000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [migrationId, refreshToken]);

  useEffect(() => {
    const interval = setInterval(() => setIsOnline(navigator.onLine), 1000);
    return () => clearInterval(interval);
  }, []);

  if (!isOnline) {
    return (
      <div className="flex items-center gap-2 rounded-full border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-600 shadow-sm">
        <CloudOff className="h-4 w-4" />
        <span>
          Offline · {pendingCount > 0 ? `${pendingCount} change(s) queued` : 'no changes queued'}
        </span>
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

  if (pendingCount > 0) {
    return (
      <div className="flex items-center gap-2 rounded-full border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs font-medium text-blue-600 shadow-sm">
        <RefreshCw className="h-4 w-4 animate-spin" />
        <span>Syncing · {pendingCount} to send</span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-600 shadow-sm transition-all duration-500">
      <Cloud className="h-4 w-4" />
      <span>Saved to server</span>
    </div>
  );
};
