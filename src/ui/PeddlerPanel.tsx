import type { GameEngine } from '../game/engine';
import { peddlerOpen } from '../game/peddler';
import {
  coopCapacity,
  ingredientCap,
  phenotype,
  type BarterOffer,
  type BloodlineOffer,
  type GameState,
  type Ingredient,
} from '../game/state';
import { ColorSwatch, GenomeTiles, PhenoBands } from './FlockPanel';
import { CloseIcon, EggIcon, RESOURCE_ICON } from './icons';
import { playCollect, playPlace } from '../audio/sfx';
import { useEscapeKey } from './useEscapeKey';


const ING_LABEL: Record<Ingredient, string> = {
  corn: 'corn',
  peas: 'peas',
  mealworms: 'mealworms',
  brewersYeast: 'brewer’s yeast',
  oysterShell: 'oyster shell',
  sunflowerSeeds: 'sunflower seeds',
  fodderSprouts: 'fodder sprouts',
};

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.max(0, Math.ceil(s)) % 60).padStart(2, '0')}`;

function BarterRow({ o, state, engine }: { o: BarterOffer; state: GameState; engine: GameEngine }) {
  const GivesIcon = RESOURCE_ICON[o.gives];
  const WantsIcon = RESOURCE_ICON[o.wants];
  const stock = Math.floor(state.resources[o.wants] ?? 0);
  const short = stock < o.wantsAmount;
  const noRoom = state.resources[o.gives] + o.givesAmount > ingredientCap(state);
  const blocked = short ? `need ${o.wantsAmount} ${ING_LABEL[o.wants]} (have ${stock})` : noRoom ? 'no room in the Feed Store' : null;
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md bg-[#1f1812] px-3 py-2 text-xs">
      <span className="inline-flex items-center gap-1 font-bold text-[#f5ecd8]">
        <GivesIcon size={13} /> {o.givesAmount.toLocaleString()} {ING_LABEL[o.gives]}
      </span>
      {o.seasonal && (
        <span
          className="rounded bg-[#3a3218] px-1 py-0.5 text-[9px] font-bold text-[#e8c45a]"
          title="The season's scarce line — exactly the crunch his cart leans toward"
        >
          seasonal
        </span>
      )}
      <span className="text-[#7a6a4a]">for your</span>
      <span className="inline-flex items-center gap-1 text-[#c9b88f]">
        <WantsIcon size={13} /> {o.wantsAmount.toLocaleString()} {ING_LABEL[o.wants]}
      </span>
      <button
        onClick={() => {
          if (engine.acceptBarter(o.id).ok) playCollect();
        }}
        disabled={blocked != null}
        title={blocked ?? 'Trade — his goods land in the Feed Store'}
        className={`ml-auto rounded-md px-3 py-1.5 text-xs font-bold transition ${
          blocked
            ? 'cursor-not-allowed bg-[#241c14] text-[#6a5a3a]'
            : 'bg-[#3a2e22] text-[#ffe9a8] hover:bg-[#4a3a2a]'
        }`}
      >
        Trade
      </button>
      {blocked && <div className="w-full text-[9px] text-[#b89a6a]">{blocked}</div>}
    </div>
  );
}

function BloodlineRow({ o, state, engine }: { o: BloodlineOffer; state: GameState; engine: GameEngine }) {
  const eggs = Math.floor(state.resources.eggs);
  const home = state.ducks.filter((d) => d.site !== 'winter').length;
  const blocked =
    eggs < o.priceEggs
      ? `need ${o.priceEggs.toLocaleString()} eggs`
      : home >= coopCapacity(state)
        ? 'no housing — build or upgrade a coop'
        : null;
  // Without a reader you buy on the public bands, exactly like judging your
  // own unread ducks; the reader reveals the full genome here too.
  const preview = state.geneReader ? (
    <GenomeTiles duck={{ genome: o.genome, genomeKnown: true }} target={state.genomeTarget} size={13} />
  ) : (
    <PhenoBands genome={o.genome} />
  );
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md bg-[#241d33] px-3 py-2 text-xs ring-1 ring-[#4a3a6e]">
      <ColorSwatch color={phenotype(o.genotype)} size={11} />
      <span className="font-bold text-[#f5ecd8]">outside {o.sex}</span>
      <span
        className="rounded bg-[#1a2a1a] px-1 py-0.5 text-[9px] font-bold text-[#8fe388]"
        title="No lineage at all — kinship 0 against every duck you own. The outcross."
      >
        clean blood
      </span>
      {preview}
      <button
        onClick={() => {
          if (engine.buyBloodline(o.id).ok) playPlace();
        }}
        disabled={blocked != null}
        title={blocked ?? 'Buy — arrives adult, unrelated to your whole flock'}
        className={`ml-auto inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-xs font-bold transition ${
          blocked
            ? 'cursor-not-allowed bg-[#241c14] text-[#6a5a3a]'
            : 'bg-[#6b4f9e] text-[#fff4d6] hover:bg-[#7a5cae]'
        }`}
      >
        <EggIcon size={11} /> {o.priceEggs.toLocaleString()}
      </button>
      {blocked && <div className="w-full text-[9px] text-[#b89a6a]">{blocked}</div>}
    </div>
  );
}

/**
 * THE PEDDLER (9e): a wandering cart — goods for goods at his prices, and now
 * and then a bird of clean outside blood. Everything is a one-click trade;
 * the board restocks on its own online clock. Never dust/shards/XP.
 */
export function PeddlerPanel({ engine, state, onClose }: { engine: GameEngine; state: GameState; onClose: () => void }) {
  useEscapeKey(onClose);
  if (!peddlerOpen(state)) return null;
  const offers = state.peddler.offers;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-4">
      <div className="max-h-[92vh] w-full max-w-md overflow-y-auto rounded-t-xl pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:max-h-[90vh] sm:rounded-xl bg-[#2a2018] p-5 ring-2 ring-[#3a2e22]">
        <div className="mb-1 flex items-center justify-between">
          <h2 className="text-lg font-black text-[#ffe9a8]">The Peddler</h2>
          <div className="flex items-center gap-3">
            <span className="text-[10px] tabular-nums text-[#9a8a6a]" title="The cart restocks on its own clock (while you play)">
              restock {mmss(state.peddler.refreshRemaining)}
            </span>
            <button onClick={onClose} className="rounded p-1.5 text-[#9a8a6a] hover:bg-[#1f1812] hover:text-[#f5ecd8]" aria-label="Close">
              <CloseIcon size={14} />
            </button>
          </div>
        </div>
        <p className="mb-3 text-xs text-[#9a8a6a]">
          Goods for goods, at his prices — he leans toward whatever the season makes scarce. A trade
          is a relief valve, not a producer: the rate always favors him. His birds carry no lineage
          at all — the outcross for your lines.
        </p>
        <div className="flex flex-col gap-2">
          {offers.length === 0 ? (
            <div className="py-6 text-center text-sm text-[#9a8a6a]">The cart is restocking…</div>
          ) : (
            offers.map((o) =>
              o.kind === 'barter' ? (
                <BarterRow key={o.id} o={o} state={state} engine={engine} />
              ) : (
                <BloodlineRow key={o.id} o={o} state={state} engine={engine} />
              ),
            )
          )}
        </div>
        <p className="mt-3 text-[10px] text-[#7a6a4a]">
          Bought birds arrive adult and unrelated to everything you own — but their colors never
          fill the dex (the dex is bred, never bought), and the Peddler never carries Prime blood.
        </p>
      </div>
    </div>
  );
}
