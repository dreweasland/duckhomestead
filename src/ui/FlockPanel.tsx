import type { GameEngine } from '../game/engine';
import { COLORS, coopCapacity, phenotype, type Color, type Duck, type GameState } from '../game/state';
import { CloseIcon } from './icons';

export const COLOR_META: Record<Color, { label: string; swatch: string }> = {
  black: { label: 'Black', swatch: '#33333c' },
  blue: { label: 'Blue', swatch: '#5b7a9d' },
  splash: { label: 'Splash', swatch: '#aebed2' },
};

const STAGE_LABEL: Record<Duck['stage'], string> = {
  duckling: 'duckling',
  juvenile: 'juvenile',
  adult: 'adult',
};

const stageRank: Record<Duck['stage'], number> = { adult: 0, juvenile: 1, duckling: 2 };

export function ColorSwatch({ color, size = 14 }: { color: Color; size?: number }) {
  return (
    <span
      className="inline-block shrink-0 rounded-full"
      style={{ width: size, height: size, background: COLOR_META[color].swatch, border: '1px solid #1a1410' }}
      title={COLOR_META[color].label}
    />
  );
}

export function FlockPanel({
  engine,
  state,
  onClose,
}: {
  engine: GameEngine;
  state: GameState;
  onClose: () => void;
}) {
  void engine;
  const ducks = [...state.ducks].sort(
    (a, b) =>
      stageRank[a.stage] - stageRank[b.stage] ||
      phenotype(b.genotype).localeCompare(phenotype(a.genotype)) ||
      b.vigor - a.vigor,
  );
  const cap = coopCapacity(state);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-xl bg-[#2a2018] p-5 ring-2 ring-[#3a2e22]">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-black text-[#ffe9a8]">Flock</h2>
          <div className="flex items-center gap-3">
            <span className="rounded bg-[#1f1812] px-2 py-1 text-xs font-bold text-[#c9b88f]">
              {state.ducks.length}/{cap} housed
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

        {/* Dex — colors collected so far */}
        <div className="mb-3 flex items-center gap-2 rounded-md bg-[#1f1812] px-3 py-2">
          <span className="text-[10px] font-bold uppercase tracking-wider text-[#7a6a4a]">Dex</span>
          {COLORS.map((c) => {
            const have = state.dexSeen.includes(c);
            return (
              <span
                key={c}
                className={`flex items-center gap-1 text-[11px] ${have ? 'text-[#f5ecd8]' : 'text-[#5a4d3a] opacity-50'}`}
              >
                <ColorSwatch color={c} size={12} />
                {COLOR_META[c].label}
              </span>
            );
          })}
        </div>

        {state.ducks.length === 0 ? (
          <div className="py-6 text-center text-sm text-[#9a8a6a]">
            No ducks yet — build a Coop to house your starting flock.
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            {ducks.map((d) => {
              const color = phenotype(d.genotype);
              return (
                <div key={d.id} className="flex items-center gap-2 rounded-md bg-[#1f1812] px-2.5 py-1.5 text-[11px]">
                  <ColorSwatch color={color} />
                  <span className="w-12 font-bold" style={{ color: COLOR_META[color].swatch === '#33333c' ? '#9aa0a8' : COLOR_META[color].swatch }}>
                    {COLOR_META[color].label}
                  </span>
                  <span className="w-10 text-[#c9b88f]">{d.sex}</span>
                  <span className="w-16 text-[#9a8a6a]">{STAGE_LABEL[d.stage]}</span>
                  <span className="ml-auto tabular-nums text-[#ffe9a8]">×{d.vigor.toFixed(2)}</span>
                  <span className="text-[9px] text-[#5a4d3a]">vigor</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
