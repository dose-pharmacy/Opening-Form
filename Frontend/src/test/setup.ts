/**
 * Test setup.
 *
 * The workspace lives in IndexedDB, so the suite runs against `fake-indexeddb`,
 * which implements the real API in memory. Each test gets a fresh database and a
 * fresh set of mock server tables.
 *
 * The environment is plain Node, so the few browser globals the modules touch
 * (`window.localStorage` for metadata, `navigator.onLine`, `window.addEventListener`
 * in the sync engine) are provided here as minimal, honest stand-ins.
 */

import 'fake-indexeddb/auto';

if (typeof globalThis.structuredClone !== 'function') {
  globalThis.structuredClone = (value: any) => JSON.parse(JSON.stringify(value));
}

/** In-memory `Storage`. Only the four methods `utils/storage.ts` uses. */
const createStorage = (): Storage => {
  const entries = new Map<string, string>();
  return {
    get length() {
      return entries.size;
    },
    key: (index: number) => [...entries.keys()][index] ?? null,
    getItem: (key: string) => (entries.has(key) ? entries.get(key)! : null),
    setItem: (key: string, value: string) => void entries.set(key, String(value)),
    removeItem: (key: string) => void entries.delete(key),
    clear: () => entries.clear(),
  } as Storage;
};

const define = (target: any, key: string, value: any) => {
  Object.defineProperty(target, key, { value, writable: true, configurable: true });
};

if (typeof (globalThis as any).window === 'undefined') {
  define(globalThis, 'window', globalThis);
}
define(globalThis, 'localStorage', createStorage());
if (typeof (globalThis as any).window !== 'undefined') {
  define((globalThis as any).window, 'localStorage', (globalThis as any).localStorage);
}

// The sync engine registers a listener and a 30s timer on import. Node has
// neither, and the timer would keep the test process alive.
const listeners = new Map<string, Set<(event?: any) => void>>();
define(globalThis, 'addEventListener', (type: string, handler: (event?: any) => void) => {
  if (!listeners.has(type)) listeners.set(type, new Set());
  listeners.get(type)!.add(handler);
});
define(globalThis, 'removeEventListener', (type: string, handler: (event?: any) => void) => {
  listeners.get(type)?.delete(handler);
});
define(globalThis, 'setInterval', ((handler: any, ms: number) => {
  // Record it but never actually run it.
  return { unref: () => undefined, _handler: handler, _ms: ms };
}) as any);
define(globalThis, '__emit', (type: string) => {
  for (const handler of listeners.get(type) ?? []) handler();
});

// `navigator` is a read-only accessor on modern Node, so it has to be redefined
// rather than assigned.
let online = true;
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  get: () => ({ get onLine() { return online; } }),
});
(globalThis as any).__setOnline = (value: boolean) => {
  online = value;
};
