// Sound.
//
// Mostly built at runtime from oscillators and a buffer of white noise, with
// one recording where synthesis could not do the job: the engine.
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
//            between a PTT click and a squelch crash

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
 * carrier hiss and the noise of the net between calls go through this channel. The spoken
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
 *
 * `duck` is how far everything else in the mix drops while that speaker is
 * talking, and it is not the same for all three because the voices are not
 * equally loud. Rendered through the same Windows speech engine Chrome uses,
 * the same sentence came out at -16.5 dBFS from Hazel, -15.6 from Susan, and
 * -23.5 from George: the male voice is seven or eight dB quieter than the
 * others before the game does anything to it, and the speech engine will not
 * go above full volume to make up for it. So the mix makes up for it instead,
 * and the unit voice is also taken a little slower and brighter -- George is
 * already the fastest of the three at his default rate, and at 2.3 he was the
 * hardest to follow as well as the quietest.
 */
const SPEAKERS = {
  control: { prefer: 'female', rate: 2.0, pitch: 1.00, rumble: 0,    duck: 0.55 },
  unit:    { prefer: 'male',   rate: 1.8, pitch: 1.08, rumble: 0,    duck: 0.25 },
  air:     { prefer: 'other',  rate: 2.1, pitch: 0.94, rumble: 0.35, duck: 0.50 },
};

const FEMALE_NAME = /female|zira|hazel|susan|libby|sonia|maisie|aria|jenny|michelle|samantha|karen|moira|tessa|serena|kate|fiona|victoria|allison|ava|emma|natasha|catherine|heera|linda/i;
const MALE_NAME = /\bmale\b|david|mark|george|ryan|guy|daniel|alex|fred|oliver|thomas|arthur|james|christopher|eric|roger|brian|richard|william|sean|ravi/i;

/**
 * Choose a voice for each speaker from whatever the machine has.
 *
 * English only, British first -- it is a British police net -- then any other
 * English. Local voices ahead of ordinary network ones: a network voice can lag
 * a second behind the line on the HUD, or not arrive at all offline, and a call
 * that turns up late is worse than one in a plainer voice. Natural voices are
 * the exception; see englishVoices. Returns null when there is no English
 * voice at all, which sends the radio to its fallback.
 */
export function pickVoices(all, chosen = voiceChoices()) {
  const en = englishVoices(all);
  if (!en.length) return null;
  const female = en.filter((v) => FEMALE_NAME.test(v.name));
  const male = en.filter((v) => !FEMALE_NAME.test(v.name) && MALE_NAME.test(v.name));

  const control = female[0] || en[0];
  const unit = male[0] || en.find((v) => v !== control) || en[0];
  const air = en.find((v) => v !== control && v !== unit) || unit;
  const picked = { control, unit, air };

  // Whatever the player chose on the menu wins, for as long as that voice is
  // still on the machine.
  for (const who of Object.keys(picked)) {
    const v = chosen[who] && (all || []).find((x) => x.name === chosen[who]);
    if (v) picked[who] = v;
  }
  return picked;
}

/**
 * The English voices, best first: British, then natural, then local.
 *
 * "Natural" voices -- Edge's neural ones, Ryan and Thomas and Sonia -- come
 * ahead of local ones despite coming over the network. The reason for
 * preferring local was a line turning up late; the reason for this is the
 * complaint that started it, that the only local British man, George, is
 * seven dB quieter than the women and hard to make out under the engine. A
 * neural voice is both louder and far clearer, and it starts quickly enough.
 */
export function englishVoices(all) {
  const en = (all || []).filter((v) => /^en([-_]|$)/i.test(v.lang));
  const score = (v) => (/^en[-_]GB/i.test(v.lang) ? 4 : 1)
    + (/\b(natural|neural)\b/i.test(v.name) ? 3 : 0)
    + (v.localService ? 2 : 0);
  return en.slice().sort((a, b) => score(b) - score(a));
}

/** Who says what, for the menu. */
export const SPEAKER_NAMES = { control: 'Control', unit: 'Units', air: 'Air support' };

const VOICE_KEY = 'pc.voices';

/** The voice picked on the menu for each speaker, by name. Empty is automatic. */
export function voiceChoices() {
  try {
    const v = JSON.parse(localStorage.getItem(VOICE_KEY) || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch (e) {
    return {};
  }
}

export function setVoiceChoice(who, name) {
  const v = voiceChoices();
  if (name) v[who] = name; else delete v[who];
  try { localStorage.setItem(VOICE_KEY, JSON.stringify(v)); } catch (e) { /* storage blocked */ }
}

/**
 * The rate a speaker's lines go out at in this voice. See SPEAKERS.
 *
 * The full rates only suit the Windows desktop voices, which barely speed up
 * when asked to: 2.0 on George is nowhere near twice as fast. Every other
 * engine -- Android's, Apple's, the network voices -- takes the rate at its
 * word, and on a phone 2.0 really was double speed: "the voices say the stuff
 * way too fast". They were only spared before if they happened to report
 * themselves as network voices, and a phone's own voices are local. So the
 * test is now what the engine is, not where it runs.
 */
export function rateFor(voice, style) {
  // No voice at all means the engine's own default is reading it, and there is
  // nothing to know about it; treat it as the cautious case.
  if (!voice) return 1 + (style.rate - 1) * 0.3;
  const windowsDesktop = voice.localService && /^Microsoft\b/i.test(voice.name)
    && !/\b(natural|online)\b/i.test(voice.name);
  return windowsDesktop ? style.rate : 1 + (style.rate - 1) * 0.3;
}

const SAMPLE_LINES = {
  control: 'Control, all units, vehicle failing to stop. Respond.',
  unit: "Unit 3, I'm primary, northbound on the high street, ninety.",
  air: 'India 99, we have them, eastbound towards the ring road.',
};

/**
 * Say a sample line in a voice, the way it would go out in a chase, so a voice
 * can be heard before it is chosen. Speech only: no radio clicks on the menu.
 */
export function speakSample(who, voice) {
  const speech = typeof window !== 'undefined' && window.speechSynthesis;
  if (!speech || !voice) return;
  const style = SPEAKERS[who];
  speech.cancel();
  const u = new SpeechSynthesisUtterance(speakable(SAMPLE_LINES[who]));
  u.voice = voice;
  u.lang = voice.lang;
  u.rate = rateFor(voice, style);
  u.pitch = style.pitch;
  speech.speak(u);
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
  // "U3 responding, northbound" -- a callsign at the front means a unit, and
  // a police player has one of those like everybody else.
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

/** How far the mix drops under a call from a speaker with no duck of its own. */
const RADIO_DUCK = 0.55;

/**
 * How long a call may wait for the channel before it is dropped, in seconds.
 * Calls are about things happening now; one read out late describes a PIT that
 * has already happened or a junction the car went through. About one line's
 * worth: a call may wait for the one on the air to finish, not for two more
 * behind it. Priority calls get slightly longer, since losing one loses more.
 */
const HOT_TTL = 4.5;
const CALL_TTL = 3;

/** Seconds of silence a routine line needs before it may go out at all. */
const LOW_QUIET = 2;

/** The recorded engine loop, and what it is doing. */
const ENGINE_SAMPLE = 'resources/sounds/freesound_community-engine-61234.mp3';

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
    // iPhones only let a page speak once it has spoken from inside a tap, and
    // the radio's first line comes later, from the game loop. A silent empty
    // line on the first interaction unlocks it; elsewhere it does nothing.
    if (!this._speechPrimed && this.speech) {
      this._speechPrimed = true;
      try {
        const u = new SpeechSynthesisUtterance('');
        u.volume = 0;
        this.speech.speak(u);
      } catch (e) { /* no speech engine worth priming */ }
    }
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
    this.currentMsg = null;    // the transmission on the air, if any
    this._endCurrent = null;   // cuts it short, when it can be cut

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
    // Routine lines -- commentary, units saying they are on their way -- only
    // go out into a gap. Never queued: by the time the channel came free they
    // would be describing a road the car has already left.
    if (opts.low && !this.roomForRoutine) return;

    const now = this.ctx.currentTime;
    // A newer call of the same kind replaces one still waiting. Two "PIT
    // authorised" calls queued back to back are one call that is late.
    if (opts.key) {
      this.radioQueue = this.radioQueue.filter((m) => m.key !== opts.key);
    }
    // A long pursuit generates more traffic than there is airtime. Keep the
    // newest, since stale calls are the ones worth dropping.
    if (this.radioQueue.length > 2) this.radioQueue.splice(0, this.radioQueue.length - 2);
    this.radioQueue.push({
      text, hot, low: !!opts.low, final: !!opts.final, key: opts.key || null,
      at: now, ttl: opts.final ? 30 : hot ? HOT_TTL : CALL_TTL,
    });

    // Something is happening now and routine chatter is on the air: cut the
    // chatter off so the call goes out while it is still true. A PIT that was
    // authorised four seconds after it happened is worse than no call at all.
    if (hot && this.currentMsg && this.currentMsg.low && this._endCurrent) this._endCurrent();
  }

  /**
   * Whether anything is on the net or waiting for it. Commentary checks this
   * so a line waits for space instead of being thrown away at the queue.
   */
  get busy() {
    if (!this.ready || this.muted || this.failed) return false;
    return this.radioQueue.length > 0 || this.ctx.currentTime < this.radioFreeAt;
  }

  /** Seconds the channel has been clear. Infinite when there is no radio to hear. */
  get quietFor() {
    if (!this.ready || this.muted || this.failed) return Infinity;
    if (this.busy) return 0;
    return this.ctx.currentTime - this.radioFreeAt;
  }

  /** Whether a routine line may go out now. */
  get roomForRoutine() { return this.quietFor >= LOW_QUIET; }

  /** Start the next transmission if the channel is clear. Called per frame. */
  _pumpRadio() {
    if (!this.radioQueue.length) return;
    const now = this.ctx.currentTime;
    if (now < this.radioFreeAt) return;
    // Spoken lines take real time to say, so a busy chase can back up behind
    // one. A call that could not get on the air within a few seconds is about
    // something that has already happened -- "PIT authorised" after the PIT --
    // and is dropped rather than read out late.
    this.radioQueue = this.radioQueue.filter((m) => now - m.at <= m.ttl);
    if (!this.radioQueue.length) return;
    // The most important call waiting goes first, oldest first among equals:
    // the arrest before a priority call, a priority call before routine
    // traffic. With calls only allowed a few seconds' wait, strict order meant
    // "they've pushed free" expiring behind "India 99, airborne".
    let best = 0;
    const rank = (m) => (m.final ? 2 : m.hot ? 1 : 0);
    for (let i = 1; i < this.radioQueue.length; i++) {
      if (rank(this.radioQueue[i]) > rank(this.radioQueue[best])) best = i;
    }
    this._transmit(this.radioQueue.splice(best, 1)[0]);
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

    // A priority call from Control gets the attention tone first -- not every
    // time, or it stops meaning anything, but often enough to be part of the
    // sound of a busy net.
    if (msg.hot && kind === 'control' && t - this.lastAlertAt > 9) {
      this.lastAlertAt = t;
      t = this._alertTone(t) + 0.14;
    }

    // ---- the key closing -------------------------------------------------
    this._squelch(t, 0.05, 0.55, 2400);
    t += 0.10;

    // The signalling a real digital net wraps around every transmission. A
    // base station sends a short data burst identifying itself as the key goes
    // down -- the "brrrp" -- and a handheld on a trunked system gets a talk
    // permit chirp before it can speak.
    if (kind === 'control') t = this._dataBurst(t, 0.16) + 0.05;
    else if (kind === 'unit') t = this._talkPermit(t) + 0.04;

    const carrier = this._openCarrier(t, style.rumble);
    if (kind !== 'control') this._crackle(t + 0.4, 2.5, style.rumble > 0 ? 2 : 3);
    this.callDuck = style.duck;
    this.radioFreeAt = Infinity;
    const serial = ++this.transmitSerial;
    this.currentMsg = msg;
    this._endCurrent = null;

    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      if (this.transmitSerial === serial) {
        this.currentUtterance = null;
        this.currentMsg = null;
        this._endCurrent = null;
      }
      // ---- the key coming up -----------------------------------------------
      // Louder and longer than the click that opened it: the receiver's
      // squelch has a moment of open carrier before it shuts, and that crash
      // of noise is the single most recognisable thing about the whole sound.
      let end = Math.max(ctx.currentTime + 0.02, t + 0.2);
      // Units sign off with a roger beep as the key comes up; the base station
      // sends its data burst again.
      if (kind === 'unit') end = this._rogerBeep(end + 0.02);
      else if (kind === 'control') end = this._dataBurst(end + 0.03, 0.12);
      carrier(end);
      this._squelch(end + 0.03, 0.12, 1.7, 3200);
      this.radioFreeAt = end + 0.27;
    };

    const startIn = Math.max(0, (t - ctx.currentTime) * 1000);
    // The voice list often arrives after the page does, and a browser only
    // announces that once -- so a game that started before the voices were
    // ready used to play the clicks and the static with nothing said in
    // between, for the rest of the session: "it has the beeps... but it
    // doesn't actually say anything". Ask again whenever a line has no voice.
    let voice = this.voices && this.voices[kind];
    if (this.speech && !voice) {
      this.voices = pickVoices(this.speech.getVoices());
      voice = this.voices && this.voices[kind];
    }

    if (this.speech) {
      const words = speakable(msg.text);
      const u = new SpeechSynthesisUtterance(words);
      // And if there is genuinely no English voice on this machine, let the
      // engine read it in whatever it does have. Saying the line in the wrong
      // accent beats a radio that never says anything.
      if (voice) {
        u.voice = voice;
        u.lang = voice.lang;
      }
      const rate = rateFor(voice, style);
      u.rate = rate;
      u.pitch = style.pitch;
      // Full volume: the speech engine will not go any louder than 1, so the
      // rest of the voice's headroom comes from ducking the engine under it.
      u.volume = clamp01(this.masterVolume / 0.75);
      u.onend = finish;
      u.onerror = finish;
      this.currentUtterance = u;
      // Cancelling fires onerror as well, which finish() ignores the second
      // time; calling it here directly covers a line still waiting on its
      // opening clicks, which the engine has not been given yet.
      this._endCurrent = () => {
        finish();
        if (this.speech.speaking || this.speech.pending) this.speech.cancel();
      };
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
      // No speech engine at all: the key goes down and comes up again with
      // nothing readable in between. There used to be recorded police traffic
      // here, and under every pursuit, until it was asked to go.
      setTimeout(finish, startIn + 600);
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

  /** One short tone into the radio channel. Returns when it ends. */
  _blip(at, hz, dur, level = 0.05, type = 'square') {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = hz;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(level, at + 0.004);
    g.gain.setValueAtTime(level, at + Math.max(0.005, dur - 0.012));
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.connect(g); g.connect(this.radioIn);
    o.start(at); o.stop(at + dur + 0.02);
    return at + dur;
  }

  /**
   * A digital ID burst: the rapid two-tone warble a base station or a car's
   * data terminal sends as the key goes down. Frequency-shift keying between
   * two tones a few milliseconds at a time, which is what gives it the
   * zipping "brrrp" rather than a beep.
   */
  _dataBurst(at, dur = 0.16) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'square';
    const bit = 0.0085;
    let t = at, hi = false;
    while (t < at + dur) {
      // Not a steady alternation: real data has runs of the same bit.
      if (Math.random() < 0.62) hi = !hi;
      o.frequency.setValueAtTime(hi ? 1800 : 1200, t);
      t += bit;
    }
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(0.026, at + 0.006);
    g.gain.setValueAtTime(0.026, at + dur - 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.connect(g); g.connect(this.radioIn);
    o.start(at); o.stop(at + dur + 0.02);
    return at + dur;
  }

  /** Talk permit: three quick chirps before a handheld is allowed to speak. */
  _talkPermit(at) {
    let t = at;
    for (let i = 0; i < 3; i++) t = this._blip(t, 1320, 0.035, 0.024) + 0.028;
    return t;
  }

  /** Roger beep: a short rising two-note blip as a unit lets go of the key. */
  _rogerBeep(at) {
    const t = this._blip(at, 1050, 0.055, 0.024);
    return this._blip(t + 0.01, 1580, 0.07, 0.024);
  }

  /**
   * Static crackle under a transmission from a moving car: a few short pops
   * of noise at random moments. Scheduled up front like everything else;
   * the ones that land after the speech ends just fall inside the tail.
   */
  _crackle(at, span, count) {
    const ctx = this.ctx;
    for (let i = 0; i < count; i++) {
      const t = at + Math.random() * span;
      const dur = 0.02 + Math.random() * 0.05;
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuffer;
      src.loop = true;
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass'; f.frequency.value = 1500 + Math.random() * 1400; f.Q.value = 0.9;
      const g = ctx.createGain();
      const level = 0.03 + Math.random() * 0.04;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(level, t + 0.003);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      src.connect(f); f.connect(g); g.connect(this.radioIn);
      src.start(t, Math.random()); src.stop(t + dur + 0.02);
    }
  }

  /**
   * The net between calls. Nobody is talking to you, but the channel is not
   * silent: somebody keys up and thinks better of it, a terminal sends a
   * status burst, a distant unit's roger beep comes through on its own. Every
   * 14 to 32 seconds, only when the channel is clear, quieter than a call.
   */
  _pumpNetNoise(dt) {
    if (this.muted) return;
    this.netTimer = (this.netTimer === undefined ? 10 : this.netTimer) - dt;
    if (this.netTimer > 0) return;
    this.netTimer = 14 + Math.random() * 18;
    const now = this.ctx.currentTime;
    if (now < this.radioFreeAt || this.radioQueue.length) return;
    const at = now + 0.05;
    const r = Math.random();
    let end;
    if (r < 0.4) {
      // A kerchunk: key down, nothing said, key up.
      this._squelch(at, 0.04, 0.35, 2400);
      end = at + 0.22;
      this._squelch(end, 0.09, 0.9, 3000);
    } else if (r < 0.75) {
      end = this._dataBurst(at, 0.1 + Math.random() * 0.1);
      this._squelch(end + 0.02, 0.07, 0.6, 3000);
    } else {
      end = this._rogerBeep(at);
      this._squelch(end + 0.02, 0.08, 0.7, 3000);
    }
    this.radioFreeAt = end + 0.3;
  }

  /**
   * Rain: two layers of filtered noise -- a broad hiss for the rain in the air
   * and a lower, rougher band for it drumming on the car. Started the first
   * frame the audio is running with `rainLevel` set; stays for the drive.
   */
  _startRain() {
    const ctx = this.ctx;
    this.rainGain = ctx.createGain();
    this.rainGain.gain.value = 0.0001;
    this.rainGain.connect(this.master);
    const layer = (type, freq, q, level) => {
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuffer;
      src.loop = true;
      src.playbackRate.value = 0.7 + Math.random() * 0.3;
      const f = ctx.createBiquadFilter();
      f.type = type; f.frequency.value = freq; f.Q.value = q;
      const g = ctx.createGain();
      g.gain.value = level;
      src.connect(f); f.connect(g); g.connect(this.rainGain);
      src.start(ctx.currentTime + Math.random() * 0.5);
    };
    layer('highpass', 2600, 0.5, 0.9);
    layer('bandpass', 900, 0.7, 0.55);
    this.rainGain.gain.setTargetAtTime(0.05 * this.rainLevel, ctx.currentTime, 1.2);
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
    if (this.rainLevel > 0 && !this.rainGain) this._startRain();
    this._pumpNetNoise(dt);

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
    // only way to bring the voices up any further is to bring everything else
    // down while they are on -- by however much that speaker needs (SPEAKERS).
    // The siren, tyres and wind go down with the engine: the siren sweeps
    // straight through the band speech lives in, and in a chase it is loudest
    // exactly when a unit close by is talking.
    const talking = this.radioFreeAt === Infinity;
    const duckTo = talking ? (this.callDuck || RADIO_DUCK) : 1;
    this.duck = damp(this.duck || 1, duckTo, talking ? 10 : 3, dt);
    const engVol = (0.085 + load * 0.130 + revs * 0.080) * shifting * ENGINE_VOLUME * this.duck;
    this.engineGain.gain.setTargetAtTime(engVol, t, smooth);

    this.intakeFilter.frequency.setTargetAtTime(300 + revs * 1500, t, smooth);
    this.intakeGain.gain.setTargetAtTime(load * revs * 0.05 * ENGINE_VOLUME * this.duck, t, smooth);

    // ---- tyres -----------------------------------------------------------
    const rolling = player.grounded > 0 && player.speed > 4;
    const sliding = rolling ? clamp01((player.maxSlip - 0.45) / 0.45) : 0;
    this.tyreFilter.frequency.setTargetAtTime(950 + sliding * 500, t, 0.08);
    this.tyreGain.gain.setTargetAtTime(sliding * 0.075 * this.duck, t, 0.06);

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
    this.scrubGain.gain.setTargetAtTime(scrub * 0.055 * this.duck, t, 0.07);

    // ---- wind ------------------------------------------------------------
    this.windGain.gain.setTargetAtTime(clamp01(player.speed / 75) * 0.045 * this.duck, t, 0.12);
    this.windFilter.frequency.setTargetAtTime(400 + player.speed * 14, t, 0.12);

    // ---- siren -----------------------------------------------------------
    // In a chase, the nearest marked car. Out of one, only a car giving you a
    // one-second "move along" blip (Officer._warnIfBlocked) -- which is always
    // the yelp: a couple of whoops, not a wail starting up.
    let nearest = Infinity, blip = false;
    if (dispatcher) {
      for (const u of dispatcher.units) {
        const blipping = u.vehicle.blipFor > 0;
        if (!blipping && (heat.tier === 0 || u.vehicle.unmarked)) continue;
        if (u.vehicle.disabled) continue;
        const d = u.distanceTo(player.position);
        if (d < nearest) { nearest = d; blip = blipping && heat.tier === 0; }
      }
    }
    if (nearest < 190) {
      this.sirenPhase += dt;

      // Wail while they are working their way towards you; yelp once they are
      // on you. Same two modes a real crew switches between, and the switch
      // itself is information: the pattern changing is how you know the car
      // behind has closed without taking your eyes off the road.
      const yelp = nearest < 55 || blip;
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
      this.sirenGain.gain.setTargetAtTime(prox * prox * 0.075 * this.duck, t, 0.12);
    } else {
      this.sirenGain.gain.setTargetAtTime(0, t, 0.25);
    }
  }
}
