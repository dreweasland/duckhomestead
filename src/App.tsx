import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import {
  playAttack,
  playCollect,
  playDing,
  playDive,
  playLoot,
  playPlace,
  playTend,
  playThreat,
  playUpgrade,
} from './audio/sfx';
import { zoneDef, type StationType } from './config/balance';
import { WaterBoard } from './ui/WaterBoard';
import type { DexEvent, DingEvent, LootEvent } from './game/engine';
import { currentThreat, predatorsActive } from './game/predators';
import { championGoal } from './game/prestige';
import { LegacyPanel } from './ui/LegacyPanel';
import { defenseFloor, flockRatio, rackSockets, RARITIES, stationAt, zoneUnlocked } from './game/state';
import { DuckIcon, LegacyIcon, ModuleIcon, NutritionIcon, OwlIcon } from './ui/icons';
import { PredatorBanner } from './ui/PredatorBanner';
import { WatchPanel } from './ui/WatchPanel';
import { ZoneBar, ZoneUnlockCard } from './ui/ZoneBar';
import { StatusPills } from './ui/StatusPills';
import { useGame } from './game/useGame';
import { GameCanvas, MAX_BOARD_WIDTH } from './render/GameCanvas';
import { AwayModal } from './ui/AwayModal';
import { BuildBar } from './ui/BuildBar';
import { DevPanel } from './ui/DevPanel';
import { DexBanner } from './ui/DexBanner';
import { DingBanner } from './ui/DingBanner';
import { ErrorBoundary } from './ui/ErrorBoundary';
import { FlockPanel } from './ui/FlockPanel';
import { HUD } from './ui/HUD';
import { TendIcon } from './ui/icons';
import { LootBanner } from './ui/LootBanner';
import { ModulesPanel } from './ui/ModulesPanel';
import { NotifyRail } from './ui/NotifyRail';
import { NutritionPanel, nutritionNeedsAttention } from './ui/NutritionPanel';
import { OwlAttack } from './ui/OwlAttack';
import { StationBar } from './ui/StationBar';

/** Per-browser flag: the first-run welcome pop-up shows once, then never again. */
const WELCOME_SEEN_KEY = 'duck-homestead-welcome-seen';
/** One-time teaching moment: the first time a threat telegraphs while the player
 *  is actively playing (defenses suppressed). Shows once, then never again. */
const DEFENSES_DOWN_SEEN_KEY = 'duck-homestead-defenses-down-seen';

/** Combined width of the two columns at desktop: board box (MAX_BOARD_WIDTH +
 *  p-2) + the gap-4 + the 300px side panel. The bottom build row / footer are
 *  pinned to this so they line up with the right column's edge regardless of
 *  their own content width (e.g. a long hint that would otherwise stretch it). */
const COLS_WIDTH = MAX_BOARD_WIDTH + 16 + 16 + 300;

export default function App() {
  const [ding, setDing] = useState<DingEvent | null>(null);
  // Brief screen flash when a milestone (Auto-Haul) is unlocked.
  const [milestoneFlash, setMilestoneFlash] = useState(0);

  const onDing = useCallback((e: DingEvent) => {
    setDing(e);
    const milestone = e.milestones.length > 0;
    playDing(milestone);
    if (milestone) setMilestoneFlash((n) => n + 1);
  }, []);

  const { engine, version } = useGame(onDing);
  // version is read so the component re-renders on each engine notify.
  void version;

  // Tend SFX for both entry points (board double-click and panel button).
  useEffect(() => engine.onTend(() => playTend()), [engine]);

  // Activity gauge: any interaction marks the player "active" (predator dives then
  // drop the passive floor and demand a scare). Lapses to "guard" after idle.
  useEffect(() => {
    const mark = () => engine.markActive();
    window.addEventListener('pointerdown', mark);
    window.addEventListener('keydown', mark);
    return () => {
      window.removeEventListener('pointerdown', mark);
      window.removeEventListener('keydown', mark);
    };
  }, [engine]);

  // The loot moment.
  const [loot, setLoot] = useState<LootEvent | null>(null);
  useEffect(
    () =>
      engine.onLoot((e) => {
        setLoot(e);
        playLoot(RARITIES.indexOf(e.module.rarity));
      }),
    [engine],
  );

  // The collection DING (a never-before-bred color first hatches).
  const [dex, setDex] = useState<DexEvent | null>(null);
  useEffect(
    () =>
      engine.onDex((e) => {
        setDex(e);
        playDing(true); // milestone fanfare
      }),
    [engine],
  );

  // Predators: the telegraph hoot (window incoming/open) and the attack screech.
  useEffect(
    () =>
      engine.onPredator((e) => {
        if (e.kind === 'introduced') return; // the milestone DING covers first contact
        if (e.kind === 'scared') return; // the scare's own whoosh plays at the click
        if (e.kind === 'winding' || e.kind === 'feint') playDive(); // a dive (re)commits — scare it!
        else if (e.kind === 'incoming' || e.kind === 'open') playThreat();
        else playAttack(); // wound / snatched / escalated / crowdInjury — a duck got hurt
      }),
    [engine],
  );

  // A tend drop that couldn't improve the rack auto-salvages to dust — a quiet
  // beat (soft chime + brief toast), distinct from the loot banner for keepers.
  const [salvage, setSalvage] = useState<{ id: number; dust: number } | null>(null);
  useEffect(
    () =>
      engine.onAutosalvage((dust) => {
        setSalvage({ id: Date.now(), dust });
        playCollect();
      }),
    [engine],
  );
  useEffect(() => {
    if (!salvage) return;
    const t = window.setTimeout(() => setSalvage(null), 1500);
    return () => clearTimeout(t);
  }, [salvage]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [buildType, setBuildType] = useState<StationType | null>(null);
  const [activeZone, setActiveZone] = useState('yard');
  const [tendFlash, setTendFlash] = useState<{ id: number; xp: number } | null>(null);
  const [awayOpen, setAwayOpen] = useState(true);
  const [nutritionOpen, setNutritionOpen] = useState(false);
  const [modulesOpen, setModulesOpen] = useState(false);
  const [flockOpen, setFlockOpen] = useState(false);
  const [watchOpen, setWatchOpen] = useState(false);
  const [legacyOpen, setLegacyOpen] = useState(false);
  const [welcomeSeen, setWelcomeSeen] = useState(() => {
    try {
      return !!localStorage.getItem(WELCOME_SEEN_KEY);
    } catch {
      return true; // storage unavailable → don't nag
    }
  });
  const dismissWelcome = () => {
    try {
      localStorage.setItem(WELCOME_SEEN_KEY, '1');
    } catch {
      /* ignore */
    }
    setWelcomeSeen(true);
  };
  const [defensesDownSeen, setDefensesDownSeen] = useState(() => {
    try {
      return !!localStorage.getItem(DEFENSES_DOWN_SEEN_KEY);
    } catch {
      return true;
    }
  });
  const dismissDefensesDown = () => {
    try {
      localStorage.setItem(DEFENSES_DOWN_SEEN_KEY, '1');
    } catch {
      /* ignore */
    }
    setDefensesDownSeen(true);
  };

  const state = engine.state;
  // Hoist the predator reads — used by the spacer, the NotifyRail offset, the
  // "defenses down" trigger, and the Watch button (was evaluated 4×/2× per render).
  const threat = currentThreat(state);
  const predActive = predatorsActive(state);
  const selected = selectedId ? state.stations.find((s) => s.id === selectedId) ?? null : null;
  // Build is only meaningful on a buildable (non-water) unlocked zone — the Yard.
  const activeZd = zoneDef(activeZone);
  const isBuildZone = zoneUnlocked(state, activeZone) && !activeZd?.pondLayout && !activeZd?.waterworks;
  // Close the station popover on Escape.
  useEffect(() => {
    if (!selectedId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelectedId(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedId]);
  // Each only feeds a milestone-gated button — short-circuit the station scan when
  // that button isn't shown (anyBuffer's Collect-All is gone once Auto-Haul is on;
  // readyToTend's Tend-All doesn't exist until that milestone unlocks).
  const anyBuffer =
    !state.autoHaulUnlocked &&
    state.stations.some((s) => Object.values(s.buffer).some((v) => (v ?? 0) > 0));
  const readyToTend = state.tendAllUnlocked
    ? state.stations.filter((s) => s.tendCooldownRemaining === 0).length
    : 0;

  // Onboarding for the pre-placed starter: the Coop is already laying but short
  // on protein + calcium. Surfaced as a one-time welcome pop-up (first run only,
  // per-browser) rather than an inline note hogging board space.
  // Present station types in one pass — several checks below (and the coop-gated
  // Nutrition button in the side panel) each used their own `stations.some(...)` scan.
  const stationTypes = new Set(state.stations.map((s) => s.type));
  const hasCoop = stationTypes.has('coop');
  const missingProducers = [
    !stationTypes.has('mealwormFarm') && 'a Mealworm Farm (protein)',
    !stationTypes.has('oysterSource') && 'an Oyster Source (calcium)',
  ].filter(Boolean) as string[];
  const showWelcome = !welcomeSeen && hasCoop && missingProducers.length > 0;
  // Fire the "defenses down" lesson when a threat first telegraphs while the player
  // is active (the floor is suppressed) — a heads-up before the dives land. Not
  // during the welcome, so the two never stack.
  const showDefensesDown =
    !defensesDownSeen && !showWelcome && predActive && state.activeRemaining > 0 && threat != null;

  const onTileClick = useCallback(
    (x: number, y: number) => {
      const existing = stationAt(engine.state, x, y, activeZone);
      if (buildType) {
        if (existing) {
          // Build mode doubles as upgrade: clicking a MATCHING station upgrades
          // it in place (no round-trip to the panel); a different type just selects.
          if (existing.type === buildType) {
            if (engine.upgrade(existing.id).ok) playUpgrade();
          }
          setSelectedId(existing.id);
          return;
        }
        const r = engine.place(buildType, x, y, activeZone);
        if (r.ok) {
          playPlace();
          setSelectedId(stationAt(engine.state, x, y, activeZone)?.id ?? null);
          // Disarm build mode after a successful place so a second click on the
          // just-placed station doesn't accidentally upgrade it (spending eggs).
          setBuildType(null);
        }
        return;
      }
      setSelectedId(existing ? existing.id : null);
    },
    [engine, buildType, activeZone],
  );

  return (
    <div className={`min-h-full w-full p-4 ${threat?.phase === 'open' ? 'threat-cursor' : ''}`}>
      {milestoneFlash > 0 && (
        <div key={milestoneFlash} className="milestone-flash pointer-events-none fixed inset-0 z-40" />
      )}
      <PredatorBanner state={state} onOpen={() => setWatchOpen(true)} />
      {/* The interactive owl dive — a top-level fixed overlay so it floats ABOVE any
          open panel (in active mode the scare is mandatory, so it must always be
          reachable). Pointer-events pass through except on the owl itself. */}
      <OwlAttack engine={engine} state={state} />
      {/* One shared, centered stack for every transient toast — they queue
          vertically with a gap instead of pinning independently and overlapping. */}
      <NotifyRail lowered={threat != null}>
        <DingBanner ding={ding} onDone={() => setDing(null)} />
        <LootBanner loot={loot} onDone={() => setLoot(null)} />
        <DexBanner dex={dex} onDone={() => setDex(null)} />
        {salvage && (
          <span
            key={salvage.id}
            className="salvage-toast rounded-full bg-[#2e2746] px-3 py-1 text-xs font-bold text-[#cdbcff] shadow ring-1 ring-[#3a2e64]"
          >
            Auto-salvaged spare · +{salvage.dust} dust
          </span>
        )}
      </NotifyRail>
      {engine.away && awayOpen && (
        <AwayModal
          away={engine.away}
          onClose={() => {
            setAwayOpen(false);
            engine.clearAway();
          }}
        />
      )}

      {nutritionOpen && (
        <NutritionPanel engine={engine} state={state} onClose={() => setNutritionOpen(false)} />
      )}
      {modulesOpen && (
        <ModulesPanel engine={engine} state={state} onClose={() => setModulesOpen(false)} />
      )}
      {flockOpen && <FlockPanel engine={engine} state={state} onClose={() => setFlockOpen(false)} />}
      {watchOpen && <WatchPanel engine={engine} state={state} onClose={() => setWatchOpen(false)} />}
      {legacyOpen && <LegacyPanel engine={engine} state={state} onClose={() => setLegacyOpen(false)} />}

      {/* First-run welcome — shown once per browser instead of an inline note. */}
      {showWelcome && (
        <div
          className="fixed inset-0 z-[55] flex items-center justify-center bg-black/60 p-4"
          onClick={dismissWelcome}
        >
          <div
            className="w-full max-w-sm rounded-xl bg-[#2a2018] p-5 text-center ring-2 ring-[#3a2e22]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-2 inline-flex items-center justify-center gap-2 text-lg font-black text-[#ffe9a8]">
              <DuckIcon size={22} /> Welcome to your homestead!
            </div>
            <p className="mb-4 text-xs leading-relaxed text-[#c9b88f]">
              It&rsquo;s already running — the Coop is laying. The flock is short on protein and
              calcium, so build {missingProducers.join(' and ')} from the build palette below (you
              have {Math.round(state.resources.eggs)} eggs), then open Nutrition to balance the
              ration.
            </p>
            <div className="flex justify-center gap-2">
              <button
                onClick={() => {
                  dismissWelcome();
                  setNutritionOpen(true);
                }}
                className="rounded-md bg-[#2e3a26] px-3 py-2 text-sm font-bold text-[#bfe8a8] transition hover:bg-[#36422c]"
              >
                Open Nutrition
              </button>
              <button
                onClick={dismissWelcome}
                className="rounded-md bg-[#6b4f9e] px-4 py-2 text-sm font-bold text-[#fff4d6] transition hover:bg-[#7a5cae]"
              >
                Got it
              </button>
            </div>
          </div>
        </div>
      )}

      {/* First-time "defenses down" lesson — the active-mode shift, taught once. */}
      {showDefensesDown && (
        <div
          className="fixed inset-0 z-[55] flex items-center justify-center bg-black/70 p-4"
          onClick={dismissDefensesDown}
        >
          <div
            className="w-full max-w-sm rounded-xl bg-[#2a1818] p-5 text-center ring-2 ring-[#5a2a2a]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-2 inline-flex items-center justify-center gap-2 text-lg font-black text-[#ffd9d9]">
              <OwlIcon size={22} /> Defenses down!
            </div>
            <p className="mb-4 text-xs leading-relaxed text-[#c9a0a0]">
              The owl knows you&rsquo;re at the keyboard. While you&rsquo;re actively playing it{' '}
              <span className="font-bold text-[#ff9a9a]">ignores your built deterrents</span> — your
              only defense is to <span className="font-bold text-[#bfe8a8]">scare each dive</span> (tap
              the swooping owl). Miss one and a duck takes an injury. Step away a couple minutes and
              your deterrents take guard again. It also dives faster and feints more as your rank
              climbs — secure prize breeders to keep them off the menu entirely.
            </p>
            <button
              onClick={dismissDefensesDown}
              className="rounded-md bg-[#6e1414] px-4 py-2 text-sm font-bold text-[#ffe2e2] transition hover:bg-[#7e1c1c]"
            >
              Got it — I&rsquo;ll scare them off
            </button>
          </div>
        </div>
      )}


      {/* The predator telegraph is pinned (fixed) to the very top; reserve flow
          space for it so it never overlaps the zone tabs / HUD beneath it. */}
      {threat && <div aria-hidden className="h-12 md:h-8" />}

      {/* Pin the column stack to the two columns' combined width (COLS_WIDTH) so
          the full-width build row + footer line up exactly with the right
          column's edge, and a long hint can't stretch the whole thing wider. */}
      <div
        className="mx-auto flex w-full max-w-full flex-col gap-4 md:w-[var(--cw)]"
        style={{ '--cw': `${COLS_WIDTH}px` } as CSSProperties}
      >
        <div className="flex flex-col gap-4 md:flex-row md:items-start">
        {/* Canvas — the board. */}
        <div className="flex flex-col items-center gap-3">
          <ZoneBar state={state} activeZone={activeZone} onPick={setActiveZone} />
          <div className="relative rounded-lg bg-[#1f1812] p-2 ring-1 ring-[#3a2e22]">
            {/* Status pills tuck into the board's empty top headroom (the canvas
                reserves space there) — present, but adding no height. Yard only:
                Auto-Haul / Tend-All are station/tending milestones, irrelevant on
                the water canvases (which have their own header). The wrapper
                ignores pointer events so the board beneath stays clickable. */}
            {activeZone === 'yard' && (
              <div className="pointer-events-none absolute inset-x-0 top-1.5 z-10 flex justify-center">
                <div className="pointer-events-auto">
                  <StatusPills state={state} />
                </div>
              </div>
            )}
            {/* Pin to the widest zone so swapping to a narrower one (pasture/pond)
                centers the board instead of shrinking the whole column. */}
            <div
              className="flex max-w-full justify-center"
              style={{ width: MAX_BOARD_WIDTH }}
            >
              <ErrorBoundary
                fallback={
                  <div className="flex h-[480px] w-full items-center justify-center p-6 text-center text-xs text-[#9a8a6a]">
                    The board failed to render, but your homestead is safe and still running. Reload
                    to bring it back.
                  </div>
                }
              >
                {(() => {
                  const zd = zoneDef(activeZone);
                  // The water canvases (Pond layout / Waterworks circulation) are
                  // dedicated puzzle surfaces, not build grids.
                  if ((zd?.pondLayout || zd?.waterworks) && zoneUnlocked(state, activeZone)) {
                    return (
                      <WaterBoard
                        engine={engine}
                        state={state}
                        mode={zd.waterworks ? 'circulation' : 'layout'}
                      />
                    );
                  }
                  return (
                    <GameCanvas
                      key={activeZone}
                      engine={engine}
                      selectedId={selectedId}
                      zoneId={activeZone}
                      unlocked={zoneUnlocked(state, activeZone)}
                      buildType={buildType}
                      onTileClick={onTileClick}
                    />
                  );
                })()}
              </ErrorBoundary>
            </div>
            {/* Selected-station controls: a slim strip on the board's bottom edge.
                Pinned to the board width so a busier station (e.g. a coop with the
                Dose button) wraps inside it instead of widening the whole column. */}
            {selected && selected.zoneId === activeZone && (
              <div style={{ width: MAX_BOARD_WIDTH, maxWidth: '100%' }}>
                <StationBar
                  engine={engine}
                  state={state}
                  station={selected}
                  onClose={() => setSelectedId(null)}
                />
              </div>
            )}
          </div>
          {!zoneUnlocked(state, activeZone) && (
            <ZoneUnlockCard engine={engine} state={state} zoneId={activeZone} />
          )}
        </div>

        {/* Side panel */}
        <div className="flex w-full flex-col gap-4 md:w-[300px]">
          <HUD state={state} />
          {hasCoop && (
            <button
              onClick={() => setNutritionOpen(true)}
              className={`flex items-center justify-between rounded-md px-3 py-2 text-sm font-bold transition ${
                nutritionNeedsAttention(state)
                  ? 'bg-[#5a3a2a] text-[#ffd9a8] ring-1 ring-[#e8835a] hover:bg-[#6a4632]'
                  : 'bg-[#2e3a26] text-[#bfe8a8] hover:bg-[#36422c]'
              }`}
            >
              <span className="flex items-center gap-1.5">
                <NutritionIcon size={16} /> Nutrition
              </span>
              <span className="tabular-nums">
                eggs {Math.round((state.nutrition?.eggMult ?? 1) * 100)}%
              </span>
            </button>
          )}
          {(state.inventory.length > 0 || state.rack.length > 0 || state.dust > 0) && (
            <button
              onClick={() => setModulesOpen(true)}
              className="flex items-center justify-between rounded-md bg-[#2e2746] px-3 py-2 text-sm font-bold text-[#cdbcff] transition hover:bg-[#372e57]"
            >
              <span className="flex items-center gap-1.5">
                <ModuleIcon size={16} /> Modules
              </span>
              <span className="tabular-nums">
                {state.rack.length}/{rackSockets(state)} rack · {state.inventory.length} spare
              </span>
            </button>
          )}
          {state.ducks.length > 0 &&
            (() => {
              const ratio = flockRatio(state);
              return (
                <button
                  onClick={() => setFlockOpen(true)}
                  className={`flex items-center justify-between rounded-md px-3 py-2 text-sm font-bold transition ${
                    ratio.injuring
                      ? 'bg-[#5a2a2a] text-[#ffd9d9] ring-1 ring-[#e26d6d] hover:bg-[#6a3434]'
                      : 'bg-[#26323a] text-[#a8d0e8] hover:bg-[#2e3c46]'
                  }`}
                >
                  <span className="flex items-center gap-1.5">
                    <DuckIcon size={16} /> Flock
                  </span>
                  <span className="tabular-nums">
                    {ratio.injuring ? `${ratio.excess} excess drake${ratio.excess > 1 ? 's' : ''}` : `${state.ducks.length} ducks`}
                  </span>
                </button>
              );
            })()}
          {(state.ducks.length > 0 || state.legacyTier > 0) &&
            (() => {
              // Compute the champion goal ONCE — it was evaluated 3× here (legacyReady
              // ×2 + championReadiness), each a full O(ducks) meanQuality scan.
              const goal = championGoal(state);
              const ready = goal.colors.met && goal.quality.met && goal.size.met;
              return (
                <button
                  onClick={() => setLegacyOpen(true)}
                  className={`flex items-center justify-between rounded-md px-3 py-2 text-sm font-bold transition ${
                    ready
                      ? 'bg-[#5a4320] text-[#ffe9a8] ring-1 ring-[#e2b94f] hover:bg-[#6a4f28]'
                      : 'bg-[#2e2746] text-[#cdbcff] hover:bg-[#372e57]'
                  }`}
                >
                  <span className="flex items-center gap-1.5">
                    <LegacyIcon size={16} /> Legacy
                  </span>
                  <span className="tabular-nums">
                    {ready ? 'champion ready!' : `T${state.legacyTier} · ${Math.round(goal.readiness * 100)}%`}
                  </span>
                </button>
              );
            })()}
          {(predActive ||
            state.deterrents > 0 ||
            state.secureCoops > 0 ||
            state.ducks.some((d) => d.wounded)) &&
            (() => {
              // Reuse the hoisted `threat`; split waiting-wounded (urgent — admit them)
              // from recovering (safe, in a slot). Only waiting/threat flags attention.
              let waiting = 0;
              let recovering = 0;
              for (const d of state.ducks) {
                if (d.recovering) recovering++;
                else if (d.wounded) waiting++;
              }
              const attention = threat != null || waiting > 0;
              const label =
                waiting > 0
                  ? `${waiting} wounded`
                  : recovering > 0
                    ? `${recovering} recovering`
                    : threat?.phase === 'open'
                      ? `hunting ${Math.ceil(threat.seconds)}s`
                      : threat?.phase === 'incoming'
                        ? `in ${Math.ceil(threat.seconds)}s`
                        : `floor ${Math.round(defenseFloor(state) * 100)}%`;
              return (
                <button
                  onClick={() => setWatchOpen(true)}
                  className={`flex items-center justify-between rounded-md px-3 py-2 text-sm font-bold transition ${
                    attention
                      ? 'bg-[#5a2a2a] text-[#ffd9d9] ring-1 ring-[#e26d6d] hover:bg-[#6a3434]'
                      : 'bg-[#2a2230] text-[#d8c8a8] hover:bg-[#332a3a]'
                  }`}
                >
                  <span className="flex items-center gap-1.5">
                    <OwlIcon size={16} /> The Watch
                  </span>
                  <span className="tabular-nums">{label}</span>
                </button>
              );
            })()}
          {!state.autoHaulUnlocked && state.stations.length > 0 && (
            <button
              onClick={() => {
                engine.collectEverything();
                playCollect();
              }}
              disabled={!anyBuffer}
              className={`rounded-md px-3 py-2 text-sm font-bold transition ${
                anyBuffer
                  ? 'bg-[#b87333] text-[#fff4d6] hover:bg-[#c9823c]'
                  : 'cursor-not-allowed bg-[#1f1812] text-[#6a5a3a]'
              }`}
            >
              Collect All — haul every station to storage
            </button>
          )}
          {state.tendAllUnlocked && state.stations.length > 0 && (
            <div className="relative">
              <button
                onClick={() => {
                  const { tended, xpGained } = engine.tendAll();
                  if (tended > 0) {
                    playTend();
                    setTendFlash({ id: Date.now(), xp: xpGained });
                  }
                }}
                disabled={readyToTend === 0}
                className={`flex w-full items-center justify-center gap-1.5 rounded-md px-3 py-2 text-sm font-bold transition ${
                  readyToTend > 0
                    ? 'bg-[#2e6b3a] text-[#dfffd6] hover:bg-[#367a44]'
                    : 'cursor-not-allowed bg-[#1f1812] text-[#6a5a3a]'
                }`}
              >
                <TendIcon size={16} />
                {readyToTend > 0 ? `Tend All — ${readyToTend} ready` : 'All tended — cooling down'}
              </button>
              {tendFlash && (
                <span
                  key={tendFlash.id}
                  className="xp-float pointer-events-none absolute -top-3 right-2 text-sm font-black text-[#8fe388] drop-shadow"
                  onAnimationEnd={() => setTendFlash(null)}
                >
                  +{tendFlash.xp} XP
                </span>
              )}
            </div>
          )}
        </div>
        </div>

        {/* Build palette — a full-width row spanning both columns, below the board.
            Yard-only: the water canvases aren't build space. */}
        {isBuildZone && (
          <div className="rounded-lg bg-[#1f1812] p-3 ring-1 ring-[#3a2e22]">
            <BuildBar state={state} buildType={buildType} onPick={setBuildType} />
          </div>
        )}

        {/* Dev tools + reset sit at the very bottom, under the build palette. */}
        {import.meta.env.DEV && <DevPanel engine={engine} state={state} />}
        <button
          onClick={() => {
            if (window.confirm('Wipe this homestead and start over?')) {
              engine.reset();
              setSelectedId(null);
              setBuildType(null);
            }
          }}
          className="self-start text-[10px] text-[#6a5a3a] underline hover:text-[#9a8a6a]"
        >
          New homestead (reset save)
        </button>
      </div>
    </div>
  );
}
