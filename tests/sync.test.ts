import { describe, it, expect } from 'vitest';
import { generateSyncCode, keyFromCode, normalizeSyncCode, planSync } from '../src/game/sync';

// Cloud sync (mobile tier 3) — the pure heart of the client. The wire calls
// and the Worker's conditional upsert are covered end-to-end by the dev-server
// drive (see .claude/skills/run-app); these lock the decision logic.

describe('planSync: the freshness model (stamp + dirty, never lastSeen)', () => {
  it('no cloud save yet → push (first device up seeds it)', () => {
    expect(planSync({ remoteSavedAt: null, lastCloudStamp: 0, dirty: false })).toBe('push');
  });
  it('cloud advanced past our stamp, clean here → adopt (another device played)', () => {
    expect(planSync({ remoteSavedAt: 2000, lastCloudStamp: 1000, dirty: false })).toBe('adopt');
  });
  it('cloud advanced AND we played here → the actively-played device wins (push)', () => {
    expect(planSync({ remoteSavedAt: 2000, lastCloudStamp: 1000, dirty: true })).toBe('push');
  });
  it('cloud is ours + we played → push', () => {
    expect(planSync({ remoteSavedAt: 1000, lastCloudStamp: 1000, dirty: true })).toBe('push');
  });
  it('cloud is ours + clean → in sync (idle progress is reproducible, not worth a write)', () => {
    expect(planSync({ remoteSavedAt: 1000, lastCloudStamp: 1000, dirty: false })).toBe('in-sync');
  });
  it('merely LOADING never claims freshness — a clean reopened device adopts, not pushes', () => {
    // The bug this model exists to prevent: catch-up stamps lastSeen=now on
    // every load, so a lastSeen comparison would let a stale parked device
    // clobber real progress just by being opened.
    expect(planSync({ remoteSavedAt: 5000, lastCloudStamp: 4000, dirty: false })).toBe('adopt');
  });
});

describe('sync codes', () => {
  it('generates duck-xxxx-xxxx-xxxx from the unambiguous alphabet', () => {
    for (let i = 0; i < 20; i++) {
      expect(generateSyncCode()).toMatch(/^duck-[23456789abcdefghjkmnpqrstuvwxyz]{4}-[23456789abcdefghjkmnpqrstuvwxyz]{4}-[23456789abcdefghjkmnpqrstuvwxyz]{4}$/);
    }
  });
  it('never repeats in practice', () => {
    const seen = new Set(Array.from({ length: 50 }, () => generateSyncCode()));
    expect(seen.size).toBe(50);
  });
  it('normalizes hand-typed input (case, whitespace)', () => {
    expect(normalizeSyncCode('  DUCK-ab2f-x9k3-mm7q ')).toBe('duck-ab2f-x9k3-mm7q');
    expect(normalizeSyncCode('duck ab2f x9k3 mm7q')).toBe('duck-ab2f-x9k3-mm7q');
  });
});

describe('keyFromCode: the code never leaves the device — only its hash', () => {
  it('derives a 64-hex key', async () => {
    expect(await keyFromCode('duck-ab2f-x9k3-mm7q')).toMatch(/^[0-9a-f]{64}$/);
  });
  it('formatting variants of the same code land on the same key', async () => {
    const a = await keyFromCode('duck-ab2f-x9k3-mm7q');
    const b = await keyFromCode('  Duck-AB2F-X9K3-MM7Q ');
    expect(b).toBe(a);
  });
  it('different codes land on different keys', async () => {
    const a = await keyFromCode('duck-ab2f-x9k3-mm7q');
    const b = await keyFromCode('duck-ab2f-x9k3-mm7r');
    expect(b).not.toBe(a);
  });
});
