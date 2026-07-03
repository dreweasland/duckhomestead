import type { GuideDef } from '../config/guides';

/**
 * THE ALMANAC's one card: a bottom-center, non-modal note (no backdrop, no
 * full-screen blocking) — the homestead stays visible and playable behind it.
 * Styling matches the pre-Phase-7 welcome/defenses-down cards (warm/bordered,
 * pixel icon), just relocated off the center-screen modal spot.
 */
export function AlmanacCard({
  def,
  onDismiss,
  onCta,
}: {
  def: GuideDef;
  onDismiss: () => void;
  onCta?: () => void;
}) {
  const Icon = def.icon;
  const danger = def.tone === 'danger';
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[55] flex justify-center px-4">
      <div
        className={`pointer-events-auto w-full max-w-sm rounded-xl p-4 text-center shadow-xl ring-2 ${
          danger ? 'bg-[#2a1818] ring-[#5a2a2a]' : 'bg-[#2a2018] ring-[#3a2e22]'
        }`}
      >
        <div
          className={`mb-1.5 inline-flex items-center justify-center gap-2 text-base font-black ${
            danger ? 'text-[#ffd9d9]' : 'text-[#ffe9a8]'
          }`}
        >
          <Icon size={20} /> {def.title}
        </div>
        <p className={`mb-3 text-xs leading-relaxed ${danger ? 'text-[#c9a0a0]' : 'text-[#c9b88f]'}`}>
          {def.body}
        </p>
        <div className="flex justify-center gap-2">
          {def.cta && onCta && (
            <button
              onClick={onCta}
              className="rounded-md bg-[#2e3a26] px-3 py-2 text-sm font-bold text-[#bfe8a8] transition hover:bg-[#36422c]"
            >
              {def.cta.label}
            </button>
          )}
          <button
            onClick={onDismiss}
            className={`rounded-md px-4 py-2 text-sm font-bold transition ${
              danger
                ? 'bg-[#6e1414] text-[#ffe2e2] hover:bg-[#7e1c1c]'
                : 'bg-[#6b4f9e] text-[#fff4d6] hover:bg-[#7a5cae]'
            }`}
          >
            {def.dismissLabel ?? 'Got it'}
          </button>
        </div>
      </div>
    </div>
  );
}
