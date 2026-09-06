/**
 * Sound — every cue the game makes, synthesized from oscillators and filtered noise.
 *
 * No asset files: a sample sheet would be a second thing to keep in step with the art,
 * and twenty cues of the kind a 90s cabinet made fit in a table of recipes shorter than
 * the manifest that would load them. One `AudioContext`, one master gain, one shared
 * second of white noise; every cue is a handful of nodes scheduled at `currentTime` and
 * garbage-collected when they stop.
 *
 * `play()` is called from render edges — the shot loop, the boss diff, the seat diff — at
 * up to twenty seats on one notification, so it has to be cheap and it must never throw.
 * Before the first gesture there is no context (browsers refuse to start one without it)
 * and a cue is DROPPED, not queued: a queue would replay the whole muster as a burst the
 * moment the player first clicks. A name may not fire twice inside `DEDUPE_MS`: twenty
 * arrows loosed on one tick are one twang, not a chord of twenty — which also makes two
 * owners accidentally cueing the same event harmless.
 *
 * Mute is remembered in `localStorage`; a browser that refuses storage still mutes for
 * the session.
 */

export type SfxName =
  | 'loose'
  | 'looseCharged'
  | 'looseSuper'
  | 'chargeStart'
  | 'chargeReady'
  | 'superReady'
  | 'fury'
  | 'hitPart'
  | 'coreHit'
  | 'partBreak'
  | 'ventOpen'
  | 'volley'
  | 'slamWarn'
  | 'slam'
  | 'hurt'
  | 'fall'
  | 'gate'
  | 'door'
  | 'win'
  | 'lose';

const STORE_KEY = 'heartrot.sfx.muted';
const MASTER = 0.5;
const DEDUPE_MS = 30;
/** `exponentialRampToValueAtTime` refuses zero; this is the silence it ramps to. */
const FLOOR = 0.0001;

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let noiseBuf: AudioBuffer | null = null;

// ---------------------------------------------------------------------------
// The boss's voice — the ONE set of recorded assets in the game
// ---------------------------------------------------------------------------

/**
 * Five lines the player recorded and processed himself (Downloads, Sep 3 2026), served
 * from `public/voice/` as mono 64 kbps mp3 loudness-normalised to -16 LUFS by ffmpeg — mp3
 * because it is the one format every browser's `decodeAudioData` takes, and 170–475 KB of
 * 48 kHz stereo WAV each became 8–20 KB. Named by the clip they came from, not by the
 * moment they play at: the moments are a table in `Boss.tsx` and can be re-dealt without
 * touching an asset.
 *
 * Fetched and decoded on `unlock`, after the first gesture, never at import: the module
 * promise is that nothing here touches the network or the audio device before the player
 * has clicked, and a failed fetch is a line that never plays, not an error anywhere.
 */
export type VoiceName = 'boss-02' | 'boss-04' | 'boss-07' | 'boss-08' | 'boss-new1';
export const VOICE_NAMES: readonly VoiceName[] = ['boss-02', 'boss-04', 'boss-07', 'boss-08', 'boss-new1'];
/** Louder than a cue: a voice is the one sound meant to be listened to rather than felt. */
const VOICE_GAIN = 1.6;
/** One line at a time; a line asked for while one is speaking is dropped, not queued. */
let voiceUntil = 0;
let speaking: AudioBufferSourceNode | null = null;
const voices = new Map<VoiceName, AudioBuffer>();
let muted = readMuted();
const lastAt = new Map<SfxName, number>();

function readMuted(): boolean {
  try {
    return localStorage.getItem(STORE_KEY) === '1';
  } catch {
    return false;
  }
}

export function isMuted(): boolean {
  return muted;
}

export function setMuted(on: boolean): void {
  muted = on;
  if (master !== null) master.gain.value = on ? 0 : MASTER;
  try {
    localStorage.setItem(STORE_KEY, on ? '1' : '0');
  } catch {
    // Storage refused: the choice holds for this session and resets on reload.
  }
}

/** Runs inside the first gesture, which is the only place a browser lets audio start. */
function unlock(): void {
  if (ctx !== null) return;
  try {
    ctx = new AudioContext();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : MASTER;
    master.connect(ctx.destination);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    void ctx.resume();
    preloadVoices(ctx);
  } catch {
    // No audio device or API: `ctx` stays null and every cue is dropped, silently.
    ctx = null;
  }
}

if (typeof window !== 'undefined') {
  // Capture, so `controls.ts`'s own handlers (which preventDefault Space) run after this
  // and cannot swallow the gesture. `once` on each — `unlock` is idempotent, so whichever
  // of the two fires second is a no-op.
  window.addEventListener('pointerdown', unlock, { capture: true, once: true });
  window.addEventListener('keydown', unlock, { capture: true, once: true });
}

/** A 5 ms attack into `vol`, then an exponential decay to silence at `t + dur`. */
function envelope(c: AudioContext, t: number, dur: number, vol: number): GainNode {
  const g = c.createGain();
  g.gain.setValueAtTime(FLOOR, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.005);
  g.gain.exponentialRampToValueAtTime(FLOOR, t + dur);
  return g;
}

/** One oscillator gliding `f0 → f1` over `dur` seconds under an envelope. */
function tone(
  c: AudioContext,
  out: AudioNode,
  t: number,
  type: OscillatorType,
  f0: number,
  f1: number,
  dur: number,
  vol: number,
): void {
  const o = c.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  o.frequency.exponentialRampToValueAtTime(f1, t + dur);
  o.connect(envelope(c, t, dur, vol)).connect(out);
  o.start(t);
  o.stop(t + dur + 0.02);
}

/** The shared noise second through one biquad, under the same envelope. */
function noise(
  c: AudioContext,
  out: AudioNode,
  t: number,
  type: BiquadFilterType,
  freq: number,
  dur: number,
  vol: number,
  q = 1,
): void {
  const s = c.createBufferSource();
  s.buffer = noiseBuf;
  const f = c.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  s.connect(f).connect(envelope(c, t, dur, vol)).connect(out);
  s.start(t);
  s.stop(t + dur + 0.02);
}

/**
 * Wind: the noise second through a filter whose cutoff GLIDES `f0 → f1`, under a gain that
 * swells for `rise` seconds before it tails off. {@link noise} cannot say this — its 5 ms
 * attack is what makes a twang a twang, and a gust that starts at full volume is a slap.
 */
function gust(
  c: AudioContext,
  out: AudioNode,
  t: number,
  type: BiquadFilterType,
  f0: number,
  f1: number,
  dur: number,
  rise: number,
  vol: number,
  q = 1,
): void {
  const s = c.createBufferSource();
  s.buffer = noiseBuf;
  const f = c.createBiquadFilter();
  f.type = type;
  f.Q.value = q;
  f.frequency.setValueAtTime(f0, t);
  f.frequency.exponentialRampToValueAtTime(f1, t + dur);
  const g = c.createGain();
  g.gain.setValueAtTime(FLOOR, t);
  g.gain.exponentialRampToValueAtTime(vol, t + rise);
  g.gain.exponentialRampToValueAtTime(FLOOR, t + dur);
  s.connect(f).connect(g).connect(out);
  s.start(t);
  s.stop(t + dur + 0.02);
}

type Recipe = (c: AudioContext, out: AudioNode, t: number) => void;

/** Loud things are low and long; a twang is a click of noise on a falling pitch. */
const RECIPES: Readonly<Record<SfxName, Recipe>> = {
  loose: (c, o, t) => {
    noise(c, o, t, 'bandpass', 2400, 0.07, 0.35, 2);
    tone(c, o, t, 'triangle', 700, 240, 0.09, 0.25);
  },
  looseCharged: (c, o, t) => {
    noise(c, o, t, 'lowpass', 1400, 0.16, 0.5);
    tone(c, o, t, 'sawtooth', 260, 55, 0.22, 0.35);
  },
  // The beam is wind, not a bigger twang: a bandpass gust sweeping up through the whole
  // audible middle, over a low airy whoosh. No oscillator anywhere — the moment a pitch
  // is in it, it reads as a bowstring again.
  looseSuper: (c, o, t) => {
    gust(c, o, t, 'bandpass', 300, 2400, 0.55, 0.14, 0.7, 1.4);
    gust(c, o, t, 'lowpass', 500, 500, 0.4, 0.08, 0.45);
  },
  chargeStart: (c, o, t) => tone(c, o, t, 'sine', 180, 520, 0.3, 0.18),
  chargeReady: (c, o, t) => {
    tone(c, o, t, 'sine', 880, 880, 0.07, 0.25);
    tone(c, o, t + 0.08, 'sine', 1320, 1320, 0.12, 0.25);
  },
  // Above `chargeReady`, and rising where that one is level, so the two edges of one
  // hold cannot be confused with the eyes shut.
  superReady: (c, o, t) => {
    tone(c, o, t, 'sine', 1320, 1980, 0.09, 0.22);
    tone(c, o, t, 'sine', 1980, 2640, 0.09, 0.14);
  },
  // `slamWarn`'s beating growl, held three times as long, dropping in pitch, over a noise
  // bed: a roar. Played once, on the false → true edge of fury (`Boss.tsx`).
  fury: (c, o, t) => {
    tone(c, o, t, 'sawtooth', 110, 82, 0.9, 0.3);
    tone(c, o, t, 'sawtooth', 116, 88, 0.9, 0.3);
    noise(c, o, t, 'lowpass', 420, 0.9, 0.35);
  },
  hitPart: (c, o, t) => {
    noise(c, o, t, 'bandpass', 1800, 0.05, 0.3, 1.5);
    tone(c, o, t, 'square', 420, 180, 0.06, 0.15);
  },
  coreHit: (c, o, t) => {
    tone(c, o, t, 'sine', 170, 70, 0.2, 0.5);
    noise(c, o, t, 'bandpass', 900, 0.1, 0.3);
  },
  partBreak: (c, o, t) => {
    noise(c, o, t, 'lowpass', 700, 0.4, 0.6);
    tone(c, o, t, 'sawtooth', 320, 45, 0.35, 0.3);
  },
  ventOpen: (c, o, t) => {
    tone(c, o, t, 'sine', 160, 900, 0.7, 0.3);
    noise(c, o, t, 'highpass', 3000, 0.7, 0.15);
  },
  volley: (c, o, t) => {
    noise(c, o, t, 'bandpass', 500, 0.12, 0.4);
    tone(c, o, t, 'triangle', 140, 70, 0.12, 0.3);
  },
  // Two sawtooths 6 Hz apart beat against each other: a growl, not a note.
  slamWarn: (c, o, t) => {
    tone(c, o, t, 'sawtooth', 95, 95, 0.35, 0.2);
    tone(c, o, t, 'sawtooth', 101, 101, 0.35, 0.2);
  },
  slam: (c, o, t) => {
    noise(c, o, t, 'lowpass', 220, 0.55, 0.8);
    tone(c, o, t, 'sine', 70, 28, 0.55, 0.7);
  },
  hurt: (c, o, t) => {
    tone(c, o, t, 'square', 320, 140, 0.13, 0.25);
    noise(c, o, t, 'bandpass', 1200, 0.06, 0.25);
  },
  fall: (c, o, t) => tone(c, o, t, 'sawtooth', 420, 60, 0.55, 0.3),
  gate: (c, o, t) => {
    noise(c, o, t, 'lowpass', 350, 0.6, 0.6);
    tone(c, o, t, 'sine', 90, 45, 0.6, 0.4);
  },
  // A side room's door: a short wooden creak rising, and the latch after it.
  door: (c, o, t) => {
    tone(c, o, t, 'sawtooth', 70, 150, 0.3, 0.1);
    noise(c, o, t + 0.06, 'lowpass', 600, 0.16, 0.22);
  },
  win: (c, o, t) =>
    [523, 659, 784, 1047].forEach((f, i) => tone(c, o, t + i * 0.12, 'triangle', f, f, 0.3, 0.3)),
  lose: (c, o, t) =>
    [392, 330, 262].forEach((f, i) => tone(c, o, t + i * 0.22, 'sawtooth', f, f * 0.94, 0.4, 0.25)),
};

/** Cue one sound. Safe before unlock (dropped), safe muted (dropped), never throws. */
function preloadVoices(c: AudioContext): void {
  for (const name of VOICE_NAMES) {
    void fetch(`/voice/${name}.mp3`)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`${r.status}`))))
      .then((bytes) => c.decodeAudioData(bytes))
      .then((buffer) => voices.set(name, buffer))
      .catch(() => {
        // A missing or undecodable clip is a line that never plays. The fight is unchanged.
      });
  }
}

/**
 * Speak one of the boss's lines. Same master as every cue, so MUTED silences it; its own
 * gain on top, because a voice under the volley's noise floor is a voice nobody hears.
 * Refused while another line is still speaking — two lines over each other is noise —
 * unless `interrupt` is set: the fight's beats (waking, fury, dying) cut a taunt off,
 * because a boss finishing a quip over its own death is worse than a clipped quip.
 */
export function speak(name: VoiceName, interrupt = false): void {
  if (muted || ctx === null || master === null) return;
  const buffer = voices.get(name);
  if (buffer === undefined) return;
  const now = ctx.currentTime;
  if (now < voiceUntil) {
    if (!interrupt) return;
    speaking?.stop();
  }
  voiceUntil = now + buffer.duration;
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const g = ctx.createGain();
  g.gain.value = VOICE_GAIN;
  src.connect(g);
  g.connect(master);
  src.start(now);
  speaking = src;
}

export function play(name: SfxName): void {
  if (muted || ctx === null || master === null) return;
  const now = performance.now();
  if (now - (lastAt.get(name) ?? -Infinity) < DEDUPE_MS) return;
  lastAt.set(name, now);
  RECIPES[name](ctx, master, ctx.currentTime);
}

if (import.meta.env.DEV) {
  // The one promise every caller relies on: a cue before the first gesture is a no-op,
  // not an exception, and it does not start a context on its own.
  play('loose');
  if (ctx !== null) throw new Error('sfx self-check: play() started audio without a gesture');
}
