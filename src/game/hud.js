// Heads-up display.
//
// Everything here is 2D canvas or DOM, kept off the WebGL path so it costs the
// GPU nothing. The minimap is the one piece that needs care: the whole road
// network is rasterised once into an offscreen canvas at load, and each frame
// only blits a crop of it.

import { clamp, clamp01, lerp, toMph } from '../util/math.js';
import { ROAD_KIND } from '../world/roadgraph.js';
import { WORLD_HALF } from '../world/common.js';
import { TRACK_SECONDS } from '../ai/dispatcher.js';
import { ENDURANCE as AIR_TANK } from './flyheli.js';

const MAP_PX = 1200;          // offscreen map resolution
const MAP_SPAN = 470;         // metres visible on the minimap
/**
 * Metres visible once it is expanded. Enlarging the picture without widening
 * the crop was the original behaviour and it is not what anybody wants from
 * tapping a map: "it just enlarges it, it doesn't actually enlarge the area
 * that I can see." The world is 2 km across, so this is over half of it in one
 * view, and the rest is a drag away.
 */
const BIG_SPAN = 1150;

export class Hud {
  constructor(game) {
    this.game = game;
    // Set by the game when this client is a police player in a multiplayer
    // game: where the car everyone is after is, for the radar.
    this.suspect = null;

    this.starsEl = document.getElementById('stars');
    this.heatFill = document.getElementById('heatfill');
    this.statusEl = document.getElementById('status');
    this.gearEl = document.getElementById('gear');
    this.gearLabel = document.getElementById('gearlabel');
    this.dmgLabel = document.getElementById('dmglabel');
    this.radioEl = document.getElementById('radiolog');
    this.overlay = document.getElementById('overlay');
    this.otitle = document.getElementById('otitle');
    this.osub = document.getElementById('osub');
    this.helpEl = document.getElementById('help');
    this.banner = document.getElementById('banner');
    this.btitle = document.getElementById('btitle');
    this.bsub = document.getElementById('bsub');
    this._bannerTimer = null;
    this.tyreEls = [0, 1, 2, 3].map((i) => document.getElementById('t' + i));
    this.dmgFill = document.getElementById('dmgfill');
    this.dmgPct = document.getElementById('dmgpct');
    this._lastDmg = -1;

    this.bustEl = document.getElementById('bust');
    this.bustFill = document.getElementById('bustfill');
    this.bustSecs = document.getElementById('bustsecs');
    this._bustShown = false;
    this.trackEl = document.getElementById('track');
    this.trackFill = document.getElementById('trackfill');
    this._trackShown = false;
    this.scoreEl = document.getElementById('scorevalue');
    this.popsEl = document.getElementById('scorepops');
    this.repairEl = document.getElementById('repair');
    this.repairLabel = document.getElementById('repairlabel');
    this.repairValue = document.getElementById('repairvalue');
    this.repairFill = document.getElementById('repairfill');
    this._repairShown = false;

    this.toastEl = document.getElementById('toast');
    this.centreEl = document.getElementById('applesay');
    this._toastTimer = null;

    this.roadEl = document.getElementById('roadsign');
    this._roadName = '';
    this._roadAt = 0;

    this.speedo = document.getElementById('speedo');
    this.sctx = this.speedo.getContext('2d');
    this.minimap = document.getElementById('minimap');
    this.mctx = this.minimap.getContext('2d');
    /** Expanded, and where it is looking if it has been dragged off the car. */
    this.mapBig = false;
    this.mapCentre = { x: 0, z: 0 };
    this.mapDragged = false;
    this._wireMinimapTap();

    this.messages = [];
    this.smoothSpeed = 0;
    this.smoothRpm = 0;

    this._buildMapTexture();
  }

  // ------------------------------------------------------------- map texture

  _buildMapTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = MAP_PX;
    const ctx = c.getContext('2d');
    const scale = MAP_PX / (WORLD_HALF * 2);

    ctx.fillStyle = '#0d1116';
    ctx.fillRect(0, 0, MAP_PX, MAP_PX);

    const toPx = (x) => (x + WORLD_HALF) * scale;

    // Draw wide roads first so junctions read cleanly.
    const order = ['motorway', 'avenue', 'ramp', 'country', 'street', 'lane'];
    const colour = {
      motorway: '#4a5766', avenue: '#3b444f', ramp: '#3b444f',
      country: '#39413a', street: '#2f353d', lane: '#333a33',
    };

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const kind of order) {
      ctx.strokeStyle = colour[kind];
      for (const e of this.game.graph.edges) {
        // Cuts are not drawn: the ways through between buildings are something
        // the player finds, not something the map hands them.
        if (e.cut) continue;
        if (e.kind !== kind) continue;
        ctx.lineWidth = Math.max(1.4, (ROAD_KIND[kind].width * 0.55) * scale);
        ctx.beginPath();
        ctx.moveTo(toPx(e.points[0].x), toPx(e.points[0].z));
        for (let i = 1; i < e.points.length; i++) {
          ctx.lineTo(toPx(e.points[i].x), toPx(e.points[i].z));
        }
        ctx.stroke();
      }
    }

    this.mapCanvas = c;
    this.mapScale = scale;
  }

  // ------------------------------------------------------------------ radio

  addMessage(text, hot = false) {
    this.messages.push({ text, hot });
    if (this.messages.length > 6) this.messages.shift();
    this.radioEl.innerHTML = this.messages
      .map((m) => `<div class="${m.hot ? 'hot' : ''}"><span>&gt;</span> ${escapeHtml(m.text)}</div>`)
      .join('');
  }

  clearMessages() {
    this.messages.length = 0;
    this.radioEl.innerHTML = '';
    if (this.banner) this.banner.classList.remove('show');
  }

  // ----------------------------------------------------------------- update

  update(dt, player, heat, dispatcher) {
    // ---- wanted stars ----
    const tier = heat.tier;
    let stars = '';
    for (let i = 0; i < 5; i++) stars += i < tier ? '<b>★</b>' : '☆';
    if (this.starsEl.innerHTML !== stars) this.starsEl.innerHTML = stars;

    // Going up is an event, and it used to happen in silence: a star quietly
    // filled in while you were watching the road. Now the panel flashes and
    // the sting plays, which is the only warning you get that the response
    // just changed. Only upward -- the heat sliding back down as you get away
    // is the good news, and it has the ESCAPED banner already.
    if (this._lastTier === undefined) this._lastTier = tier;
    if (tier > this._lastTier) this._flashStars(tier);
    this._lastTier = tier;
    this.heatFill.style.width = (heat.progress * 100).toFixed(0) + '%';

    const st = dispatcher.statusLine();
    if (this.statusEl.textContent !== st.text) this.statusEl.textContent = st.text;
    if (this.statusEl.className !== st.cls) this.statusEl.className = st.cls;

    // ---- gear, or height ----
    // An aircraft has no gearbox and no tyres, and what a pilot actually
    // wants in that corner is how far off the ground they are -- so the gear
    // readout becomes a radar altimeter and the four tyre lights become a
    // fuel gauge. Same four boxes, filling up from the left.
    if (player.isAircraft) {
      const alt = Math.max(0, Math.round(player.radarAlt));
      const g2 = alt >= 1000 ? (alt / 1000).toFixed(1) + 'k' : String(alt);
      if (this.gearEl.textContent !== g2) this.gearEl.textContent = g2;
      if (this.gearLabel && this.gearLabel.textContent !== 'HEIGHT') {
        this.gearLabel.textContent = 'HEIGHT';
      }
      // Fuel on the damage bar, which is a bar and reads as one, rather than
      // on four tyre lights that read as four of something. With a
      // ninety-second tank this is the gauge the whole sortie is flown
      // against, so it says the seconds as well.
      const left = clamp01(player.fuel / AIR_TANK);
      const secs = Math.max(0, Math.round(player.fuel));
      const low = left < 0.25;
      this.dmgFill.style.width = (left * 100).toFixed(1) + '%';
      this.dmgFill.style.background = low ? '#ff3b30' : left < 0.5 ? '#ffb020' : '#35d0a5';
      const label = `${secs}s` + (player.refuelling > 0 ? '  ▲ FUELLING' : '');
      if (this.dmgPct.textContent !== label) this.dmgPct.textContent = label;
      this.dmgPct.className = low ? 'bad' : left < 0.5 ? 'warn' : '';
      if (this.dmgLabel && this.dmgLabel.textContent !== 'FUEL') {
        this.dmgLabel.textContent = 'FUEL';
      }
      // The four lights become the airframe's own condition instead.
      const hurt = clamp01(player.damage);
      for (let i = 0; i < 4; i++) {
        const gone = hurt > i / 4;
        const col = gone ? '#ff3b30' : '#35d0a5';
        const el = this.tyreEls[i];
        if (el.style.background !== col) el.style.background = col;
      }
      this._airHud = true;
    } else {
      if (this._airHud) {
        this._airHud = false;
        this._lastDmg = -1;
        if (this.dmgLabel) this.dmgLabel.textContent = 'DAMAGE';
      }
      this._carGearAndTyres(player);
    }

    // ---- damage ----
    // Worth showing plainly: past about 35% the engine starts losing power,
    // so a driver needs to know why the car has gone flat.
    const dmg = Math.round(player.damage * 100);
    if (!player.isAircraft && dmg !== this._lastDmg) {
      this._lastDmg = dmg;
      this.dmgFill.style.width = dmg + '%';
      this.dmgFill.style.background = dmg > 70 ? '#ff3b30' : dmg > 35 ? '#ffb020' : '#35d0a5';
      this.dmgPct.textContent = dmg + '%' + (dmg > 35 ? '  ▼ PWR' : '');
      this.dmgPct.className = dmg > 70 ? 'bad' : dmg > 35 ? 'warn' : '';
    }

    // ---- busted meter ----
    // Shown as soon as the clock starts, and kept up while it drains, so
    // breaking free reads as the bar falling rather than simply vanishing.
    const show = heat.bustTimer > 0.01;
    if (show !== this._bustShown) {
      this._bustShown = show;
      this.bustEl.classList.toggle('on', show);
    }
    if (show) {
      this.bustFill.style.width = (heat.bustProgress * 100).toFixed(1) + '%';
      this.bustSecs.textContent = heat.bustRemaining.toFixed(1);
      this.bustEl.classList.toggle('pulse', heat.bustPinned && heat.bustRemaining < 2.5);
    }

    // ---- tracking meter ----
    // The window after you break line of sight in which they still know
    // exactly where you are. Only worth showing while there is a pursuit and
    // they cannot currently see you: with eyes on you it would sit full the
    // whole time and say nothing.
    const k = dispatcher.knowledge;
    const tracking = heat.tier > 0 && !k.seen && k.timeSinceSeen < TRACK_SECONDS;
    if (tracking !== this._trackShown) {
      this._trackShown = tracking;
      this.trackEl.classList.toggle('on', tracking);
    }
    if (tracking) {
      const left = clamp01(1 - k.timeSinceSeen / TRACK_SECONDS);
      this.trackFill.style.width = (left * 100).toFixed(1) + '%';
      this.trackEl.classList.toggle('fading', left < 0.34);
    }

    // ---- score ----
    const score = this.game.score;
    if (score) {
      // A frozen run says so, rather than leaving a number that has quietly
      // stopped moving and looks like a bug.
      const val = score.value.toLocaleString() + (score.frozen ? '  — OFF' : '');
      if (this.scoreEl.textContent !== val) this.scoreEl.textContent = val;
      if (this._scoreFrozen !== score.frozen) {
        this._scoreFrozen = score.frozen;
        this.scoreEl.classList.toggle('off', !!score.frozen);
      }
      // Each bonus as a line that rises and fades under the wanted panel.
      const key = score.popups.map((p) => p.text + p.points).join('|');
      if (key !== this._popKey) {
        this._popKey = key;
        this.popsEl.innerHTML = score.popups
          .map((p) => `<div><b>+${p.points.toLocaleString()}</b>${p.text}</div>`).join('');
      }
      const kids = this.popsEl.children;
      for (let i = 0; i < kids.length; i++) {
        const t = score.popups[i] ? score.popups[i].t : 9;
        kids[i].style.opacity = String(Math.max(0, Math.min(1, (2.6 - t) / 0.6)));
        kids[i].style.transform = `translateY(${-Math.min(t, 0.25) * 24 + 6}px)`;
      }
    }

    // ---- garage ----
    const garage = this.game.garage;
    const r = garage ? garage.readout : null;
    const on = !!r;
    if (on !== this._repairShown) {
      this._repairShown = on;
      this.repairEl.classList.toggle('on', on);
    }
    if (r) {
      if (this.repairLabel.textContent !== r.label) this.repairLabel.textContent = r.label;
      if (this.repairValue.textContent !== r.value) this.repairValue.textContent = r.value;
      this.repairFill.style.width = (r.fill * 100).toFixed(1) + '%';
      if (this.repairEl.dataset.cls !== r.cls) {
        this.repairEl.dataset.cls = r.cls;
        this.repairEl.classList.toggle('work', r.cls === 'work');
      }
    }

    this._drawSpeedo(dt, player);
    // A pilot has no use for the name of the road below, and every use for
    // whether the car is in sight. Same plate, different job.
    if (player.isAircraft) this._drawSpotting();
    else this._drawRoadSign(player);
    this._drawMinimap(player, dispatcher, heat);
  }

  // ---------------------------------------------------------------- speedo

  _drawSpeedo(dt, v) {
    const ctx = this.sctx;
    const S = this.speedo.width;
    const cx = S / 2, cy = S / 2, r = S * 0.42;

    // An aircraft's needle is its speed through the air, not its speed along
    // its nose: it can fly sideways, and 80 km/h of drift is still 80 km/h.
    const through = v.isAircraft ? v.speed : v.forwardSpeed;
    this.smoothSpeed = lerp(this.smoothSpeed, Math.abs(toMph(through)), 1 - Math.exp(-14 * dt));
    this.smoothRpm = lerp(this.smoothRpm, v.rpmFraction, 1 - Math.exp(-18 * dt));

    ctx.clearRect(0, 0, S, S);

    const A0 = Math.PI * 0.78;
    const A1 = Math.PI * 2.22;
    // Miles per hour, because the roads outside are signed in them. 180 is
    // past what anything in the game will do, so the needle never pins.
    const maxMph = 180;

    // dial
    ctx.strokeStyle = 'rgba(140,170,200,0.18)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, r, A0, A1);
    ctx.stroke();

    // ticks
    ctx.strokeStyle = 'rgba(200,220,240,0.45)';
    for (let k = 0; k <= maxMph; k += 10) {
      const a = A0 + (A1 - A0) * (k / maxMph);
      const major = k % 30 === 0;
      ctx.lineWidth = major ? 2.5 : 1;
      const r0 = r - (major ? 13 : 7);
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
      ctx.lineTo(cx + Math.cos(a) * (r - 1), cy + Math.sin(a) * (r - 1));
      ctx.stroke();
    }

    // rpm arc
    const rpmA = A0 + (A1 - A0) * this.smoothRpm;
    ctx.lineWidth = 5;
    ctx.strokeStyle = this.smoothRpm > 0.92 ? '#ff3b30' : '#4ea3ff';
    ctx.beginPath();
    ctx.arc(cx, cy, r - 20, A0, Math.max(A0 + 0.01, rpmA));
    ctx.stroke();

    // needle
    const sa = A0 + (A1 - A0) * clamp01(this.smoothSpeed / maxMph);
    ctx.strokeStyle = '#e8eef5';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(cx - Math.cos(sa) * 12, cy - Math.sin(sa) * 12);
    ctx.lineTo(cx + Math.cos(sa) * (r - 26), cy + Math.sin(sa) * (r - 26));
    ctx.stroke();

    // readout
    ctx.fillStyle = '#e8eef5';
    ctx.font = '600 44px ui-monospace, Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(String(Math.round(this.smoothSpeed)), cx, cy + 30);
    ctx.font = '500 13px ui-monospace, Consolas, monospace';
    ctx.fillStyle = '#8c9bab';
    ctx.fillText('mph', cx, cy + 50);
  }

  /**
   * The wanted panel flashing as a star lands.
   *
   * The class is taken off and put back on with a reflow in between, so that
   * two levels in quick succession flash twice rather than the second one
   * being swallowed by the animation the first one started.
   */
  _flashStars(tier) {
    const el = document.getElementById('heat');
    if (el) {
      el.classList.remove('levelup');
      void el.offsetWidth;
      el.classList.add('levelup');
      clearTimeout(this._flashTimer);
      this._flashTimer = setTimeout(() => el.classList.remove('levelup'), 1300);
    }
    if (this.game.audio) this.game.audio.wantedUp(tier);
  }

  /**
   * A line from Control, in the middle of the screen.
   *
   * For the Apple jibes, which are the only thing telling you why the game
   * has gone strange and were only ever said out loud -- so with the sound off
   * the joke happened to nobody at all, and even with it on a line goes past
   * while you are busy driving. Three seconds up, then it fades.
   */
  centreLine(text) {
    if (!this.centreEl) return;
    this.centreEl.textContent = text;
    this.centreEl.classList.add('show');
    clearTimeout(this._centreTimer);
    this._centreTimer = setTimeout(() => this.centreEl.classList.remove('show'), 3000);
  }

  /**
   * A word on screen for a moment: what a control did, when it has no other
   * visible answer. Deliberately small -- the banner is for the chase.
   */
  toast(text) {
    if (!this.toastEl) return;
    this.toastEl.textContent = text;
    this.toastEl.classList.add('on');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => this.toastEl.classList.remove('on'), 1600);
  }

  /**
   * Tap the map to open it; drag it about; tap anything else to put it back.
   *
   * Open, it is twice the size *and* shows two and a half times the ground --
   * the canvas is 380 pixels square behind a 190 px picture, so the big one is
   * drawn pixel for pixel rather than blown up, and the extra ground comes from
   * a wider crop rather than a bigger picture. It also turns north-up, because
   * dragging around a map that is rotating under you is horrible.
   *
   * Dragging moves the view and pins it there; without a drag it stays on the
   * car. A press that does not move is still a tap, so the map closes the way
   * it always did, and a press anywhere else closes it from the document.
   */
  _wireMinimapTap() {
    const wrap = document.getElementById('mapwrap');
    if (!wrap) return;
    const open = (on) => {
      this.mapBig = on;
      wrap.classList.toggle('big', on);
      if (!on) this.mapDragged = false;
    };
    let press = null;
    wrap.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      if (!this.mapBig) { open(true); return; }
      press = { x: e.clientX, y: e.clientY, moved: false };
      if (wrap.setPointerCapture) wrap.setPointerCapture(e.pointerId);
    });
    wrap.addEventListener('pointermove', (e) => {
      if (!press || !this.mapBig) return;
      const dx = e.clientX - press.x, dy = e.clientY - press.y;
      // A few pixels of slop, so a shaky tap is still a tap.
      if (!press.moved && Math.hypot(dx, dy) < 4) return;
      press.x = e.clientX; press.y = e.clientY;
      if (!press.moved) {
        press.moved = true;
        // Take over from wherever the view had got to following the car.
        const p = this.game.player;
        if (!this.mapDragged && p) { this.mapCentre.x = p.position.x; this.mapCentre.z = p.position.z; }
        this.mapDragged = true;
      }
      // Metres per screen pixel, off the canvas's own box so the CSS scale is
      // already in it. North-up, so screen x is world x and screen y is world z.
      const rect = this.minimap.getBoundingClientRect();
      const m = BIG_SPAN / Math.max(1, rect.width);
      this.mapCentre.x -= dx * m;
      this.mapCentre.z -= dy * m;
      const lim = Math.max(0, WORLD_HALF - BIG_SPAN / 2);
      this.mapCentre.x = clamp(this.mapCentre.x, -lim, lim);
      this.mapCentre.z = clamp(this.mapCentre.z, -lim, lim);
    });
    const release = (e) => {
      if (press && !press.moved) open(false);
      if (press && wrap.releasePointerCapture) {
        try { wrap.releasePointerCapture(e.pointerId); } catch (_) { /* gone already */ }
      }
      press = null;
    };
    wrap.addEventListener('pointerup', release);
    wrap.addEventListener('pointercancel', release);
    document.addEventListener('pointerdown', () => open(false));
  }

  // ------------------------------------------------------------- road sign
  /**
   * Which road you are on, on a nameplate beside the speedometer.
   *
   * The names are the ones dispatch has always used on the radio ("last seen
   * on Cold Harbour"), so the plate and the voice agree, and a call about a
   * road you are nowhere near is easy to tell from one about the road you are
   * on. Looked up a few times a second rather than every frame -- it is a
   * search through the road index, and the answer changes at walking pace.
   *
   * Cutting across a field keeps the last road, dimmed: a name that blanks
   * every time two wheels touch grass is worse than one that is a moment out
   * of date.
   */
  /**
   * Whether the pilot can call it in, and if not, why not.
   *
   * The whole role is one key, and nothing on screen used to say whether
   * pressing it would do anything -- so a pilot who was slightly too far, or
   * pointed the wrong way, or behind a roof, got the same silence as one with
   * nobody to find. Green means press it.
   */
  _drawSpotting() {
    if (!this.roadEl) return;
    const sp = this.game.spotting;
    const text = sp ? sp.text : 'NO TARGET';
    if (this.roadEl.textContent !== text) this.roadEl.textContent = text;
    this.roadEl.hidden = false;
    const cls = sp && sp.state === 'ready' ? 'spot-on'
      : sp && sp.state === 'wait' ? 'spot-wait' : 'off';
    if (this.roadEl.className !== cls) this.roadEl.className = cls;
  }

  _drawRoadSign(v) {
    if (!this.roadEl) return;
    const now = performance.now();
    if (now - this._roadAt < 250) return;
    this._roadAt = now;

    const name = this.game.roadSign ? this.game.roadSign(v.position) : '';
    if (name && name !== this._roadName) {
      this._roadName = name;
      this.roadEl.textContent = name;
    }
    this.roadEl.hidden = !this._roadName;
    this.roadEl.classList.toggle('off', !name);
  }

  /** Gear and the four tyre lights: the car's half of that corner of the HUD. */
  _carGearAndTyres(player) {
    const g = player.gear === -1 ? 'R' : player.gear === 0 ? 'N' : String(player.gear);
    if (this.gearEl.textContent !== g) this.gearEl.textContent = g;
    if (this.gearLabel && this.gearLabel.textContent !== 'GEAR') {
      this.gearLabel.textContent = 'GEAR';
    }
    for (let i = 0; i < 4; i++) {
      const w = player.wheels[i];
      const s = clamp01(w.slip);
      const el = this.tyreEls[i];
      // A flat tyre -- a stinger -- flashes red until it is fixed.
      const flat = w.condition < 0.8 && (performance.now() % 700) < 420;
      const col = flat ? '#ff3b30'
        : !w.grounded ? '#3a4048'
          : s > 0.6 ? `rgb(255,${Math.round(90 + (1 - s) * 120)},40)`
            : `rgb(${Math.round(50 + s * 200)},${Math.round(110 + s * 60)},${Math.round(120 - s * 60)})`;
      if (el.style.background !== col) el.style.background = col;
    }
  }

  // --------------------------------------------------------------- minimap

  /**
   * Heading-up minimap: the map rotates under a fixed player marker, so
   * "ahead" is always up. The source crop is oversized by sqrt(2) so the
   * corners stay covered as it turns.
   */
  _drawMinimap(player, dispatcher, heat) {
    const ctx = this.mctx;
    const W = this.minimap.width;
    const src = this.mapCanvas;

    // Expanded, the map is north-up and shows a lot more ground; small, it is
    // heading-up and centred on the car as it always was.
    //
    // One angle does all of that. The projection below turns the world so that
    // `ang` points up the screen, and north here is -z, which is `ang = PI` --
    // so passing PI instead of the car's heading gives a north-up map and every
    // marker, tail and the N itself follow without a single special case.
    const big = this.mapBig;
    const span = big ? BIG_SPAN : MAP_SPAN;
    const heading = Math.atan2(player.forward.x, player.forward.z);
    const ang = big ? Math.PI : heading;

    // What the view is centred on. Expanded it starts on the car and follows it
    // around, until it is dragged -- after which it stays where it was put,
    // because a map that slides out from under the finger is no use for looking
    // at the far side of town. Clamped so the edge of the world cannot be
    // dragged into the middle of the picture.
    let cx = player.position.x, cz = player.position.z;
    if (big && this.mapDragged) { cx = this.mapCentre.x; cz = this.mapCentre.z; }
    if (big) {
      const lim = Math.max(0, WORLD_HALF - span / 2);
      cx = clamp(cx, -lim, lim);
      cz = clamp(cz, -lim, lim);
    }

    // Published so what the map is actually showing can be checked rather than
    // assumed: metres across the view, and where its middle is.
    this.mapSpanNow = span;
    this.mapCentreNow = { x: cx, z: cz };

    const OVER = big ? 1 : 1.45;
    const spanPx = span * this.mapScale * OVER;
    const sx = (cx + WORLD_HALF) * this.mapScale - spanPx / 2;
    const sy = (cz + WORLD_HALF) * this.mapScale - spanPx / 2;

    ctx.fillStyle = '#0d1116';
    ctx.fillRect(0, 0, W, W);

    ctx.save();
    ctx.translate(W / 2, W / 2);
    // The map image has +x to the right and +z downward. Rotating by
    // heading + PI turns the car's forward vector to point up the screen.
    ctx.rotate(ang + Math.PI);
    const D = W * OVER;
    ctx.drawImage(src, sx, sy, spanPx, spanPx, -D / 2, -D / 2, D, D);
    ctx.restore();

    const k = W / span;              // pixels per metre on the minimap
    // Project a world point into the rotated frame: `ang` is up, and its right
    // is to the right.
    const sh = Math.sin(ang), ch = Math.cos(ang);
    const toMap = (x, z) => {
      const dx = x - cx, dz = z - cz;
      const fwd = dx * sh + dz * ch;
      const right = -dx * ch + dz * sh;
      return { x: W / 2 + right * k, y: W / 2 - fwd * k };
    };

    // ---- detection ring ----
    // How far the force can see you right now, centred on your own marker.
    // Only up while they actually have contact: once they are searching, the
    // ring would be telling you about a rule that is no longer the one in
    // force, and the last-known marker below is the useful thing instead.
    //
    // It is a range limit, not a guarantee. Line of sight still has to be
    // clear, so a unit inside the ring with a building between you cannot see
    // you -- but a unit outside it cannot see you at all, whatever is in the
    // way. That is the whole point of drawing it.
    // Centred on the car, which is the middle of the picture until the map has
    // been dragged off it.
    const me = toMap(player.position.x, player.position.z);
    if (heat.tier > 0 && dispatcher.inContact && dispatcher.sightRange) {
      const rad = dispatcher.sightRange * k;
      ctx.save();
      ctx.beginPath();
      ctx.arc(me.x, me.y, rad, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,59,48,0.55)';
      ctx.lineWidth = 2;
      ctx.setLineDash([7, 6]);
      ctx.stroke();
      ctx.setLineDash([]);
      // A wash inside it, so "inside the ring" reads at a glance.
      const grd = ctx.createRadialGradient(me.x, me.y, rad * 0.55, me.x, me.y, rad);
      grd.addColorStop(0, 'rgba(255,59,48,0)');
      grd.addColorStop(1, 'rgba(255,59,48,0.13)');
      ctx.fillStyle = grd;
      ctx.fill();
      ctx.restore();
    }

    // ---- last known position, if they have lost you ----
    // Only once the tracking bar has emptied: until then the "last known"
    // position is simply where the car is, and drawing it as a guess while the
    // force still has a hard fix says the opposite of what is happening.
    const kn = dispatcher.knowledge;
    if (heat.tier > 0 && !kn.seen && !dispatcher.inContact && kn.confidence > 0) {
      const p = toMap(kn.position.x, kn.position.z);
      const rad = lerp(70, 12, kn.confidence) * k;
      ctx.strokeStyle = `rgba(255,176,32,${0.25 + kn.confidence * 0.4})`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(p.x, p.y, rad, 0, Math.PI * 2);
      ctx.stroke();
    }

    // ---- air support ----
    // Drawn before the cars so a unit on top of it still reads, and with its
    // own sight circle: while you are inside that, hiding does not work.
    const heli = this.game.helicopter;
    if (heli && heli.active) {
      const p = toMap(heli.pos.x, heli.pos.z);

      // The searchlight, where it is actually pointing -- not a detection
      // radius round the aircraft. The light is what sees you, it moves
      // independently of the airframe, and it is something you can watch and
      // drive out of, so it is the thing worth drawing.
      const b = toMap(heli.beam.x, heli.beam.z);
      ctx.fillStyle = 'rgba(255,240,180,0.20)';
      ctx.beginPath();
      ctx.arc(b.x, b.y, 26 * k, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,240,180,0.65)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(b.x, b.y, 26 * k, 0, Math.PI * 2);
      ctx.stroke();

      ctx.fillStyle = '#ffe9a3';
      ctx.beginPath();
      ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
      ctx.fill();
      // Rotor tick, so it is not mistaken for another car.
      ctx.strokeStyle = '#ffe9a3';
      ctx.lineWidth = 2;
      const a = performance.now() * 0.012;
      ctx.beginPath();
      ctx.moveTo(p.x - Math.cos(a) * 10, p.y - Math.sin(a) * 10);
      ctx.lineTo(p.x + Math.cos(a) * 10, p.y + Math.sin(a) * 10);
      ctx.stroke();
    }

    // ---- the garage ----
    // Always on the map, and pinned to the edge in its direction when it is
    // further away than the map shows, so it can be found from anywhere.
    const gm = this.game.garage && this.game.garage.marker;
    if (gm) {
      let p = toMap(gm.x, gm.z);
      const dx = p.x - W / 2, dy = p.y - W / 2;
      const lim = W / 2 - 18;
      const far = Math.max(Math.abs(dx), Math.abs(dy)) > lim;
      if (far) {
        const s = lim / Math.max(Math.abs(dx), Math.abs(dy));
        p = { x: W / 2 + dx * s, y: W / 2 + dy * s };
      }
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.fillStyle = '#2f9d5c';
      ctx.strokeStyle = '#e9f7ee';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(-13, -13, 26, 26, 6); else ctx.rect(-13, -13, 26, 26);
      ctx.fill();
      ctx.stroke();
      // A spanner, as on the bay floor.
      ctx.rotate(-Math.PI / 4);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(-2.2, -3, 4.4, 13);
      ctx.beginPath();
      ctx.arc(0, -5.5, 5.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#2f9d5c';
      ctx.fillRect(-2, -12, 4, 6.5);
      ctx.restore();
    }

    // ---- the suspect, when you are the one chasing them ----
    // A police player is told where the car is for as long as the pursuit has
    // eyes on it, the way the rest of the force is; the marker is the same
    // orange as the car's own blip on the escapee's map.
    if (this.suspect) {
      // Seen: a solid dot where they are. Lost: the last place anybody saw
      // them, flashing, so it reads as a memory rather than a position.
      const blink = this.suspectStale ? (Math.floor(performance.now() / 380) % 2 === 0) : true;
      if (blink) {
        const p = toMap(this.suspect.x, this.suspect.z);
        const edge = 11;
        const off = p.x < edge || p.y < edge || p.x > W - edge || p.y > W - edge;
        ctx.globalAlpha = this.suspectStale ? 0.75 : 1;
        ctx.fillStyle = '#ff7a1a';
        if (off) {
          // Past the edge of what the map shows, which in a chase is most of
          // the time: hold the marker against the rim as an arrow pointing
          // the way they went, so the map still answers "which way".
          const cx = W / 2, cy = W / 2;
          let dx = p.x - cx, dy = p.y - cy;
          const len = Math.hypot(dx, dy) || 1;
          dx /= len; dy /= len;
          const r = W / 2 - edge;
          const ax = cx + dx * r, ay = cy + dy * r;
          ctx.save();
          ctx.translate(ax, ay);
          ctx.rotate(Math.atan2(dy, dx));
          ctx.beginPath();
          ctx.moveTo(8, 0);
          ctx.lineTo(-5, 5.5);
          ctx.lineTo(-5, -5.5);
          ctx.closePath();
          ctx.fill();
          ctx.strokeStyle = 'rgba(255,255,255,0.85)';
          ctx.lineWidth = 1.5;
          ctx.stroke();
          ctx.restore();
        } else {
          ctx.beginPath();
          ctx.arc(p.x, p.y, 8, 0, Math.PI * 2);
          if (this.suspectStale) {
            ctx.lineWidth = 2.5;
            ctx.strokeStyle = '#ff7a1a';
            ctx.stroke();
          } else {
            ctx.fill();
            ctx.strokeStyle = 'rgba(255,255,255,0.85)';
            ctx.lineWidth = 2.5;
            ctx.stroke();
          }
        }
        ctx.globalAlpha = 1;
      }
    }

    // ---- police ----
    for (const u of dispatcher.units) {
      // A wrecked unit is out of the pursuit; leaving it on the map just
      // makes you plan around a car that is never coming.
      if (u.vehicle.disabled || u.vehicle.damage >= 0.85) continue;

      const p = toMap(u.position.x, u.position.z);
      if (p.x < -20 || p.y < -20 || p.x > W + 20 || p.y > W + 20) continue;

      ctx.fillStyle = u.role === 'intercept' ? '#ffb020'
        : (u.role === 'pit' || u.role === 'box') ? '#ff3b30' : '#4ea3ff';
      ctx.beginPath();
      ctx.arc(p.x, p.y, 7, 0, Math.PI * 2);
      ctx.fill();

      // A short tail showing which way they are going reads faster than a dot.
      if (u.vehicle.speed > 3) {
        const f = u.vehicle.forward;
        const tf = f.x * sh + f.z * ch;
        const tr = -f.x * ch + f.z * sh;
        ctx.strokeStyle = ctx.fillStyle;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x + tr * 16, p.y - tf * 16);
        ctx.stroke();
      }
    }

    // ---- other players' helicopters ----
    //
    // A remote aircraft is not a car and not a dispatcher unit -- it has no
    // collider and nothing to send anywhere -- so it fell through both of
    // the loops above and appeared on nobody's map. Which is the worst thing
    // for it to be missing from: a helicopter is the one unit you cannot see
    // out of the window and most want to know about.
    if (this.game.netAir) {
      for (const a of this.game.netAir.values()) {
        const q = toMap(a.pos.x, a.pos.z);
        if (q.x < -20 || q.y < -20 || q.x > W + 20 || q.y > W + 20) continue;
        ctx.save();
        ctx.translate(q.x, q.y);
        ctx.fillStyle = '#ffe9a3';
        ctx.beginPath();
        ctx.arc(0, 0, 5.5, 0, Math.PI * 2);
        ctx.fill();
        // A turning rotor, so it reads as the aircraft rather than a unit.
        ctx.strokeStyle = '#ffe9a3';
        ctx.lineWidth = 2;
        const spin = performance.now() * 0.012;
        ctx.beginPath();
        ctx.moveTo(-Math.cos(spin) * 10, -Math.sin(spin) * 10);
        ctx.lineTo(Math.cos(spin) * 10, Math.sin(spin) * 10);
        ctx.stroke();
        ctx.restore();
      }
    }

    // ---- north marker, since the map now turns under you ----
    const nx = W / 2 - sh * W * 0.43;
    const ny = W / 2 + ch * W * 0.43;
    ctx.fillStyle = 'rgba(180,200,220,0.55)';
    ctx.font = '600 20px ui-monospace, Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('N', nx, ny);

    // ---- player ----
    // On the small map this is the middle of the picture pointing straight up,
    // as it always was, and the maths below says so on its own: the car's own
    // heading is what the frame is turned by. Expanded and dragged, the car is
    // somewhere off in the picture and pointing wherever it is pointing, so the
    // marker is drawn where it actually is and turned to match.
    const pf = player.forward;
    ctx.save();
    ctx.translate(me.x, me.y);
    ctx.rotate(Math.atan2(-pf.x * ch + pf.z * sh, pf.x * sh + pf.z * ch));
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(0, -14);
    ctx.lineTo(9, 10);
    ctx.lineTo(0, 5);
    ctx.lineTo(-9, 10);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // frame
    ctx.strokeStyle = 'rgba(140,170,200,0.25)';
    ctx.lineWidth = 4;
    ctx.strokeRect(0, 0, W, W);
  }

  // ---------------------------------------------------------------- overlay

  showOverlay(title, sub, { canRestart = true } = {}) {
    this.otitle.textContent = title;
    this.osub.innerHTML = sub;
    // A police player in a multiplayer game cannot start the chase again --
    // that is the escapee's to do -- so do not tell them to press R.
    const hint = document.getElementById('ohint');
    if (hint) hint.hidden = !canRestart;
    this.overlay.classList.add('show');
  }

  hideOverlay() { this.overlay.classList.remove('show'); }

  /**
   * A big line across the middle of the screen that goes away by itself.
   *
   * For the things that are worth announcing but are not the end of the run --
   * escaping, most obviously. Nothing is paused and nothing wants a keypress.
   */
  flash(title, sub, seconds = 4.5) {
    if (!this.banner) return;
    this.btitle.textContent = title;
    this.bsub.innerHTML = sub || '';
    this.banner.classList.add('show');
    if (this._bannerTimer) clearTimeout(this._bannerTimer);
    this._bannerTimer = setTimeout(() => {
      this.banner.classList.remove('show');
      this._bannerTimer = null;
    }, seconds * 1000);
  }
  toggleHelp() { this.helpEl.classList.toggle('show'); }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
