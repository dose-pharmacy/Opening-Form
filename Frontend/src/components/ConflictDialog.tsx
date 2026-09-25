import React, { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Check, Cloud, RefreshCw, XCircle } from 'lucide-react';
import { getDB } from '../local-store/db';
import { OperationQueue, type ConflictRecord, type SyncOperation } from '../sync/queue';
import { SyncManager } from '../sync/syncManager';

interface ConflictDialogProps {
  migrationId: string;
  onClose: () => void;
}

interface ResolvedIssue {
  op: SyncOperation;
  details?: ConflictRecord;
}

export const ConflictDialog: React.FC<ConflictDialogProps> = ({ migrationId, onClose }) => {
  const [issues, setIssues] = useState<ResolvedIssue[]>([]);
  const [loading, setLoading] = useState(true);

  const loadIssues = useCallback(async () => {
    setLoading(true);
    const db = await getDB();
    const allOps = (await db.getAllFromIndex('operations', 'by-migration', migrationId)) as
      | SyncOperation[]
      | undefined;
    const unresolved = (allOps ?? []).filter(
      (op) => op.status === 'CONFLICT' || op.status === 'ERROR'
    );

    const detailed = await Promise.all(
      unresolved.map(async (op) => ({ op, details: await OperationQueue.getConflict(op.operationId) }))
    );

    setIssues(detailed);
    setLoading(false);
    if (detailed.length === 0) onClose();
  }, [migrationId, onClose]);

  useEffect(() => {
    loadIssues();
  }, [loadIssues]);

  const handleKeepServer = async ({ op }: ResolvedIssue) => {
    await OperationQueue.removeOperation(op.operationId);
    const db = await getDB();
    await db.delete('conflicts', op.operationId);
    // The server copy stays authoritative; the next pull refreshes the mirror.
    SyncManager.pullChanges(migrationId).finally(loadIssues);
  };

  const handleKeepLocal = async ({ op, details }: ResolvedIssue) => {
    await OperationQueue.requeue(op.operationId, details?.currentVersion ?? undefined);
    SyncManager.triggerSync(migrationId).finally(loadIssues);
  };

  const handleRetry = async ({ op }: ResolvedIssue) => {
    await OperationQueue.requeue(op.operationId);
    SyncManager.triggerSync(migrationId).finally(loadIssues);
  };

  if (loading) return null;

  const label = (op: SyncOperation) => op.entityType.replace(/_/g, ' ').toLowerCase();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl">
        <div className="flex items-center gap-3 border-b border-primary-mid/10 bg-primary-light/30 px-6 py-4">
          <AlertCircle className="h-5 w-5 text-red-500" />
          <h2 className="text-lg font-semibold text-text-primary">
            {title(issues)}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto rounded-lg p-1.5 text-text-muted hover:bg-black/5"
            aria-label="Close"
          >
            <XCircle className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          {issues.map(({ op, details }) => {
            const isConflict = op.status === 'CONFLICT';
            const serverData = details?.serverData;
            const hasServerCopy = Boolean(serverData && Object.keys(serverData).length > 0);

            return (
              <div
                key={op.operationId}
                className="mb-6 rounded-lg border border-red-200 bg-red-50/30 p-4 last:mb-0"
              >
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-bold uppercase tracking-wide text-text-primary">
                    {label(op)} · {op.entityId}
                  </span>
                  <span
                    className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${
                      isConflict ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'
                    }`}
                  >
                    {isConflict ? 'Conflicting change' : 'Rejected by server'}
                  </span>
                </div>

                {!isConflict && (
                  <p className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                    {details?.error || op.lastError || 'The server could not apply this change.'}
                  </p>
                )}

                <div className="grid gap-4 text-sm sm:grid-cols-2">
                  <div className="rounded border bg-white p-3 shadow-sm">
                    <h4 className="mb-2 font-semibold text-text-primary">Your change</h4>
                    <pre className="max-h-40 overflow-auto text-xs text-text-secondary">
                      {JSON.stringify(op.payload, null, 2)}
                    </pre>
                    <div className="mt-2 text-xs text-text-muted">
                      Base version: {op.baseVersion ?? '—'}
                    </div>
                  </div>
                  <div className="rounded border border-blue-200 bg-white p-3 shadow-sm">
                    <h4 className="mb-2 flex items-center gap-2 font-semibold text-text-primary">
                      <Cloud className="h-3.5 w-3.5 text-blue-500" /> Server version
                    </h4>
                    {hasServerCopy ? (
                      <>
                        <pre className="max-h-40 overflow-auto text-xs text-text-secondary">
                          {JSON.stringify(serverData, null, 2)}
                        </pre>
                        <div className="mt-2 text-xs text-text-muted">
                          Current version: {details?.currentVersion ?? '—'}
                        </div>
                      </>
                    ) : (
                      <p className="text-xs text-text-muted">
                        No record on the server for this change.
                      </p>
                    )}
                  </div>
                </div>

                <div className="mt-4 flex flex-wrap justify-end gap-3">
                  {isConflict ? (
                    <>
                      <button
                        type="button"
                        onClick={() => handleKeepServer({ op, details })}
                        className="rounded-lg border bg-white px-4 py-2 text-sm font-medium transition-colors hover:bg-gray-50"
                      >
                        Keep server version
                      </button>
                      <button
                        type="button"
                        onClick={() => handleKeepLocal({ op, details })}
                        className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-accent-soft"
                      >
                        <Check className="h-4 w-4" /> Keep my version
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => handleRetry({ op, details })}
                      className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-accent-soft"
                    >
                      <RefreshCw className="h-4 w-4" /> Retry change
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div className="flex justify-end border-t border-primary-mid/10 bg-gray-50 p-4">
          <button
            type="button"
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

const title = (issues: ResolvedIssue[]): string => {
  const conflicts = issues.filter((i) => i.op.status === 'CONFLICT').length;
  const errors = issues.length - conflicts;
  if (conflicts && errors) return `${conflicts} conflict(s) and ${errors} rejected change(s)`;
  if (conflicts) return `${conflicts} conflict(s) to resolve`;
  return `${errors} change(s) rejected by the server`;
};

export default ConflictDialog;
