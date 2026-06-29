import { useEffect, useState } from 'react';
import { playScare } from '../audio/sfx';
import type { GameEngine } from '../game/engine';
import { activeStrike } from '../game/predators';
import type { GameState } from '../game/state';
import { SwoopOwlIcon } from './icons';

/**
 * The interactive owl — the active "be present" save made real. While a strike is
 * in flight (an open window has committed a dive at a duck), the owl visibly
 * SWOOPS down the board toward the flock and the player can click it to scare it
 * off, foiling the strike entirely. Let the dive land and it resolves against the
 * built floor + passive presence only.
 *
 * Rendered inside the board's relative container so the dive plays out over the
 * actual ducks. Everything reads from GameState (activeStrike) — the wind-up's
 * remaining time drives the dive via an inline animation-duration, so the owl
 * lands exactly when the strike would. Keyed by the strike id so each fresh dive
 * restarts the swoop from the top.
 */
export function OwlAttack({ engine, state }: { engine: GameEngine; state: GameState }) {
  // A brief "scared off!" puff that outlives the strike it celebrates (the strike
  // clears the instant we scare, so the puff is tracked locally).
  const [puff, setPuff] = useState<number | null>(null);
  useEffect(() => {
    if (puff == null) return;
    const t = window.setTimeout(() => setPuff(null), 650);
    return () => window.clearTimeout(t);
  }, [puff]);

  const strike = activeStrike(state);

  const onScare = () => {
    if (engine.scare('owl')) {
      playScare();
      setPuff(Date.now());
    }
  };

  if (!strike && puff == null) return null;

  const windup = strike?.strike.windupTotal ?? 0;

  return (
    <div className="pointer-events-none absolute inset-0 z-30 overflow-hidden rounded-lg">
      {strike && (
        <>
          {/* Unmissable "attack NOW" cue: a pulsing red edge-glow over the board. */}
          <div className="danger-vignette absolute inset-0 rounded-lg" />

          {/* Targeting reticle on the threatened ground (where the dive lands). */}
          <div
            className="reticle-spin absolute left-1/2 top-[58%] h-16 w-16"
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
              wind-up, so the moment it reaches the flock is the moment it would
              land. Scare it before then. */}
          <button
            key={strike.strike.id}
            type="button"
            onClick={onScare}
            aria-label="Scare off the owl"
            className="owl-swoop pointer-events-auto absolute left-1/2 top-0 flex flex-col items-center"
            style={{ animationDuration: `${windup}s` }}
          >
            <span className="owl-flap inline-block">
              <SwoopOwlIcon size={84} />
            </span>
            <span className="mt-1 whitespace-nowrap rounded bg-[#5a1f1f] px-2 py-0.5 text-[10px] font-black uppercase tracking-wider text-[#ffd9d9] shadow ring-1 ring-[#e26d6d]">
              Tap to scare!
            </span>
            {/* Fuse: depletes over the wind-up so the urgency is legible. */}
            <span className="mt-1 h-1 w-16 overflow-hidden rounded-full bg-[#3a1c1c]">
              <span
                className="owl-fuse block h-full bg-[#e26d6d]"
                style={{ animationDuration: `${windup}s` }}
              />
            </span>
          </button>
        </>
      )}

      {/* Scared-off reward beat. */}
      {puff != null && (
        <span
          key={puff}
          className="scare-puff absolute left-1/2 top-[55%] whitespace-nowrap text-sm font-black uppercase tracking-wider text-[#bfe8a8] drop-shadow"
        >
          Scared off!
        </span>
      )}
    </div>
  );
}
