import { BALANCE } from '../config/balance';
import type { GameEngine } from '../game/engine';
import { type Contract, type GameState } from '../game/state';
import { ColorSwatch, GENE_META } from './FlockPanel';
import { useEscapeKey } from './useEscapeKey';
import { CheckIcon, CloseIcon, DustIcon, EggIcon, GrangeIcon, OwlIcon } from './icons';

const C = BALANCE.CONTRACTS;

const mmss = (secs: number): string => {
  const s = Math.max(0, Math.ceil(secs));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** A hatch spec's gene pattern: specified slots read as gene pips, "don't care"
 *  slots read as dim placeholders — never reveals more than the spec asks for. */
function SpecPips({ pattern, size = 13 }: { pattern: (string | null)[]; size?: number }) {
  return (
    <span className="inline-flex gap-0.5 align-middle">
      {pattern.map((g, i) => (
        <span
          key={i}
          className="inline-flex items-center justify-center rounded-[2px] font-bold leading-none"
          style={{
            width: size,
            height: size,
            fontSize: size - 5,
            background: g ? GENE_META[g as 'L' | 'V' | 'H'].color : '#2a2018',
            color: g ? '#171009' : '#5a4d3a',
          }}
          title={g ? `Slot ${i + 1}: ${GENE_META[g as 'L' | 'V' | 'H'].label}` : `Slot ${i + 1}: any`}
        >
          {g ?? '·'}
        </span>
      ))}
    </span>
  );
}

/** One contract's goal, rendered by type — used for both offers and the active card. */
function ContractGoal({ c }: { c: Contract }) {
  if (c.type === 'delivery') {
    return (
      <span className="inline-flex items-center gap-1">
        <EggIcon size={12} /> Deliver {Math.round(c.quota).toLocaleString()} eggs
        <span className="text-[#7a6a4a]">· {C.DELIVERY.LIMIT_MIN}m limit</span>
      </span>
    );
  }
  if (c.type === 'defense') {
    return (
      <span className="inline-flex items-center gap-1">
        <OwlIcon size={12} /> Foil {c.scareTarget} dives, unwounded
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      Hatch to spec
      {c.color && <ColorSwatch color={c.color} size={10} />}
      <SpecPips pattern={c.genePattern} />
    </span>
  );
}

function RewardTag({ c }: { c: Contract }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[10px] font-bold text-[#e2b94f]">
      <DustIcon size={10} /> +{c.reward.dust}
      <span className="text-[#8fe388]">+{c.reward.shards} shards</span>
      {c.reward.moduleRarity && <span className="text-[#cdbcff]">+{c.reward.moduleRarity} module</span>}
    </span>
  );
}

/** Progress for the active contract: a bar for delivery/defense, a waiting note
 *  for hatch (a binary "matched yet?" goal has no meaningful fractional bar). */
function ActiveProgress({ c }: { c: Contract }) {
  if (c.type === 'delivery') {
    const pct = Math.min(1, c.delivered / Math.max(1, c.quota));
    return (
      <div>
        <div className="mb-0.5 flex items-center justify-between text-[10px] text-[#c9b88f]">
          <span className="tabular-nums">
            {Math.round(c.delivered).toLocaleString()} / {Math.round(c.quota).toLocaleString()} eggs
          </span>
          <span className="tabular-nums text-[#e8c45a]">{mmss(c.limitRemaining)} left</span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-[#0f0b07]">
          <div
            className="h-full rounded-full bg-[#8fe388] transition-[width]"
            style={{ width: `${Math.round(pct * 100)}%` }}
          />
        </div>
      </div>
    );
  }
  if (c.type === 'defense') {
    const pct = Math.min(1, c.scareProgress / Math.max(1, c.scareTarget));
    return (
      <div>
        <div className="mb-0.5 text-[10px] tabular-nums text-[#c9b88f]">
          {c.scareProgress} / {c.scareTarget} dives foiled — no time limit
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-[#0f0b07]">
          <div
            className="h-full rounded-full bg-[#8fe388] transition-[width]"
            style={{ width: `${Math.round(pct * 100)}%` }}
          />
        </div>
      </div>
    );
  }
  return <div className="text-[10px] text-[#c9b88f]">Awaiting a matching hatch — no time limit.</div>;
}

export function GrangePanel({
  engine,
  state,
  onClose,
}: {
  engine: GameEngine;
  state: GameState;
  onClose: () => void;
}) {
  useEscapeKey(onClose);
  const cs = state.contracts;
  const canAffordReroll = state.dust >= C.REROLL_DUST;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-xl bg-[#2a2018] p-5 ring-2 ring-[#3a2e22]">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-lg font-black text-[#ffe9a8]">
            <GrangeIcon size={20} /> The Grange
          </h2>
          <div className="flex items-center gap-3">
            <span className="inline-flex items-center gap-1 rounded bg-[#1f1812] px-2 py-1 text-xs font-bold text-[#e2b94f]">
              <DustIcon size={11} /> {state.dust}
            </span>
            <button
              onClick={onClose}
              className="rounded p-1.5 text-[#9a8a6a] hover:bg-[#1f1812] hover:text-[#f5ecd8]"
              aria-label="Close"
            >
              <CloseIcon size={14} />
            </button>
          </div>
        </div>

        <p className="mb-3 text-[10px] text-[#9a8a6a]">
          One contract at a time. Rewards are dust + a trickle of legacy shards (a top-tier offer
          also grants a module) — never eggs, resources, or XP. Everything here runs only while
          you're online.
        </p>

        {/* Active contract */}
        {cs.active ? (
          <div className="mb-3 rounded-md bg-[#1f1812] px-3 py-2.5">
            <div className="mb-1.5 flex items-center justify-between text-[10px] font-bold uppercase tracking-wider text-[#7a6a4a]">
              <span>Active contract</span>
              <RewardTag c={cs.active} />
            </div>
            <div className="mb-2 text-xs font-bold text-[#f5ecd8]">
              <ContractGoal c={cs.active} />
            </div>
            <ActiveProgress c={cs.active} />
            <div className="mt-2 flex gap-2">
              <button
                onClick={() => engine.claimContract()}
                disabled={!cs.active.completed}
                className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-bold transition ${
                  cs.active.completed
                    ? 'bg-[#2e6b3a] text-[#dfffd6] hover:bg-[#367a44]'
                    : 'cursor-not-allowed bg-[#241c14] text-[#6a5a3a]'
                }`}
              >
                <CheckIcon size={11} /> Claim
              </button>
              <button
                onClick={() => engine.abandonContract()}
                className="rounded-md bg-[#3a2e22] px-3 py-1.5 text-xs font-bold text-[#c9b88f] transition hover:bg-[#4a3a2a]"
              >
                Abandon
              </button>
            </div>
          </div>
        ) : (
          <div className="mb-3 rounded-md bg-[#1f1812] px-3 py-2.5 text-center text-[11px] text-[#7a6a4a]">
            No active contract — accept an offer below.
          </div>
        )}

        {/* Offer board */}
        <div className="mb-1 flex items-center justify-between">
          <span className="text-[10px] font-bold uppercase tracking-wider text-[#7a6a4a]">
            Offers · refresh in {mmss(cs.refreshRemaining)}
          </span>
          <button
            onClick={() => engine.rerollContractOffers()}
            disabled={!canAffordReroll}
            className={`rounded px-2 py-0.5 text-[10px] font-bold ${
              canAffordReroll
                ? 'bg-[#3a2e22] text-[#ffe9a8] hover:bg-[#4a3a2a]'
                : 'cursor-not-allowed bg-[#241c14] text-[#6a5a3a]'
            }`}
            title={`Reroll the whole board for ${C.REROLL_DUST} dust`}
          >
            Reroll · {C.REROLL_DUST} dust
          </button>
        </div>
        <div className="flex flex-col gap-1.5">
          {cs.offers.map((o) => (
            <div key={o.id} className="flex items-center gap-2 rounded bg-[#171009] px-2.5 py-2">
              <div className="min-w-0 flex-1">
                <div className="text-[11px] font-bold text-[#f5ecd8]">
                  <ContractGoal c={o} />
                </div>
                <RewardTag c={o} />
              </div>
              <button
                onClick={() => engine.acceptContract(o.id)}
                disabled={!!cs.active}
                className={`shrink-0 rounded px-2.5 py-1 text-[10px] font-bold ${
                  cs.active
                    ? 'cursor-not-allowed bg-[#241c14] text-[#6a5a3a]'
                    : 'bg-[#3a2e22] text-[#ffe9a8] hover:bg-[#4a3a2a]'
                }`}
              >
                Accept
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
