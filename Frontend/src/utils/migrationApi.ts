/**
 * Thin HTTP client for the migration service.
 *
 * Entity writes deliberately do NOT live here: every change is pushed through
 * the outbox (`sync/pushDraft.ts` + `sync/syncManager.ts`) so it survives being
 * offline, is ordered parent-first, and is retried instead of being lost.
 */

import { API_BASE } from './apiBase';

export interface MigrationSummaryResponse {
  id: string;
  name: string;
  status: string;
  revision: number;
  counts: Record<string, number>;
}

export const migrationApi = {
  createMigration: async (name: string): Promise<{ id: string; revision: number }> => {
    const res = await fetch(`${API_BASE}/migrations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) throw new Error('Failed to create migration');
    return res.json();
  },

  /**
   * Throws with `status: 404` when the stored migration is genuinely gone.
   * Any other failure (offline, server down) is transient and must NOT be
   * treated as "this migration no longer exists".
   */
  getMigration: async (id: string): Promise<{ id: string; revision: number }> => {
    const res = await fetch(`${API_BASE}/migrations/${id}`);
    if (!res.ok) {
      const error: any = new Error(
        res.status === 404 ? 'Migration not found' : `Migration service unavailable (${res.status})`
      );
      error.status = res.status;
      throw error;
    }
    return res.json();
  },

  getSummary: async (id: string): Promise<MigrationSummaryResponse> => {
    const res = await fetch(`${API_BASE}/migrations/${id}/summary`);
    if (!res.ok) throw new Error('Failed to get summary');
    return res.json();
  },

  getChanges: async (id: string, sinceRevision: number = 0): Promise<any> => {
    const res = await fetch(`${API_BASE}/migrations/${id}/changes?sinceRevision=${sinceRevision}`);
    if (!res.ok) throw new Error('Failed to get changes');
    return res.json();
  },

  exportMigration: async (id: string): Promise<any> => {
    const res = await fetch(`${API_BASE}/migrations/${id}/export`);
    if (!res.ok) throw new Error('Failed to export migration');
    return res.json();
  },
};
