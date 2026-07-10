import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import {
  playAttack,
  playCollect,
  playDing,
  playDive,
  playLoot,
  playPlace,
  playTend,
  playThreat,
  playScare,
  playUpgrade,
} from './audio/sfx';
import { BALANCE, zoneDef, type StationType } from './config/balance';
import { resetAllGuides, type GuideDef } from './config/guides';
import { AlmanacCard } from './ui/AlmanacCard';
import { useAlmanac } from './ui/useAlmanac';
import { WaterBoard, WaterBuildBar } from './ui/WaterBoard';
import type { DexEvent, DingEvent, LootEvent } from './game/engine';
import { currentThreat, predatorsActive } from './game/predators';
import { championGoal } from './game/prestige';
import { ActiveContractStrip, GrangePanel } from './ui/GrangePanel';
import { LegacyPanel } from './ui/LegacyPanel';
import { defenseFloor, flockRatio, rackSockets, RARITIES, stationAt, zoneUnlocked, type FlowFeatureType, type PondFeatureType } from './game/state';
import { DuckIcon, GrangeIcon, LegacyIcon, ModuleIcon, NutritionIcon, OwlIcon } from './ui/icons';
import { PredatorBanner } from './ui/PredatorBanner';
import { WatchPanel } from './ui/WatchPanel';
import { ZoneBar, ZoneUnlockCard } from './ui/ZoneBar';
import { StatusPills } from './ui/StatusPills';
import { useGame } from './game/useGame';
import { GameCanvas, MAX_BOARD_WIDTH } from './render/GameCanvas';
import { AwayModal } from './ui/AwayModal';
import { BackupControls } from './ui/BackupPanel';
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
import { NutritionPanel, nutritionNeedsAttention, type NutritionTab } from './ui/NutritionPanel';
import { OwlAttack } from './ui/OwlAttack';
import { StationBar } from './ui/StationBar';

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
  // Dev-build console access to the live engine (repairs/inspection) — the
  // debounced autosave persists edits made THROUGH the engine, whereas raw
  // localStorage writes race it and get clobbered.
  if (import.meta.env.DEV) (window as unknown as { __engine: unknown }).__engine = engine;
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
  // NAMED victims additionally get a story toast — an anonymous duck is ambient
  // sound; a named one is news. (Naming is what buys the difference.)
  const [duckNews, setDuckNews] = useState<{ id: number; text: string; grave: boolean } | null>(null);
  useEffect(
    () =>
      engine.onPredator((e) => {
        if (e.kind === 'introduced') return; // the milestone DING covers first contact
        if (e.kind === 'scared') return; // the scare's own whoosh plays at the click
        if (e.kind === 'winding' || e.kind === 'feint') playDive(); // a dive (re)commits — scare it!
        else if (e.kind === 'incoming' || e.kind === 'open') playThreat();
        else if (e.kind === 'huntBegins') {
          playThreat();
          setDuckNews({ id: Date.now(), text: 'A PAIRED HUNT — the owl and raccoon strike together. Scare every dive for the bounty!', grave: false });
        } else if (e.kind === 'huntFoiled' || e.kind === 'siegeFoiled') {
          // Victories — the triumphant whoosh, never the attack screech
          // (siegeFoiled previously fell into the harm branch and SCREECHED).
          playScare();
          setDuckNews({
            id: Date.now(),
            text:
              e.kind === 'huntFoiled'
                ? `Paired hunt FOILED — the Grange sends a bounty (+${e.dust} dust, a module).`
                : `Siege FOILED — flawless. The bounty is yours (+${e.dust} dust, a module).`,
            grave: false,
          });
        } else if (e.kind === 'repelled' || e.kind === 'shrugged') {
          // Good outcomes get the scare's own triumphant whoosh, not the screech —
          // and a named Hardy duck's shrug is a story worth a toast.
          playScare();
          if (e.kind === 'shrugged' && e.duckName) {
            setDuckNews({ id: Date.now(), text: `${e.duckName} shrugged it off!`, grave: false });
          }
        } else {
          playAttack(); // wound / snatched / escalated / crowdInjury — a duck got hurt
          if ('duckName' in e && e.duckName) {
            const text =
              e.kind === 'wound'
                ? `${e.duckName} was wounded — infirmary, quick!`
                : e.kind === 'crowdInjury'
                  ? `${e.duckName} was hurt in the crush — treat the wound, then cull the extra drakes`
                  : e.kind === 'snatched'
                    ? `${e.duckName} was taken…`
                    : `${e.duckName} didn’t make it…`;
            setDuckNews({ id: Date.now(), text, grave: e.kind !== 'wound' && e.kind !== 'crowdInjury' });
          }
        }
      }),
    [engine],
  );
  useEffect(() => {
    if (!duckNews) return;
    const t = window.setTimeout(() => setDuckNews(null), duckNews.grave ? 4000 : 2500);
    return () => clearTimeout(t);
  }, [duckNews]);

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

  // Phase 9c: a season turn is a quiet announcement — the note tells you what
  // the year just changed, so re-checking the ration is a choice, not a hunt.
  const [seasonNews, setSeasonNews] = useState<{ id: number; label: string; note: string; color: string } | null>(null);
  useEffect(
    () =>
      engine.onSeason((seasonId) => {
        const def = BALANCE.SEASONS.DEFS[seasonId as keyof typeof BALANCE.SEASONS.DEFS];
        if (!def) return;
        setSeasonNews({ id: Date.now(), label: def.label, note: def.note, color: def.color });
        playThreat(); // the attention chime — a season is weather, not danger
      }),
    [engine],
  );
  useEffect(() => {
    if (!seasonNews) return;
    const t = window.setTimeout(() => setSeasonNews(null), 5000);
    return () => clearTimeout(t);
  }, [seasonNews]);

  // The Grange: claiming a contract is a quiet rhythm beat, not a milestone DING.
  const [grangeClaim, setGrangeClaim] = useState<{ id: number; dust: number; shards: number; module?: boolean } | null>(
    null,
  );
  useEffect(
    () =>
      engine.onContractClaim((e) => {
        setGrangeClaim({ id: Date.now(), dust: e.dust, shards: e.shards, module: !!e.module });
        playCollect();
      }),
    [engine],
  );
  useEffect(() => {
    if (!grangeClaim) return;
    const t = window.setTimeout(() => setGrangeClaim(null), 1500);
    return () => clearTimeout(t);
  }, [grangeClaim]);

  // A delivery that hits its deadline must never vanish silently — quiet toast,
  // slightly longer hold than the happy beats (it's a miss, worth reading).
  const [grangeExpired, setGrangeExpired] = useState<{ id: number } | null>(null);
  useEffect(() => engine.onContractExpire(() => setGrangeExpired({ id: Date.now() })), [engine]);
  useEffect(() => {
    if (!grangeExpired) return;
    const t = window.setTimeout(() => setGrangeExpired(null), 2500);
    return () => clearTimeout(t);
  }, [grangeExpired]);

  // Water attribution beats (Phase 5 juice) — the pond's payout made visible
  // at the exact moments it pays. Quiet toasts, pure UI over existing water
  // math (see game/water.ts, game/engine.ts's drainWoundSaved/drainConditionRebound).
  const [woundSaved, setWoundSaved] = useState<{ id: number; spareSec: number; boughtSec: number } | null>(
    null,
  );
  useEffect(
    () =>
      engine.onWoundSaved((e) => setWoundSaved({ id: Date.now(), spareSec: e.spareSec, boughtSec: e.boughtSec })),
    [engine],
  );
  useEffect(() => {
    if (!woundSaved) return;
    const t = window.setTimeout(() => setWoundSaved(null), 2500);
    return () => clearTimeout(t);
  }, [woundSaved]);

  const [conditionRebound, setConditionRebound] = useState<{ id: number; mult: number } | null>(null);
  useEffect(
    () => engine.onConditionRebound((e) => setConditionRebound({ id: Date.now(), mult: e.mult })),
    [engine],
  );
  useEffect(() => {
    if (!conditionRebound) return;
    const t = window.setTimeout(() => setConditionRebound(null), 2500);
    return () => clearTimeout(t);
  }, [conditionRebound]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [buildType, setBuildType] = useState<StationType | null>(null);
  const [activeZone, setActiveZone] = useState('yard');
  const [tendFlash, setTendFlash] = useState<{ id: number; xp: number } | null>(null);
  // No local open flag: engine.away is the single source — clearAway() on
  // dismiss nulls it, and a hidden-tab resume (resumeFromHidden) may set a
  // FRESH summary later in the session, which must re-open the modal.
  const [nutritionOpen, setNutritionOpen] = useState(false);
  const [modulesOpen, setModulesOpen] = useState(false);
  const [flockOpen, setFlockOpen] = useState(false);
  const [watchOpen, setWatchOpen] = useState(false);
  const [legacyOpen, setLegacyOpen] = useState(false);
  const [grangeOpen, setGrangeOpen] = useState(false);
  const [nutritionTab, setNutritionTab] = useState<NutritionTab>('layers');

  const state = engine.state;
  // Hoist the predator reads — used by the spacer, the NotifyRail offset, the
  // "defenses down" trigger, and the Watch button (was evaluated 4×/2× per render).
  const threat = currentThreat(state);
  const predActive = predatorsActive(state);
  const selected = selectedId ? state.stations.find((s) => s.id === selectedId) ?? null : null;
  // Build is only meaningful on a buildable (non-water) unlocked zone — the Yard.
  const activeZd = zoneDef(activeZone);
  const isBuildZone = zoneUnlocked(state, activeZone) && !activeZd?.pondLayout && !activeZd?.waterworks;
  const isWaterZone = zoneUnlocked(state, activeZone) && !!(activeZd?.pondLayout || activeZd?.waterworks);
  // The water build tool — lifted here (like buildType) so the palette lives
  // in the BUILD card below the board. Cleared on zone switch (pond and
  // waterworks arm different feature kinds).
  const [waterPick, setWaterPick] = useState<PondFeatureType | FlowFeatureType | null>(null);
  useEffect(() => setWaterPick(null), [activeZone]);
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

  // Present station types in one pass — several checks below (the coop-gated
  // Nutrition button in the side panel) each used their own `stations.some(...)` scan.
  const stationTypes = new Set(state.stations.map((s) => s.type));
  const hasCoop = stationTypes.has('coop');

  // THE ALMANAC (Phase 7): one data-driven guide book replaces the old ad-hoc
  // welcome/defenses-down flags. The reader skips entirely while any other
  // overlay is up — the away modal, a DING/loot/dex banner, an in-flight
  // predator dive, or any open panel — so a guide never fights a moment.
  const anyPanelOpen =
    nutritionOpen || modulesOpen || flockOpen || watchOpen || legacyOpen || grangeOpen;
  const predatorDiving = Object.values(state.predators).some((p) => p.strike != null);
  // Stable identity — the FlockPanel memo comparator checks onClose equality.
  const closeFlock = useCallback(() => setFlockOpen(false), []);
  const guideBlocked =
    engine.away != null ||
    ding != null ||
    loot != null ||
    dex != null ||
    anyPanelOpen ||
    predatorDiving;
  const { active: guide, dismiss: dismissGuide } = useAlmanac(state, guideBlocked);
  const backupRef = useRef<HTMLDivElement>(null);
  const openGuideCta = useCallback((cta: NonNullable<GuideDef['cta']>) => {
    switch (cta.open) {
      case 'nutrition':
        if (cta.tab) setNutritionTab(cta.tab);
        setNutritionOpen(true);
        break;
      case 'flock':
        setFlockOpen(true);
        break;
      case 'modules':
        setModulesOpen(true);
        break;
      case 'watch':
        setWatchOpen(true);
        break;
      case 'legacy':
        setLegacyOpen(true);
        break;
      case 'grange':
        setGrangeOpen(true);
        break;
      case 'backup':
        backupRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        break;
      case 'build-silo':
        // The fix is a PLACEMENT: jump to the Yard with the silo tool armed —
        // the next tile click builds one.
        setActiveZone('yard');
        setBuildType('silo');
        break;
      case 'zone':
        // Zone-unlockable announcements: jump straight to the locked tab —
        // its unlock card (rank/eggs/the button) is the landing page.
        if (cta.zone) {
          setActiveZone(cta.zone);
          setBuildType(null); // a yard tool is meaningless on another board
        }
        break;
    }
  }, []);

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
        {seasonNews && (
          <span
            key={seasonNews.id}
            className="ding-pop rounded-full bg-[#241c14] px-3 py-1 text-xs font-bold shadow ring-1 ring-[#3a2e22]"
            style={{ color: seasonNews.color }}
          >
            {seasonNews.label} — {seasonNews.note}
          </span>
        )}
        {grangeClaim && (
          <span
            key={grangeClaim.id}
            className="salvage-toast rounded-full bg-[#2e3a26] px-3 py-1 text-xs font-bold text-[#bfe8a8] shadow ring-1 ring-[#3a5a3a]"
          >
            Contract claimed · +{grangeClaim.dust} dust · +{grangeClaim.shards} shards
            {grangeClaim.module ? ' · +module' : ''}
          </span>
        )}
        {duckNews && (
          <span
            key={duckNews.id}
            className={`salvage-toast rounded-full px-3 py-1 text-xs font-bold shadow ring-1 ${
              duckNews.grave
                ? 'bg-[#2a1420] text-[#e8a3c8] ring-[#5a2a44]'
                : 'bg-[#2a1818] text-[#e8a3a3] ring-[#5a2a2a]'
            }`}
          >
            {duckNews.text}
          </span>
        )}
        {grangeExpired && (
          <span
            key={grangeExpired.id}
            className="salvage-toast rounded-full bg-[#3a2a1a] px-3 py-1 text-xs font-bold text-[#e8a45a] shadow ring-1 ring-[#5a3e22]"
          >
            Delivery expired — the Grange slot freed up
          </span>
        )}
        {woundSaved && (
          <span
            key={woundSaved.id}
            className="salvage-toast rounded-full bg-[#1a2e3a] px-3 py-1 text-xs font-bold text-[#8fd4f0] shadow ring-1 ring-[#2a4a5a]"
          >
            Treated with {Math.round(woundSaved.spareSec)}s to spare — your pond bought{' '}
            {Math.round(woundSaved.boughtSec)}s of those seconds
          </span>
        )}
        {conditionRebound && (
          <span
            key={conditionRebound.id}
            className="salvage-toast rounded-full bg-[#1a2e3a] px-3 py-1 text-xs font-bold text-[#8fd4f0] shadow ring-1 ring-[#2a4a5a]"
          >
            Condition recovered ×{conditionRebound.mult.toFixed(1)} faster — well watered
          </span>
        )}
      </NotifyRail>
      {engine.away && (
        <AwayModal
          away={engine.away}
          onClose={() => {
            engine.clearAway();
          }}
        />
      )}

      {nutritionOpen && (
        <NutritionPanel
          engine={engine}
          state={state}
          onClose={() => setNutritionOpen(false)}
          initialTab={nutritionTab}
        />
      )}
      {modulesOpen && (
        <ModulesPanel engine={engine} state={state} onClose={() => setModulesOpen(false)} />
      )}
      {flockOpen && (
        <FlockPanel
          engine={engine}
          state={state}
          // ~4Hz normally; FROZEN while a dive is in flight so the scare click
          // never fights a 1000-duck list repaint for the main thread.
          renderTick={predatorDiving ? -1 : Math.floor(version / 4)}
          onClose={closeFlock}
        />
      )}
      {watchOpen && <WatchPanel engine={engine} state={state} onClose={() => setWatchOpen(false)} />}
      {legacyOpen && <LegacyPanel engine={engine} state={state} onClose={() => setLegacyOpen(false)} />}
      {grangeOpen && <GrangePanel engine={engine} state={state} onClose={() => setGrangeOpen(false)} />}

      {/* THE ALMANAC (Phase 7): one guide card at a time, non-modal — the
          homestead stays visible and playable behind it. */}
      {guide && (
        <AlmanacCard
          def={guide}
          onDismiss={dismissGuide}
          onCta={
            guide.cta
              ? () => {
                  const cta = guide.cta!;
                  dismissGuide();
                  openGuideCta(cta);
                }
              : undefined
          }
        />
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
        <div className="flex min-w-0 max-w-full flex-col items-center gap-3">
          <ZoneBar
            state={state}
            activeZone={activeZone}
            onPick={(id) => {
              setActiveZone(id);
              setBuildType(null); // a yard tool is meaningless on the winter board (and vice versa)
            }}
          />
          {/* max-w-full lets the whole board box shrink on narrow screens —
              without it this box sizes to the canvas's native width and the
              page scrolls sideways on a phone. */}
          <div className="relative max-w-full rounded-lg bg-[#1f1812] p-2 ring-1 ring-[#3a2e22]">
            {/* Status pills tuck into the board's empty top headroom (the canvas
                reserves space there) — present, but adding no height. Yard only:
                Auto-Haul / Tend-All are station/tending milestones, irrelevant on
                the water canvases (which have their own header). The wrapper
                ignores pointer events so the board beneath stays clickable. */}
            {activeZone === 'yard' && (
              // Vertically centered in the board's empty top headroom (canvas OY 30 +
              // the box's p-2) so there's equal brown above and below the pills.
              <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex h-[38px] items-center justify-center">
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
                        pick={waterPick}
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
          {state.legacyTier >= BALANCE.CONTRACTS.UNLOCK_TIER &&
            (() => {
              const active = state.contracts.active;
              const claimable = !!active?.completed;
              const tag = claimable
                ? 'ready to claim!'
                : active
                  ? active.type === 'order'
                    ? 'commission'
                    : active.type === 'provision'
                      ? 'provision'
                      : 'defense'
                  : `${state.contracts.offers.length} offers`;
              return (
                <button
                  onClick={() => setGrangeOpen(true)}
                  className={`flex flex-col gap-1.5 rounded-md px-3 py-2 text-sm font-bold transition ${
                    claimable
                      ? 'bg-[#5a4320] text-[#ffe9a8] ring-1 ring-[#e2b94f] hover:bg-[#6a4f28]'
                      : 'bg-[#2e3a26] text-[#bfe8a8] hover:bg-[#36422c]'
                  }`}
                >
                  <span className="flex w-full items-center justify-between">
                    <span className="flex items-center gap-1.5">
                      <GrangeIcon size={16} /> The Grange
                    </span>
                    <span className="tabular-nums">{tag}</span>
                  </span>
                  {active && <ActiveContractStrip state={state} />}
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

        {/* Build palette — a full-width row spanning both columns, below the
            board. The water zones get their own palette here too (same layout
            as the yard — playtest ask: no build UI crammed into the board). */}
        {isBuildZone && (
          <div className="rounded-lg bg-[#1f1812] p-3 ring-1 ring-[#3a2e22]">
            <BuildBar state={state} buildType={buildType} onPick={setBuildType} activeZone={activeZone} />
          </div>
        )}
        {isWaterZone && (
          <div className="rounded-lg bg-[#1f1812] p-3 ring-1 ring-[#3a2e22]">
            <WaterBuildBar
              state={state}
              mode={activeZd?.waterworks ? 'circulation' : 'layout'}
              pick={waterPick}
              onPick={setWaterPick}
            />
          </div>
        )}

        {/* Dev tools + backup/reset sit at the very bottom, under the build palette. */}
        {import.meta.env.DEV && <DevPanel engine={engine} state={state} />}
        <div ref={backupRef}>
          <BackupControls engine={engine} />
        </div>
        <div className="flex items-center gap-3">
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
          <button
            onClick={resetAllGuides}
            className="self-start text-[10px] text-[#6a5a3a] underline hover:text-[#9a8a6a]"
            title="Re-arm every Almanac page for this browser — handy for testing or handing the homestead to someone new"
          >
            Re-show all tips
          </button>
        </div>
      </div>
    </div>
  );
}
