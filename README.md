# Duck Homestead — Phase 1

A single-player, browser-based automation incremental. Place stations on a
bounded grid to produce a feed → eggs chain; tend them actively to rank up.

**Design law:** Idle is the floor, active play is the engine. Offline produces
resources at a reduced rate and grants **no rank XP** — XP comes only from
tending stations while you're present.

## Run

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # typecheck + production build
npm test         # run the Vitest suite (game-logic sim tests, node env)
```

Tests live in `tests/` and exercise the pure simulation (actions, rank, the
nutrition grid, save/offline) headlessly — see `vitest.config.ts`.

## Loop

1. Place a **Feed Plot** (makes corn), **Feed Mill** (corn → pellets), and
   **Coop** (pellets → eggs). Eggs are the currency for placing/upgrading.
2. Output sits in each station's buffer until **hauled** into central storage
   (the chain consumes from central). Before the milestone you haul by hand
   with **Collect**.
3. **Tend** a station for an instant burst + rank XP, on a per-station cooldown.
   Tending is the only path to ranking up.
4. At **Rank 5** the **Auto-Haul Cart** unlocks — output flows to storage
   automatically and a cart visibly loops the homestead.
5. Leave and come back: offline catch-up runs at 0.4× (capped 8h) and shows a
   "While you were away" summary — resources only, never XP.

## Architecture

- `src/config/balance.ts` — **single source of feel**: every tunable number,
  commented. Nothing balance-related is hardcoded elsewhere.
- `src/game/` — serializable `GameState` + decoupled fixed-timestep sim:
  - `state.ts` — `GameState` + `initialState()`
  - `tick.ts` — fixed-timestep simulation; online vs offline rates
  - `actions.ts` — place / upgrade / tend / collect / gainXP / rankUp
  - `rank.ts` — XP curve + milestones
  - `save.ts` — localStorage serialize/deserialize + offline catch-up
  - `engine.ts` — owns the loop (accumulator + rAF), autosave, events
  - `useGame.ts` — React binding
- `src/render/GameCanvas.tsx` — PixiJS grid + station sprites, draws **from**
  `GameState` (no game state lives in the canvas).
- `src/ui/` — HUD, BuildBar, StationPanel, DING banner, away modal, and the
  hand-drawn pixel icon set (`icons.tsx`). No emojis — every glyph is drawn.

Art: stations and ducks are hand-drawn pixel sprites (`public/assets/farm/`,
baked from `.asset-src/farm.cjs`); ground tiles are Kenney "Tiny Town" (CC0).
The renderer loads them through `src/render/assets.ts` and falls back to flat
placeholders if any asset is missing.

Simulation is decoupled from rendering: an accumulator advances the sim in
fixed ~10Hz steps; `requestAnimationFrame` paces rendering. The canvas and UI
render from the single `GameState`.
