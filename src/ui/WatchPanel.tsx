import { BALANCE, PREDATOR_DEFS } from '../config/balance';
import type { GameEngine } from '../game/engine';
import { currentThreat } from '../game/predators';
import { waterWoundMult } from '../game/water';
import { defenseFloor, secureCapacity, type GameState } from '../game/state';
import { playPlace, playTend } from '../audio/sfx';
import { CloseIcon, EggIcon, HealIcon, NetIcon, OwlIcon, ShieldIcon } from './icons';

const P = BALANCE.PREDATORS;

function StatRow({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between rounded bg-[#171009] px-2.5 py-1.5">
      <span className="text-[11px] text-[#9a8a6a]">{label}</span>
      <span className="text-right">
        <span className="text-sm font-bold tabular-nums text-[#f5ecd8]">{value}</span>
        {hint && <span className="ml-1 text-[10px] text-[#7a6a4a]">{hint}</span>}
      </span>
    </div>
  );
}

export function WatchPanel({
  engine,
  state,
  onClose,
}: {
  engine: GameEngine;
  state: GameState;
  onClose: () => void;
}) {
  const eggs = Math.round(state.resources.eggs);
  const floor = defenseFloor(state);
  const floorPct = Math.round(floor * 100);
  const capPct = Math.round(P.DEFENSE_FLOOR_CAP * 100);
  const securedCount = state.ducks.filter((d) => d.secured).length;
  const slots = secureCapacity(state);
  const threat = currentThreat(state);
  const wounded = state.ducks.filter((d) => d.wounded);

  const deterrentCost = P.DETERRENT_COST_EGGS;
  const secureCost = P.SECURE_COOP_COST_EGGS;
  const treatCost = P.TREAT_COST_EGGS;
  // Maxed keys off PRISTINE capacity (so wear doesn't re-invite building more nets —
  // you repair instead).
  const floorMaxed = state.deterrents * P.DEFENSE_FLOOR_PER_DETERRENT >= P.DEFENSE_FLOOR_CAP;

  // Deterrent integrity + repair.
  const integrity = state.deterrentIntegrity;
  const integrityPct = Math.round(integrity * 100);
  const repairCost = Math.max(
    1,
    Math.round(state.deterrents * P.DETERRENT_REPAIR_COST_PER_NET * (1 - integrity)),
  );
  const integrityColor = integrity >= 0.66 ? '#8fe388' : integrity >= 0.33 ? '#e8c45a' : '#e8835a';
  const canRepair = state.deterrents > 0 && integrity < 1 && eggs >= repairCost;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-xl bg-[#2a2018] p-5 ring-2 ring-[#3a2e22]">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-lg font-black text-[#ffe9a8]">
            <OwlIcon size={20} /> The Watch
          </h2>
          <button
            onClick={onClose}
            className="rounded p-1.5 text-[#9a8a6a] hover:bg-[#1f1812] hover:text-[#f5ecd8]"
            aria-label="Close"
          >
            <CloseIcon size={14} />
          </button>
        </div>

        {/* Threat status */}
        <div
          className={`mb-3 rounded-md px-3 py-2 text-xs ring-1 ${
            threat?.phase === 'open'
              ? 'bg-[#3a1c1c] text-[#ffd9d9] ring-[#e26d6d]'
              : threat?.phase === 'incoming'
                ? 'bg-[#3a2e16] text-[#ffe9a8] ring-[#e2b94f]'
                : 'bg-[#1f2a1c] text-[#bfe8a8] ring-[#3a4a2c]'
          }`}
        >
          {threat?.phase === 'open' ? (
            <span className="font-bold">
              {threat.def.name} hunting now — {Math.ceil(threat.seconds)}s left. Watch the board and
              tap the owl to scare each dive off — or secure your breeders.
            </span>
          ) : threat?.phase === 'incoming' ? (
            <span className="font-bold">
              {threat.def.name} incoming in {Math.ceil(threat.seconds)}s.
            </span>
          ) : (
            <span>
              All quiet. {PREDATOR_DEFS.map((d) => d.name).join(', ')} hunt in telegraphed windows —
              you’ll always get a warning.
            </span>
          )}
        </div>

        <div className="mb-3 grid grid-cols-1 gap-1.5">
          <StatRow
            label="Protection floor"
            value={`${floorPct}%`}
            hint={`cap ${capPct}% · ${state.deterrents} nets @ ${integrityPct}%`}
          />
          <StatRow label="Secured breeders" value={`${securedCount} / ${slots}`} hint="excluded from attacks" />
          <StatRow label="Wounded" value={`${wounded.length}`} hint={wounded.length ? 'treat before they escalate' : 'none'} />
        </div>

        {/* Deterrent integrity + repair — the upkeep loop */}
        {state.deterrents > 0 && (
          <div className="mb-3 rounded-md bg-[#1f1812] px-3 py-2.5">
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-[10px] font-bold uppercase tracking-wider text-[#7a6a4a]">
                Deterrent integrity
              </span>
              <span className="text-xs font-bold tabular-nums" style={{ color: integrityColor }}>
                {integrityPct}%
              </span>
            </div>
            <div className="mb-2 h-2 overflow-hidden rounded-full bg-[#3a2e22]">
              <div
                className="h-full rounded-full transition-[width]"
                style={{ width: `${integrityPct}%`, background: integrityColor }}
              />
            </div>
            <button
              onClick={() => {
                if (engine.repairDeterrents().ok) playPlace();
              }}
              disabled={!canRepair}
              className={`w-full rounded-md px-3 py-2 text-xs font-bold transition ${
                canRepair
                  ? 'bg-[#2e3a26] text-[#bfe8a8] hover:bg-[#36422c]'
                  : 'cursor-not-allowed bg-[#241c14] text-[#6a5a3a]'
              }`}
            >
              {integrity >= 1 ? 'Nets pristine' : `Repair nets · ${repairCost} eggs`}
            </button>
            <div className="mt-1 text-[10px] text-[#7a6a4a]">
              Threat windows weather the nets and breaches tear them — repair to keep the floor up.
            </div>
          </div>
        )}

        {/* Build defenses */}
        <div className="mb-3 rounded-md bg-[#1f1812] px-3 py-2.5">
          <div className="mb-2 text-[10px] font-bold uppercase tracking-wider text-[#7a6a4a]">
            Build defenses
          </div>
          <div className="flex flex-col gap-2">
            <button
              onClick={() => {
                if (engine.buildDeterrent().ok) playPlace();
              }}
              disabled={eggs < deterrentCost || floorMaxed}
              className={`flex items-center gap-2 rounded-md px-3 py-2 text-left text-xs transition ${
                eggs >= deterrentCost && !floorMaxed
                  ? 'bg-[#2e3a26] text-[#bfe8a8] hover:bg-[#36422c]'
                  : 'cursor-not-allowed bg-[#241c14] text-[#6a5a3a]'
              }`}
            >
              <NetIcon size={18} />
              <span className="flex-1">
                <span className="font-bold">Deterrent</span>
                <span className="block text-[10px] opacity-80">
                  {floorMaxed
                    ? `floor maxed at ${capPct}% — build secure coops instead`
                    : `+${Math.round(P.DEFENSE_FLOOR_PER_DETERRENT * 100)}% protection floor (passive, offline-safe)`}
                </span>
              </span>
              <span className="inline-flex items-center gap-1 font-bold text-[#ffe9a8]">
                <EggIcon size={12} /> {deterrentCost}
              </span>
            </button>
            <button
              onClick={() => {
                if (engine.buildSecureCoop().ok) playPlace();
              }}
              disabled={eggs < secureCost}
              className={`flex items-center gap-2 rounded-md px-3 py-2 text-left text-xs transition ${
                eggs >= secureCost
                  ? 'bg-[#26323a] text-[#a8d0e8] hover:bg-[#2e3c46]'
                  : 'cursor-not-allowed bg-[#241c14] text-[#6a5a3a]'
              }`}
            >
              <ShieldIcon size={18} />
              <span className="flex-1">
                <span className="font-bold">Secure Coop</span>
                <span className="block text-[10px] opacity-80">
                  +{P.SECURE_SLOTS_PER_COOP} secure slots — mark prize breeders safe in the Flock panel
                </span>
              </span>
              <span className="inline-flex items-center gap-1 font-bold text-[#ffe9a8]">
                <EggIcon size={12} /> {secureCost}
              </span>
            </button>
          </div>
        </div>

        {/* Wounded triage */}
        {wounded.length > 0 && (
          <div className="rounded-md bg-[#2a1818] px-3 py-2.5 ring-1 ring-[#5a2a2a]">
            <div className="mb-2 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-[#e8a3a3]">
              <HealIcon size={13} /> Wounded — treat before they’re lost
            </div>
            <div className="flex flex-col gap-1.5">
              {wounded.map((d) => {
                // Phase 4d: the effective escalation window stretches/tightens with water access.
                const escalateAt = P.WOUND_ESCALATE_SEC * waterWoundMult(state);
                const left = Math.max(0, escalateAt - (d.woundElapsed ?? 0));
                const frac = escalateAt > 0 ? left / escalateAt : 0;
                return (
                  <div key={d.id} className="rounded bg-[#171009] px-2.5 py-1.5">
                    <div className="flex items-center gap-2 text-[11px]">
                      <span className="text-[#c9b88f]">{d.sex}</span>
                      <span className="text-[#7a6a4a]">{d.stage}</span>
                      <span className="ml-auto tabular-nums text-[#e8a3a3]">{Math.ceil(left)}s to lose</span>
                      <button
                        onClick={() => {
                          if (engine.treat(d.id).ok) playTend();
                        }}
                        disabled={eggs < treatCost}
                        className={`rounded px-2 py-0.5 text-[10px] font-bold ${
                          eggs >= treatCost
                            ? 'bg-[#2e6b3a] text-[#dfffd6] hover:bg-[#367a44]'
                            : 'cursor-not-allowed bg-[#241c14] text-[#6a5a3a]'
                        }`}
                        title={`Heal this duck (${treatCost} eggs)`}
                      >
                        Treat {treatCost}
                      </button>
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-[#3a1c1c]">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-[#e26d6d] to-[#e2b94f]"
                        style={{ width: `${frac * 100}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div className="mt-3 text-[10px] leading-relaxed text-[#7a6a4a]">
          Built deterrents are your <span className="text-[#a8d0e8]">guard</span> armor — they protect
          while you’re away or idle. But while you’re <span className="text-[#ff9a9a]">actively
          playing</span>, the owl knows it: the floor drops and a dive you don’t <span className="text-[#bfe8a8]">scare</span>
          {' '}lands an injury (the owl also dives faster and feints more as your rank climbs). Securing
          a breeder takes it off the menu entirely, and a wound only turns permanent if left untended —
          so every loss is one you could have prevented.
        </div>
      </div>
    </div>
  );
}
