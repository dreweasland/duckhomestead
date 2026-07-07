import { useEffect, useRef, useState } from 'react';
import { GameEngine, type DingEvent } from './engine';

export interface UseGame {
  engine: GameEngine;
  /** Bumps on each throttled notify so consuming components re-render. */
  version: number;
}

/**
 * Creates and drives a single GameEngine for the app lifetime. Returns the
 * engine plus a version counter that increments on state changes so React
 * components re-render. DING events are surfaced via onDing.
 */
export function useGame(onDing: (e: DingEvent) => void): UseGame {
  const engineRef = useRef<GameEngine | null>(null);
  if (engineRef.current == null) {
    engineRef.current = new GameEngine(Date.now());
  }
  const engine = engineRef.current;
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const unsub = engine.subscribe(() => setVersion((v) => (v + 1) % 1_000_000));
    const unsubDing = engine.onDing(onDing);
    engine.start(performance.now());

    const onUnload = () => engine.saveNow();
    const onVisibility = () => {
      // Hide: stamp lastSeen so the resume path knows how long we were dark.
      // Show: browsers paused the rAF sim while hidden/occluded — credit the
      // gap through the SAME offline catch-up a page load gets (engine no-ops
      // for blips under VISIBILITY_CATCHUP_MIN_S).
      if (document.visibilityState === 'hidden') engine.saveNow();
      else engine.resumeFromHidden(Date.now());
    };
    window.addEventListener('beforeunload', onUnload);
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      engine.saveNow();
      engine.stop();
      unsub();
      unsubDing();
      window.removeEventListener('beforeunload', onUnload);
      document.removeEventListener('visibilitychange', onVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine]);

  return { engine, version };
}
