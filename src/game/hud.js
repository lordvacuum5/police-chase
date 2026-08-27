// Heads-up display.
//
// Everything here is 2D canvas or DOM, kept off the WebGL path so it costs the
// GPU nothing. The minimap is the one piece that needs care: the whole road
// network is rasterised once into an offscreen canvas at load, and each frame
// only blits a crop of it.

import { clamp, clamp01, lerp, toKmh } from '../util/math.js';
import { ROAD_KIND } from '../world/roadgraph.js';
import { WORLD_HALF } from '../world/common.js';
import { TRACK_SECONDS } from '../ai/dispatcher.js';

const MAP_PX = 1200;          // offscreen map resolution
const MAP_SPAN = 470;         // metres visible on the minimap

export class Hud {
  constructor(game) {
    this.game = game;

    this.starsEl = document.getElementById('stars');
    this.heatFill = document.getElementById('heatfill');
    this.statusEl = document.getElementById('status');
    this.gearEl = document.getElementById('gear');
    this.radioEl = document.getElementById('radiolog');
    this.overlay = document.getElementById('overlay');
    this.otitle = document.getElementById('otitle');
    this.osub = document.getElementById('osub');
    this.helpEl = document.getElementById('help');
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

    this.speedo = document.getElementById('speedo');
    this.sctx = this.speedo.getContext('2d');
    this.minimap = document.getElementById('minimap');
    this.mctx = this.minimap.getContext('2d');

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
  }

  // ----------------------------------------------------------------- update

  update(dt, player, heat, dispatcher) {
    // ---- wanted stars ----
    const tier = heat.tier;
    let stars = '';
    for (let i = 0; i < 5; i++) stars += i < tier ? '<b>★</b>' : '☆';
    if (this.starsEl.innerHTML !== stars) this.starsEl.innerHTML = stars;
    this.heatFill.style.width = (heat.progress * 100).toFixed(0) + '%';

    const st = dispatcher.statusLine();
    if (this.statusEl.textContent !== st.text) this.statusEl.textContent = st.text;
    if (this.statusEl.className !== st.cls) this.statusEl.className = st.cls;

    // ---- gear ----
    const g = player.gear === -1 ? 'R' : player.gear === 0 ? 'N' : String(player.gear);
    if (this.gearEl.textContent !== g) this.gearEl.textContent = g;

    // ---- tyres ----
    for (let i = 0; i < 4; i++) {
      const w = player.wheels[i];
      const s = clamp01(w.slip);
      const el = this.tyreEls[i];
      const col = !w.grounded ? '#3a4048'
        : s > 0.6 ? `rgb(255,${Math.round(90 + (1 - s) * 120)},40)`
          : `rgb(${Math.round(50 + s * 200)},${Math.round(110 + s * 60)},${Math.round(120 - s * 60)})`;
      if (el.style.background !== col) el.style.background = col;
    }

    // ---- damage ----
    // Worth showing plainly: past about 35% the engine starts losing power,
    // so a driver needs to know why the car has gone flat.
    const dmg = Math.round(player.damage * 100);
    if (dmg !== this._lastDmg) {
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

    this._drawSpeedo(dt, player);
    this._drawMinimap(player, dispatcher, heat);
  }

  // ---------------------------------------------------------------- speedo

  _drawSpeedo(dt, v) {
    const ctx = this.sctx;
    const S = this.speedo.width;
    const cx = S / 2, cy = S / 2, r = S * 0.42;

    this.smoothSpeed = lerp(this.smoothSpeed, Math.abs(toKmh(v.forwardSpeed)), 1 - Math.exp(-14 * dt));
    this.smoothRpm = lerp(this.smoothRpm, v.rpmFraction, 1 - Math.exp(-18 * dt));

    ctx.clearRect(0, 0, S, S);

    const A0 = Math.PI * 0.78;
    const A1 = Math.PI * 2.22;
    const maxKmh = 300;

    // dial
    ctx.strokeStyle = 'rgba(140,170,200,0.18)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, r, A0, A1);
    ctx.stroke();

    // ticks
    ctx.strokeStyle = 'rgba(200,220,240,0.45)';
    for (let k = 0; k <= maxKmh; k += 20) {
      const a = A0 + (A1 - A0) * (k / maxKmh);
      const major = k % 60 === 0;
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
    const sa = A0 + (A1 - A0) * clamp01(this.smoothSpeed / maxKmh);
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
    ctx.fillText('km/h', cx, cy + 50);
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

    const heading = Math.atan2(player.forward.x, player.forward.z);
    const OVER = 1.45;
    const spanPx = MAP_SPAN * this.mapScale * OVER;
    const sx = (player.position.x + WORLD_HALF) * this.mapScale - spanPx / 2;
    const sy = (player.position.z + WORLD_HALF) * this.mapScale - spanPx / 2;

    ctx.fillStyle = '#0d1116';
    ctx.fillRect(0, 0, W, W);

    ctx.save();
    ctx.translate(W / 2, W / 2);
    // The map image has +x to the right and +z downward. Rotating by
    // heading + PI turns the car's forward vector to point up the screen.
    ctx.rotate(heading + Math.PI);
    const D = W * OVER;
    ctx.drawImage(src, sx, sy, spanPx, spanPx, -D / 2, -D / 2, D, D);
    ctx.restore();

    const k = W / MAP_SPAN;          // pixels per metre on the minimap
    // Project a world point into the rotated frame: forward is up, and the
    // car's right is to the right.
    const sh = Math.sin(heading), ch = Math.cos(heading);
    const toMap = (x, z) => {
      const dx = x - player.position.x, dz = z - player.position.z;
      const fwd = dx * sh + dz * ch;
      const right = -dx * ch + dz * sh;
      return { x: W / 2 + right * k, y: W / 2 - fwd * k };
    };

    // ---- last known position, if they have lost you ----
    const kn = dispatcher.knowledge;
    if (heat.tier > 0 && !kn.seen && kn.confidence > 0) {
      const p = toMap(kn.position.x, kn.position.z);
      const rad = lerp(70, 12, kn.confidence) * k;
      ctx.strokeStyle = `rgba(255,176,32,${0.25 + kn.confidence * 0.4})`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(p.x, p.y, rad, 0, Math.PI * 2);
      ctx.stroke();
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

    // ---- north marker, since the map now turns under you ----
    const nx = W / 2 - sh * W * 0.43;
    const ny = W / 2 + ch * W * 0.43;
    ctx.fillStyle = 'rgba(180,200,220,0.55)';
    ctx.font = '600 20px ui-monospace, Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('N', nx, ny);

    // ---- player: fixed, always pointing up ----
    const c = W / 2;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(c, c - 14);
    ctx.lineTo(c + 9, c + 10);
    ctx.lineTo(c, c + 5);
    ctx.lineTo(c - 9, c + 10);
    ctx.closePath();
    ctx.fill();

    // frame
    ctx.strokeStyle = 'rgba(140,170,200,0.25)';
    ctx.lineWidth = 4;
    ctx.strokeRect(0, 0, W, W);
  }

  // ---------------------------------------------------------------- overlay

  showOverlay(title, sub) {
    this.otitle.textContent = title;
    this.osub.innerHTML = sub;
    this.overlay.classList.add('show');
  }

  hideOverlay() { this.overlay.classList.remove('show'); }
  toggleHelp() { this.helpEl.classList.toggle('show'); }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
