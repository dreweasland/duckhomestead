import { useCallback, useEffect, useRef, useState } from 'react';
import type { GameEngine } from './engine';
import { serialize } from './save';
import {
  clearSyncCode,
  fetchRemote,
  generateSyncCode,
  keyFromCode,
  normalizeSyncCode,
  planSync,
  pushRemote,
  storeCloudStamp,
  storedCloudStamp,
  storeSyncCode,
  storedSyncCode,
  type RemoteSave,
} from './sync';

export type SyncStatus = 'off' | 'syncing' | 'synced' | 'error';

export interface CloudSync {
  status: SyncStatus;
  /** The private sync code (shown on demand so it can be typed elsewhere). */
  code: string | null;
  lastSyncAt: number | null;
  /** Generate a fresh code, store it, push the current save. Returns the code. */
  enableNew(): Promise<string>;
  /** Connect with an existing code — the cloud homestead loads HERE if one
   *  exists (that's what typing a code means); otherwise this save seeds it. */
  connect(code: string): Promise<void>;
  /** Forget the code on THIS device (the cloud save stays for the others). */
  disable(): void;
  syncNow(): Promise<void>;
}

/** Heartbeat cadence. A GET per beat detects another device's push; a write
 *  only happens when THIS device was actively played (see sync.ts's model). */
const HEARTBEAT_MS = 4 * 60 * 1000;

/**
 * Cloud sync orchestration: reconcile on mount, on every visibility flip, and
 * on a slow heartbeat. All triggers funnel through one in-flight guard so a
 * slow network can't stack reconciles. Local-first: the cloud being
 * unreachable never blocks play — status shows 'error' and the next trigger
 * retries.
 */
export function useCloudSync(engine: GameEngine): CloudSync {
  const [code, setCode] = useState<string | null>(() => storedSyncCode());
  const [status, setStatus] = useState<SyncStatus>(code ? 'syncing' : 'off');
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null);
  const inFlight = useRef(false);
  /** Actively played since the last successful push/adopt — the same
   *  pointer/key signal that arms markActive. */
  const dirty = useRef(false);

  const adopt = useCallback(
    (remote: RemoteSave) => {
      engine.adoptCloudSave(remote.save, Date.now());
      storeCloudStamp(remote.savedAt);
      dirty.current = false;
    },
    [engine],
  );

  const push = useCallback(async (key: string) => {
    const stamp = Date.now();
    engine.saveNow(stamp); // the save carries lastSeen = stamp for the next device's catch-up
    const r = await pushRemote(key, serialize(engine.state), stamp);
    if (r.stored) {
      storeCloudStamp(stamp);
      dirty.current = false;
    } else {
      // Beaten by an even fresher push (or clock skew) — newest wins: adopt it.
      adopt(r.newer);
    }
  }, [adopt, engine]);

  const runSync = useCallback(
    async (activeCode: string, mode: 'reconcile' | 'connect') => {
      if (inFlight.current) return;
      inFlight.current = true;
      setStatus('syncing');
      try {
        const key = await keyFromCode(activeCode);
        const remote = await fetchRemote(key);
        if (mode === 'connect') {
          // Typing a code means "give me that homestead" — the cloud wins
          // outright if it exists; otherwise this save becomes the seed.
          if (remote) adopt(remote);
          else await push(key);
        } else {
          const plan = planSync({
            remoteSavedAt: remote?.savedAt ?? null,
            lastCloudStamp: storedCloudStamp(),
            dirty: dirty.current,
          });
          if (plan === 'adopt') adopt(remote!);
          else if (plan === 'push') await push(key);
        }
        setStatus('synced');
        setLastSyncAt(Date.now());
      } catch {
        setStatus('error'); // unreachable/failed — retried on the next trigger
      } finally {
        inFlight.current = false;
      }
    },
    [adopt, push],
  );

  // Dirty tracking + the reconcile triggers, live while a code is set.
  useEffect(() => {
    if (!code) return;
    const markDirty = (e: Event) => {
      // Interacting with the sync controls themselves isn't playing — a
      // "Sync now" click must not make this device claim fork-victory over
      // another device's real progress. (Elements under [data-sync-ui].)
      if (e.target instanceof Element && e.target.closest('[data-sync-ui]')) return;
      dirty.current = true;
    };
    window.addEventListener('pointerdown', markDirty);
    window.addEventListener('keydown', markDirty);

    void runSync(code, 'reconcile');
    const onVisibility = () => {
      // Hidden: park the fresh save in the cloud (if we played). Visible:
      // pick up whatever another device pushed — useGame's handler registered
      // first, so offline catch-up has already run when this fires.
      void runSync(code, 'reconcile');
    };
    document.addEventListener('visibilitychange', onVisibility);
    const heartbeat = window.setInterval(() => void runSync(code, 'reconcile'), HEARTBEAT_MS);
    return () => {
      window.removeEventListener('pointerdown', markDirty);
      window.removeEventListener('keydown', markDirty);
      document.removeEventListener('visibilitychange', onVisibility);
      window.clearInterval(heartbeat);
    };
  }, [code, runSync]);

  const enableNew = useCallback(async () => {
    const fresh = generateSyncCode();
    storeSyncCode(fresh);
    storeCloudStamp(0);
    dirty.current = true; // this homestead is the seed — push it regardless
    setCode(fresh);
    await runSync(fresh, 'reconcile');
    return fresh;
  }, [runSync]);

  const connect = useCallback(
    async (raw: string) => {
      const normalized = normalizeSyncCode(raw);
      storeSyncCode(normalized);
      storeCloudStamp(0);
      setCode(normalized);
      await runSync(normalized, 'connect');
    },
    [runSync],
  );

  const disable = useCallback(() => {
    clearSyncCode();
    setCode(null);
    setStatus('off');
    setLastSyncAt(null);
  }, []);

  const syncNow = useCallback(async () => {
    if (code) await runSync(code, 'reconcile');
  }, [code, runSync]);

  return { status, code, lastSyncAt, enableNew, connect, disable, syncNow };
}
