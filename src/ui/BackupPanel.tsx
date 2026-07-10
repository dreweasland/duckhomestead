import { useRef, useState } from 'react';
import type { GameEngine } from '../game/engine';
import { deserialize, looksLikeSave, serialize } from '../game/save';
import type { GameState } from '../game/state';
import { useCloudSync } from '../game/useCloudSync';

interface Preview {
  rank: number;
  tier: number;
  flockSize: number;
  eggs: number;
}

function previewOf(state: GameState): Preview {
  return {
    rank: state.rank,
    tier: state.legacyTier,
    flockSize: state.ducks.length,
    eggs: Math.round(state.resources.eggs),
  };
}

/**
 * CLOUD SYNC (mobile tier 3): the same homestead on every device, keyed by a
 * private sync code — no accounts. Newest save wins everywhere (the device
 * played most recently IS the homestead); adopting an older device's cloud
 * save credits the gap through offline catch-up, so the Away summary fires
 * exactly as if you'd been gone. Local-first: the cloud being unreachable
 * never blocks play.
 */
function CloudSyncControls({ engine }: { engine: GameEngine }) {
  const sync = useCloudSync(engine);
  const [showCode, setShowCode] = useState(false);
  const [entering, setEntering] = useState(false);
  const [draft, setDraft] = useState('');
  const [copied, setCopied] = useState(false);

  const link = 'text-[10px] text-[#6a5a3a] underline hover:text-[#9a8a6a]';
  const timeOf = (t: number) =>
    new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  const copyCode = async () => {
    if (!sync.code) return;
    try {
      await navigator.clipboard.writeText(sync.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — the code is on screen to copy by hand */
    }
  };

  return (
    // data-sync-ui: clicks in here never count as "playing" for the fork rule
    // (see useCloudSync's dirty tracking).
    <div data-sync-ui className="flex flex-col items-start gap-1">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-[10px] text-[#6a5a3a]">
          Cloud sync:{' '}
          {sync.status === 'off' ? (
            'off'
          ) : sync.status === 'error' ? (
            <span className="text-[#e8835a]">unreachable — will retry</span>
          ) : sync.status === 'syncing' ? (
            'syncing…'
          ) : (
            <span className="text-[#8fe388]">
              synced{sync.lastSyncAt ? ` ${timeOf(sync.lastSyncAt)}` : ''}
            </span>
          )}
        </span>
        {sync.status === 'off' ? (
          <>
            <button
              className={link}
              onClick={() => {
                void sync.enableNew().then(() => setShowCode(true));
              }}
            >
              Enable cloud sync
            </button>
            <button className={link} onClick={() => setEntering(true)}>
              I have a sync code
            </button>
          </>
        ) : (
          <>
            <button className={link} onClick={() => void sync.syncNow()}>
              Sync now
            </button>
            <button className={link} onClick={() => setShowCode(true)}>
              Show code
            </button>
            <button className={link} onClick={sync.disable}>
              Turn off
            </button>
          </>
        )}
      </div>

      {showCode && sync.code && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-4">
          <div className="w-full max-w-sm rounded-t-xl pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:rounded-xl bg-[#2a2018] p-5 ring-2 ring-[#3a2e22]">
            <h2 className="text-lg font-black text-[#ffe9a8]">Your sync code</h2>
            <p className="mt-1 text-xs text-[#9a8a6a]">
              Type this into &ldquo;I have a sync code&rdquo; on your other device to play the same
              homestead there. Keep it private — the code IS the save.
            </p>
            <div className="mt-3 rounded-md bg-[#1f1812] px-3 py-2 text-center font-bold tracking-wider text-[#ffe9a8]">
              {sync.code}
            </div>
            <div className="mt-4 flex gap-2">
              <button
                onClick={copyCode}
                className="flex-1 rounded-md bg-[#1f1812] px-3 py-2 text-sm font-bold text-[#c9b88f] hover:bg-[#241b13]"
              >
                {copied ? 'Copied!' : 'Copy'}
              </button>
              <button
                onClick={() => setShowCode(false)}
                className="flex-1 rounded-md bg-[#e2b94f] px-3 py-2 text-sm font-bold text-[#2a2018] hover:bg-[#efc864]"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {entering && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-4">
          <div className="w-full max-w-sm rounded-t-xl pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:rounded-xl bg-[#2a2018] p-5 ring-2 ring-[#3a2e22]">
            <h2 className="text-lg font-black text-[#ffe9a8]">Connect a sync code</h2>
            <p className="mt-1 text-xs text-[#9a8a6a]">
              The cloud homestead for this code will load HERE, replacing this device&rsquo;s save.
              From then on, whichever device you actively play carries the homestead everywhere.
            </p>
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="duck-xxxx-xxxx-xxxx"
              autoFocus
              className="mt-3 w-full rounded-md bg-[#1f1812] px-3 py-2 text-center font-bold tracking-wider text-[#ffe9a8] outline-none ring-1 ring-[#3a2e22] placeholder:text-[#5a4d3a]"
            />
            <div className="mt-4 flex gap-2">
              <button
                onClick={() => {
                  setEntering(false);
                  setDraft('');
                }}
                className="flex-1 rounded-md bg-[#1f1812] px-3 py-2 text-sm font-bold text-[#c9b88f] hover:bg-[#241b13]"
              >
                Cancel
              </button>
              <button
                disabled={draft.trim().length < 8}
                onClick={() => {
                  void sync.connect(draft);
                  setEntering(false);
                  setDraft('');
                }}
                className="flex-1 rounded-md bg-[#e2b94f] px-3 py-2 text-sm font-bold text-[#2a2018] hover:bg-[#efc864] disabled:cursor-not-allowed disabled:opacity-40"
              >
                Connect
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Export/import controls (Phase 5 juice — "a save can survive anything").
 * Export just downloads serialize(state). Import routes through save.ts's
 * existing deserialize (no parallel parser) behind a shape-sniff gate, since
 * deserialize itself never throws — it silently falls back to a fresh game on
 * anything it can't parse, which would otherwise make garbage input LOOK like
 * a successful (if bad) import instead of a rejected one.
 */
export function BackupControls({ engine }: { engine: GameEngine }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, setPending] = useState<{ state: GameState; preview: Preview } | null>(null);

  const exportBackup = () => {
    const json = serialize(engine.state);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const stamp = new Date(Date.now()).toISOString().slice(0, 10); // YYYY-MM-DD
    a.href = url;
    a.download = `duck-homestead-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // let the same file be re-picked later
    if (!file) return;
    setError(null);
    setDone(false);
    let text: string;
    try {
      text = await file.text();
    } catch {
      setError('Could not read that file — nothing was changed.');
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      setError("That file isn't valid JSON — nothing was changed.");
      return;
    }
    if (!looksLikeSave(parsed)) {
      setError("That doesn't look like a Duck Homestead save — nothing was changed.");
      return;
    }
    const state = deserialize(text, Date.now());
    setPending({ state, preview: previewOf(state) });
  };

  const confirmImport = () => {
    if (!pending) return;
    engine.importState(pending.state);
    setPending(null);
    setDone(true);
  };

  return (
    <div className="flex flex-col items-start gap-1">
      <div className="flex items-center gap-3">
        <button
          onClick={exportBackup}
          className="text-[10px] text-[#6a5a3a] underline hover:text-[#9a8a6a]"
        >
          Back up homestead
        </button>
        <button
          onClick={() => fileRef.current?.click()}
          className="text-[10px] text-[#6a5a3a] underline hover:text-[#9a8a6a]"
        >
          Restore from backup
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={onFile}
        />
      </div>
      {error && <div className="text-[10px] text-[#e8835a]">{error}</div>}
      {done && <div className="text-[10px] text-[#8fe388]">Homestead restored from backup.</div>}

      <CloudSyncControls engine={engine} />

      {pending && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-4">
          <div className="w-full max-w-sm rounded-t-xl pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:rounded-xl bg-[#2a2018] p-5 ring-2 ring-[#3a2e22]">
            <h2 className="text-lg font-black text-[#ffe9a8]">Replace your current homestead?</h2>
            <p className="mt-1 text-xs text-[#9a8a6a]">This backup has:</p>
            <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
              <div className="rounded-md bg-[#1f1812] px-3 py-2">
                Rank <span className="font-bold text-[#ffe9a8]">{pending.preview.rank}</span>
              </div>
              <div className="rounded-md bg-[#1f1812] px-3 py-2">
                Legacy tier <span className="font-bold text-[#ffe9a8]">{pending.preview.tier}</span>
              </div>
              <div className="rounded-md bg-[#1f1812] px-3 py-2">
                Flock <span className="font-bold text-[#ffe9a8]">{pending.preview.flockSize} ducks</span>
              </div>
              <div className="rounded-md bg-[#1f1812] px-3 py-2">
                Eggs <span className="font-bold text-[#ffe9a8]">{pending.preview.eggs}</span>
              </div>
            </div>
            <p className="mt-3 text-[10px] text-[#e8835a]">
              Your current homestead will be permanently replaced. This can&rsquo;t be undone.
            </p>
            <div className="mt-4 flex gap-2">
              <button
                onClick={() => setPending(null)}
                className="flex-1 rounded-md bg-[#1f1812] px-3 py-2 text-sm font-bold text-[#c9b88f] hover:bg-[#241b13]"
              >
                Cancel
              </button>
              <button
                onClick={confirmImport}
                className="flex-1 rounded-md bg-[#e2b94f] px-3 py-2 text-sm font-bold text-[#2a2018] hover:bg-[#efc864]"
              >
                Replace homestead
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
