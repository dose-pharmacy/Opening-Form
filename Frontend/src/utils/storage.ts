import type { MigrationData } from './types';

const STORAGE_KEY = 'pharmacy_opening_inventory_draft';
const LEGACY_KEY = 'pharmacy_migration_draft';

export interface DraftEnvelope {
  savedAt: string;
  data: MigrationData;
}

export interface LoadResult {
  data: MigrationData | null;
  savedAt: string | null;
  error: string | null;
}

export function isStorageAvailable(): boolean {
  try {
    const probe = '__pharmacy_storage_probe__';
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the draft. Accepts both the current envelope format and the legacy
 * raw-document format so old drafts keep working.
 */
export function loadDraft(): LoadResult {
  if (!isStorageAvailable()) {
    return { data: null, savedAt: null, error: 'Local storage is unavailable in this browser.' };
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY) ?? window.localStorage.getItem(LEGACY_KEY);
    if (!raw) return { data: null, savedAt: null, error: null };
    const parsed = JSON.parse(raw) as Partial<DraftEnvelope> & Partial<MigrationData>;
    if (parsed && typeof parsed === 'object' && 'data' in parsed && parsed.data) {
      return { data: parsed.data as MigrationData, savedAt: parsed.savedAt ?? null, error: null };
    }
    if (parsed && typeof parsed === 'object' && 'schemaVersion' in parsed) {
      return { data: parsed as MigrationData, savedAt: null, error: null };
    }
    return { data: null, savedAt: null, error: 'The saved draft could not be read.' };
  } catch {
    return { data: null, savedAt: null, error: 'The saved draft is corrupted and could not be loaded.' };
  }
}

export interface SaveResult {
  ok: boolean;
  savedAt: string | null;
  error: string | null;
}

export function saveDraft(data: MigrationData): SaveResult {
  const savedAt = new Date().toISOString();
  if (!isStorageAvailable()) {
    return { ok: false, savedAt: null, error: 'Local storage is unavailable — the draft cannot be saved.' };
  }
  try {
    const envelope: DraftEnvelope = { savedAt, data };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(envelope));
    return { ok: true, savedAt, error: null };
  } catch (error) {
    const isQuota =
      error instanceof DOMException &&
      (error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED');
    return {
      ok: false,
      savedAt: null,
      error: isQuota
        ? 'Local storage is full — export your JSON to keep your work safe.'
        : 'Local storage is unavailable — the draft could not be saved.',
    };
  }
}

export function clearDraft(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
    window.localStorage.removeItem(LEGACY_KEY);
  } catch {
    /* ignore */
  }
}
