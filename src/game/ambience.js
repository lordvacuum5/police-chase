// The world's own sounds: the train, the level crossings, birds and crows.
//
// "Can you add any sounds that you think you should add just in general in the game? Like train sounds,
// maybe a few bird sounds when they take off. I don't know, like corn crows."
//
// Made the way the rest of the game's sound is (game/audio.js): oscillators and the shared noise buffer,
// no recordings to fetch. One-shots are a handful of nodes each, started and stopped on the audio clock;
// the train's three layers are made when it comes within TRAIN_HEAR and let go when it leaves.
//
//   train     a rumble and a roar that grow as it nears, a clickety-clack at the rail joints, and its
//             horn, twice, as it comes towards you
//   crossing  the two-tone warble of a crossing whose lights are going
//   birds     a flock bursting out of a hedge or a tree when you go through, hit or tear past one: wings
//             and alarm calls, by day, in the country
//   crows     a few caws from somewhere across the fields every so often, by day; at night an owl
import { RAPIER, GROUP, groups } from '../physics/world.js';
import { clamp } from '../util/math.js';

/** Heard from this far, m; at this distance it is at half. */
const TRAIN_HEAR = 650;
const TRAIN_HALF = 90;
/** The horn: when its front is this close and coming your way, at most once in this many seconds. */
const HORN_NEAR = 320;
const HORN_EVERY = 30;
/** Measured offline: at 0.5 the horn at 140 m peaked at 0.39, three times a middling crash (0.13). */
const HORN_LEVEL = 0.18;
/** Rail joints, m apart: a clack pair as each bogie crosses one. */
const JOINT = 18;
const BELL_HEAR = 220;
/** Birds: over this speed, m/s, and within this of a tree or hedge, a chance each look of startling some; no more often than this, s. */
const FLUSH_SPEED = 17;
const FLUSH_NEAR = 7;
const FLUSH_CHANCE = 0.35;
const FLUSH_EVERY = 7;
/** Crows: one lot every CROW_MIN to CROW_MAX seconds; an owl every OWL_MIN to OWL_MAX at night. */
const CROW_MIN = 14;
const CROW_MAX = 38;
const OWL_MIN = 25;
const OWL_MAX = 60;
const NEAR_QUERY = groups(0xFFFF, GROUP.PROP | GROUP.HEDGE);

export class Ambience {
  constructor(game) {
    this.game = game;
    this.nextCrow = 6 + Math.random() * 10;
    this.nextOwl = 10 + Math.random() * 20;
    this.flushCool = 3;
    this.lookIn = 0;
    this.hornCool = 0;
    this.train = null;
    this.bell = null;
    this.nextClack = 0;
    this._hedgeSeen = 0;
    this._hitSeen = null;
  }

  /** Once a frame. Cheap when nothing is near: a few sums and a ball query twice a second. */
  update(dt) {
    const g = this.game, a = g.audio, p = g.player;
    if (!a || !a.ready || a.muted || !a.ctx || a.ctx.state !== 'running' || !p || g.paused || g.replay.playing) {
      this._quiet();
      return;
    }
    const rural = g.mapDef && g.mapDef.id === 'haldon';
    const night = !!(g.weather && g.weather.night);
    const rail = g.world && g.world.__map && g.world.__map.railway;
    this._ear(p);
    if (rail) this._rail(rail, a, dt);
    else this._quiet();
    if (p.isAircraft) return;

    // Birds out of a hedge or tree.
    this.flushCool -= dt;
    if (rural && !night && this.flushCool <= 0) {
      let why = null;
      if (p.hedgeAt && p.hedgeAt !== this._hedgeSeen) { this._hedgeSeen = p.hedgeAt; why = 'hedge'; }
      const h = p.lastHit;
      if (!why && h && h !== this._hitSeen && !h.ground) { this._hitSeen = h; if (h.dv > 5) why = 'hit'; }
      this.lookIn -= dt;
      if (!why && this.lookIn <= 0) {
        this.lookIn = 0.5;
        if (Math.hypot(p.linvel.x, p.linvel.z) > FLUSH_SPEED && this._nearCover(p) && Math.random() < FLUSH_CHANCE) why = 'past';
      }
      if (why) {
        this.flushCool = FLUSH_EVERY;
        this._flush(a, why === 'hit' ? 1 : 0.7);
      }
    }

    // Crows by day, an owl by night; fewer in town, none in the city.
    const often = rural ? 1 : g.mapDef && g.mapDef.id === 'town' ? 0.35 : 0;
    if (often > 0) {
      if (!night) {
        this.nextCrow -= dt * often;
        if (this.nextCrow <= 0) {
          this.nextCrow = CROW_MIN + Math.random() * (CROW_MAX - CROW_MIN);
          this._crows(a, 2 + Math.floor(Math.random() * 3), 0.04 + Math.random() * 0.05, Math.random() * 2 - 1);
        }
      } else {
        this.nextOwl -= dt * often;
        if (this.nextOwl <= 0) {
          this.nextOwl = OWL_MIN + Math.random() * (OWL_MAX - OWL_MIN);
          this._owl(a, Math.random() * 1.6 - 0.8);
        }
      }
    }
  }

  // ---- where you are listening from ------------------------------------------------------------

  _ear(p) {
    // The car's +x is its left (Vehicle AXIS_L), and the screen's right is the other way.
    this.ex = p.position.x;
    this.ez = p.position.z;
    this.lx = p.left ? p.left.x : 1;
    this.lz = p.left ? p.left.z : 0;
  }

  /** -1 left .. 1 right, for a sound at (x, z). */
  _pan(x, z) {
    const dx = x - this.ex, dz = z - this.ez, l = Math.hypot(dx, dz) || 1;
    return clamp(-(dx * this.lx + dz * this.lz) / l, -1, 1) * 0.85;
  }

  _nearCover(p) {
    const w = this.game.world;
    if (!w || !w.intersectionsWithShape) return false;
    let hit = false;
    const t = p.position;
    w.intersectionsWithShape({ x: t.x, y: t.y, z: t.z }, { x: 0, y: 0, z: 0, w: 1 }, new RAPIER.Ball(FLUSH_NEAR),
      () => { hit = true; return false; }, undefined, NEAR_QUERY, p.collider);
    return hit;
  }

  // ---- the train -------------------------------------------------------------------------------

  _rail(rail, a, dt) {
    const { train, bell } = rail.hear(this.ex, this.ez);
    const ctx = a.ctx, now = ctx.currentTime;
    this.hornCool -= dt;

    if (train && train.d < TRAIN_HEAR) {
      if (!this.train) this.train = this._trainNodes(a);
      const n = this.train;
      const near = 1 / (1 + (train.d / TRAIN_HALF) ** 2);
      const pan = this._pan(train.x, train.z);
      n.pan.pan.setTargetAtTime(pan, now, 0.15);
      n.rumble.gain.setTargetAtTime(0.5 * near, now, 0.2);
      n.roar.gain.setTargetAtTime(0.16 * near, now, 0.2);
      // Rail joints: a pair of clacks for each bogie over each joint, scheduled a little ahead.
      if (this.nextClack < now) this.nextClack = now + 0.05;
      while (this.nextClack < now + 0.25) {
        const at = this.nextClack;
        const level = 0.22 * near * (0.8 + Math.random() * 0.4);
        if (level > 0.003) {
          this._clack(a, n.pan, at, level);
          this._clack(a, n.pan, at + 0.11, level * 0.85);
        }
        // Five carriages, two bogies each, over a joint every JOINT m.
        this.nextClack += (JOINT / train.speed) / 2.2 * (0.85 + Math.random() * 0.3);
      }
      // The horn: towards you and close.
      const f = train.front;
      const toYou = (this.ex - f.x) * f.dx + (this.ez - f.z) * f.dz;
      const df = Math.hypot(this.ex - f.x, this.ez - f.z);
      if (this.hornCool <= 0 && toYou > 0 && df < HORN_NEAR) {
        this.hornCool = HORN_EVERY;
        const lvl = HORN_LEVEL / (1 + (df / 140) ** 2);
        const hp = this._pan(f.x, f.z);
        this._horn(a, now + 0.05, 1.1, lvl, hp);
        this._horn(a, now + 1.45, 0.7, lvl, hp);
      }
    } else if (this.train) {
      this._dropTrain();
    }

    if (bell && bell.d < BELL_HEAR) {
      if (!this.bell) this.bell = this._bellNodes(a);
      const lvl = 0.07 / (1 + (bell.d / 40) ** 2);
      this.bell.out.gain.setTargetAtTime(lvl, now, 0.1);
      this.bell.pan.pan.setTargetAtTime(this._pan(bell.x, bell.z), now, 0.15);
    } else if (this.bell) {
      this._dropBell();
    }
  }

  _trainNodes(a) {
    const ctx = a.ctx;
    const pan = ctx.createStereoPanner();
    pan.connect(a.master);
    const noise = () => {
      const s = ctx.createBufferSource();
      s.buffer = a.noiseBuffer;
      s.loop = true;
      s.loopStart = Math.random();
      return s;
    };
    // The weight of it: low noise, and a slow beat in it from the carriages.
    const r = noise();
    const rl = ctx.createBiquadFilter();
    rl.type = 'lowpass'; rl.frequency.value = 120; rl.Q.value = 0.9;
    const rumble = ctx.createGain(); rumble.gain.value = 0;
    r.connect(rl); rl.connect(rumble); rumble.connect(pan);
    // Steel on steel: a broad roar higher up.
    const o = noise();
    const ob = ctx.createBiquadFilter();
    ob.type = 'bandpass'; ob.frequency.value = 900; ob.Q.value = 0.6;
    const roar = ctx.createGain(); roar.gain.value = 0;
    o.connect(ob); ob.connect(roar); roar.connect(pan);
    r.start(); o.start();
    return { pan, rumble, roar, srcs: [r, o] };
  }

  _dropTrain() {
    const n = this.train;
    this.train = null;
    const ctx = this.game.audio.ctx, now = ctx.currentTime;
    n.rumble.gain.setTargetAtTime(0, now, 0.3);
    n.roar.gain.setTargetAtTime(0, now, 0.3);
    for (const s of n.srcs) s.stop(now + 1.5);
    setTimeout(() => n.pan.disconnect(), 1800);
  }

  _clack(a, out, at, level) {
    const ctx = a.ctx;
    const s = ctx.createBufferSource();
    s.buffer = a.noiseBuffer;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass'; f.frequency.value = 1700 + Math.random() * 600; f.Q.value = 1.2;
    const lo = ctx.createBiquadFilter();
    lo.type = 'lowpass'; lo.frequency.value = 260;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(level, at + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 0.06);
    // A metallic tick on top of a thump.
    s.connect(f); f.connect(g);
    s.connect(lo); lo.connect(g);
    g.connect(out);
    s.start(at, Math.random());
    s.stop(at + 0.08);
  }

  /** A two-tone horn, the way a British train sounds one. */
  _horn(a, at, dur, level, pan) {
    const ctx = a.ctx;
    const p = ctx.createStereoPanner(); p.pan.value = pan; p.connect(a.master);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2200; lp.connect(p);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(level, at + 0.06);
    g.gain.setValueAtTime(level, at + dur - 0.12);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    g.connect(lp);
    for (const hz of [311, 370]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(hz * 0.97, at);
      o.frequency.linearRampToValueAtTime(hz, at + 0.08);
      o.connect(g);
      o.start(at);
      o.stop(at + dur + 0.05);
    }
    setTimeout(() => p.disconnect(), (at - ctx.currentTime + dur + 0.5) * 1000);
  }

  _bellNodes(a) {
    // A crossing's alarm: two tones warbling against each other, about three times a second.
    const ctx = a.ctx;
    const pan = ctx.createStereoPanner(); pan.connect(a.master);
    const out = ctx.createGain(); out.gain.value = 0; out.connect(pan);
    const o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = 760;
    const sw = ctx.createOscillator(); sw.type = 'square'; sw.frequency.value = 2.8;
    const depth = ctx.createGain(); depth.gain.value = 140;
    sw.connect(depth); depth.connect(o.frequency);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1800;
    o.connect(lp); lp.connect(out);
    o.start(); sw.start();
    return { pan, out, srcs: [o, sw] };
  }

  _dropBell() {
    const n = this.bell;
    this.bell = null;
    const ctx = this.game.audio.ctx, now = ctx.currentTime;
    n.out.gain.setTargetAtTime(0, now, 0.1);
    for (const s of n.srcs) s.stop(now + 0.6);
    setTimeout(() => n.pan.disconnect(), 900);
  }

  _quiet() {
    if (this.train) this._dropTrain();
    if (this.bell) this._dropBell();
  }

  // ---- birds -----------------------------------------------------------------------------------

  /** A few birds bursting out of cover: wings, and alarm calls. `loud` 0..1. */
  _flush(a, loud) {
    const ctx = a.ctx, now = ctx.currentTime;
    const birds = 3 + Math.floor(Math.random() * 4);
    for (let b = 0; b < birds; b++) {
      const pan = ctx.createStereoPanner();
      pan.pan.value = Math.random() * 1.6 - 0.8;
      pan.connect(a.master);
      const start = now + Math.random() * 0.35;
      // Wings: quick soft beats, fast at first, slowing and fading as it gets away.
      let t = start, gap = 0.035 + Math.random() * 0.015;
      const beats = 10 + Math.floor(Math.random() * 10);
      for (let i = 0; i < beats; i++) {
        const lvl = 0.16 * loud * (1 - i / beats) ** 1.5;
        if (lvl > 0.002) this._wing(a, pan, t, lvl);
        t += gap;
        gap *= 1.05 + Math.random() * 0.06;
      }
      // A call or two from some of them.
      if (Math.random() < 0.7) {
        let c = start + 0.05 + Math.random() * 0.2;
        const calls = 1 + Math.floor(Math.random() * 3);
        const hz = 3000 + Math.random() * 1800;
        for (let i = 0; i < calls; i++) {
          this._chirp(a, pan, c, hz, 0.04 * loud);
          c += 0.09 + Math.random() * 0.08;
        }
      }
      setTimeout(() => pan.disconnect(), 2500);
    }
    // Sometimes it is crows in the trees, and they go up complaining.
    if (Math.random() < 0.35) this._crows(a, 2 + Math.floor(Math.random() * 2), 0.07 * loud, Math.random() * 1.2 - 0.6, 0.3);
  }

  _wing(a, out, at, level) {
    const ctx = a.ctx;
    const s = ctx.createBufferSource();
    s.buffer = a.noiseBuffer;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass'; f.frequency.value = 900 + Math.random() * 900; f.Q.value = 0.8;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(level, at + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 0.045);
    s.connect(f); f.connect(g); g.connect(out);
    s.start(at, Math.random());
    s.stop(at + 0.06);
  }

  _chirp(a, out, at, hz, level) {
    const ctx = a.ctx;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(hz * 1.15, at);
    o.frequency.exponentialRampToValueAtTime(hz * 0.8, at + 0.07);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(level, at + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 0.08);
    o.connect(g); g.connect(out);
    o.start(at);
    o.stop(at + 0.1);
  }

  /** `n` caws from one crow, from the side `pan`, starting `delay` s from now. */
  _crows(a, n, level, pan, delay = 0) {
    const ctx = a.ctx;
    const p = ctx.createStereoPanner(); p.pan.value = pan; p.connect(a.master);
    let at = ctx.currentTime + delay;
    const hz = 380 + Math.random() * 120;
    for (let i = 0; i < n; i++) {
      this._caw(a, p, at, hz * (1 - i * 0.03), level * (1 - i * 0.12), 0.22 + Math.random() * 0.1);
      at += 0.38 + Math.random() * 0.2;
    }
    setTimeout(() => p.disconnect(), (at - ctx.currentTime + 1) * 1000);
  }

  /** A caw: a harsh buzz, its pitch up then down, through the two resonances of a crow's throat. */
  _caw(a, out, at, hz, level, dur) {
    const ctx = a.ctx;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(hz * 0.9, at);
    o.frequency.linearRampToValueAtTime(hz * 1.08, at + dur * 0.25);
    o.frequency.exponentialRampToValueAtTime(hz * 0.72, at + dur);
    // The rasp: the buzz itself roughened at about 60 Hz.
    const rasp = ctx.createOscillator(); rasp.type = 'square'; rasp.frequency.value = 55 + Math.random() * 20;
    const rg = ctx.createGain(); rg.gain.value = 0.45;
    const am = ctx.createGain(); am.gain.value = 0.55;
    rasp.connect(rg); rg.connect(am.gain);
    const f1 = ctx.createBiquadFilter(); f1.type = 'bandpass'; f1.frequency.value = 1150; f1.Q.value = 2.5;
    const f2 = ctx.createBiquadFilter(); f2.type = 'bandpass'; f2.frequency.value = 2300; f2.Q.value = 3;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(level, at + 0.02);
    g.gain.setValueAtTime(level, at + dur * 0.6);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.connect(am); am.connect(f1); am.connect(f2); f1.connect(g); f2.connect(g); g.connect(out);
    o.start(at); rasp.start(at);
    o.stop(at + dur + 0.02); rasp.stop(at + dur + 0.02);
  }

  /** A tawny owl: the long hoot, a pause, the wavering one. */
  _owl(a, pan) {
    const ctx = a.ctx;
    const p = ctx.createStereoPanner(); p.pan.value = pan; p.connect(a.master);
    const level = 0.035;
    const hoot = (at, dur, wobble) => {
      const o = ctx.createOscillator(); o.type = 'sine';
      o.frequency.setValueAtTime(390, at);
      o.frequency.linearRampToValueAtTime(410, at + dur * 0.3);
      o.frequency.linearRampToValueAtTime(370, at + dur);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(level, at + 0.05);
      g.gain.setValueAtTime(level, at + dur - 0.1);
      g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
      if (wobble) {
        const w = ctx.createOscillator(); w.frequency.value = 9;
        const wg = ctx.createGain(); wg.gain.value = level * 0.6;
        w.connect(wg); wg.connect(g.gain);
        w.start(at); w.stop(at + dur);
      }
      o.connect(g); g.connect(p);
      o.start(at); o.stop(at + dur + 0.02);
    };
    const t = ctx.currentTime;
    hoot(t, 0.7, false);
    hoot(t + 1.6, 0.25, false);
    hoot(t + 1.95, 1.0, true);
    setTimeout(() => p.disconnect(), 4000);
  }
}

/** For trying them by ear from the console: `__amb('crows')`, 'flush', 'owl', 'horn'. */
export function soundCheck(amb) {
  window.__amb = (what) => {
    const a = amb.game.audio;
    if (!a || !a.ctx) return 'no audio';
    if (what === 'crows') amb._crows(a, 3, 0.07, 0.3);
    else if (what === 'flush') amb._flush(a, 1);
    else if (what === 'owl') amb._owl(a, -0.3);
    else if (what === 'horn') { const t = a.ctx.currentTime + 0.05; amb._horn(a, t, 1.1, 0.3, 0); amb._horn(a, t + 1.4, 0.7, 0.3, 0); }
    return what;
  };
}

