import { useCallback, useEffect, useState } from 'react';
import {
  playAttack,
  playCollect,
  playDing,
  playLoot,
  playPlace,
  playTend,
  playThreat,
  playUpgrade,
} from './audio/sfx';
import { zoneDef, type StationType } from './config/balance';
import { IrrigationBoard } from './ui/IrrigationBoard';
import type { DexEvent, DingEvent, LootEvent } from './game/engine';
import { currentThreat, predatorsActive } from './game/predators';
import { thresholdProgress } from './game/prestige';
import { LegacyPanel, legacyReady } from './ui/LegacyPanel';
import { defenseFloor, rackSockets, RARITIES, stationAt, zoneUnlocked } from './game/state';
import { DuckIcon, LegacyIcon, ModuleIcon, NutritionIcon, OwlIcon } from './ui/icons';
import { PredatorBanner } from './ui/PredatorBanner';
import { WatchPanel, watchNeedsAttention } from './ui/WatchPanel';
import { ZoneBar, ZoneUnlockCard } from './ui/ZoneBar';
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
import { NutritionPanel, nutritionNeedsAttention } from './ui/NutritionPanel';
import { StationPanel } from './ui/StationPanel';

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
        if (e.kind === 'incoming' || e.kind === 'open') playThreat();
        else playAttack();
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

  const state = engine.state;
  const selected = selectedId ? state.stations.find((s) => s.id === selectedId) ?? null : null;
  const anyBuffer = state.stations.some((s) => Object.values(s.buffer).some((v) => (v ?? 0) > 0));
  const readyToTend = state.stations.filter((s) => s.tendCooldownRemaining === 0).length;

  // Onboarding nudge for the pre-placed starter: the Coop is already laying but
  // short on protein + calcium. Point at the first meaningful build, then
  // self-hide once both producers exist. (No persisted flag — purely derived.)
  const hasCoop = state.stations.some((s) => s.type === 'coop');
  const missingProducers = [
    !state.stations.some((s) => s.type === 'mealwormFarm') && 'a Mealworm Farm (protein)',
    !state.stations.some((s) => s.type === 'oysterSource') && 'an Oyster Source (calcium)',
  ].filter(Boolean) as string[];
  const showStarterNudge = hasCoop && missingProducers.length > 0;

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
    <div className="min-h-full w-full p-4">
      {milestoneFlash > 0 && (
        <div key={milestoneFlash} className="milestone-flash pointer-events-none fixed inset-0 z-40" />
      )}
      <PredatorBanner state={state} onOpen={() => setWatchOpen(true)} />
      {salvage && (
        <div
          key={salvage.id}
          className="pointer-events-none fixed inset-x-0 top-14 z-40 flex justify-center"
        >
          <span className="salvage-toast rounded-full bg-[#2e2746] px-3 py-1 text-xs font-bold text-[#cdbcff] shadow ring-1 ring-[#3a2e64]">
            Auto-salvaged spare · +{salvage.dust} dust
          </span>
        </div>
      )}
      <DingBanner ding={ding} onDone={() => setDing(null)} />
      <LootBanner loot={loot} onDone={() => setLoot(null)} />
      <DexBanner dex={dex} onDone={() => setDex(null)} />
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

      <div className="mx-auto flex max-w-4xl flex-col gap-4 md:flex-row md:items-start">
        {/* Canvas + the station box directly under it (close to the tiles). */}
        <div className="flex flex-col items-center gap-3">
          <ZoneBar state={state} activeZone={activeZone} onPick={setActiveZone} />
          <div className="rounded-lg bg-[#1f1812] p-2 ring-1 ring-[#3a2e22]">
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
                {zoneDef(activeZone)?.irrigation && zoneUnlocked(state, activeZone) ? (
                  // The pasture is the irrigation puzzle, not a build grid.
                  <IrrigationBoard engine={engine} state={state} />
                ) : (
                  <GameCanvas
                    key={activeZone}
                    engine={engine}
                    selectedId={selectedId}
                    zoneId={activeZone}
                    unlocked={zoneUnlocked(state, activeZone)}
                    buildType={buildType}
                    onTileClick={onTileClick}
                  />
                )}
              </ErrorBoundary>
            </div>
          </div>
          {!zoneUnlocked(state, activeZone) && (
            <ZoneUnlockCard engine={engine} state={state} zoneId={activeZone} />
          )}
          {showStarterNudge && (
            <div className="max-w-[460px] rounded-md bg-[#2a2018] px-4 py-2.5 text-center text-xs text-[#c9b88f] ring-1 ring-[#3a2e22]">
              Your homestead is already running — the Coop is laying. The flock is short on protein
              and calcium, so build {missingProducers.join(' and ')} from the bar below (you have{' '}
              {Math.round(state.resources.eggs)} eggs), then open Nutrition to balance the ration.
            </div>
          )}
          {selected && (
            <div className="w-full max-w-[496px] md:w-[496px]">
              <StationPanel engine={engine} state={state} station={selected} />
            </div>
          )}
        </div>

        {/* Side panel */}
        <div className="flex w-full flex-col gap-4 md:w-[300px]">
          <HUD state={state} />
          {state.stations.some((s) => s.type === 'coop') && (
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
          {state.ducks.length > 0 && (
            <button
              onClick={() => setFlockOpen(true)}
              className="flex items-center justify-between rounded-md bg-[#26323a] px-3 py-2 text-sm font-bold text-[#a8d0e8] transition hover:bg-[#2e3c46]"
            >
              <span className="flex items-center gap-1.5">
                <DuckIcon size={16} /> Flock
              </span>
              <span className="tabular-nums">{state.ducks.length} ducks</span>
            </button>
          )}
          {(state.ducks.length > 0 || state.legacyTier > 0) && (
            <button
              onClick={() => setLegacyOpen(true)}
              className={`flex items-center justify-between rounded-md px-3 py-2 text-sm font-bold transition ${
                legacyReady(state)
                  ? 'bg-[#5a4320] text-[#ffe9a8] ring-1 ring-[#e2b94f] hover:bg-[#6a4f28]'
                  : 'bg-[#2e2746] text-[#cdbcff] hover:bg-[#372e57]'
              }`}
            >
              <span className="flex items-center gap-1.5">
                <LegacyIcon size={16} /> Legacy
              </span>
              <span className="tabular-nums">
                {legacyReady(state)
                  ? 'champion ready!'
                  : `T${state.legacyTier} · ${Math.round(thresholdProgress(state) * 100)}%`}
              </span>
            </button>
          )}
          {(predatorsActive(state) ||
            state.deterrents > 0 ||
            state.secureCoops > 0 ||
            state.ducks.some((d) => d.wounded)) &&
            (() => {
              const attention = watchNeedsAttention(state);
              const threat = currentThreat(state);
              const woundedCount = state.ducks.filter((d) => d.wounded).length;
              const label =
                woundedCount > 0
                  ? `${woundedCount} wounded`
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
          <BuildBar state={state} buildType={buildType} onPick={setBuildType} />
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
    </div>
  );
}
