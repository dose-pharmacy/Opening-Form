const METADATA_KEY = 'pharmacy_opening_metadata';

export interface Metadata {
  activeMigrationId: string | null;
  lastKnownRevision: number;
  setupStatus: 'not_started' | 'in_progress' | 'completed';
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

function getMetadata(): Metadata {
  if (!isStorageAvailable()) return { activeMigrationId: null, lastKnownRevision: 0, setupStatus: 'not_started' };
  try {
    const raw = window.localStorage.getItem(METADATA_KEY);
    if (!raw) return { activeMigrationId: null, lastKnownRevision: 0, setupStatus: 'not_started' };
    return JSON.parse(raw);
  } catch {
    return { activeMigrationId: null, lastKnownRevision: 0, setupStatus: 'not_started' };
  }
}

function setMetadata(data: Partial<Metadata>) {
  if (!isStorageAvailable()) return;
  const current = getMetadata();
  const next = { ...current, ...data };
  window.localStorage.setItem(METADATA_KEY, JSON.stringify(next));
}

export function getActiveMigrationId(): string | null {
  return getMetadata().activeMigrationId;
}

export function setActiveMigrationId(id: string | null): void {
  setMetadata({ activeMigrationId: id });
}

export function getMigrationRevision(): number {
  return getMetadata().lastKnownRevision;
}

export function setMigrationRevision(rev: number): void {
  setMetadata({ lastKnownRevision: rev });
}

export function getSetupStatus(): 'not_started' | 'in_progress' | 'completed' {
  return getMetadata().setupStatus;
}

export function setSetupStatus(status: 'not_started' | 'in_progress' | 'completed'): void {
  setMetadata({ setupStatus: status });
}

