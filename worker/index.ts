/**
 * worker/index.ts — CLOUD SYNC (mobile tier 3).
 *
 * One Worker, one D1 table: the same homestead on every device. The client
 * pushes its serialized save with `savedAt = state.lastSeen`; the Worker
 * enforces NEWEST-WINS server-side with a conditional upsert — a stale push
 * is rejected with 409 + the newer save, so the losing device pulls instead
 * of clobbering. No accounts: the "user" is a 64-hex key the client derives
 * by hashing a private sync code (see src/game/sync.ts). Distinct codes are
 * distinct users by construction.
 *
 * Static assets are served by the assets binding (wrangler.jsonc); only
 * /api/* is routed here (run_worker_first).
 */

// Minimal local declarations for the two Cloudflare bindings this worker
// touches — enough for editor sanity without pulling in workers-types.
interface D1Result {
  meta: { changes: number };
}
interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  run(): Promise<D1Result>;
  first<T>(): Promise<T | null>;
}
interface D1Database {
  prepare(query: string): D1PreparedStatement;
}
interface Env {
  DB: D1Database;
}

/** Sync keys are SHA-256 hex of the user's sync code — nothing else is a key. */
const KEY_RE = /^[0-9a-f]{64}$/;
/** Generous cap — a huge endgame save serializes to a few hundred KB. */
const MAX_SAVE_BYTES = 2 * 1024 * 1024;

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** Lazy one-table schema — CREATE IF NOT EXISTS beats migration ceremony for
 *  a personal app. Runs once per isolate. */
let schemaReady: Promise<unknown> | null = null;
function ensureSchema(db: D1Database): Promise<unknown> {
  schemaReady ??= db
    .prepare(
      `CREATE TABLE IF NOT EXISTS saves (
         user_key   TEXT PRIMARY KEY,
         save_json  TEXT NOT NULL,
         saved_at   INTEGER NOT NULL,
         updated_at INTEGER NOT NULL
       )`,
    )
    .run();
  return schemaReady;
}

/** The same shape-sniff the client's import uses (save.ts looksLikeSave):
 *  every real save has always had these fields. Not a validator — a gate
 *  against storing arbitrary blobs under a save's name. */
function looksLikeSave(parsed: unknown): boolean {
  if (typeof parsed !== 'object' || parsed === null) return false;
  const p = parsed as Record<string, unknown>;
  return typeof p.rank === 'number' && Array.isArray(p.ducks) && typeof p.resources === 'object' && p.resources !== null;
}

async function getSave(db: D1Database, key: string): Promise<Response> {
  const row = await db
    .prepare('SELECT save_json, saved_at FROM saves WHERE user_key = ?1')
    .bind(key)
    .first<{ save_json: string; saved_at: number }>();
  if (!row) return json(404, { error: 'no save' });
  return json(200, { save: row.save_json, savedAt: row.saved_at });
}

async function putSave(db: D1Database, key: string, req: Request): Promise<Response> {
  const text = await req.text();
  if (text.length > MAX_SAVE_BYTES) return json(413, { error: 'save too large' });
  let body: { save?: unknown; savedAt?: unknown };
  try {
    body = JSON.parse(text);
  } catch {
    return json(400, { error: 'bad json' });
  }
  const { save, savedAt } = body;
  if (typeof save !== 'string' || typeof savedAt !== 'number' || !Number.isFinite(savedAt)) {
    return json(400, { error: 'expected { save: string, savedAt: number }' });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(save);
  } catch {
    return json(400, { error: 'save is not JSON' });
  }
  if (!looksLikeSave(parsed)) return json(400, { error: 'not a homestead save' });

  // NEWEST-WINS, enforced atomically: the upsert only applies when the pushed
  // save is at least as fresh as the stored one. meta.changes tells us which
  // way it went — a rejected push returns the newer save so the client can
  // adopt it instead (its offline catch-up absorbs the gap).
  const result = await db
    .prepare(
      `INSERT INTO saves (user_key, save_json, saved_at, updated_at)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(user_key) DO UPDATE
         SET save_json = excluded.save_json,
             saved_at = excluded.saved_at,
             updated_at = excluded.updated_at
         WHERE excluded.saved_at >= saves.saved_at`,
    )
    .bind(key, save, savedAt, Date.now())
    .run();
  if (result.meta.changes > 0) return json(200, { stored: true, savedAt });

  const newer = await db
    .prepare('SELECT save_json, saved_at FROM saves WHERE user_key = ?1')
    .bind(key)
    .first<{ save_json: string; saved_at: number }>();
  return json(409, { stored: false, save: newer?.save_json, savedAt: newer?.saved_at });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/api\/save\/([0-9a-f]+)$/);
    if (!match) return json(404, { error: 'not found' });
    const key = match[1];
    if (!KEY_RE.test(key)) return json(400, { error: 'bad key' });

    await ensureSchema(env.DB);
    if (request.method === 'GET') return getSave(env.DB, key);
    if (request.method === 'PUT') return putSave(env.DB, key, request);
    return json(405, { error: 'method not allowed' });
  },
};
