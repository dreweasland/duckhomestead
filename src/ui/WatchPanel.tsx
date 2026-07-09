import { BALANCE, PREDATOR_DEFS } from '../config/balance';
import { repairCostPerNet } from '../game/actions';
import type { GameEngine } from '../game/engine';
import { currentThreat, predatorLive } from '../game/predators';
import { waterWoundMult } from '../game/water';
import {
  defenseCoverage,
  defenseFloor,
  exposedFlock,
  deterrentCost as deterrentCostFn,
  hardwareClothCost as hardwareClothCostFn,
  infirmaryCapacity,
  infirmaryCost as infirmaryCostFn,
  infirmaryOccupied,
  secureCapacity,
  secureCoopCost as secureCoopCostFn,
  type GameState,
} from '../game/state';
import { playPlace, playTend } from '../audio/sfx';
import { CloseIcon, EggIcon, HealIcon, NetIcon, OwlIcon, ShieldIcon } from './icons';
import { useEscapeKey } from './useEscapeKey';

const P = BALANCE.PREDATORS;
const sevColor = (s?: string): string =>
  s === 'critical' ? '#e8835a' : s === 'serious' ? '#e8c45a' : '#8fbf6a';

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
  useEscapeKey(onClose);
  const eggs = Math.round(state.resources.eggs);
  const floor = defenseFloor(state);
  const floorPct = Math.round(floor * 100);
  const capPct = Math.round(P.DEFENSE_FLOOR_CAP * 100);
  const securedCount = state.ducks.filter((d) => d.secured).length;
  const slots = secureCapacity(state);
  const threat = currentThreat(state);
  const wounded = state.ducks.filter((d) => d.wounded);

  // Build costs escalate with each of a kind already built (the price shown is the NEXT).
  const deterrentCost = deterrentCostFn(state);
  const secureCost = secureCoopCostFn(state);
  // Infirmary: recovery slots for wounded ducks (admit = the save; slots are scarce).
  const infCost = infirmaryCostFn(state);
  const infCap = infirmaryCapacity(state);
  const infUsed = infirmaryOccupied(state);
  const infFree = infCap - infUsed;
  const recovering = wounded.filter((d) => d.recovering);
  const waiting = wounded.filter((d) => !d.recovering);
  // Maxed keys off PRISTINE capacity (so wear doesn't re-invite building more nets —
  // you repair instead). COVERAGE changed what "maxed" means: past the floor
  // cap, extra nets still stretch the line over MORE ducks — so the line is
  // only truly done when the floor is capped AND every exposed duck is under
  // it. A STRETCHED line must never grey the build button.
  const floorMaxed =
    state.deterrents * P.DEFENSE_FLOOR_PER_DETERRENT >= P.DEFENSE_FLOOR_CAP &&
    state.deterrents * P.DUCKS_COVERED_PER_UNIT >= exposedFlock(state);

  // Deterrent integrity + repair.
  const integrity = state.deterrentIntegrity;
  const integrityPct = Math.round(integrity * 100);
  const repairCost = Math.max(
    1,
    Math.round(state.deterrents * repairCostPerNet(state) * (1 - integrity)),
  );
  const integrityColor = integrity >= 0.66 ? '#8fe388' : integrity >= 0.33 ? '#e8c45a' : '#e8835a';
  const canRepair = state.deterrents > 0 && integrity < 1 && eggs >= repairCost;
  // Coverage (the flock-proportional defense ladder): a line stretched over too
  // many exposed ducks protects each of them less — surfaced right on the floor rows.
  const PER_UNIT = BALANCE.PREDATORS.DUCKS_COVERED_PER_UNIT;
  const exposed = exposedFlock(state);
  const netCoverage = defenseCoverage(state, 'net');
  const clothCoverage = defenseCoverage(state, 'cloth');

  // Hardware cloth (ground defense vs the raccoon) — shown once the raccoon debuts.
  const raccoonHere = (state.predatorsSeen ?? []).includes('raccoon');
  const clothCost = hardwareClothCostFn(state);
  const clothFloorPct = Math.round(defenseFloor(state, 'cloth') * 100);
  const clothMaxed =
    state.hardwareCloth * P.DEFENSE_FLOOR_PER_DETERRENT >= P.DEFENSE_FLOOR_CAP &&
    state.hardwareCloth * P.DUCKS_COVERED_PER_UNIT >= exposedFlock(state);
  const clothIntegrity = state.hardwareClothIntegrity;
  const clothIntegrityPct = Math.round(clothIntegrity * 100);
  const clothRepairCost = Math.max(
    1,
    Math.round(state.hardwareCloth * repairCostPerNet(state) * (1 - clothIntegrity)),
  );
  const clothColor = clothIntegrity >= 0.66 ? '#8fe388' : clothIntegrity >= 0.33 ? '#e8c45a' : '#e8835a';
  const canRepairCloth = state.hardwareCloth > 0 && clothIntegrity < 1 && eggs >= clothRepairCost;

  // Phase 6c: only name predators that have actually debuted (rank + tier gates
  // met) — a not-yet-live siege stays a Legacy-panel tease, never spoiled here.
  const liveDefs = PREDATOR_DEFS.filter((d) => predatorLive(state, d));
  const siege = PREDATOR_DEFS.find((d) => d.jackpot);
  const siegeLive = !!siege && predatorLive(state, siege);
  const streak = state.predatorFlawlessStreak ?? 0;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-4">
      <div className="max-h-[92vh] w-full max-w-md overflow-y-auto rounded-t-xl pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:max-h-[90vh] sm:rounded-xl bg-[#2a2018] p-5 ring-2 ring-[#3a2e22]">
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
              All quiet. {liveDefs.map((d) => d.name).join(', ')} hunt in telegraphed windows —
              you’ll always get a warning.
            </span>
          )}
        </div>

        <div className="mb-3 grid grid-cols-1 gap-1.5">
          <StatRow
            label="Aerial floor (owl)"
            value={`${floorPct}%`}
            hint={
              netCoverage < 1
                ? `STRETCHED — ${state.deterrents} nets cover ${state.deterrents * PER_UNIT} of ${exposed} exposed ducks; build more netting`
                : `cap ${capPct}% · ${state.deterrents} nets @ ${integrityPct}% · covers all ${exposed} exposed`
            }
          />
          {raccoonHere && (
            <StatRow
              label="Ground floor (raccoon)"
              value={`${clothFloorPct}%`}
              hint={
                clothCoverage < 1
                  ? `STRETCHED — ${state.hardwareCloth} cloth covers ${state.hardwareCloth * PER_UNIT} of ${exposed} exposed ducks; build more cloth`
                  : `cap ${capPct}% · ${state.hardwareCloth} cloth @ ${clothIntegrityPct}% · covers all ${exposed} exposed`
              }
            />
          )}
          <StatRow label="Secured breeders" value={`${securedCount} / ${slots}`} hint="excluded from attacks" />
          <StatRow label="Wounded" value={`${wounded.length}`} hint={wounded.length ? 'treat before they escalate' : 'none'} />
          {siegeLive && siege?.jackpot && (
            <StatRow
              label="Siege flawless streak"
              value={`${streak}`}
              hint={
                streak > 0
                  ? `every dive scared, nothing landed · ${siege.jackpot.streakForLegendary}× → legendary loot`
                  : 'a clean defense (no landed hits) pays a jackpot'
              }
            />
          )}
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

        {/* Hardware cloth integrity + repair — the raccoon's upkeep loop */}
        {state.hardwareCloth > 0 && (
          <div className="mb-3 rounded-md bg-[#1f1812] px-3 py-2.5">
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-[10px] font-bold uppercase tracking-wider text-[#7a6a4a]">
                Hardware cloth integrity
              </span>
              <span className="text-xs font-bold tabular-nums" style={{ color: clothColor }}>
                {clothIntegrityPct}%
              </span>
            </div>
            <div className="mb-2 h-2 overflow-hidden rounded-full bg-[#3a2e22]">
              <div
                className="h-full rounded-full transition-[width]"
                style={{ width: `${clothIntegrityPct}%`, background: clothColor }}
              />
            </div>
            <button
              onClick={() => {
                if (engine.repairHardwareCloth().ok) playPlace();
              }}
              disabled={!canRepairCloth}
              className={`w-full rounded-md px-3 py-2 text-xs font-bold transition ${
                canRepairCloth
                  ? 'bg-[#2e3a26] text-[#bfe8a8] hover:bg-[#36422c]'
                  : 'cursor-not-allowed bg-[#241c14] text-[#6a5a3a]'
              }`}
            >
              {clothIntegrity >= 1 ? 'Cloth pristine' : `Repair cloth · ${clothRepairCost} eggs`}
            </button>
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
                    ? `line complete — ${capPct}% floor, all ${exposedFlock(state)} exposed covered`
                    : `+${Math.round(P.DEFENSE_FLOOR_PER_DETERRENT * 100)}% protection floor (passive, offline-safe)`}
                </span>
              </span>
              <span className="inline-flex items-center gap-1 font-bold text-[#ffe9a8]">
                <EggIcon size={12} /> {deterrentCost}
              </span>
            </button>
            {raccoonHere && (
              <button
                onClick={() => {
                  if (engine.buildHardwareCloth().ok) playPlace();
                }}
                disabled={eggs < clothCost || clothMaxed}
                className={`flex items-center gap-2 rounded-md px-3 py-2 text-left text-xs transition ${
                  eggs >= clothCost && !clothMaxed
                    ? 'bg-[#2e3a26] text-[#bfe8a8] hover:bg-[#36422c]'
                    : 'cursor-not-allowed bg-[#241c14] text-[#6a5a3a]'
                }`}
              >
                <NetIcon size={18} />
                <span className="flex-1">
                  <span className="font-bold">Hardware Cloth</span>
                  <span className="block text-[10px] opacity-80">
                    {clothMaxed
                      ? `line complete — ${capPct}% ground floor, all exposed covered`
                      : `+${Math.round(P.DEFENSE_FLOOR_PER_DETERRENT * 100)}% GROUND floor vs the raccoon (nets don’t help here)`}
                  </span>
                </span>
                <span className="inline-flex items-center gap-1 font-bold text-[#ffe9a8]">
                  <EggIcon size={12} /> {clothCost}
                </span>
              </button>
            )}
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
                  {/* Diminishing by design: the FIRST coop adds the full set, each
                      additional adds fewer — show the NEXT purchase's real slots. */}
                  +{state.secureCoops === 0 ? P.SECURE_SLOTS_PER_COOP : P.SECURE_SLOTS_ADDITIONAL} secure
                  slots — mark prize breeders safe in the Flock panel
                </span>
              </span>
              <span className="inline-flex items-center gap-1 font-bold text-[#ffe9a8]">
                <EggIcon size={12} /> {secureCost}
              </span>
            </button>
            <button
              onClick={() => {
                if (engine.buildInfirmary().ok) playPlace();
              }}
              disabled={eggs < infCost}
              className={`flex items-center gap-2 rounded-md px-3 py-2 text-left text-xs transition ${
                eggs >= infCost
                  ? 'bg-[#3a2636] text-[#e8b8d8] hover:bg-[#46304a]'
                  : 'cursor-not-allowed bg-[#241c14] text-[#6a5a3a]'
              }`}
            >
              <HealIcon size={18} />
              <span className="flex-1">
                <span className="font-bold">Infirmary {infCap > 0 && `(${infUsed}/${infCap} slots)`}</span>
                <span className="block text-[10px] opacity-80">
                  +{P.INFIRMARY.SLOTS_PER} recovery slots — admit wounded ducks to heal them over time
                </span>
              </span>
              <span className="inline-flex items-center gap-1 font-bold text-[#ffe9a8]">
                <EggIcon size={12} /> {infCost}
              </span>
            </button>
          </div>
        </div>

        {/* Wounded triage: recovering (in a slot) + waiting (admit before they escalate) */}
        {wounded.length > 0 && (
          <div className="rounded-md bg-[#2a1818] px-3 py-2.5 ring-1 ring-[#5a2a2a]">
            <div className="mb-2 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-[#e8a3a3]">
              <HealIcon size={13} /> Wounded
              {infCap > 0 && <span className="ml-auto text-[#c9a0c0]">{infUsed}/{infCap} slots</span>}
            </div>
            <div className="flex flex-col gap-1.5">
              {recovering.map((d) => {
                const recSec = P.INFIRMARY.RECOVERY_SEC[d.severity ?? 'serious'] / waterWoundMult(state);
                const left = Math.max(0, recSec - (d.recoveryElapsed ?? 0));
                const frac = recSec > 0 ? Math.min(1, (d.recoveryElapsed ?? 0) / recSec) : 1;
                return (
                  <div key={d.id} className="rounded bg-[#171009] px-2.5 py-1.5">
                    <div className="flex items-center gap-2 text-[11px]">
                      <span className="text-[#c9b88f]">{d.sex}</span>
                      <span className="text-[10px]" style={{ color: sevColor(d.severity) }}>{d.severity ?? 'serious'}</span>
                      <span className="ml-auto tabular-nums text-[#8fe388]">recovering · {Math.ceil(left)}s</span>
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-[#1f2a1c]">
                      <div className="h-full rounded-full bg-[#8fe388]" style={{ width: `${frac * 100}%` }} />
                    </div>
                  </div>
                );
              })}
              {waiting.map((d) => {
                // Phase 4d: the effective escalation window stretches/tightens with water access.
                const escalateAt = P.WOUND_ESCALATE_SEC * waterWoundMult(state);
                const left = Math.max(0, escalateAt - (d.woundElapsed ?? 0));
                const frac = escalateAt > 0 ? left / escalateAt : 0;
                return (
                  <div key={d.id} className="rounded bg-[#171009] px-2.5 py-1.5">
                    <div className="flex items-center gap-2 text-[11px]">
                      <span className="text-[#c9b88f]">{d.sex}</span>
                      <span className="text-[10px]" style={{ color: sevColor(d.severity) }}>{d.severity ?? 'serious'}</span>
                      <span className="ml-auto tabular-nums text-[#e8a3a3]">{Math.ceil(left)}s to lose</span>
                      <button
                        onClick={() => {
                          if (engine.admit(d.id).ok) playTend();
                        }}
                        disabled={infFree <= 0}
                        className={`rounded px-2 py-0.5 text-[10px] font-bold ${
                          infFree > 0
                            ? 'bg-[#2e6b3a] text-[#dfffd6] hover:bg-[#367a44]'
                            : 'cursor-not-allowed bg-[#241c14] text-[#6a5a3a]'
                        }`}
                        title={infFree > 0 ? 'Admit to a recovery slot (heals over time)' : 'Infirmary full — build another or wait'}
                      >
                        {infFree > 0 ? 'Admit' : 'Full'}
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
            {infCap === 0 && waiting.length > 0 && (
              <div className="mt-1.5 text-[10px] text-[#e8a35a]">
                Build an Infirmary above to admit and heal wounded ducks.
              </div>
            )}
          </div>
        )}

        <div className="mt-3 text-[10px] leading-relaxed text-[#7a6a4a]">
          Built deterrents are your <span className="text-[#a8d0e8]">guard</span> armor — they protect
          while you’re away or idle. But while you’re <span className="text-[#ff9a9a]">actively
          playing</span>, the owl knows it: the floor drops and a dive you don’t <span className="text-[#bfe8a8]">scare</span>
          {' '}lands an injury. A wound halves the duck’s laying and turns permanent unless you
          <span className="text-[#8fe388]"> admit it to an Infirmary</span> in time — where it recovers
          over time (faster with good water), holding a scarce slot and eating extra feed. Securing a
          breeder takes it off the menu entirely, so every loss is one you could have prevented.
        </div>
      </div>
    </div>
  );
}
