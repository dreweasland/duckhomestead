import { useCallback, useState } from 'react';
import type { StationType } from './config/balance';
import type { DingEvent } from './game/engine';
import { stationAt } from './game/state';
import { useGame } from './game/useGame';
import { GameCanvas } from './render/GameCanvas';
import { AwayModal } from './ui/AwayModal';
import { BuildBar } from './ui/BuildBar';
import { DingBanner, playDing } from './ui/DingBanner';
import { HUD } from './ui/HUD';
import { StationPanel } from './ui/StationPanel';

export default function App() {
  const [ding, setDing] = useState<DingEvent | null>(null);

  const onDing = useCallback((e: DingEvent) => {
    setDing(e);
    playDing(e.milestones.length > 0);
  }, []);

  const { engine, version } = useGame(onDing);
  // version is read so the component re-renders on each engine notify.
  void version;

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [buildType, setBuildType] = useState<StationType | null>(null);
  const [awayOpen, setAwayOpen] = useState(true);

  const state = engine.state;
  const selected = selectedId ? state.stations.find((s) => s.id === selectedId) ?? null : null;
  const anyBuffer = state.stations.some((s) => Object.values(s.buffer).some((v) => (v ?? 0) > 0));

  const onTileClick = useCallback(
    (x: number, y: number) => {
      const existing = stationAt(engine.state, x, y);
      if (existing) {
        setSelectedId(existing.id);
        return;
      }
      if (buildType) {
        const r = engine.place(buildType, x, y);
        if (r.ok) {
          const placed = stationAt(engine.state, x, y);
          setSelectedId(placed?.id ?? null);
        }
        return;
      }
      setSelectedId(null);
    },
    [engine, buildType],
  );

  return (
    <div className="min-h-full w-full p-4">
      <DingBanner ding={ding} onDone={() => setDing(null)} />
      {engine.away && awayOpen && (
        <AwayModal
          away={engine.away}
          onClose={() => {
            setAwayOpen(false);
            engine.clearAway();
          }}
        />
      )}

      <div className="mx-auto flex max-w-4xl flex-col gap-4 md:flex-row md:items-start">
        {/* Canvas */}
        <div className="flex flex-col items-center gap-2">
          <div className="rounded-lg bg-[#1f1812] p-2 ring-1 ring-[#3a2e22]">
            <GameCanvas engine={engine} selectedId={selectedId} onTileClick={onTileClick} />
          </div>
          {state.stations.length === 0 && (
            <div className="max-w-[460px] text-center text-xs text-[#9a8a6a]">
              You start with {state.resources.eggs} eggs — enough to build the whole chain. Place a
              Feed Plot (corn), a Feed Mill (corn → pellets), and a Coop (pellets → eggs). Eggs only
              come from the Coop, so build all three, then Collect corn so the Mill can run.
            </div>
          )}
        </div>

        {/* Side panel */}
        <div className="flex w-full flex-col gap-4 md:w-[300px]">
          <HUD state={state} />
          {!state.autoHaulUnlocked && state.stations.length > 0 && (
            <button
              onClick={() => engine.collectEverything()}
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
          <BuildBar state={state} buildType={buildType} onPick={setBuildType} />
          <StationPanel engine={engine} state={state} station={selected} />
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
