/**
 * Hand-drawn pixel-art icon set. No emojis anywhere — each icon is a tiny
 * pixel grid rendered as crisp SVG rects so it matches the game's pixel vibe.
 *
 * Multi-color icons carry a fixed palette. Monochrome action icons use the
 * char `x` -> `currentColor` so they inherit the surrounding text color.
 */

interface PixProps {
  size?: number;
  className?: string;
  title?: string;
}

function Pix({
  rows,
  palette,
  size = 16,
  className,
  title,
}: PixProps & { rows: string[]; palette: Record<string, string> }) {
  const h = rows.length;
  const w = rows[0]?.length ?? 0;
  const cells: React.ReactNode[] = [];
  rows.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      const c = palette[ch];
      if (c) cells.push(<rect key={`${x},${y}`} x={x} y={y} width={1} height={1} fill={c} />);
    });
  });
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${w} ${h}`}
      shapeRendering="crispEdges"
      className={className}
      role="img"
      aria-label={title}
    >
      {title ? <title>{title}</title> : null}
      {cells}
    </svg>
  );
}

// ── Resources ───────────────────────────────────────────────────────
export const CornIcon = (p: PixProps) => (
  <Pix
    {...p}
    palette={{ g: '#5a8f3a', y: '#e2b94f', o: '#c79530' }}
    rows={[
      '..g..',
      '.gyg.',
      'gyoyg',
      'gyoyg',
      'gyoyg',
      '.gyg.',
      '..y..',
    ]}
  />
);

export const PelletIcon = (p: PixProps) => (
  <Pix
    {...p}
    palette={{ b: '#b87333', d: '#8a531f' }}
    rows={['.bb.', 'bbbb', 'bdbb', '.bb.']}
  />
);

export const EggIcon = (p: PixProps) => (
  <Pix
    {...p}
    palette={{ w: '#f5ecd8', s: '#d3c4a0' }}
    rows={[
      '..ww..',
      '.wwww.',
      'wwwwsw',
      'wwwwsw',
      'wwwssw',
      '.wsss.',
    ]}
  />
);

// ── Mascot / chrome ─────────────────────────────────────────────────
export const DuckIcon = (p: PixProps) => (
  <Pix
    {...p}
    palette={{ y: '#e2b94f', o: '#d95f5f', k: '#2a2018', w: '#fff4d6' }}
    rows={[
      '...yyy..',
      '..yyyyk.',
      '.yyyyyy.',
      'oyyyyyy.',
      'oyyyyyy.',
      '.yyyyyy.',
      '.ww..ww.',
    ]}
  />
);

export const CartIcon = (p: PixProps) => (
  <Pix
    {...p}
    palette={{ p: '#8a6fc0', l: '#cdbcff', k: '#2a2018' }}
    rows={[
      '.lllll.',
      'ppppppp',
      'ppppppp',
      'ppppppp',
      '.k..k..',
    ]}
  />
);

// ── Monochrome action icons (inherit currentColor) ──────────────────
export const HandIcon = (p: PixProps) => (
  <Pix
    {...p}
    palette={{ x: 'currentColor' }}
    rows={[
      'x.x.x.',
      'xxxxxx',
      'xxxxxx',
      'xxxxxx',
      '.xxxx.',
      '.xxxx.',
    ]}
  />
);

export const UpgradeIcon = (p: PixProps) => (
  <Pix
    {...p}
    palette={{ x: 'currentColor' }}
    rows={[
      '..x..',
      '.xxx.',
      'xxxxx',
      '..x..',
      '..x..',
      '..x..',
    ]}
  />
);

export const CollectIcon = (p: PixProps) => (
  <Pix
    {...p}
    palette={{ x: 'currentColor' }}
    rows={[
      '..x..',
      '..x..',
      'xxxxx',
      '.xxx.',
      '..x..',
      'xxxxx',
    ]}
  />
);

export const LockIcon = (p: PixProps) => (
  <Pix
    {...p}
    palette={{ x: 'currentColor' }}
    rows={[
      '.xxx.',
      'x...x',
      'xxxxx',
      'xxxxx',
      'xx.xx',
      'xxxxx',
    ]}
  />
);

export const PeaIcon = (p: PixProps) => (
  <Pix
    {...p}
    palette={{ g: '#7fae54', d: '#5a8f3a', h: '#a6d27a' }}
    rows={['.ggg.', 'ghgdg', 'ggggg', '.ggg.']}
  />
);

/** Tending Whistle / Tend All — a bright sparkle (the tend "burst" beat). */
export const TendIcon = (p: PixProps) => (
  <Pix
    {...p}
    palette={{ g: '#8fe388', h: '#d6ffcf' }}
    rows={['..h..', '..g..', 'hgggh', '..g..', '..h..']}
  />
);

export const ForageIcon = (p: PixProps) => (
  <Pix
    {...p}
    palette={{ g: '#7fae54', d: '#5a8f3a', h: '#a6d27a' }}
    rows={['h..g.', 'hg.gd', 'hgdgd', 'gdgdg', '.ddd.']}
  />
);

export const MealwormIcon = (p: PixProps) => (
  <Pix
    {...p}
    palette={{ w: '#d9a07a', d: '#b87a55' }}
    rows={['.wdwd.', 'wdwdww', '.wdwd.']}
  />
);

export const YeastIcon = (p: PixProps) => (
  <Pix
    {...p}
    palette={{ c: '#e8d9a0', h: '#fff4d6', d: '#c9b884' }}
    rows={['.cc.', 'chcc', 'cdcc', '.cc.']}
  />
);

export const ShellIcon = (p: PixProps) => (
  <Pix
    {...p}
    palette={{ s: '#c9cdd2', d: '#9aa0a8', h: '#eef0f2' }}
    rows={['.shs.', 'sssss', 'sdsds', '.ddd.']}
  />
);

export const CloseIcon = (p: PixProps) => (
  <Pix
    {...p}
    palette={{ x: 'currentColor' }}
    rows={['x...x', 'xx.xx', '.xxx.', 'xx.xx', 'x...x']}
  />
);

export const SpeakerIcon = (p: PixProps) => (
  <Pix
    {...p}
    palette={{ x: 'currentColor' }}
    rows={[
      '...x..x',
      '..xx.x.',
      'xxxx..x',
      'xxxx.x.',
      'xxxx..x',
      '..xx.x.',
      '...x..x',
    ]}
  />
);

export const MuteIcon = (p: PixProps) => (
  <Pix
    {...p}
    palette={{ x: 'currentColor' }}
    rows={[
      '...x...',
      '..xx.x.',
      'xxxx.x.',
      'xxxxx..',
      'xxxx.x.',
      '..xx.x.',
      '...x...',
    ]}
  />
);

// ── Phase 4c: predators / defenses ──────────────────────────────────
/** The owl — predator threat. A round face, two big yellow eyes, a beak. */
export const OwlIcon = (p: PixProps) => (
  <Pix
    {...p}
    palette={{ b: '#6b5a44', d: '#4a3d2c', y: '#ffd24a', k: '#1a1410', o: '#d98a3a' }}
    rows={[
      'b.....b',
      'bb...bb',
      'byybyyb',
      'bykbkyb',
      'bbbobbb',
      '.bbobb.',
      '.b.k.b.',
    ]}
  />
);

/** Protection floor / deterrent netting — a woven mesh. */
export const NetIcon = (p: PixProps) => (
  <Pix
    {...p}
    palette={{ x: 'currentColor' }}
    rows={[
      'x.x.x.x',
      '.x.x.x.',
      'x.x.x.x',
      '.x.x.x.',
      'x.x.x.x',
      '.x.x.x.',
    ]}
  />
);

/** Secured housing — a shield (excluded from targeting). */
export const ShieldIcon = (p: PixProps) => (
  <Pix
    {...p}
    palette={{ x: 'currentColor', h: '#8fe388' }}
    rows={[
      '.xxxxx.',
      'xxxxxxx',
      'xx.h.xx',
      'xxh.hxx',
      '.xhhhx.',
      '..xxx..',
      '...x...',
    ]}
  />
);

/** Treat / heal a wound — a medical cross. */
export const HealIcon = (p: PixProps) => (
  <Pix
    {...p}
    palette={{ r: '#e26d6d', h: '#f4a3a3' }}
    rows={[
      '..hh..',
      '..rr..',
      'hrrrrh',
      'hrrrrh',
      '..rr..',
      '..rr..',
    ]}
  />
);

/** A wounded duck — a small bandage/heart-break tick used on flock rows. */
export const WoundIcon = (p: PixProps) => (
  <Pix
    {...p}
    palette={{ r: '#e26d6d', d: '#a84a4a' }}
    rows={['rr.rr', 'rrdrr', 'rrrrr', '.rrr.', '..r..']}
  />
);

// ── Panel glyphs (side-panel buttons) ───────────────────────────────
/** Nutrition — a feed sprout (the ration / grid). */
export const NutritionIcon = (p: PixProps) => (
  <Pix
    {...p}
    palette={{ g: '#7fae54', h: '#a6d27a', d: '#5a8f3a' }}
    rows={[
      '..h..',
      '.hgh.',
      'hgggh',
      '.dgd.',
      '..d..',
    ]}
  />
);

/** Modules — a faceted gem (loot upgrades). */
export const ModuleIcon = (p: PixProps) => (
  <Pix
    {...p}
    palette={{ p: '#8a6fc0', l: '#cdbcff', d: '#6b4f9e' }}
    rows={[
      '.lll.',
      'lpppl',
      'lpppl',
      'dpppd',
      '.dpd.',
      '..d..',
    ]}
  />
);

/** Map a resource key to its icon for inline use. */
export const RESOURCE_ICON = {
  corn: CornIcon,
  peas: PeaIcon,
  mealworms: MealwormIcon,
  brewersYeast: YeastIcon,
  oysterShell: ShellIcon,
  forage: ForageIcon,
  pellets: PelletIcon,
  eggs: EggIcon,
} as const;
