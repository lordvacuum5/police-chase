// Sound, synthesised at runtime.
//
// There are no audio files in this project, so everything is built from
// oscillators and a single buffer of white noise. That keeps the download at
// zero and lets the engine note track rpm exactly rather than crossfading
// between samples.
//
// Layers:
//   engine   three oscillators locked to firing frequency, through a lowpass
//            whose cutoff opens with throttle -- so load is audible, not just speed
//   intake   filtered noise that swells with revs
//   tyres    narrow band noise driven by the worst wheel's slip
//   wind     broad noise driven by road speed
//   siren    a wailing two-tone that fades in with the nearest pursuing unit
//   impacts  one-shot filtered noise bursts
//   radio    dispatch traffic: squelch, a band-limited voice, and the crash
//            of the key coming up

import { clamp, clamp01, lerp } from '../util/math.js';

// =====================================================================
//  Police radio
// =====================================================================

/**
 * What a transmission is band-limited to.
 *
 * A police radio is recognisable long before you have parsed a word of it,
 * and almost all of that is the channel rather than the voice: 300 Hz to
 * 3 kHz, squashed flat by the compressor at the transmitter, with the click
 * of the PTT closing at one end and the squelch crash at the other. Get those
 * right and a synthesised mumble reads as radio traffic; get them wrong and a
 * perfect voice recording still does not.
 */
const RADIO_LO = 330, RADIO_HI = 2850;

/**
 * Formant pairs for a handful of vowels, in Hz.
 *
 * The "words" are nonsense -- a buzz through two resonances, moved from one
 * vowel to the next once per syllable. That is enough for the ear to hear
 * speech, and it means the radio never says anything that contradicts the
 * message printed on the HUD.
 */
const VOWELS = [
  [730, 1090],   // ah
  [530, 1840],   // eh
  [270, 2290],   // ee
  [570, 840],    // oh
  [440, 1020],   // aw
  [490, 1350],   // er
  [640, 1190],   // uh
];

/**
 * Who is talking. Control is a base station: lower, steadier, cleaner. A unit
 * is on a handheld in a car doing 90, so it is higher, faster and dirtier.
 * The helicopter has the rotor sitting under everything it says.
 */
const VOICES = {
  control: { pitch: 104, rate: 5.6, formant: 1.00, noise: 0.10, drive: 2.2, rumble: 0 },
  unit:    { pitch: 128, rate: 6.6, formant: 1.09, noise: 0.20, drive: 3.4, rumble: 0 },
  air:     { pitch: 118, rate: 6.1, formant: 1.05, noise: 0.26, drive: 3.8, rumble: 0.35 },
};

/** Cheap deterministic PRNG, so a given message always sounds the same. */
function seededRng(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h ^= h << 13; h >>>= 0;
    h ^= h >> 17;
    h ^= h << 5; h >>>= 0;
    return h / 4294967296;
  };
}

/** Which of the three voices a line of dispatch is in. */
function voiceFor(text) {
  if (/India 99|Air support/i.test(text)) return 'air';
  if (/^Control\b|^All units\b/i.test(text)) return 'control';
  // "U3 responding, northbound" -- a callsign at the front means a unit.
  if (/^[A-Z]+\d+\b/.test(text)) return 'unit';
  return 'control';
}

/**
 * Firing frequency of a 4-stroke V8: rpm/60 * cylinders/2. The three
 * oscillators sit at f, 2f and 3f -- putting real energy in the harmonics
 * matters because a 50 Hz fundamental is inaudible on laptop speakers.
 */
const ENGINE_ORDER = 4;

/** The recorded engine loop, and what it is doing. */
const ENGINE_SAMPLE = '/resources/sounds/freesound_community-engine-61234.mp3';

/**
 * The recording is a steady idle: 31 s with a rock-solid 50 Hz fundamental and
 * no rev sweep in it at all, so it cannot be sliced into per-rev bands -- it
 * has to be pitch shifted. 50 Hz of firing frequency on a V8 is 750 rpm.
 */
const SAMPLE_RPM = 750;

/**
 * Pitch is compressed rather than proportional. Idle to redline is an 8:1
 * ratio, and a single sample stretched that far is a mosquito at the top end.
 * At 0.62 the sample still rises monotonically through about two octaves,
 * while the synthesised sub underneath tracks the *true* firing frequency --
 * and the ear takes its pitch cue from the bass, so the engine still reads as
 * revving all the way to the limiter.
 */
const PITCH_EXP = 0.62;

/** The stable stretch of the recording to loop, in seconds. */
const LOOP_FROM = 2.0, LOOP_TO = 15.0, LOOP_FADE = 0.2;

/**
 * Fold a region of a recording into a seamless mono loop by crossfading the
 * material just past the loop end back over its beginning. Looping a raw
 * region clicks at the seam every pass, which at idle is several times a second.
 */
function makeSeamlessLoop(ctx, raw, fromSec, toSec, fadeSec) {
  const sr = raw.sampleRate;
  const from = Math.floor(fromSec * sr);
  const fade = Math.floor(fadeSec * sr);
  const len = Math.min(Math.floor((toSec - fromSec) * sr), raw.length - from - fade) - fade;
  if (len <= fade * 2) return null;

  const chans = raw.numberOfChannels;
  const src = new Float32Array(len + fade);
  for (let c = 0; c < chans; c++) {
    const data = raw.getChannelData(c);
    for (let i = 0; i < len + fade; i++) src[i] += data[from + i] / chans;
  }

  const out = ctx.createBuffer(1, len, sr);
  const o = out.getChannelData(0);
  o.set(src.subarray(0, len));
  for (let i = 0; i < fade; i++) {
    const t = i / fade;
    o[i] = o[i] * t + src[len + i] * (1 - t);
  }
  return out;
}

/**
 * Soft clipping curve for the waveshaper. tanh rather than a hard clip: it
 * rounds into saturation the way a real exhaust does, instead of adding the
 * fizzy high harmonics a hard knee would.
 */
function softClipCurve(amount = 3) {
  const n = 1024;
  const curve = new Float32Array(n);
  const norm = Math.tanh(amount);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * amount) / norm;
  }
  return curve;
}

export class GameAudio {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.muted = false;
    this.failed = false;
    this.sirenPhase = 0;
    this.masterVolume = 0.75;
  }

  /**
   * Browsers refuse to start audio without a user gesture, so this is called
   * from the first key press or click rather than at load.
   */
  resume() {
    if (this.failed) return;
    if (!this.ctx) {
      try { this._build(); } catch (e) { this.failed = true; return; }
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  _build() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { this.failed = true; return; }
    const ctx = new AC();
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = this.masterVolume;

    // A gentle limiter on the way out. The engine at full chat, a siren
    // alongside and a collision thud all land at once often enough that
    // without one the mix clips into crackle exactly when it matters most.
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -8;
    this.limiter.knee.value = 6;
    this.limiter.ratio.value = 8;
    this.limiter.attack.value = 0.004;
    this.limiter.release.value = 0.18;
    this.master.connect(this.limiter);
    this.limiter.connect(ctx.destination);

    // ---- shared noise source -------------------------------------------
    const len = Math.floor(ctx.sampleRate * 2);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noiseBuffer = buf;

    const makeNoise = () => {
      const n = ctx.createBufferSource();
      n.buffer = buf;
      n.loop = true;
      n.start();
      return n;
    };

    // ---- engine ----------------------------------------------------------
    //
    // Three plain oscillators through a lowpass sound like a synth drone. A
    // real exhaust is a train of pressure pulses pushed through a resonant
    // pipe, so this is built the same way:
    //
    //   * a custom PeriodicWave whose harmonic series is shaped like an
    //     exhaust pulse rather than a sawtooth,
    //   * a half-order sub for the weight big V8s get from their uneven
    //     firing across the two banks,
    //   * two banks a few cents apart, which beat against each other and give
    //     the note its lump instead of a dead steady tone,
    //   * a waveshaper path crossfaded in with throttle, because an engine
    //     under load is not just louder, it is dirtier,
    //   * a resonant peak tracking the firing frequency, standing in for the
    //     pipe itself.

    const N = 28;
    const real = new Float32Array(N);
    const imag = new Float32Array(N);
    for (let h = 1; h < N; h++) {
      // Gentle rolloff with the odd harmonics favoured -- a hollower, more
      // pipe-like spectrum than a saw, and much deeper on small speakers.
      const odd = h % 2 === 1 ? 1.3 : 0.72;
      imag[h] = odd / Math.pow(h, 1.18);
    }
    const engineWave = ctx.createPeriodicWave(real, imag);

    this.engineMix = ctx.createGain();
    this.engineMix.gain.value = 1;

    const mkOsc = (gain, detune, wave, dest) => {
      const o = ctx.createOscillator();
      if (wave) o.setPeriodicWave(wave); else o.type = 'sine';
      o.detune.value = detune || 0;
      const g = ctx.createGain();
      g.gain.value = gain;
      o.connect(g); g.connect(dest || this.engineMix);
      o.start();
      return o;
    };
    // The sub always plays: it tracks the true firing frequency across the
    // whole rev range, which is what keeps the pitch reading correctly once
    // the sampled layer's pitch has been compressed. Its level is faded in
    // with revs -- it exists to put back the bottom end that pitching the
    // recording up takes away, and at idle it is below what a laptop speaker
    // can reproduce anyway, so down there it only eats headroom.
    this.subGain = ctx.createGain();
    this.subGain.gain.value = 0.3;
    this.subGain.connect(this.engineMix);
    this.oscSub = mkOsc(0.9, 0, null, this.subGain);

    // The rest are the synthesised stand-in, used until the recording has
    // loaded and as the fallback if it cannot be fetched at all.
    this.synthGain = ctx.createGain();
    this.synthGain.gain.value = 1;
    this.synthGain.connect(this.engineMix);
    this.oscA = mkOsc(0.55, 0, engineWave, this.synthGain);
    this.oscB = mkOsc(0.42, 9, engineWave, this.synthGain);
    this.oscHarm = mkOsc(0.20, -6, engineWave, this.synthGain);

    // Sampled layer, faded in when the file arrives.
    this.sampleGain = ctx.createGain();
    this.sampleGain.gain.value = 0;
    this.sampleGain.connect(this.engineMix);
    this.sampleSource = null;

    // Clean path: the note as heard off the throttle.
    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.frequency.value = 700;
    this.engineFilter.Q.value = 1.2;
    this.cleanGain = ctx.createGain();
    this.cleanGain.gain.value = 0.9;
    this.engineMix.connect(this.engineFilter);
    this.engineFilter.connect(this.cleanGain);

    // Driven path: soft-clipped and band-limited, faded in with throttle.
    this.preGain = ctx.createGain();
    this.preGain.gain.value = 0.5;
    this.shaper = ctx.createWaveShaper();
    this.shaper.curve = softClipCurve(3.2);
    this.shaper.oversample = '2x';
    this.driveFilter = ctx.createBiquadFilter();
    this.driveFilter.type = 'bandpass';
    this.driveFilter.frequency.value = 500;
    this.driveFilter.Q.value = 1.1;
    this.driveGain = ctx.createGain();
    this.driveGain.gain.value = 0;
    this.engineMix.connect(this.preGain);
    this.preGain.connect(this.shaper);
    this.shaper.connect(this.driveFilter);
    this.driveFilter.connect(this.driveGain);

    // Exhaust resonance, then the master engine level.
    this.enginePeak = ctx.createBiquadFilter();
    this.enginePeak.type = 'peaking';
    this.enginePeak.frequency.value = 200;
    this.enginePeak.Q.value = 3;
    this.enginePeak.gain.value = 6;

    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    this.cleanGain.connect(this.enginePeak);
    this.driveGain.connect(this.enginePeak);
    this.enginePeak.connect(this.engineGain);
    this.engineGain.connect(this.master);

    // Idle burble: a slow wobble on the level that dies away as the revs rise.
    this.lfo = ctx.createOscillator();
    this.lfo.type = 'sine';
    this.lfo.frequency.value = 6;
    this.lfoDepth = ctx.createGain();
    this.lfoDepth.gain.value = 0;
    this.lfo.connect(this.lfoDepth);
    this.lfoDepth.connect(this.engineGain.gain);
    this.lfo.start();

    // ---- intake roar -----------------------------------------------------
    this.intakeFilter = ctx.createBiquadFilter();
    this.intakeFilter.type = 'bandpass';
    this.intakeFilter.frequency.value = 500;
    this.intakeFilter.Q.value = 1.4;
    this.intakeGain = ctx.createGain();
    this.intakeGain.gain.value = 0;
    makeNoise().connect(this.intakeFilter);
    this.intakeFilter.connect(this.intakeGain);
    this.intakeGain.connect(this.master);

    // ---- tyre squeal -----------------------------------------------------
    this.tyreFilter = ctx.createBiquadFilter();
    this.tyreFilter.type = 'bandpass';
    this.tyreFilter.frequency.value = 1150;
    this.tyreFilter.Q.value = 7;
    this.tyreGain = ctx.createGain();
    this.tyreGain.gain.value = 0;
    makeNoise().connect(this.tyreFilter);
    this.tyreFilter.connect(this.tyreGain);
    this.tyreGain.connect(this.master);

    // ---- tyre scrub ------------------------------------------------------
    // Its own voice, because scrubbing and sliding are different sounds and
    // happen at different times. The squeal above only starts once a wheel is
    // properly sliding; a tyre complains long before that, as soon as it is
    // being asked to carry a slip angle through a corner. Lower and broader
    // than the squeal -- a growl rather than a shriek -- so the two layer
    // rather than competing.
    this.scrubFilter = ctx.createBiquadFilter();
    this.scrubFilter.type = 'bandpass';
    this.scrubFilter.frequency.value = 620;
    this.scrubFilter.Q.value = 3.2;
    this.scrubGain = ctx.createGain();
    this.scrubGain.gain.value = 0;
    makeNoise().connect(this.scrubFilter);
    this.scrubFilter.connect(this.scrubGain);
    this.scrubGain.connect(this.master);

    // ---- wind ------------------------------------------------------------
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'lowpass';
    this.windFilter.frequency.value = 700;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    makeNoise().connect(this.windFilter);
    this.windFilter.connect(this.windGain);
    this.windGain.connect(this.master);

    // ---- siren -----------------------------------------------------------
    this.sirenOsc = ctx.createOscillator();
    this.sirenOsc.type = 'square';
    this.sirenOsc.frequency.value = 700;
    this.sirenShape = ctx.createBiquadFilter();
    this.sirenShape.type = 'lowpass';
    this.sirenShape.frequency.value = 1800;
    this.sirenGain = ctx.createGain();
    this.sirenGain.gain.value = 0;
    this.sirenOsc.connect(this.sirenShape);
    this.sirenShape.connect(this.sirenGain);
    this.sirenGain.connect(this.master);
    this.sirenOsc.start();

    this._buildRadio();

    this.ready = true;
    this._loadEngineSample();
  }

  /**
   * Fetch, decode and loop the engine recording, then crossfade it in over the
   * synthesised layer. Deliberately fire-and-forget: if the file is missing or
   * the decode fails, the synth carries on and the game is none the wiser.
   */
  async _loadEngineSample() {
    const ctx = this.ctx;
    try {
      const res = await fetch(ENGINE_SAMPLE);
      if (!res.ok) throw new Error('http ' + res.status);
      const raw = await ctx.decodeAudioData(await res.arrayBuffer());
      const loop = makeSeamlessLoop(ctx, raw, LOOP_FROM, LOOP_TO, LOOP_FADE);
      if (!loop) throw new Error('loop region too short');

      const src = ctx.createBufferSource();
      src.buffer = loop;
      src.loop = true;
      src.connect(this.sampleGain);
      src.start();

      this.sampleSource = src;
      this.sampleReady = true;

      // Hand the mid and top of the note over to the recording; the sub keeps
      // the true firing frequency underneath it.
      const t = ctx.currentTime;
      this.sampleGain.gain.setTargetAtTime(1.45, t, 0.25);
      this.synthGain.gain.setTargetAtTime(0.14, t, 0.25);
    } catch (e) {
      this.sampleReady = false;
    }
  }

  // ------------------------------------------------------------- radio

  /**
   * The radio channel.
   *
   * Everything the radio says goes through one bus, because the bus *is* the
   * sound: band-limited hard at both ends, a presence peak where speech
   * intelligibility lives, and a waveshaper standing in for the compressor at
   * the transmitter that squashes every syllable to the same level.
   *
   * Split out from _build so tests/radio.js can raise the same chain inside an
   * OfflineAudioContext and look at what actually comes out of it.
   */
  _buildRadio() {
    const ctx = this.ctx;
    this.radioIn = ctx.createGain();
    // Two highpass stages, not one. A single 12 dB/octave slope at 330 Hz
    // still lets a third of the energy through underneath it -- the voice
    // fundamental is around 110 Hz and its low harmonics sail past -- and
    // that bass is exactly what stops it sounding like a radio. Cascading
    // two takes it to 24 dB/octave, and the difference is the whole effect.
    const hp1 = ctx.createBiquadFilter();
    hp1.type = 'highpass'; hp1.frequency.value = RADIO_LO; hp1.Q.value = 0.7;
    const hp2 = ctx.createBiquadFilter();
    hp2.type = 'highpass'; hp2.frequency.value = RADIO_LO; hp2.Q.value = 0.7;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = RADIO_HI; lp.Q.value = 0.9;
    const pk = ctx.createBiquadFilter();
    pk.type = 'peaking'; pk.frequency.value = 1700; pk.Q.value = 1.1; pk.gain.value = 7;
    const sh = ctx.createWaveShaper();
    sh.curve = softClipCurve(4.5);
    sh.oversample = '2x';
    this.radioGain = ctx.createGain();
    this.radioGain.gain.value = 0.70;
    this.radioIn.connect(hp1); hp1.connect(hp2); hp2.connect(lp); lp.connect(pk);
    pk.connect(sh); sh.connect(this.radioGain);
    this.radioGain.connect(this.master);

    this.radioQueue = [];
    this.radioFreeAt = 0;      // ctx time the channel is clear again
    this.lastAlertAt = -1e9;
  }

  /**
   * Queue a dispatch transmission.
   *
   * Called from Game.radio, so every line that reaches the HUD is also heard.
   * The channel is one at a time -- two units never talk over each other on a
   * real net, and it is the queueing that makes it sound like a net rather
   * than a soundboard.
   */
  radio(text, hot = false) {
    if (!this.ready || this.muted || this.failed) return;
    // Bracketed lines are the game talking to the player about settings, not
    // anybody talking on the radio.
    if (!text || text.startsWith('[')) return;
    // A long pursuit generates more traffic than there is airtime. Keep the
    // newest, since stale calls are the ones worth dropping.
    if (this.radioQueue.length > 3) this.radioQueue.splice(0, this.radioQueue.length - 3);
    this.radioQueue.push({ text, hot });
  }

  /** Start the next transmission if the channel is clear. Called per frame. */
  _pumpRadio() {
    if (!this.radioQueue.length) return;
    const now = this.ctx.currentTime;
    if (now < this.radioFreeAt) return;
    this._transmit(this.radioQueue.shift());
  }

  /**
   * One transmission, scheduled in full at the moment it starts.
   *
   * Nothing here runs per frame: the whole thing -- click, syllables, squelch
   * tail -- is written into the AudioParam timeline up front and then left
   * alone, which is both cheaper and immune to a dropped frame stuttering
   * somebody's sentence.
   */
  _transmit(msg) {
    const ctx = this.ctx;
    const kind = voiceFor(msg.text);
    const v = VOICES[kind];
    const rnd = seededRng(msg.text);
    let t = Math.max(ctx.currentTime + 0.03, this.radioFreeAt + 0.12);

    // A priority call from Control gets the attention tone first -- but only
    // now and then, or it stops meaning anything.
    if (msg.hot && kind === 'control' && t - this.lastAlertAt > 24) {
      this.lastAlertAt = t;
      t = this._alertTone(t) + 0.14;
    }

    // ---- the key closing -------------------------------------------------
    this._squelch(t, 0.05, 0.55, 2400);
    t += 0.10;

    // ---- the voice -------------------------------------------------------
    // Long enough to track the length of the line on the HUD, short enough to
    // sound like dispatch rather than a conversation. Real radio traffic is
    // terse; a six-second mumble is neither.
    const syl = clamp(Math.round(msg.text.length / 3.6), 3, 17);
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';

    const f1 = ctx.createBiquadFilter();
    f1.type = 'bandpass'; f1.Q.value = 5.5;
    const f2 = ctx.createBiquadFilter();
    f2.type = 'bandpass'; f2.Q.value = 8;
    const g1 = ctx.createGain(); g1.gain.value = 1.0;
    const g2 = ctx.createGain(); g2.gain.value = 0.55;

    // Consonants: a little band-passed hiss riding the same envelope.
    const hiss = ctx.createBufferSource();
    hiss.buffer = this.noiseBuffer; hiss.loop = true;
    const hf = ctx.createBiquadFilter();
    hf.type = 'bandpass'; hf.frequency.value = 2100; hf.Q.value = 1.2;
    const hg = ctx.createGain(); hg.gain.value = v.noise;

    const env = ctx.createGain();
    env.gain.value = 0.0001;

    osc.connect(f1); f1.connect(g1); g1.connect(env);
    osc.connect(f2); f2.connect(g2); g2.connect(env);
    hiss.connect(hf); hf.connect(hg); hg.connect(env);
    env.connect(this.radioIn);

    const start = t;
    for (let i = 0; i < syl; i++) {
      const u = i / syl;
      const len = (1 / v.rate) * (0.72 + rnd() * 0.62);
      // A statement falls away at the end; a stressed syllable lifts.
      const stress = rnd() < 0.28 ? 1.13 : 1.0;
      const fall = 1 - 0.20 * u;
      osc.frequency.setValueAtTime(v.pitch * fall * stress * (0.95 + rnd() * 0.12), t);

      const vow = VOWELS[(rnd() * VOWELS.length) | 0];
      f1.frequency.setValueAtTime(vow[0] * v.formant, t);
      f2.frequency.setValueAtTime(vow[1] * v.formant, t);

      // `drive` is how hard this voice hits the shaper on the bus, which is
      // what makes a handheld in a moving car sound more squashed than the
      // base station does.
      const amp = 0.075 * v.drive * (0.75 + rnd() * 0.45);
      env.gain.setValueAtTime(0.0001, t);
      env.gain.exponentialRampToValueAtTime(amp, t + Math.min(0.022, len * 0.25));
      env.gain.exponentialRampToValueAtTime(amp * 0.5, t + len * 0.6);
      env.gain.exponentialRampToValueAtTime(0.0001, t + len * 0.94);
      t += len;

      // The odd gap, where somebody draws breath or hunts for a word.
      if (rnd() < 0.09) t += 0.07 + rnd() * 0.10;
    }

    osc.start(start);
    osc.stop(t + 0.05);
    hiss.start(start);
    hiss.stop(t + 0.05);

    // Rotor noise under the whole thing, for the aircraft.
    if (v.rumble > 0) {
      const r = ctx.createBufferSource();
      r.buffer = this.noiseBuffer; r.loop = true;
      const rf = ctx.createBiquadFilter();
      rf.type = 'bandpass'; rf.frequency.value = 700; rf.Q.value = 0.8;
      const rg = ctx.createGain();
      rg.gain.setValueAtTime(0.0001, start);
      rg.gain.exponentialRampToValueAtTime(0.05 * v.rumble, start + 0.05);
      rg.gain.setValueAtTime(0.05 * v.rumble, t - 0.05);
      rg.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
      r.connect(rf); rf.connect(rg); rg.connect(this.radioIn);
      r.start(start); r.stop(t + 0.1);
    }

    // ---- the key coming up -----------------------------------------------
    // Louder and longer than the click that opened it: the receiver's squelch
    // has a moment of open carrier before it shuts, and that crash of noise is
    // the single most recognisable thing about the whole sound.
    t += 0.03;
    this._squelch(t, 0.12, 1.7, 3200);
    this.radioFreeAt = t + 0.24;
  }

  /** A burst of band-passed noise: the PTT closing, or the squelch tail. */
  _squelch(at, dur, level, from) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 0.7;
    f.frequency.setValueAtTime(from, at);
    f.frequency.exponentialRampToValueAtTime(900, at + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(0.12 * level, at + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    src.connect(f); f.connect(g); g.connect(this.radioIn);
    src.start(at);
    src.stop(at + dur + 0.05);
  }

  /** Two-tone attention signal, ahead of a priority call from Control. */
  _alertTone(at) {
    const ctx = this.ctx;
    let t = at;
    for (const hz of [1060, 790]) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = hz;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.085, t + 0.012);
      g.gain.setValueAtTime(0.085, t + 0.20);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
      o.connect(g); g.connect(this.radioIn);
      o.start(t); o.stop(t + 0.3);
      t += 0.24;
    }
    return t;
  }

  toggleMute() {
    this.muted = !this.muted;
    // Drop anything still queued, or unmuting fires off a backlog of calls
    // about a pursuit that finished a minute ago.
    if (this.muted && this.radioQueue) this.radioQueue.length = 0;
    if (this.master) {
      this.master.gain.setTargetAtTime(this.muted ? 0 : this.masterVolume, this.ctx.currentTime, 0.05);
    }
    return this.muted;
  }

  /** A short thud whose weight scales with the impact. */
  impact(strength) {
    if (!this.ready || this.muted || this.ctx.state !== 'running') return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const s = clamp01(strength);

    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;

    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(1400 + s * 1800, now);
    f.frequency.exponentialRampToValueAtTime(140, now + 0.25);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.10 + s * 0.32, now + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.28 + s * 0.2);

    src.connect(f); f.connect(g); g.connect(this.master);
    src.start(now);
    src.stop(now + 0.55 + s * 0.2);
  }

  /**
   * Called once per rendered frame. Everything is a smoothed parameter set,
   * so this is cheap -- no nodes are created here.
   */
  update(dt, player, dispatcher, heat) {
    if (!this.ready || this.muted) return;
    const ctx = this.ctx;
    if (ctx.state !== 'running') return;
    const t = ctx.currentTime;
    const smooth = 0.045;

    this._pumpRadio();

    // ---- engine ----------------------------------------------------------
    const rpm = player.rpm;
    const revs = clamp01(rpm / player.spec.engine.redline);
    const load = player.controls.throttle;
    const f0 = clamp((rpm / 60) * ENGINE_ORDER, 20, 700);

    // Every oscillator is locked to the firing frequency, so the whole note
    // moves as one rather than sliding apart.
    this.oscSub.frequency.setTargetAtTime(f0 * 0.5, t, smooth);
    this.oscA.frequency.setTargetAtTime(f0, t, smooth);
    this.oscB.frequency.setTargetAtTime(f0, t, smooth);
    this.oscHarm.frequency.setTargetAtTime(f0 * 2, t, smooth);

    // The recording is an idle loop, so revving it means playing it faster.
    // The exponent compresses an 8:1 rev range into about two octaves, which
    // keeps the top end from turning into a mosquito.
    if (this.sampleSource) {
      const rate = clamp(Math.pow(rpm / SAMPLE_RPM, PITCH_EXP), 0.55, 4.4);
      this.sampleSource.playbackRate.setTargetAtTime(rate, t, smooth);
    }
    // Bring the sub in as the sample climbs and thins out.
    this.subGain.gain.setTargetAtTime(0.22 + revs * 0.95, t, smooth);

    // Opening the filter with throttle is what makes the engine sound like it
    // is working rather than just spinning faster.
    this.engineFilter.frequency.setTargetAtTime(
      260 + load * 1900 + revs * 2400, t, smooth,
    );
    this.engineFilter.Q.setTargetAtTime(1.1 + load * 1.6, t, smooth);

    // Crossfade clean to driven with throttle. Off the throttle the note is
    // rounded and quiet; on it, the waveshaper adds the rasp.
    this.preGain.gain.setTargetAtTime(0.5 + load * 3.0, t, smooth);
    this.cleanGain.gain.setTargetAtTime(0.9 - load * 0.42, t, smooth);
    this.driveGain.gain.setTargetAtTime(0.10 + load * 0.72, t, smooth);
    this.driveFilter.frequency.setTargetAtTime(clamp(f0 * 4.5, 180, 3400), t, smooth);

    // The exhaust resonance rides with the note rather than sitting still.
    this.enginePeak.frequency.setTargetAtTime(clamp(f0 * 3, 90, 2600), t, smooth);
    this.enginePeak.gain.setTargetAtTime(5 + load * 6, t, smooth);

    // Burble at idle, gone by the time it is pulling.
    this.lfo.frequency.setTargetAtTime(5.5 + revs * 7, t, 0.2);
    this.lfoDepth.gain.setTargetAtTime((1 - clamp01(revs * 2.2)) * 0.020, t, 0.2);

    // Duck the note briefly while the clutch is out mid-shift.
    const shifting = player.shiftTimer > 0 ? 0.35 : 1;
    const engVol = (0.085 + load * 0.130 + revs * 0.080) * shifting;
    this.engineGain.gain.setTargetAtTime(engVol, t, smooth);

    this.intakeFilter.frequency.setTargetAtTime(300 + revs * 1500, t, smooth);
    this.intakeGain.gain.setTargetAtTime(load * revs * 0.05, t, smooth);

    // ---- tyres -----------------------------------------------------------
    const rolling = player.grounded > 0 && player.speed > 4;
    const sliding = rolling ? clamp01((player.maxSlip - 0.45) / 0.45) : 0;
    this.tyreFilter.frequency.setTargetAtTime(950 + sliding * 500, t, 0.08);
    this.tyreGain.gain.setTargetAtTime(sliding * 0.075, t, 0.06);

    // Scrub: the worst lateral slip angle any grounded wheel is carrying.
    // Starts around three degrees, which is where a tyre begins to protest,
    // and is well up before anything is sliding. Scaled by speed too -- the
    // same slip angle at walking pace makes almost no noise.
    let worstAngle = 0;
    if (rolling) {
      for (const w of player.wheels) {
        if (!w.grounded) continue;
        const a = Math.abs(w.slipAngle);
        if (a > worstAngle) worstAngle = a;
      }
    }
    const scrub = clamp01((worstAngle - 0.040) / 0.155)
      * clamp01((player.speed - 4) / 9);
    this.scrubFilter.frequency.setTargetAtTime(560 + scrub * 260, t, 0.09);
    this.scrubGain.gain.setTargetAtTime(scrub * 0.055, t, 0.07);

    // ---- wind ------------------------------------------------------------
    this.windGain.gain.setTargetAtTime(clamp01(player.speed / 75) * 0.045, t, 0.12);
    this.windFilter.frequency.setTargetAtTime(400 + player.speed * 14, t, 0.12);

    // ---- siren -----------------------------------------------------------
    let nearest = Infinity;
    if (heat.tier > 0 && dispatcher) {
      for (const u of dispatcher.units) {
        if (u.vehicle.disabled || u.vehicle.unmarked) continue;
        const d = u.distanceTo(player.position);
        if (d < nearest) nearest = d;
      }
    }
    if (nearest < 170) {
      this.sirenPhase += dt;
      // A wail: a slow sweep rather than a two-tone honk.
      const sweep = 0.5 - 0.5 * Math.cos((this.sirenPhase / 1.5) * Math.PI * 2);
      this.sirenOsc.frequency.setTargetAtTime(620 + sweep * 480, t, 0.03);
      const prox = 1 - clamp01(nearest / 170);
      this.sirenGain.gain.setTargetAtTime(prox * prox * 0.055, t, 0.12);
    } else {
      this.sirenGain.gain.setTargetAtTime(0, t, 0.25);
    }
  }
}
