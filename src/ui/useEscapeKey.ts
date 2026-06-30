import { useEffect, useRef } from 'react';

/**
 * Dismiss-on-Escape for modal panels. Attaches one window keydown listener for the
 * panel's lifetime (mounted only while the modal is open) and calls the latest
 * `onClose` when Escape is pressed — held in a ref so an inline `onClose` doesn't
 * re-attach the listener every render.
 */
export function useEscapeKey(onClose: () => void): void {
  const ref = useRef(onClose);
  ref.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') ref.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
