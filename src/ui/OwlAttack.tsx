import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { playScare } from '../audio/sfx';
import type { GameEngine } from '../game/engine';
import { activeStrike } from '../game/predators';
import type { GameState } from '../game/state';
import { RaccoonIcon, SwoopOwlIcon } from './icons';

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
  kind: 'foiled' | 'feint' | 'wound' | 'repelled' | 'shrugged';
  left: number;
  top: number;
  /** Which art flees on a foil (the raccoon scurries; the owl climbs). */
  raccoon: boolean;
}

/** Burst styling per outcome — the foil is the HEADLINE beat (big text + the
 *  predator visibly fleeing); the rest are readable mid-size bursts. */
const PUFF_META: Record<Puff['kind'], { text: string; className: string }> = {
  foiled: { text: 'Scared off!', className: 'text-xl text-[#bfe8a8]' },
  feint: { text: 'Dodged!', className: 'text-sm text-[#ffd9a8]' },
  wound: { text: 'Wounded!', className: 'text-base text-[#ff9a9a]' },
  repelled: { text: 'Defenses held!', className: 'text-base text-[#8fc8e8]' },
  shrugged: { text: 'Shrugged it off!', className: 'text-base text-[#9fd4e8]' },
};

export function OwlAttack({ engine, state }: { engine: GameEngine; state: GameState }) {
  // A brief click-feedback puff that outlives the dive it reacts to (the strike
  // moves/clears the instant we click, so the puff is tracked locally).
  const [puff, setPuff] = useState<Puff | null>(null);
  useEffect(() => {
    if (puff == null) return;
    const t = window.setTimeout(() => setPuff(null), puff.kind === 'feint' ? 650 : 950);
    return () => window.clearTimeout(t);
  }, [puff?.id]);

  const strike = activeStrike(state);

  // Remember where the current dive is aimed — a strike clears from state the
  // instant it RESOLVES, so outcome events (wound/repelled/shrugged) arrive
  // after the spot is gone. The ref holds the last live position.
  const lastSpotRef = useRef<{ left: number; top: number; raccoon: boolean } | null>(null);
  if (strike) {
    const sp = DIVE_SPOTS[strike.strike.spot % DIVE_SPOTS.length];
    lastSpotRef.current = { left: sp.left, top: sp.top, raccoon: strike.predatorId === 'raccoon' };
  }

  // Un-clicked resolutions get their beat too: a landed hit, the floor holding,
  // or a Hardy shrug — each bursts at the dive spot the moment it resolves.
  useEffect(
    () =>
      engine.onPredator((e) => {
        if (e.kind !== 'wound' && e.kind !== 'repelled' && e.kind !== 'shrugged') return;
        const at = lastSpotRef.current;
        if (!at) return;
        setPuff({ id: Date.now(), kind: e.kind, left: at.left, top: at.top, raccoon: at.raccoon });
      }),
    [engine],
  );

  const onScare = () => {
    if (!strike) return;
    const spot = DIVE_SPOTS[strike.strike.spot % DIVE_SPOTS.length];
    const res = engine.scare(strike.predatorId); // scare THIS predator (owl or raccoon)
    if (!res) return;
    if (res.kind === 'foiled') playScare(); // feint's re-dive screech plays via onPredator
    setPuff({
      id: Date.now(),
      kind: res.kind,
      left: spot.left,
      top: spot.top,
      raccoon: strike.predatorId === 'raccoon',
    });
  };

  if (!strike && puff == null) return null;

  const s = strike?.strike;
  const spot = s ? DIVE_SPOTS[s.spot % DIVE_SPOTS.length] : null;
  const windup = s?.windupTotal ?? 0;
  const multi = s ? s.clicksLanded > 0 : false; // reveal pips only once it's juked
  // ACTIVE play: the passive floor is suppressed, so the scare is mandatory.
  const active = state.activeRemaining > 0;
  // The raccoon scurries up from the ground; the owl dives from above — different art.
  const isRaccoon = strike?.predatorId === 'raccoon';

  return (
    // While a dive is LIVE the overlay becomes a full-screen click SHIELD:
    // everything except the attacker is unclickable (playtest: fast dives +
    // near-miss clicks kept opening panels/build tools mid-scare). Stray
    // clicks are swallowed — they don't count as scares; the owl stays the
    // target, the crosshair cursor says "hunt mode". Once the dive resolves
    // (puff only), clicks pass through again.
    <div
      className={`fixed inset-0 z-[70] overflow-hidden ${
        s && spot ? 'pointer-events-auto cursor-crosshair' : 'pointer-events-none'
      }`}
    >
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
            key={`pred-${s.id}-${s.clicksLanded}`}
            type="button"
            onClick={onScare}
            aria-label={`Scare off the ${isRaccoon ? 'raccoon' : 'owl'}`}
            className={`${isRaccoon ? 'raccoon-scurry' : 'owl-swoop'} pointer-events-auto absolute flex flex-col items-center`}
            style={
              {
                left: `${spot.left}%`,
                animationDuration: `${windup}s`,
                '--spot-top': `${spot.top}%`,
              } as CSSProperties
            }
          >
            <span className={`${isRaccoon ? 'raccoon-waddle' : 'owl-flap'} inline-block`}>
              {isRaccoon ? <RaccoonIcon size={76} /> : <SwoopOwlIcon size={84} />}
            </span>
            <span
              className={`mt-1 whitespace-nowrap rounded px-2 py-0.5 text-[10px] font-black uppercase tracking-wider shadow ring-1 ${
                active
                  ? 'bg-[#6e1414] text-[#ffe2e2] ring-[#ff8a8a]'
                  : 'bg-[#5a1f1f] text-[#ffd9d9] ring-[#e26d6d]'
              }`}
            >
              {multi ? 'Again!' : active ? 'Scare or injury!' : 'Tap to scare!'}
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

      {/* Outcome beats: every resolution speaks. The foil is the headline —
          big burst + the predator visibly fleeing; wound / defenses-held /
          shrugged burst at the dive spot in their own colors. */}
      {puff != null && (
        <>
          {puff.kind === 'foiled' && (
            <span
              key={`flee-${puff.id}`}
              className={`${puff.raccoon ? 'raccoon-flee' : 'predator-flee'} absolute`}
              style={{ left: `${puff.left}%`, top: `${puff.top}%` }}
              aria-hidden
            >
              {puff.raccoon ? <RaccoonIcon size={76} /> : <SwoopOwlIcon size={84} />}
            </span>
          )}
          <span
            key={puff.id}
            className={`outcome-burst absolute whitespace-nowrap font-black uppercase tracking-wider drop-shadow ${PUFF_META[puff.kind].className}`}
            style={{ left: `${puff.left}%`, top: `${puff.top}%` }}
          >
            {PUFF_META[puff.kind].text}
          </span>
        </>
      )}
    </div>
  );
}
