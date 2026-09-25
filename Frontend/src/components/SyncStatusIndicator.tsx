import React, { useEffect, useState } from 'react';
import { OperationQueue } from '../sync/queue';
import { SyncManager } from '../sync/syncManager';
import { Cloud, CloudOff, RefreshCw, AlertCircle, CheckCircle2 } from 'lucide-react';

export const SyncStatusIndicator: React.FC<{ migrationId: string | null; onReviewConflicts: () => void }> = ({ migrationId, onReviewConflicts }) => {
  const [pendingCount, setPendingCount] = useState(0);
  const [conflictCount, setConflictCount] = useState(0);
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [isSyncing, setIsSyncing] = useState(false);

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

    // A simple polling to check pending operations count for UI purposes
    // A more robust implementation would use events from SyncManager or IndexedDB observers
    const interval = setInterval(async () => {
      const count = await OperationQueue.countPending(migrationId);
      setPendingCount(count);
      
      const db = await import('../local-store/db').then(m => m.getDB());
      const allOps = await db.getAllFromIndex('operations', 'by-migration', migrationId);
      const conflicts = allOps.filter(op => op.status === 'CONFLICT').length;
      setConflictCount(conflicts);
    }, 1000);

    return () => clearInterval(interval);
  }, [migrationId]);

  if (!isOnline) {
    return (
      <div className="flex items-center gap-2 text-xs font-medium text-amber-600 bg-amber-50 px-3 py-1.5 rounded-full border border-amber-200 shadow-sm">
        <CloudOff className="h-4 w-4" />
        <span>Offline · {pendingCount > 0 ? `${pendingCount} changes pending` : 'No changes'}</span>
      </div>
    );
  }

  if (conflictCount > 0) {
    return (
      <button onClick={onReviewConflicts} className="flex items-center gap-2 text-xs font-bold text-red-600 bg-red-50 hover:bg-red-100 px-3 py-1.5 rounded-full border border-red-300 shadow-sm transition-all cursor-pointer">
        <AlertCircle className="h-4 w-4" />
        <span>{conflictCount} conflicts need attention</span>
      </button>
    );
  }

  if (pendingCount > 0) {
    return (
      <div className="flex items-center gap-2 text-xs font-medium text-blue-600 bg-blue-50 px-3 py-1.5 rounded-full border border-blue-200 shadow-sm">
        <RefreshCw className="h-4 w-4 animate-spin" />
        <span>Syncing · {pendingCount} remaining</span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 text-xs font-medium text-emerald-600 bg-emerald-50 px-3 py-1.5 rounded-full border border-emerald-200 shadow-sm transition-all duration-500">
      <Cloud className="h-4 w-4" />
      <span>Saved</span>
    </div>
  );
};
