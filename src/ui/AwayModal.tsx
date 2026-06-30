import { BALANCE } from '../config/balance';
import type { AwaySummary } from '../game/save';
import type { Resource } from '../game/state';
import { fmt, fmtDuration } from './format';
import { DuckIcon, HealIcon, OwlIcon, RESOURCE_ICON } from './icons';

export function AwayModal({ away, onClose }: { away: AwaySummary; onClose: () => void }) {
  const entries = (Object.keys(away.produced) as Resource[]).filter(
    (k) => (away.produced[k] ?? 0) > 0,
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-sm rounded-xl bg-[#2a2018] p-5 ring-2 ring-[#3a2e22]">
        <h2 className="text-lg font-black text-[#ffe9a8]">While you were away</h2>
        <p className="mt-1 text-xs text-[#9a8a6a]">
          Gone {fmtDuration(away.elapsedSeconds)} · idle ran at{' '}
          {Math.round(BALANCE.OFFLINE_RATE_MULT * 100)}% rate
          {away.capped && <> · capped at {BALANCE.OFFLINE_CAP_HOURS}h</>}.
        </p>

        <div className="mt-4 flex flex-col gap-2">
          {entries.length === 0 ? (
            <div className="text-sm text-[#7a6a4a]">The homestead was quiet. Nothing produced.</div>
          ) : (
            entries.map((k) => {
              const Icon = RESOURCE_ICON[k];
              return (
                <div
                  key={k}
                  className="flex items-center justify-between rounded-md bg-[#1f1812] px-3 py-2"
                >
                  <span className="flex items-center gap-2 text-sm capitalize">
                    <Icon size={16} /> {k}
                  </span>
                  <span className="font-bold tabular-nums text-[#8fe388]">
                    +{fmt(away.produced[k] ?? 0)}
                  </span>
                </div>
              );
            })
          )}
        </div>

        {away.predator && (away.predator.wounded > 0 || away.predator.lost > 0) && (
          <div className="mt-3 rounded-md bg-[#2a1818] px-3 py-2 text-xs ring-1 ring-[#5a2a2a]">
            <div className="flex items-center gap-1.5 font-bold text-[#e8a3a3]">
              <OwlIcon size={15} /> The owl came in the night
            </div>
            <div className="mt-1 text-[#c9a0a0]">
              {away.predator.lost > 0 && (
                <span>
                  {away.predator.lost} duck{away.predator.lost > 1 ? 's' : ''} lost
                  {away.predator.wounded > 0 ? ' · ' : '.'}
                </span>
              )}
              {away.predator.wounded > 0 && (
                <span className="inline-flex items-center gap-1">
                  {away.predator.wounded} wounded — <HealIcon size={11} /> treat them before they
                  escalate.
                </span>
              )}
            </div>
            <div className="mt-1 text-[10px] text-[#8a6a6a]">
              Secured breeders stayed safe. Build deterrents and secure prize birds to harden the
              homestead.
            </div>
          </div>
        )}

        {away.overcrowd && (away.overcrowd.injured > 0 || away.overcrowd.lost > 0) && (
          <div className="mt-3 rounded-md bg-[#2a1f14] px-3 py-2 text-xs ring-1 ring-[#5a3a22]">
            <div className="flex items-center gap-1.5 font-bold text-[#e8c45a]">
              <DuckIcon size={15} /> The flock got overcrowded
            </div>
            <div className="mt-1 text-[#d8b87a]">
              {away.overcrowd.lost > 0 && (
                <span>
                  {away.overcrowd.lost} duck{away.overcrowd.lost > 1 ? 's' : ''} lost
                  {away.overcrowd.injured > 0 ? ' · ' : '.'}
                </span>
              )}
              {away.overcrowd.injured > 0 && (
                <span className="inline-flex items-center gap-1">
                  {away.overcrowd.injured} injured — <HealIcon size={11} /> treat them, and cull
                  surplus drakes.
                </span>
              )}
            </div>
            <div className="mt-1 text-[10px] text-[#8a7a5a]">
              Too many drakes harass the flock. Keep ~1 drake per 4 hens (Flock panel) to stop it.
            </div>
          </div>
        )}

        <p className="mt-3 text-[10px] text-[#7a6a4a]">
          Idle produces resources only — no rank XP. Tend stations while you’re here to rank up.
        </p>

        <button
          onClick={onClose}
          className="mt-4 w-full rounded-md bg-[#8fe388] px-3 py-2 text-sm font-bold text-[#143010] hover:bg-[#a4f09c]"
        >
          Back to the homestead
        </button>
      </div>
    </div>
  );
}
