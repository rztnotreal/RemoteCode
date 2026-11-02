/**
 * Small ID/timestamp helpers shared across RemoteCode.
 */

import { randomUUID } from 'node:crypto';

/**
 * Returns a UUID-based id, optionally prefixed for readability,
 * e.g. `newId('ses')` → `ses_<uuid>`.
 */
export function newId(prefix?: string): string {
  const id = randomUUID();
  return prefix !== undefined && prefix !== '' ? `${prefix}_${id}` : id;
}

/** Current time as unix epoch milliseconds. */
export function now(): number {
  return Date.now();
}
