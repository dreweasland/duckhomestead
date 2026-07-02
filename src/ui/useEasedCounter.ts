import { useEffect, useRef, useState } from 'react';

/**
 * Eases a displayed number toward `target` (ease-out cubic, ~300ms by
 * default) instead of snapping on every ~15Hz engine notify. Also reports a
 * `flashKey` that bumps when a single update jumps the target by a lot (a
 * contract claim, a siege jackpot) — never on ordinary passive accrual,
 * which only moves the total a little between two consecutive notifies.
 */
export function useEasedCounter(
  target: number,
  opts: { duration?: number; jumpFraction?: number; jumpFloor?: number } = {},
) {
  const { duration = 300, jumpFraction = 0.03, jumpFloor = 40 } = opts;
  const [display, setDisplay] = useState(target);
  const [flashKey, setFlashKey] = useState(0);
  const animRef = useRef({ from: target, to: target, start: 0 });
  const rafRef = useRef(0);
  const prevTarget = useRef(target);
  const displayRef = useRef(target);
  displayRef.current = display;

  useEffect(() => {
    if (target === prevTarget.current) return;
    const delta = target - prevTarget.current;
    if (delta > 0 && delta >= Math.max(jumpFloor, prevTarget.current * jumpFraction)) {
      setFlashKey((n) => n + 1);
    }
    animRef.current = { from: displayRef.current, to: target, start: performance.now() };
    prevTarget.current = target;
    const step = (now: number) => {
      const { from, to, start } = animRef.current;
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(from + (to - from) * eased);
      if (t < 1) rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(rafRef.current);
  }, [target, duration, jumpFraction, jumpFloor]);

  return { display, flashKey };
}
