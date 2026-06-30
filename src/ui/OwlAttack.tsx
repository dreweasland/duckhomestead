import { useEffect, useState, type CSSProperties } from 'react';
import { playScare } from '../audio/sfx';
import type { GameEngine } from '../game/engine';
import { activeStrike } from '../game/predators';
import type { GameState } from '../game/state';
import { SwoopOwlIcon } from './icons';

/**
 * The interactive owl — the active "be present" save made real. While a strike is
 * in flight (an open window has committed a dive at a duck), the owl visibly
 * SWOOPS down the board toward the flock and the player clicks it to scare it off.
 *
 * It's a 1–3 click skill check: the owl dives at one of several spots, and a
 * non-final click is a FEINT — it jukes to a DIFFERENT spot and re-dives. Only the
 * final required click foils the strike. Let any dive's wind-up expire un-foiled
 * and it resolves against the built floor + passive presence.
 *
 * Rendered inside the board's relative container so the dive plays out over the
 * actual ducks. Everything reads from GameState (activeStrike) — the spot + wind-up
 * drive the position and the inline animation-duration, and the owl is keyed by
 * (strike id, clicks landed) so each fresh dive/feint restarts the swoop.
 */

/** Candidate dive spots as board-relative percentages (must be ≥ STRIKE_DIVE_SPOTS
 *  long; the sim picks an index, the UI reads the coordinates). Spread across the
 *  lower-middle board where the flock roams. */
const DIVE_SPOTS = [
  { left: 32, top: 56 },
  { left: 68, top: 56 },
  { left: 50, top: 67 },
  { left: 26, top: 44 },
  { left: 74, top: 46 },
];

interface Puff {
  id: number;
  kind: 'foiled' | 'feint';
  left: number;
  top: number;
}

export function OwlAttack({ engine, state }: { engine: GameEngine; state: GameState }) {
  // A brief click-feedback puff that outlives the dive it reacts to (the strike
  // moves/clears the instant we click, so the puff is tracked locally).
  const [puff, setPuff] = useState<Puff | null>(null);
  useEffect(() => {
    if (puff == null) return;
    const t = window.setTimeout(() => setPuff(null), 650);
    return () => window.clearTimeout(t);
  }, [puff?.id]);

  const strike = activeStrike(state);

  const onScare = () => {
    if (!strike) return;
    const spot = DIVE_SPOTS[strike.strike.spot % DIVE_SPOTS.length];
    const res = engine.scare('owl');
    if (!res) return;
    if (res.kind === 'foiled') playScare(); // feint's re-dive screech plays via onPredator
    setPuff({ id: Date.now(), kind: res.kind, left: spot.left, top: spot.top });
  };

  if (!strike && puff == null) return null;

  const s = strike?.strike;
  const spot = s ? DIVE_SPOTS[s.spot % DIVE_SPOTS.length] : null;
  const windup = s?.windupTotal ?? 0;
  const multi = s ? s.clicksLanded > 0 : false; // reveal pips only once it's juked

  return (
    <div className="pointer-events-none absolute inset-0 z-30 overflow-hidden rounded-lg">
      {s && spot && (
        <>
          {/* Unmissable "attack NOW" cue: a pulsing red edge-glow over the board. */}
          <div className="danger-vignette absolute inset-0 rounded-lg" />

          {/* Targeting reticle on the threatened ground (where THIS dive lands). */}
          <div
            key={`reticle-${s.id}-${s.clicksLanded}`}
            className="reticle-spin absolute h-16 w-16"
            style={{ left: `${spot.left}%`, top: `${spot.top}%` }}
            aria-hidden
          >
            <svg viewBox="0 0 32 32" className="h-full w-full" shapeRendering="crispEdges">
              <circle cx="16" cy="16" r="13" fill="none" stroke="#e26d6d" strokeWidth="2" strokeDasharray="4 3" />
              <circle cx="16" cy="16" r="6" fill="none" stroke="#ffd9d9" strokeWidth="1.5" />
              <rect x="15" y="1" width="2" height="6" fill="#e26d6d" />
              <rect x="15" y="25" width="2" height="6" fill="#e26d6d" />
              <rect x="1" y="15" width="6" height="2" fill="#e26d6d" />
              <rect x="25" y="15" width="6" height="2" fill="#e26d6d" />
            </svg>
          </div>

          {/* The diving owl — the click target. Its swoop + fuse run for exactly the
              wind-up, ending on the reticle. Keyed by (id, clicks) so a feint
              restarts the dive at the new spot. */}
          <button
            key={`owl-${s.id}-${s.clicksLanded}`}
            type="button"
            onClick={onScare}
            aria-label="Scare off the owl"
            className="owl-swoop pointer-events-auto absolute flex flex-col items-center"
            style={
              {
                left: `${spot.left}%`,
                animationDuration: `${windup}s`,
                '--spot-top': `${spot.top}%`,
              } as CSSProperties
            }
          >
            <span className="owl-flap inline-block">
              <SwoopOwlIcon size={84} />
            </span>
            <span className="mt-1 whitespace-nowrap rounded bg-[#5a1f1f] px-2 py-0.5 text-[10px] font-black uppercase tracking-wider text-[#ffd9d9] shadow ring-1 ring-[#e26d6d]">
              {multi ? 'Again!' : 'Tap to scare!'}
            </span>
            {/* Fuse: depletes over the wind-up so the urgency is legible. */}
            <span className="mt-1 h-1 w-16 overflow-hidden rounded-full bg-[#3a1c1c]">
              <span
                className="owl-fuse block h-full bg-[#e26d6d]"
                style={{ animationDuration: `${windup}s` }}
              />
            </span>
            {/* Progress pips — shown once it's juked at least once, so a plain
                single-tap strike never reveals one. */}
            {multi && (
              <span className="mt-1 flex gap-1">
                {Array.from({ length: s.clicksRequired }).map((_, i) => (
                  <span
                    key={i}
                    className={`h-1.5 w-1.5 rounded-full ${
                      i < s.clicksLanded ? 'bg-[#bfe8a8]' : 'bg-[#e26d6d]'
                    }`}
                  />
                ))}
              </span>
            )}
          </button>
        </>
      )}

      {/* Click-feedback beat: green "Scared off!" on a foil, amber "Dodged!" when
          the owl juked away (feint). */}
      {puff != null && (
        <span
          key={puff.id}
          className={`scare-puff absolute whitespace-nowrap text-sm font-black uppercase tracking-wider drop-shadow ${
            puff.kind === 'foiled' ? 'text-[#bfe8a8]' : 'text-[#ffd9a8]'
          }`}
          style={{ left: `${puff.left}%`, top: `${puff.top}%` }}
        >
          {puff.kind === 'foiled' ? 'Scared off!' : 'Dodged!'}
        </span>
      )}
    </div>
  );
}
