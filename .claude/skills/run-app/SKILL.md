---
name: run-app
description: Launch Duck Homestead's Vite dev server and drive it with headless Playwright — screenshots, taps through the Pixi board, live-engine assertions. Use when a change needs to be seen working in the real app (desktop or mobile viewport), not just pass tests.
---

# Running Duck Homestead

Vite + React + Pixi web app. No auth, no backend — state lives in
localStorage (`duck-homestead-save-v1`); every fresh browser context is a
fresh homestead (starter plot/mill/coop at grid (2,3)-(4,3), 3 ducks, 70 eggs).

## Dev server

```bash
(npm run dev > /tmp/homestead-dev.log 2>&1 & echo $! > /tmp/homestead-dev.pid)
for i in {1..30}; do curl -sf http://localhost:5173 >/dev/null && break; sleep 1; done
```

Stop with `kill $(cat /tmp/homestead-dev.pid)` or `pkill -f vite`.
Note: macOS zsh here has no `timeout` — poll with the `for` loop above.

## Drive it (Playwright)

`chromium-cli` is NOT installed; `playwright@1.61` IS (in node_modules, with
cached browsers). Import it by absolute path — scripts living outside the
repo (e.g. the scratchpad) can't resolve the bare specifier:

```js
import { chromium } from '/Users/dreweasland/work/homestead/node_modules/playwright/index.mjs';

const browser = await chromium.launch({ args: ['--no-sandbox'] });
// Mobile viewport when checking phone layout; drop these three for desktop.
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true,
});
const page = await ctx.newPage();
await page.goto('http://localhost:5173', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.board-host canvas', { timeout: 20000 });
await page.waitForTimeout(1500); // texture load + first frames
```

## Gotchas (all hit in practice)

- **The Almanac welcome card floats over the board on a fresh game** and
  silently swallows board taps (its "Open Nutrition" button sits right where
  the coop is). Dismiss it first:
  ```js
  const gotIt = page.getByRole('button', { name: /got it/i });
  if (await gotIt.isVisible().catch(() => false)) { await gotIt.tap(); await page.waitForTimeout(300); }
  ```
- **The board is a Pixi canvas — no DOM selectors inside it.** Tap tiles by
  canvas-space math: tile (gx,gy) centers at `(16 + gx*56 + 28, 30 + gy*56 + 28)`
  in a 480-wide native canvas. The canvas may be CSS-downscaled (mobile), so
  always map through the live rect:
  ```js
  const p = await page.evaluate(([cx, cy]) => {
    const c = document.querySelector('.board-host canvas');
    const r = c.getBoundingClientRect();
    return { x: r.left + cx * (r.width / c.width), y: r.top + cy * (r.height / c.height) };
  }, [268, 226]); // coop at (4,3)
  await page.touchscreen.tap(p.x, p.y); // page.mouse.click for desktop contexts
  ```
- **Assert against the live engine, not pixels.** Dev builds expose the
  engine at `window.__engine` (App.tsx) — e.g. a double-tap tend is proven by
  `page.evaluate(() => window.__engine.state.xp)` going up, selection by
  the StationBar's Tend button appearing (`getByRole('button', { name: /tend/i })`).
- **Double-tap = tend**: two taps on the same station < 350ms apart
  (~120ms wait between taps works).
- Check `scrollWidth <= clientWidth` on `document.scrollingElement` when
  layout is in question, and collect `console`/`pageerror` events — the page
  renders its shell even if a system throws.

## One representative loop

Dismiss welcome card → tap coop (StationBar appears) → double-tap plot at
(2,3) (`xp` rises by 20) → tap the Nutrition button (modal opens, fits
viewport) → screenshot → assert zero console errors.
