/**
 * sync.ts — CLOUD SYNC client (mobile tier 3): the same homestead on every
 * device, no accounts.
 *
 * Identity is a private SYNC CODE the player generates once and types into
 * their other devices. The server never sees the code — only its SHA-256 hex
 * (the storage key), so a leaked database is a pile of anonymous saves.
 *
 * THE FRESHNESS MODEL. "Newest save wins" can't be judged by the save's own
 * lastSeen — merely LOADING the game runs offline catch-up and stamps
 * lastSeen to now, so any device that opened the page would claim maximal
 * freshness and push its stale timeline over real progress. Instead each
 * device tracks:
 *   - lastCloudStamp — the cloud save's stamp this device last agreed with
 *     (set on every successful push or adopt), and
 *   - dirty — whether the player has ACTIVELY played here since that
 *     agreement (pointer/key input, the same signal as markActive).
 * Reconciling: a cloud save newer than our stamp means another device pushed
 * — adopt it, unless we're dirty (a true fork), in which case the device
 * being actively played wins and pushes. A clean device never pushes at all:
 * pure idle/catch-up progress is reproducible from the cloud save, so it
 * isn't worth a write. The Worker enforces newest-wins server-side too (a
 * stale push gets 409 + the newer save), so no race can clobber progress.
 *
 * Adopting is cheap by construction: GameEngine.adoptCloudSave credits the
 * gap since the save's lastSeen through the SAME offline catch-up a page
 * load gets — staleness costs only the other device's active progress.
 */

const CODE_KEY = 'duck-homestead-sync-code';
const STAMP_KEY = 'duck-homestead-sync-stamp';

// ── The sync code ─────────────────────────────────────────────────────
/** Unambiguous base32-ish alphabet (no 0/o, 1/l/i) — the code gets typed
 *  across devices, sometimes from a phone screen. */
const ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';

/** A fresh sync code: duck-xxxx-xxxx-xxxx (~62 bits — plenty for a namespace
 *  where guessing wrong yields someone's anonymous duck farm). */
export function generateSyncCode(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const chars = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]);
  return `duck-${chars.slice(0, 4).join('')}-${chars.slice(4, 8).join('')}-${chars.slice(8, 12).join('')}`;
}

/** Normalize hand-typed input: trim, lowercase, unify separators. */
export function normalizeSyncCode(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, '-');
}

/** The storage key is the code's SHA-256 hex — the code itself never leaves
 *  the device. */
export async function keyFromCode(code: string): Promise<string> {
  const data = new TextEncoder().encode(normalizeSyncCode(code));
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function storedSyncCode(): string | null {
  try {
    return localStorage.getItem(CODE_KEY);
  } catch {
    return null;
  }
}
export function storeSyncCode(code: string): void {
  try {
    localStorage.setItem(CODE_KEY, normalizeSyncCode(code));
  } catch {
    /* storage unavailable — sync just won't persist across reloads */
  }
}
export function clearSyncCode(): void {
  try {
    localStorage.removeItem(CODE_KEY);
    localStorage.removeItem(STAMP_KEY);
  } catch {
    /* ignore */
  }
}

/** The cloud stamp this device last pushed or adopted (0 = never synced). */
export function storedCloudStamp(): number {
  try {
    const v = Number(localStorage.getItem(STAMP_KEY));
    return Number.isFinite(v) && v > 0 ? v : 0;
  } catch {
    return 0;
  }
}
export function storeCloudStamp(stamp: number): void {
  try {
    localStorage.setItem(STAMP_KEY, String(stamp));
  } catch {
    /* ignore */
  }
}

// ── The reconcile decision (pure — the tested heart of the sync) ──────
export type SyncPlan = 'push' | 'adopt' | 'in-sync';

/**
 * Which way to sync (see THE FRESHNESS MODEL above):
 *  - no cloud save → push (first device up).
 *  - cloud advanced past our stamp → another device pushed: adopt it — unless
 *    we're dirty (played HERE too — a fork), where the actively-played device
 *    wins and pushes.
 *  - cloud is ours → push only if dirty; pure idle progress is reproducible
 *    from the cloud save and never worth a write.
 */
export function planSync(opts: {
  remoteSavedAt: number | null;
  lastCloudStamp: number;
  dirty: boolean;
}): SyncPlan {
  const { remoteSavedAt, lastCloudStamp, dirty } = opts;
  if (remoteSavedAt == null) return 'push';
  if (remoteSavedAt > lastCloudStamp) return dirty ? 'push' : 'adopt';
  return dirty ? 'push' : 'in-sync';
}

// ── Wire calls ────────────────────────────────────────────────────────
export interface RemoteSave {
  save: string;
  savedAt: number;
}

/** GET the cloud save. null = none stored yet. Throws on network/server error. */
export async function fetchRemote(key: string): Promise<RemoteSave | null> {
  const res = await fetch(`/api/save/${key}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`sync fetch failed (${res.status})`);
  return (await res.json()) as RemoteSave;
}

export type PushResult = { stored: true } | { stored: false; newer: RemoteSave };

/** PUT the local save. A 409 means the cloud holds something newer — the
 *  caller adopts it instead (newest-wins, enforced server-side). */
export async function pushRemote(key: string, save: string, savedAt: number): Promise<PushResult> {
  const res = await fetch(`/api/save/${key}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ save, savedAt }),
  });
  if (res.status === 409) {
    const body = (await res.json()) as { save?: string; savedAt?: number };
    if (typeof body.save === 'string' && typeof body.savedAt === 'number') {
      return { stored: false, newer: { save: body.save, savedAt: body.savedAt } };
    }
    throw new Error('sync conflict with no payload');
  }
  if (!res.ok) throw new Error(`sync push failed (${res.status})`);
  return { stored: true };
}
