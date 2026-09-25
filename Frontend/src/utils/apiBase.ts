/**
 * Base URL of the migration service.
 *
 * Override with `VITE_API_BASE` (e.g. a deployed API, or a second local
 * backend while another instance is running on the default port).
 */
const configured = (import.meta.env?.VITE_API_BASE as string | undefined)?.trim();

export const API_BASE = (configured || 'http://localhost:3001/api').replace(/\/+$/, '');
