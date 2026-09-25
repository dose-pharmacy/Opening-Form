import React, { useEffect, useState } from 'react';
import { AlertCircle, Check, X, RefreshCw } from 'lucide-react';
import { getDB } from '../local-store/db';
import { OperationQueue } from '../sync/queue';
import { SyncManager } from '../sync/syncManager';

interface ConflictDialogProps {
  migrationId: string;
  onClose: () => void;
}

export const ConflictDialog: React.FC<ConflictDialogProps> = ({ migrationId, onClose }) => {
  const [conflicts, setConflicts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadConflicts();
  }, [migrationId]);

  const loadConflicts = async () => {
    setLoading(true);
    const db = await getDB();
    const allOps = await db.getAllFromIndex('operations', 'by-migration', migrationId);
    const conflictOps = allOps.filter(op => op.status === 'CONFLICT');
    
    const detailedConflicts = await Promise.all(
        conflictOps.map(async op => {
            const conflictDetails = await db.get('conflicts', op.operationId);
            return { op, details: conflictDetails };
        })
    );
    setConflicts(detailedConflicts);
    setLoading(false);
    
    if (detailedConflicts.length === 0) {
        onClose();
    }
  };

  const handleKeepServer = async (op: any, serverVersion: number) => {
    // Drop the local operation, adopt server version
    const db = await getDB();
    await db.delete('operations', op.operationId);
    await db.delete('conflicts', op.operationId);
    // Let next sync/fetch pull the server data, or we just rely on full reconcile
    await SyncManager.updateLocalVersion(migrationId, op.entityId, serverVersion); 
    loadConflicts();
  };

  const handleKeepLocal = async (op: any, serverVersion: number) => {
    // Re-enqueue the operation but with the updated baseVersion
    const db = await getDB();
    const operation = await db.get('operations', op.operationId);
    if (operation) {
        operation.baseVersion = serverVersion;
        operation.status = 'PENDING';
        operation.retryCount = 0;
        await db.put('operations', operation);
        await db.delete('conflicts', op.operationId);
    }
    SyncManager.triggerSync(migrationId);
    loadConflicts();
  };

  if (loading) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl">
        <div className="flex items-center gap-3 border-b border-primary-mid/10 bg-primary-light/30 px-6 py-4">
          <AlertCircle className="h-5 w-5 text-red-500" />
          <h2 className="text-lg font-semibold text-text-primary">Resolve Conflicts</h2>
        </div>
        
        <div className="overflow-y-auto p-6 flex flex-col gap-6">
            {conflicts.map(({ op, details }) => (
                <div key={op.operationId} className="border border-red-200 bg-red-50/30 rounded-lg p-4 flex flex-col gap-4">
                    <div className="flex items-center justify-between">
                        <span className="font-bold text-sm text-text-primary uppercase tracking-wide">{op.entityType}</span>
                        <span className="text-xs text-text-muted">Entity ID: {op.entityId.slice(0, 8)}...</span>
                    </div>
                    
                    <div className="grid grid-cols-2 gap-4 text-sm">
                        <div className="bg-white p-3 rounded border shadow-sm">
                            <h4 className="font-semibold text-text-primary mb-2">Your Change</h4>
                            <pre className="text-xs text-text-secondary overflow-auto max-h-40">{JSON.stringify(op.payload, null, 2)}</pre>
                            <div className="mt-2 text-xs text-text-muted">Base Version: {op.baseVersion || 1}</div>
                        </div>
                        <div className="bg-white p-3 rounded border shadow-sm border-blue-200">
                            <h4 className="font-semibold text-text-primary mb-2 flex items-center gap-2">
                                <Cloud className="h-3.5 w-3.5 text-blue-500" /> Server Version
                            </h4>
                            <pre className="text-xs text-text-secondary overflow-auto max-h-40">{JSON.stringify(details?.serverData || {}, null, 2)}</pre>
                            <div className="mt-2 text-xs text-text-muted">Current Version: {details?.currentVersion}</div>
                        </div>
                    </div>

                    <div className="flex justify-end gap-3 mt-2">
                        <button onClick={() => handleKeepServer(op, details?.currentVersion)} className="px-4 py-2 text-sm bg-white border hover:bg-gray-50 rounded-lg font-medium transition-colors">
                            Keep Server Version
                        </button>
                        <button onClick={() => handleKeepLocal(op, details?.currentVersion)} className="px-4 py-2 text-sm bg-accent hover:bg-accent-soft text-white rounded-lg font-medium shadow-sm transition-colors flex items-center gap-2">
                            <Check className="h-4 w-4" /> Keep My Version
                        </button>
                    </div>
                </div>
            ))}
        </div>

        <div className="flex justify-end border-t border-primary-mid/10 bg-gray-50 p-4">
          <button
            onClick={onClose}
            className="rounded-lg px-4 py-2 text-sm font-medium text-text-secondary hover:bg-black/5"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

// Helper for icon
const Cloud = ({ className }: { className?: string }) => (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}><path d="M17.5 19a1 1 0 0 0 1-1 4.5 4.5 0 0 0-1-8.7A5 5 0 0 0 8.5 5.5a1 1 0 0 0-1 1 5 5 0 1 0-2.5 9.4 1 1 0 0 0 .5 1.7 6.5 6.5 0 1 0 12-7.8"/></svg>
)
