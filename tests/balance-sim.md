# balance-sim — the headless balance harness

`tests/balance-sim.test.ts` imports the live sim core (`tick`, `nutrition`,
`predators`, `genetics`, `winter`) with **no UI** and answers the balance
questions that hand-playtesting can't: does the genome collapse into
"maximize L", and how fast does breeding climb. Everything reads `BALANCE`
at call time, so it tracks `src/config/balance.ts` — re-run it after every
tuning change.

## Run it

```sh
npm run sim:balance          # the full report (~2–6 min)
npm test                     # the fast invariants only (run in CI on every change)
```

Knobs (env vars):

| var | default | meaning |
|---|---|---|
| `SIM_HOURS` | 12 | simulated hours per online regime cell |
| `SIM_DAYS` | 4 | days per `nightly` cell (each = 4 h attentive online + 8 h offline) |
| `SIM_SEEDS` | 2 | RNG seeds averaged per cell |
| `SIM_SEED` | 1234 | base seed (reproducibility) |

## What it reports

- **A. Strategy × regime net output** — 30-hen flocks of fixed genomes
  (`LLLLLL` … `DDDDDD`) across `safe / guarded / exposed / negligent /
  nightly` regimes. Columns: net eggs (repair costs come out of the same
  pool), % vs pure-L, wounds, deaths, surviving hens. **The
  genome-collapse question is answered by whether any regime's winner
  isn't `LLLLLL`.**
- **B. Winterstead** — premium winter lay per genome mix + the analytic
  L/H-split sweep (`layMult × hardinessMult`). The 6d thesis check.
- **C. Breeding progression** — generations (and est. wall-clock at the
  current clutch/incubate/mature timers) from a seed flock to the tier-0
  quality gate (4.5) and to a truebred, `sweat` (gene-reader + odds
  calculator) vs `casual` (phenotype bands only), swept over
  `DOMINANCE ∈ {2,3,4}` × `MUTATION_CHANCE ∈ {0.01..0.08}`, for the T0
  (`LLLLLL`) and T4 (`LHLHLH`, positional) targets. `(n✗)` = runs that
  never got there. The sweep mutates `BALANCE.GENOME` in-process and
  restores it (vitest isolates the process).
- **D. Marginal per-gene value** — the analytic eggs/hour value of one L /
  V / H gene at current numbers, and the structural note that per-hen H
  value scales with 1/flock-size (predator attacks per window are O(1)).

## Modeling notes / caveats

- Lab states push stations/ducks **directly into GameState** (bypassing
  placement costs & zone rules) — the harness measures the economy, not
  the build UX. Nutrition is pre-stocked and mill capacity is ample, so
  the nutrition puzzle (genome-independent) never confounds the genome
  comparison.
- Player care is an explicit policy: *attentive* admits wounded ducks
  every 30 s and repairs defenses every 10 min; *negligent* never
  intervenes. H's value depends on exactly this, so both are measured.
- Offline nights replicate `save.ts` catch-up faithfully: 1 s steps,
  `offline` mode, fresh 25 % mercy budget per night, infirmary auto-admit.
- The always-on invariants (no `SIM` env) guard the design thesis in CI:
  L out-lays everything at home; `LLLHHH`/`LLHHHH` out-earn `LLLLLL` at
  Winterstead; the predator harness runs clean.
