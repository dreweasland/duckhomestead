/**
 * Tiny synthesized sound system — no audio files. Each effect is a short
 * WebAudio envelope so the game ships with zero assets. Sounds are soft and
 * optional: a persisted mute flag silences everything, and the AudioContext is
 * created lazily on the first sound (after a user gesture) to satisfy autoplay
 * policies.
 */

const MUTE_KEY = 'duck-homestead-muted';

let ctx: AudioContext | null = null;
let muted = readMuted();

function readMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    return false;
  }
}

export function isMuted(): boolean {
  return muted;
}

export function setMuted(v: boolean): void {
  muted = v;
  try {
    localStorage.setItem(MUTE_KEY, v ? '1' : '0');
  } catch {
    /* ignore */
  }
}

function audio(): AudioContext | null {
  if (muted) return null;
  try {
    if (!ctx) {
      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      ctx = new Ctx();
    }
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

/** One enveloped oscillator note. */
function note(
  c: AudioContext,
  freq: number,
  start: number,
  dur: number,
  type: OscillatorType,
  peak: number,
) {
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, start);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(peak, start + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  osc.connect(gain).connect(c.destination);
  osc.start(start);
  osc.stop(start + dur + 0.02);
}

/** A short bright blip — tending a station. */
export function playTend() {
  const c = audio();
  if (!c) return;
  const t = c.currentTime;
  note(c, 523, t, 0.1, 'triangle', 0.18);
  note(c, 784, t + 0.05, 0.12, 'triangle', 0.16);
}

/** A soft low thunk — placing a station. */
export function playPlace() {
  const c = audio();
  if (!c) return;
  const t = c.currentTime;
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = 'square';
  osc.frequency.setValueAtTime(220, t);
  osc.frequency.exponentialRampToValueAtTime(110, t + 0.12);
  gain.gain.setValueAtTime(0.18, t);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
  osc.connect(gain).connect(c.destination);
  osc.start(t);
  osc.stop(t + 0.16);
}

/** A quick rising sparkle — collecting / hauling. */
export function playCollect() {
  const c = audio();
  if (!c) return;
  const t = c.currentTime;
  [659, 880, 1046].forEach((f, i) => note(c, f, t + i * 0.045, 0.1, 'sine', 0.13));
}

/** A short descending tone — removing a station. */
export function playRemove() {
  const c = audio();
  if (!c) return;
  const t = c.currentTime;
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(330, t);
  osc.frequency.exponentialRampToValueAtTime(98, t + 0.18);
  gain.gain.setValueAtTime(0.16, t);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
  osc.connect(gain).connect(c.destination);
  osc.start(t);
  osc.stop(t + 0.22);
}

/** A bright ascending pair — upgrading. */
export function playUpgrade() {
  const c = audio();
  if (!c) return;
  const t = c.currentTime;
  note(c, 587, t, 0.12, 'triangle', 0.17);
  note(c, 880, t + 0.08, 0.16, 'triangle', 0.17);
}

/** The level-up chime; a fuller fanfare for milestone level-ups. */
export function playDing(milestone: boolean) {
  const c = audio();
  if (!c) return;
  const t = c.currentTime;
  const notes = milestone ? [523.25, 659.25, 783.99, 1046.5] : [659.25, 987.77];
  notes.forEach((f, i) => note(c, f, t + i * 0.09, 0.34, 'triangle', 0.25));
}
