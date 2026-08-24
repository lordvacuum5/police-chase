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

import { clamp, clamp01, lerp } from '../util/math.js';

/**
 * Firing frequency of a 4-stroke V8: rpm/60 * cylinders/2. The three
 * oscillators sit at f, 2f and 3f -- putting real energy in the harmonics
 * matters because a 50 Hz fundamental is inaudible on laptop speakers.
 */
const ENGINE_ORDER = 4;

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

    const mkOsc = (gain, detune, wave) => {
      const o = ctx.createOscillator();
      if (wave) o.setPeriodicWave(wave); else o.type = 'sine';
      o.detune.value = detune || 0;
      const g = ctx.createGain();
      g.gain.value = gain;
      o.connect(g); g.connect(this.engineMix);
      o.start();
      return o;
    };
    this.oscSub = mkOsc(0.62, 0, null);            // half order, sine, weight
    this.oscA = mkOsc(0.55, 0, engineWave);        // firing frequency
    this.oscB = mkOsc(0.42, 9, engineWave);        // second bank, detuned
    this.oscHarm = mkOsc(0.20, -6, engineWave);    // upper body

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

    this.ready = true;
  }

  toggleMute() {
    this.muted = !this.muted;
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
    const engVol = (0.050 + load * 0.090 + revs * 0.055) * shifting;
    this.engineGain.gain.setTargetAtTime(engVol, t, smooth);

    this.intakeFilter.frequency.setTargetAtTime(300 + revs * 1500, t, smooth);
    this.intakeGain.gain.setTargetAtTime(load * revs * 0.05, t, smooth);

    // ---- tyres -----------------------------------------------------------
    const sliding = player.grounded > 0 && player.speed > 4
      ? clamp01((player.maxSlip - 0.45) / 0.45) : 0;
    this.tyreFilter.frequency.setTargetAtTime(950 + sliding * 500, t, 0.08);
    this.tyreGain.gain.setTargetAtTime(sliding * 0.075, t, 0.06);

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
