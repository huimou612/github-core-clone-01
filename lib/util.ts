// Deterministic time, ids and small helpers shared by every surface.
//
// The final trials are replayed, so nothing a response carries may come from a
// wall clock, Math.random or an unseeded UUID. Every timestamp and id below
// derives from one monotonic counter seeded from MAKEFUN_TRIAL_NOW when the
// env sets it, else from a fixed base time.

import { createHash } from 'node:crypto';

/** The viewer the trial's token names. Fixed by the kit's scenario seed. */
export const VIEWER = Object.freeze({
  login: 'adaiversen',
  id: 1000,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
});

/** Parse MAKEFUN_TRIAL_NOW (epoch ms, or an ISO string) or fall back to the fixed base. */
function baseMsOf(): number {
  const raw = (process.env.MAKEFUN_TRIAL_NOW ?? '').trim();
  if (raw !== '') {
    if (/^-?\d+$/.test(raw)) {
      const ms = Number(raw);
      if (Number.isFinite(ms)) return ms;
    }
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.parse('2026-11-19T00:00:00.000Z');
}

const BASE_MS = baseMsOf();
const BASE_SEC = Math.floor(BASE_MS / 1000);

/** One monotonic tick, in seconds, shared by every timestamp the server emits. */
let tick = 0;

/** The next deterministic instant, as an ISO string. One second per call, strictly increasing. */
export function isoNow(): string {
  tick += 1;
  return new Date(BASE_MS + tick * 1000).toISOString();
}

/** The next deterministic instant, as epoch seconds (for git author/committer lines). */
export function epochNow(): number {
  tick += 1;
  return BASE_SEC + tick;
}

/** A monotonic numeric id, starting at 1, for REST objects (repos, issues, pulls, comments). */
let idCounter = 0;
export function nextId(): number {
  idCounter += 1;
  return idCounter;
}

/** An opaque, stable global id: base64url of a typed key. Never the plain database id. */
export function globalId(kind: string, id: number): string {
  return Buffer.from(`${kind}:${id}`, 'utf8').toString('base64url');
}

/** Decode a global id back to its typed key, or null when it is not one of ours. */
export function parseGlobalId(value: string): { kind: string; id: number } | null {
  try {
    const text = Buffer.from(value, 'base64url').toString('utf8');
    const colon = text.indexOf(':');
    if (colon <= 0) return null;
    const kind = text.slice(0, colon);
    const id = Number(text.slice(colon + 1));
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    return { kind, id };
  } catch {
    return null;
  }
}

/** A base64 cursor for a numeric position, and its decode. Opaque to the caller. */
export function encodeCursor(n: number): string {
  return Buffer.from(`cursor:${n}`, 'utf8').toString('base64url');
}

export function decodeCursor(value: string): number | null {
  try {
    const text = Buffer.from(value, 'base64url').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const n = Number(text.slice('cursor:'.length));
    return Number.isSafeInteger(n) ? n : null;
  } catch {
    return null;
  }
}

/** sha1 of a buffer, as lowercase hex. */
export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The 40-zero object id. */
export const ZERO_OID = '0000000000000000000000000000000000000000';

/** True when `value` is a 40-hex object id. */
export function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

/** Split a base64 content body the way the contents API accepts it (whitespace tolerated). */
export function decodeBase64(text: string): Buffer | null {
  const clean = text.replace(/\s+/g, '');
  if (clean === '') return Buffer.alloc(0);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) return null;
  try {
    return Buffer.from(clean, 'base64');
  } catch {
    return null;
  }
}
