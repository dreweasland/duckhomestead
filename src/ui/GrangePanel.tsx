import { BALANCE } from '../config/balance';
import type { GameEngine } from '../game/engine';
import { eligibleForOrder } from '../game/contracts';
import { type Contract, type GameState, type Ingredient } from '../game/state';
import { GENE_META } from './FlockPanel';
import { useEscapeKey } from './useEscapeKey';
import { CheckIcon, CloseIcon, DustIcon, GrangeIcon, HandoverIcon, LegacyIcon, OwlIcon, RESOURCE_ICON } from './icons';

const C = BALANCE.CONTRACTS;

const ING_LABEL: Record<Ingredient, string> = {
  corn: 'Corn',
  peas: 'Peas',
  mealworms: 'Mealworms',
  brewersYeast: "Brewer's Yeast",
  oysterShell: 'Oyster Shell',
  sunflowerSeeds: 'Sunflower Seeds',
  fodderSprouts: 'Fodder Sprouts',
};

const mmss = (secs: number): string => {
  const s = Math.max(0, Math.ceil(secs));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** An order's spec: constrained slots read as gene pips (always the odd gene
 *  out against the Standard), "don't care" slots read as dim placeholders —
 *  never reveals more than the spec asks for. */
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
          title={g ? `Slot ${i + 1}: ${GENE_META[g as 'L' | 'V' | 'H'].label} (odd blood)` : `Slot ${i + 1}: any`}
        >
          {g ?? '·'}
        </span>
      ))}
    </span>
  );
}

/** One contract's goal, rendered by type — used for both offers and the active card. */
function ContractGoal({ c }: { c: Contract }) {
  if (c.type === 'provision') {
    const Icon = RESOURCE_ICON[c.ingredient];
    return (
      <span className="inline-flex items-center gap-1">
        <Icon size={12} /> Provide {c.amount.toLocaleString()} {ING_LABEL[c.ingredient]}
        <span className="text-[#7a6a4a]">· {C.PROVISION.LIMIT_MIN}m limit</span>
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
      WANTED: odd blood
      <SpecPips pattern={c.constraints} />
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

/** Progress + the completing action for the active contract: a stock bar +
 *  Fulfil for provision, a live eligible-count + Deliver for an order, a scare
 *  bar for defense (no action — the sim itself completes it). */
function ActiveJob({ c, state, engine }: { c: Contract; state: GameState; engine: GameEngine }) {
  if (c.type === 'provision') {
    const stock = state.resources[c.ingredient];
    const pct = Math.min(1, stock / Math.max(1, c.amount));
    const canFulfil = !c.completed && stock >= c.amount;
    return (
      <div>
        <div className="mb-0.5 flex items-center justify-between text-[10px] text-[#c9b88f]">
          <span className="tabular-nums">
            {Math.floor(stock).toLocaleString()} / {c.amount.toLocaleString()} {ING_LABEL[c.ingredient]} on hand
          </span>
          <span className="tabular-nums text-[#e8c45a]">{mmss(c.limitRemaining)} left</span>
        </div>
        <div className="mb-2 h-1.5 overflow-hidden rounded-full bg-[#0f0b07]">
          <div
            className="h-full rounded-full bg-[#8fe388] transition-[width]"
            style={{ width: `${Math.round(pct * 100)}%` }}
          />
        </div>
        <button
          onClick={() => engine.fulfilProvision()}
          disabled={!canFulfil}
          className={`flex w-full items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-bold transition ${
            canFulfil
              ? 'bg-[#3a2e22] text-[#ffe9a8] hover:bg-[#4a3a2a]'
              : 'cursor-not-allowed bg-[#241c14] text-[#6a5a3a]'
          }`}
        >
          <HandoverIcon size={11} /> Fulfil
        </button>
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
  const eligible = eligibleForOrder(state, c).length;
  const canDeliver = !c.completed && eligible > 0;
  return (
    <div>
      <div className="mb-2 text-[10px] tabular-nums text-[#c9b88f]">
        {eligible} eligible in the flock — no time limit
      </div>
      <button
        onClick={() => engine.deliverOrderDuck()}
        disabled={!canDeliver}
        className={`flex w-full items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-bold transition ${
          canDeliver
            ? 'bg-[#3a2e22] text-[#ffe9a8] hover:bg-[#4a3a2a]'
            : 'cursor-not-allowed bg-[#241c14] text-[#6a5a3a]'
        }`}
        title="Hands over your lowest-target-quality eligible duck — your best stock is kept"
      >
        <HandoverIcon size={11} /> Deliver
      </button>
    </div>
  );
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
            <span
              className="inline-flex items-center gap-1 rounded bg-[#1f1812] px-2 py-1 text-xs font-bold text-[#e2b94f]"
              title="Dust — reroll modules (10) or this board (5). Contracts + salvage feed it."
            >
              <DustIcon size={11} /> {state.dust}
            </span>
            <span
              className="inline-flex items-center gap-1 rounded bg-[#1f1812] px-2 py-1 text-xs font-bold text-[#cdbcff]"
              title="Legacy — contract shards land here (the same currency prestige grants). Spend it on permanent boosts in the Legacy panel."
            >
              <LegacyIcon size={11} /> {state.legacyCurrency}
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
          The county's notice board: one job at a time, and every job costs a real detour — a
          dedicated breeding pair, a purchased buffer, or a defended window. Rewards are dust + a
          trickle of legacy shards (a top-tier job also grants a module) — never eggs, resources,
          or XP. Everything here runs only while you're online.
        </p>

        {/* Active contract */}
        {cs.active ? (
          <div className="mb-3 rounded-md bg-[#1f1812] px-3 py-2.5">
            <div className="mb-1.5 flex items-center justify-between text-[10px] font-bold uppercase tracking-wider text-[#7a6a4a]">
              <span>Active job</span>
              <RewardTag c={cs.active} />
            </div>
            <div className="mb-2 text-xs font-bold text-[#f5ecd8]">
              <ContractGoal c={cs.active} />
            </div>
            <ActiveJob c={cs.active} state={state} engine={engine} />
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
            No active job — accept an offer below.
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
