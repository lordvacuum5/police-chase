// Sound.
//
// Mostly built at runtime from oscillators and a buffer of white noise, with
// three recordings where synthesis could not do the job: the engine, and two
// clips of real police radio traffic.
//
// Layers:
//   engine   a recorded engine pitched to rpm, over oscillators locked to the
//            firing frequency, through a filter that opens with throttle
//   intake   filtered noise that swells with revs
//   tyres    scrub and squeal, driven by slip angle and slip
//   wind     broad noise driven by road speed
//   siren    wail and yelp, faded in with the nearest marked unit
//   impacts  one-shot filtered noise bursts
//   radio    dispatch calls actually spoken by the browser's speech engine,
//            between a PTT click and a squelch crash; recorded traffic
//            underneath a pursuit

import { clamp, clamp01, lerp, damp } from '../util/math.js';

// =====================================================================
//  Police radio
// =====================================================================

/**
 * What a transmission is band-limited to.
 *
 * A police radio is recognisable long before you have parsed a word of it,
 * and almost all of that is the channel rather than the voice: 300 Hz to
 * 3 kHz, squashed flat by the compressor at the transmitter, with the click
 * of the PTT closing at one end and the squelch crash at the other. The
 * recorded traffic and the carrier hiss go through this channel. The spoken
 * calls cannot -- see _transmit -- so they get the click and the crash instead.
 */
const RADIO_LO = 330, RADIO_HI = 2850;

/**
 * Who is talking, and how.
 *
 * The voice used to be synthesised here: a buzz through two formant filters,
 * stepped from one vowel to the next once a syllable. It was meant to read as
 * speech without ever saying anything, and it did not read as speech -- the
 * verdict was "a really weird noise, it's not even speech", which is fair.
 * Nonsense syllables are uncanny in exactly the way a real voice is not.
 *
 * So the radio now actually says the line, with the browser's own speech
 * engine. Control is a dispatcher at a desk: steady, a female voice where there
 * is one. A unit is somebody in a car doing ninety: quicker, a male voice. The
 * helicopter gets a third voice where the machine has one, and the rotor under
 * everything it says.
 *
 * Rates are well above the engine default, on purpose. At its own pace a
 * desktop voice took 6.8 s over "Control, reports of a vehicle driving
 * dangerously, all units respond" -- about half the speed of real radio
 * traffic, which is clipped and quick -- and in a busy chase every call behind
 * it went stale waiting. The Windows voices do not scale linearly with rate,
 * either: measured on that line, 1.3 only took it to 6.1 s, 2.1 to 4.9 s.
 * Network voices do scale roughly linearly, so they get a gentler version of
 * the same numbers (see _transmit) rather than being read at double speed.
 */
const SPEAKERS = {
  control: { prefer: 'female', rate: 2.0, pitch: 1.00, rumble: 0 },
  unit:    { prefer: 'male',   rate: 2.3, pitch: 0.97, rumble: 0 },
  air:     { prefer: 'other',  rate: 2.1, pitch: 0.94, rumble: 0.35 },
};

const FEMALE_NAME = /female|zira|hazel|susan|libby|sonia|maisie|aria|jenny|michelle|samantha|karen|moira|tessa|serena|kate|fiona|victoria|allison|ava|emma|natasha|catherine|heera|linda/i;
const MALE_NAME = /\bmale\b|david|mark|george|ryan|guy|daniel|alex|fred|oliver|thomas|arthur|james|christopher|eric|roger|brian|richard|william|sean/i;

/**
 * Choose a voice for each speaker from whatever the machine has.
 *
 * English only, British first -- it is a British police net -- then any other
 * English. Local voices ahead of network ones: a network voice can lag a
 * second behind the line on the HUD, or not arrive at all offline, and a call
 * that turns up late is worse than one in a plainer voice. Returns null when
 * there is no English voice at all, which sends the radio to its fallback.
 */
export function pickVoices(all) {
  const en = (all || []).filter((v) => /^en([-_]|$)/i.test(v.lang));
  if (!en.length) return null;
  const score = (v) => (/^en[-_]GB/i.test(v.lang) ? 4 : 1) + (v.localService ? 2 : 0);
  const sorted = en.slice().sort((a, b) => score(b) - score(a));
  const female = sorted.filter((v) => FEMALE_NAME.test(v.name));
  const male = sorted.filter((v) => !FEMALE_NAME.test(v.name) && MALE_NAME.test(v.name));

  const control = female[0] || sorted[0];
  const unit = male[0] || sorted.find((v) => v !== control) || sorted[0];
  const air = sorted.find((v) => v !== control && v !== unit) || unit;
  return { control, unit, air };
}

/**
 * A HUD line, rewritten the way a person would read it aloud.
 *
 * Speech engines read what they are given: "U3" comes out as "you three",
 * "PIT" gets spelled, a slash is "slash" and an em dash is nothing at all.
 */
export function speakable(text) {
  return String(text)
    .replace(/\s*[—–]\s*/g, ', ')
    .replace(/\s+\/\s+/g, ' and ')
    .replace(/\bU(\d+)\b/g, 'Unit $1')
    .replace(/\bPIT\b/g, 'pit')
    .replace(/\b(\d+)s\b/g, '$1 seconds')
    .replace(/,\s*,/g, ',')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Which of the three speakers a line of dispatch belongs to. */
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

/**
 * Overall engine level, intake roar included. Halved on request: the engine
 * was the loudest thing in the mix and sat on top of the radio.
 */
const ENGINE_VOLUME = 0.5;

/** How far the engine drops while a radio call is being spoken. */
const RADIO_DUCK = 0.55;

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
 * Recorded police net chatter, played underneath a pursuit.
 *
 * The spoken calls say what is on the HUD and nothing else. Recorded traffic
 * is the rest of the net -- other units, other jobs -- so the calls that mean
 * something are spoken, and a recording fills the gaps with the sound of a
 * busy channel. It is also what the radio falls back to on a machine with no
 * speech engine.
 *
 * Every path here is optional and tried in order. Drop a clip into
 * `resources/sounds/` under one of these names and it is picked up on the next
 * load; with none of them present nothing happens at all and the radio behaves
 * exactly as it did before. Same fire-and-forget contract as the engine
 * sample: a missing or undecodable file must never break the game's audio.
 */
const CHATTER_SAMPLES = [
  // Both from the same Pixabay uploader as the engine recording, and named
  // the same way: uploader, subject, Pixabay id. The scanner one is a 60 s
  // excerpt cut out of a four-minute recording -- 254 s of 24 kHz stereo is
  // 49 MB once decoded, which is a lot of memory to hold for room tone.
  '/resources/sounds/freesound_community-police-radio-chatter-30048.mp3',
  '/resources/sounds/freesound_community-police-scanner-14646.mp3',
];

/**
 * Your own recordings, under either of these names. Only looked for if fewer
 * than two of the shipped clips loaded -- so replacing or deleting one picks
 * yours up, and a default install does not put a pair of 404s in the console
 * every boot looking for files that were never meant to be there.
 */
const CHATTER_EXTRA = [
  '/resources/sounds/police-radio-chatter.mp3',
  '/resources/sounds/police-scanner.mp3',
];

/** Seconds between bursts of background chatter, and how long one runs for. */
const CHATTER_GAP = [7.0, 17.0];
const CHATTER_LEN = [1.6, 4.2];

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
    //
    // It has to be recognisable as a siren, and the first version was not: a
    // square wave swept slowly over a narrow range, muffled by a fixed lowpass
    // well below its own harmonics. Played quietly behind an engine that reads
    // as a wobbling synth note -- "almost music", which is exactly what it
    // sounded like and nothing like a police car.
    //
    // What makes the real thing identifiable is a bright, harmonically rich
    // tone through a resonant horn, sweeping a wide interval; and the *pattern*
    // carries the meaning. So: sawtooth for the harmonics, a bandpass riding
    // an octave above the fundamental for the horn, and a wail that becomes a
    // yelp when they are on top of you -- which tells you how close they are
    // without looking.
    this.sirenOsc = ctx.createOscillator();
    this.sirenOsc.type = 'sawtooth';
    this.sirenOsc.frequency.value = 760;
    // Second voice a fifth up, slightly detuned. Real sirens are a pair of
    // horns and never quite in tune with each other; one oscillator on its own
    // is a test tone however it is filtered.
    this.sirenOsc2 = ctx.createOscillator();
    this.sirenOsc2.type = 'square';
    this.sirenOsc2.frequency.value = 1140;
    this.sirenOsc2Gain = ctx.createGain();
    this.sirenOsc2Gain.gain.value = 0.34;

    this.sirenHorn = ctx.createBiquadFilter();
    this.sirenHorn.type = 'bandpass';
    this.sirenHorn.frequency.value = 1500;
    this.sirenHorn.Q.value = 3.2;
    this.sirenBody = ctx.createBiquadFilter();
    this.sirenBody.type = 'highpass';
    this.sirenBody.frequency.value = 420;

    this.sirenGain = ctx.createGain();
    this.sirenGain.gain.value = 0;
    this.sirenOsc.connect(this.sirenHorn);
    this.sirenOsc2.connect(this.sirenOsc2Gain);
    this.sirenOsc2Gain.connect(this.sirenHorn);
    this.sirenHorn.connect(this.sirenBody);
    this.sirenBody.connect(this.sirenGain);
    this.sirenGain.connect(this.master);
    this.sirenOsc.start();
    this.sirenOsc2.start();

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
    this.transmitSerial = 0;
    this.currentUtterance = null;

    // The speech engine and its voices. Voices arrive asynchronously in most
    // browsers -- the list is empty on the first call and filled in by a
    // voiceschanged event -- so the choice is made again whenever it changes.
    this.speech = (typeof window !== 'undefined' && window.speechSynthesis) || null;
    this.voices = null;
    if (this.speech) {
      const choose = () => { this.voices = pickVoices(this.speech.getVoices()); };
      choose();
      this.speech.addEventListener('voiceschanged', choose);
      // Speech carries on across a page reload -- pressing M to go back to
      // the menu reloads -- so without this the last calls of a chase follow
      // you into the menu.
      window.addEventListener('pagehide', () => this.speech.cancel());
    }

    this.chatter = [];         // decoded recordings, if any were found
    this.chatterTimer = 4;
    this.chatterLevel = 0.03;  // see _pumpChatter; set by measurement
    this._loadChatter();
  }

  /**
   * Fetch and decode whatever police net recordings are present.
   *
   * Deliberately silent about failure, like the engine sample: with no files
   * in place `this.chatter` stays empty and `_pumpChatter` does nothing.
   */
  async _loadChatter() {
    const tryLoad = async (url) => {
      try {
        const res = await fetch(url);
        if (!res.ok) return;
        const buf = await this.ctx.decodeAudioData(await res.arrayBuffer());
        if (buf.duration > 1.0) this.chatter.push(buf);
      } catch (e) {
        // Missing, wrong format, or a decoder that does not like it. Fine.
      }
    };
    for (const url of CHATTER_SAMPLES) await tryLoad(url);
    if (this.chatter.length < 2) {
      for (const url of CHATTER_EXTRA) await tryLoad(url);
    }
  }

  /**
   * Background traffic on the net while a pursuit is running.
   *
   * A burst is a window cut out of the middle of a recording with a squelch
   * click either end, played through the same channel as everything else, so
   * it is the same radio rather than a second one. It never speaks over a
   * dispatch call -- `radioFreeAt` is the channel, and the queue owns it --
   * and it holds the channel itself for the length of the burst, so a call
   * that arrives mid-burst waits its turn the way a real transmission would.
   */
  _pumpChatter(dt, heat) {
    if (!this.chatter.length || this.muted) return;
    const tier = heat ? heat.tier : 0;
    if (tier <= 0) { this.chatterTimer = CHATTER_GAP[0]; return; }

    this.chatterTimer -= dt;
    if (this.chatterTimer > 0) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    if (now < this.radioFreeAt || this.radioQueue.length) return;

    const buf = this.chatter[(Math.random() * this.chatter.length) | 0];
    const len = Math.min(buf.duration - 0.2,
      CHATTER_LEN[0] + Math.random() * (CHATTER_LEN[1] - CHATTER_LEN[0]));
    const from = Math.random() * Math.max(0, buf.duration - len - 0.1);

    // Quieter clicks than a real transmission gets. The key-up crash is
    // deliberately the loudest thing on the net -- it is the local set keying
    // up -- and borrowing that level for background traffic made the clicks,
    // not the voices, the loudest moment of a chase: 0.39 at the master bus
    // against 0.29 for the call it was sitting under.
    const at = now + 0.05;
    this._squelch(at, 0.05, 0.30, 2600);

    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    // Under the calls that matter, and a little busier the higher the
    // response.
    //
    // The number is small, and it has to be. A recording is mastered dense and
    // full-band, and the channel's waveshaper saturates, so it arrives with a
    // lot of energy for its nominal gain. Measured at the master bus against
    // the old synthesised call, which peaked at 0.287: gain 0.03 gives 0.135,
    // 0.08 gives 0.317, 0.15 gives 0.454. The spoken calls now play outside
    // Web Audio, louder than that call ever was, so this sits further under
    // them still.
    const level = this.chatterLevel * (0.8 + 0.06 * Math.min(5, tier));
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(level, at + 0.05);
    g.gain.setValueAtTime(level, at + len - 0.12);
    g.gain.exponentialRampToValueAtTime(0.0001, at + len);
    src.connect(g); g.connect(this.radioIn);
    src.start(at + 0.04, from, len);
    src.stop(at + len + 0.05);

    this._squelch(at + len, 0.10, 0.45, 3000);
    this.radioFreeAt = at + len + 0.2;
    this.chatterTimer = CHATTER_GAP[0]
      + Math.random() * (CHATTER_GAP[1] - CHATTER_GAP[0]);
  }

  /**
   * Queue a dispatch transmission.
   *
   * Called from Game.radio, so every line that reaches the HUD is also heard.
   * The channel is one at a time -- two units never talk over each other on a
   * real net, and it is the queueing that makes it sound like a net rather
   * than a soundboard.
   */
  radio(text, hot = false, opts = {}) {
    if (!this.ready || this.muted || this.failed) return;
    // Bracketed lines are the game talking to the player about settings, not
    // anybody talking on the radio.
    if (!text || text.startsWith('[')) return;
    // Running commentary is the first thing to give way when the net is busy.
    // It is still on the HUD; it just does not get read out behind two calls
    // that matter more.
    if (opts.low && this.radioQueue.length >= 1) return;
    // A long pursuit generates more traffic than there is airtime. Keep the
    // newest, since stale calls are the ones worth dropping.
    if (this.radioQueue.length > 3) this.radioQueue.splice(0, this.radioQueue.length - 3);
    this.radioQueue.push({ text, hot, at: performance.now() });
  }

  /** Start the next transmission if the channel is clear. Called per frame. */
  _pumpRadio() {
    if (!this.radioQueue.length) return;
    const now = this.ctx.currentTime;
    if (now < this.radioFreeAt) return;
    // Spoken lines take real time to say, so a busy chase can back up behind
    // one. A call that has waited more than ten seconds is about something
    // that is no longer happening -- "PIT authorised" after the PIT -- and is
    // dropped rather than read out late.
    while (this.radioQueue.length && performance.now() - (this.radioQueue[0].at || 0) > 10000) {
      this.radioQueue.shift();
    }
    if (this.radioQueue.length) this._transmit(this.radioQueue.shift());
  }

  /**
   * One transmission: the key closing, the line spoken, the squelch crash.
   *
   * The clicks and the carrier hiss are scheduled on the audio clock like
   * everything else. The voice is not, because the browser's speech engine
   * plays through its own output rather than through Web Audio -- which also
   * means it cannot be put through the radio channel's band limiting. What
   * makes it sound like a radio instead is everything around it: the PTT click
   * before, a faint open-carrier hiss underneath (and the rotor, for the
   * helicopter), and the squelch crash after.
   *
   * The channel is held for as long as the engine is actually speaking, since
   * nothing can know in advance how long a line will take to say.
   */
  _transmit(msg) {
    const ctx = this.ctx;
    const kind = voiceFor(msg.text);
    const style = SPEAKERS[kind];
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

    const carrier = this._openCarrier(t, style.rumble);
    this.radioFreeAt = Infinity;
    const serial = ++this.transmitSerial;

    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      if (this.transmitSerial === serial) this.currentUtterance = null;
      // ---- the key coming up -----------------------------------------------
      // Louder and longer than the click that opened it: the receiver's
      // squelch has a moment of open carrier before it shuts, and that crash
      // of noise is the single most recognisable thing about the whole sound.
      const end = Math.max(ctx.currentTime + 0.02, t + 0.2);
      carrier(end);
      this._squelch(end + 0.03, 0.12, 1.7, 3200);
      this.radioFreeAt = end + 0.27;
    };

    const startIn = Math.max(0, (t - ctx.currentTime) * 1000);
    const voice = this.voices && this.voices[kind];

    if (this.speech && voice) {
      const words = speakable(msg.text);
      const u = new SpeechSynthesisUtterance(words);
      u.voice = voice;
      u.lang = voice.lang;
      const rate = voice.localService ? style.rate : 1 + (style.rate - 1) * 0.3;
      u.rate = rate;
      u.pitch = style.pitch;
      // Full volume: the speech engine will not go any louder than 1, so the
      // rest of the voice's headroom comes from ducking the engine under it.
      u.volume = clamp01(this.masterVolume / 0.75);
      u.onend = finish;
      u.onerror = finish;
      this.currentUtterance = u;
      setTimeout(() => {
        if (finished || this.muted) { finish(); return; }
        this.speech.speak(u);
      }, startIn);
      // Some engines never report the end of an utterance. A generous guess
      // at how long the line takes, so a lost event cannot hold the channel
      // for the rest of the chase.
      // About 9.8 characters a second at rate 1 on a desktop voice, and the
      // speed-up from a higher rate is far less than proportional -- so the
      // square root, which keeps the guess on the long side.
      const guess = 1.5 + (words.length / 9.5) / Math.sqrt(rate);
      setTimeout(finish, startIn + (guess + 3) * 1000);
    } else {
      // No speech engine, or no English voice on this machine. Real radio
      // traffic out of the recordings, the length of the line, stands in for
      // it -- not the words on the HUD, but a real voice on a real net, which
      // is the thing the synthesised one never managed.
      const len = this._recordedVoice(t, msg.text);
      setTimeout(finish, startIn + len * 1000);
    }
  }

  /**
   * The open carrier under a transmission: a faint band-limited hiss, and the
   * rotor for the aircraft. Returns a function that closes it at a given time.
   */
  _openCarrier(at, rumble) {
    const ctx = this.ctx;
    const nodes = [];
    const layer = (freq, q, level) => {
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuffer;
      src.loop = true;
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = q;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(level, at + 0.04);
      src.connect(f); f.connect(g); g.connect(this.radioIn);
      src.start(at);
      nodes.push({ src, g, level });
    };
    layer(1900, 0.6, 0.010);
    if (rumble > 0) layer(700, 0.8, 0.05 * rumble);
    return (end) => {
      for (const n of nodes) {
        n.g.gain.cancelScheduledValues(end);
        n.g.gain.setValueAtTime(n.level, end);
        n.g.gain.exponentialRampToValueAtTime(0.0001, end + 0.05);
        n.src.stop(end + 0.08);
      }
    };
  }

  /**
   * A stretch of recorded radio traffic the length of a line, for a machine
   * with no speech engine. Returns how long it runs, in seconds.
   */
  _recordedVoice(at, text) {
    const len = clamp(0.9 + text.length / 17, 1.4, 4.2);
    const buf = this.chatter && this.chatter[(Math.random() * this.chatter.length) | 0];
    if (!buf) return 0.6;
    const run = Math.min(len, buf.duration - 0.2);
    const from = Math.random() * Math.max(0, buf.duration - run - 0.1);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const g = this.ctx.createGain();
    // Well above the background chatter: this is the call, not the room.
    const level = this.chatterLevel * 3.2;
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(level, at + 0.04);
    g.gain.setValueAtTime(level, at + run - 0.1);
    g.gain.exponentialRampToValueAtTime(0.0001, at + run);
    src.connect(g); g.connect(this.radioIn);
    src.start(at, from, run);
    src.stop(at + run + 0.05);
    return run;
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

  /**
   * Attention signal ahead of a priority call from Control.
   *
   * It was two sine notes of a fifth apart, a fifth of a second each -- which
   * is a real paging convention and, at game volume behind an engine, reads as
   * a little tune playing every time the radio goes. One note, short, square
   * through the channel's own band limiting: a beep that belongs to a radio
   * rather than an interval that belongs to music.
   */
  _alertTone(at) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = 1180;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(0.055, at + 0.006);
    g.gain.setValueAtTime(0.055, at + 0.11);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 0.15);
    o.connect(g); g.connect(this.radioIn);
    o.start(at); o.stop(at + 0.2);
    return at + 0.19;
  }

  toggleMute() {
    this.muted = !this.muted;
    // Drop anything still queued, or unmuting fires off a backlog of calls
    // about a pursuit that finished a minute ago.
    if (this.muted && this.radioQueue) this.radioQueue.length = 0;
    // The voice does not go through the master gain, so muting has to stop it
    // directly. Cancelling fires the utterance's error handler, which releases
    // the channel.
    if (this.muted && this.speech) this.speech.cancel();
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
    this._pumpChatter(dt, heat);

    // ---- engine ----------------------------------------------------------
    const rpm = player.rpm;
    const revs = clamp01(rpm / player.spec.engine.redline);
    const load = player.controls.throttle;
    // Firing frequency: a V8 fires four times a revolution, a V12 six, and
    // the order is most of the difference between a burble and a shriek.
    const order = player.spec.engine.order || ENGINE_ORDER;
    const f0 = clamp((rpm / 60) * order, 20, 950);

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
      // The recording is a V8. A twelve fires half as often again at the same
      // revs, so it is pitched as though the engine were turning that much
      // faster -- the note, not the tacho, is what the ear follows.
      const pulses = rpm * (order / ENGINE_ORDER);
      const rate = clamp(Math.pow(pulses / SAMPLE_RPM, PITCH_EXP), 0.55, 4.6);
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
    // And under the radio while somebody is talking. The spoken calls play
    // outside Web Audio and are already at the speech engine's maximum, so the
    // only way to bring the voices up any further is to bring the engine down
    // while they are on.
    const talking = this.radioFreeAt === Infinity;
    this.duck = damp(this.duck || 1, talking ? RADIO_DUCK : 1, talking ? 10 : 3, dt);
    const engVol = (0.085 + load * 0.130 + revs * 0.080) * shifting * ENGINE_VOLUME * this.duck;
    this.engineGain.gain.setTargetAtTime(engVol, t, smooth);

    this.intakeFilter.frequency.setTargetAtTime(300 + revs * 1500, t, smooth);
    this.intakeGain.gain.setTargetAtTime(load * revs * 0.05 * ENGINE_VOLUME * this.duck, t, smooth);

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
    if (nearest < 190) {
      this.sirenPhase += dt;

      // Wail while they are working their way towards you; yelp once they are
      // on you. Same two modes a real crew switches between, and the switch
      // itself is information: the pattern changing is how you know the car
      // behind has closed without taking your eyes off the road.
      const yelp = nearest < 55;
      const period = yelp ? 0.32 : 3.1;
      const ph = (this.sirenPhase % period) / period;
      // The yelp is a sawtooth in frequency -- fast up, snap back. The wail is
      // the same interval taken smoothly, up and down.
      const sweep = yelp ? ph : 0.5 - 0.5 * Math.cos(ph * Math.PI * 2);
      const hz = 640 + sweep * 900;
      const glide = yelp ? 0.006 : 0.03;
      this.sirenOsc.frequency.setTargetAtTime(hz, t, glide);
      // A fifth above, three cents out, so the pair beats against each other.
      this.sirenOsc2.frequency.setTargetAtTime(hz * 1.502, t, glide);
      // The horn rides with the note rather than sitting still below it, which
      // is what stops the sweep sounding like a filter opening.
      this.sirenHorn.frequency.setTargetAtTime(hz * 1.9, t, glide);

      const prox = 1 - clamp01(nearest / 190);
      this.sirenGain.gain.setTargetAtTime(prox * prox * 0.075, t, 0.12);
    } else {
      this.sirenGain.gain.setTargetAtTime(0, t, 0.25);
    }
  }
}
