/**
 * Base URL of the migration service.
 *
 * Resolution order:
 *  1. `VITE_API_BASE` (build-time env var) — used as-is, with the `/api` path
 *     appended when it is missing (the backend always mounts its routes there).
 *  2. A production fallback to the deployed API, so a release build can never
 *     silently point at `localhost` (which is what happened when the variable
 *     was missing or commented out: Vite inlines env vars at build time, so the
 *     browser had no way to reach the deployed backend).
 *  3. The local development backend.
 */

const DEV_FALLBACK = 'http://localhost:3001/api';
const PROD_FALLBACK = 'https://opening-form.onrender.com/api';

/** The service is mounted under `/api` — tolerate a bare origin in the env var. */
const normalize = (raw: string): string => {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  return /\/api$/i.test(trimmed) ? trimmed : `${trimmed}/api`;
};

const configured = (import.meta.env?.VITE_API_BASE as string | undefined)?.trim();

export const API_BASE = configured
  ? normalize(configured)
  : import.meta.env?.PROD
    ? PROD_FALLBACK
    : DEV_FALLBACK;
