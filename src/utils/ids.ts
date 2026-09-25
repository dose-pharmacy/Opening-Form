/** Client-only identifiers. These never leave the browser. */
export function newId(): string {
  const cryptoObj = typeof crypto !== 'undefined' ? crypto : undefined;
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    return cryptoObj.randomUUID();
  }
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Unique, human-readable names. */
export function uniqueNames(values: Array<string | { name: string }>): string[] {
  return [...new Set(values.map((v) => (typeof v === 'string' ? v : v.name)).filter(Boolean))];
}
