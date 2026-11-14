// The daily challenge.
//
// "Daily challenges ... everyone is on the same thing ... It would have to be hard though ... level 5 with
// the helicopter ... you can't hit anything almost ... you can hit streetlights and stuff, but if you hit a
// building, tree, any other car [it's over] ... a route system ... a little blue line on the mini-map of
// which way to go ... rolling roadblocks and spike strips quite often along that route. And ... give me like
// a minute almost to get across the map."
//
// Everything about a day is worked out from the date (UTC), on each player's own machine: the map, the
// car, the start, the finish, the road between them, and where the blocks and the stingers are. Nothing has
// to be sent anywhere for two people to be given the same run -- the maps are built from fixed seeds, so the
// same date picks the same nodes of the same road graph everywhere. Only the times go to the server
// (server/Program.cs, /api/daily), for the day's table.
//
// The rules (DailyChallenge.update):
//   * five stars from the start, helicopter and all, and they stay at five;
//   * hitting things costs damage as in any chase, and 100% damage ends it. (It used to end on touching a
//     building, a tree or another car; the player had that taken out.)
//   * busted ends it; so does the clock;
//   * the finish is the end of the blue line.
import * as THREE from 'three';
import { MAPS } from '../world/maps.js';
import { GROUP } from '../physics/world.js';
import { makeRng, clamp } from '../util/math.js';

const DAILY_KEY = 'pc.daily';
const BEST_KEY = 'pc.dailybest';
const NAME_KEY = 'pc.name';
const KEY_KEY = 'pc.key';

/** The cars a day can give you, and how fast each covers a route on average, m/s, for the clock (DAILY_PACE). */
export const DAILY_CARS = ['runner', 'supercar', 'offroad'];
const CAR_NAMES = { runner: 'Runner', supercar: 'Stiletto', offroad: 'Badger' };
/** The clock, as a share of the route's length over DAILY_PACE. Was 1: "the time limit seems a little bit too easy." */
const DAILY_SLACK = 0.85;
/** Gates to drive through along the route, this far apart, m; this many standing ahead of you at once. */
const GATE_EVERY = 90;
const GATES_SHOWN = 3;
/** A gate's arch reaches this far past each kerb, m; and a gate this far behind you, m, along the route, is missed. */
const GATE_SPARE = 2.5;
const GATE_MISSED = 35;
/** Further than this from the line, m, and OFF ROUTE comes up: "you can deviate quite a lot, but if you deviate loads ..." */
const OFF_ROUTE = 55;
/** How long a route, m: about a minute of driving. */
const ROUTE_MIN = 1100, ROUTE_MAX = 1500;
/** The first obstacle this far along, then one every OBSTACLE_EVERY, none in the last OBSTACLE_END. */
const OBSTACLE_FIRST = 260, OBSTACLE_EVERY = 230, OBSTACLE_END = 150;
/** Put down this far ahead of you along the route, taken away this far behind. */
const OBSTACLE_AHEAD = 330, OBSTACLE_BEHIND = 70;
/** Within this of the end of the line is the finish, m. */
const FINISH_R = 14;
/** What counts as hitting something. */
const HARD = GROUP.BUILDING | GROUP.PROP;

/** Today, as the day's name: UTC, so everyone in the world is on the same one at the same moment. */
export function dayKey(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** The parts of a day that are chosen before a map is built: which map, and which car. */
export function dailyPlan(day = dayKey()) {
  const rng = makeRng(hash(`daily:${day}`));
  const maps = MAPS.filter((m) => !m.hidden);
  const map = maps[Math.floor(rng() * maps.length) % maps.length];
  const car = DAILY_CARS[Math.floor(rng() * DAILY_CARS.length) % DAILY_CARS.length];
  return { day, mapId: map.id, mapName: map.name, car, carName: CAR_NAMES[car] };
}

/** The day being played in this tab, if a daily challenge is on; null otherwise. A new day ends it. */
export function dailyActive() {
  try {
    const d = sessionStorage.getItem(DAILY_KEY);
    if (d && d === dayKey()) return d;
    if (d) sessionStorage.removeItem(DAILY_KEY);
  } catch (e) { /* storage blocked */ }
  return null;
}

export function setDaily(day) {
  try {
    if (day) sessionStorage.setItem(DAILY_KEY, day);
    else sessionStorage.removeItem(DAILY_KEY);
  } catch (e) { /* storage blocked */ }
}

/** Your best time for a day on this machine, seconds, or null. */
export function dailyBest(day = dayKey()) {
  try {
    const all = JSON.parse(localStorage.getItem(BEST_KEY) || '{}');
    return typeof all[day] === 'number' ? all[day] : null;
  } catch (e) { return null; }
}

function saveBest(day, t) {
  try {
    const all = JSON.parse(localStorage.getItem(BEST_KEY) || '{}');
    if (typeof all[day] !== 'number' || t < all[day]) all[day] = t;
    // Only the last fortnight: nobody needs last March.
    for (const k of Object.keys(all).sort().slice(0, -14)) delete all[k];
    localStorage.setItem(BEST_KEY, JSON.stringify(all));
  } catch (e) { /* storage blocked */ }
}

export function savedName() {
  try { return localStorage.getItem(NAME_KEY) || ''; } catch (e) { return ''; }
}

function saveName(n) {
  try { localStorage.setItem(NAME_KEY, n); } catch (e) { /* storage blocked */ }
}

/** The day's table from the server: [{ name, time, car }], fastest first. Empty if it cannot be reached. */
export async function fetchBoard(day = dayKey()) {
  try {
    const r = await fetch(`/api/daily?day=${encodeURIComponent(day)}`, { cache: 'no-store' });
    if (!r.ok) return [];
    const j = await r.json();
    return Array.isArray(j) ? j : [];
  } catch (e) { return []; }
}

/**
 * This device's key: random, made once, kept. The server locks a name to the first key that posts with it
 * (server/Program.cs), so nobody else can post under your name. Clearing the browser's data loses it, and
 * with it the name.
 */
function deviceKey() {
  try {
    let k = localStorage.getItem(KEY_KEY);
    if (!k) {
      k = (crypto.randomUUID ? crypto.randomUUID()
        : Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join(''));
      localStorage.setItem(KEY_KEY, k);
    }
    return k;
  } catch (e) { return ''; }
}

/** Rows on success, 'taken' if the name is someone else's, null if it could not be sent. */
async function postTime(day, name, time, car) {
  try {
    const r = await fetch('/api/daily', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ day, name, time, car, key: deviceKey() }),
    });
    if (r.status === 409) return 'taken';
    if (!r.ok) return null;
    const j = await r.json();
    return Array.isArray(j) ? j : null;
  } catch (e) { return null; }
}

export function fmtTime(t) {
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** The table as HTML rows, with `mine` marked. */
export function boardHtml(rows, mine = '') {
  if (!rows.length) return '<div class="dnone">No times yet today.</div>';
  return '<ol class="dboard">' + rows.slice(0, 10).map((r) => {
    const me = mine && r.name === mine ? ' class="me"' : '';
    return `<li${me}><span>${escapeHtml(r.name)}</span><b>${fmtTime(r.time)}</b></li>`;
  }).join('') + '</ol>';
}

export class DailyChallenge {
  constructor(game, day) {
    this.game = game;
    this.plan = dailyPlan(day);
    this.day = day;
    this.route = null;
    this.state = 'ready';           // ready | running | won | failed
    this.time = 0;
    this.obstacles = [];
    this.progress = 0;
    this._idx = 0;
    this.el = document.getElementById('daily');
  }

  /**
   * The route, from the road graph: a start and a finish ROUTE_MIN-ROUTE_MAX metres of road apart, chosen
   * by the day's own random numbers, so the same everywhere. Called once the map is built.
   */
  build() {
    const g = this.game.graph;
    const rng = makeRng(hash(`route:${this.day}:${this.plan.mapId}`));
    const ok = (n) => n.edges.length > 0 && !n.quarry && n.edges.some((id) => !g.edges[id].cut && g.edges[id].width >= 7);
    const nodes = g.nodes.filter(ok);
    for (let tries = 0; tries < 400 && !this.route; tries++) {
      const a = nodes[Math.floor(rng() * nodes.length) % nodes.length];
      const b = nodes[Math.floor(rng() * nodes.length) % nodes.length];
      const straight = Math.hypot(b.x - a.x, b.z - a.z);
      if (straight < ROUTE_MIN * 0.6 || straight > ROUTE_MAX) continue;
      const path = g.route(a.id, b.id);
      if (!path || path.length < 3) continue;
      let len = 0;
      for (let i = 0; i < path.length - 1; i++) {
        const e = g.edgeBetween(path[i], path[i + 1]);
        if (!e || e.cut || e.width < 7) { len = -1; break; }
        len += e.length;
      }
      if (len < ROUTE_MIN || len > ROUTE_MAX) continue;
      const pts = g.pathToPoints(path, 0, true);
      if (pts.length < 4) continue;
      // Every point needs a road under it to place a car at the start.
      const first = g.edgeBetween(path[0], path[1]);
      const place = this.game._placeOnRoad(a, (e) => e === first);
      if (!place) continue;
      this.route = { path, pts, len, start: place };
    }
    if (!this.route) return false;
    // Distance along the line at each point.
    const pts = this.route.pts;
    pts[0].s = 0;
    for (let i = 1; i < pts.length; i++) pts[i].s = pts[i - 1].s + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
    this.route.length = pts[pts.length - 1].s;
    this.limit = Math.round(this.route.length / this._pace() * DAILY_SLACK);
    // The obstacles, by the same numbers: a stinger or a half-block, on alternate sides.
    const orng = makeRng(hash(`obstacles:${this.day}`));
    for (let s = OBSTACLE_FIRST; s < this.route.length - OBSTACLE_END; s += OBSTACLE_EVERY * (0.85 + orng() * 0.3)) {
      this.obstacles.push({ s, kind: orng() < 0.5 ? 'stinger' : 'block', side: orng() < 0.5 ? 1 : -1, block: null, done: false });
    }
    this._finishMarker();
    this._buildGates();
    return true;
  }

  /**
   * The gates: an arch across the road every GATE_EVERY metres of the route, and every one of them a
   * checkpoint. "Big visuals so you know which way to go ... I want it that you have to go through each one
   * like a checkpoint, and if you fail to go through one, you have to like go back and go through it. It
   * doesn't matter which direction you go through it, but you have to go through them all. To be able to
   * then actually finish." The first one not yet driven through and the two after it stand at once (three
   * meshes, moved along; nothing that collides), a missed one in orange.
   */
  _buildGates() {
    this.gates = [];
    for (let s = 60; s < this.route.length - 40; s += GATE_EVERY) {
      const site = this._siteAt(s);
      // Kerb to kerb and a little more: "make sure they fully go over the road."
      const r = Math.max(5, site.width * 0.5 + GATE_SPARE);
      this.gates.push({ s, x: site.x, z: site.z, tx: site.tx, tz: site.tz, r, passed: false });
    }
    const geo = new THREE.TorusGeometry(1, 0.045, 8, 40, Math.PI);
    this.gateMeshes = [];
    for (let i = 0; i < GATES_SHOWN; i++) {
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
        color: 0x3fa9ff, transparent: true, opacity: 0.7 - i * 0.2, depthWrite: false, fog: false,
      }));
      m.frustumCulled = false;
      m.visible = false;
      this.game.scene.add(m);
      this.gateMeshes.push(m);
    }
    this._gateFrom = -1;
  }

  /** The first gate not yet driven through, or the number of gates when all have been. */
  _nextGate() {
    const i = this.gates.findIndex((g) => !g.passed);
    return i < 0 ? this.gates.length : i;
  }

  /**
   * Has the car gone through any gate since last frame? Its path over the frame crossing the gate's line,
   * within the arch, either way.
   */
  _throughGates(p) {
    const prev = this._prevPos, cur = { x: p.position.x, z: p.position.z };
    this._prevPos = cur;
    if (!prev || Math.hypot(cur.x - prev.x, cur.z - prev.z) > 40) return;   // put somewhere, not driven
    for (const g of this.gates) {
      if (g.passed || Math.hypot(cur.x - g.x, cur.z - g.z) > g.r + 40) continue;
      const a0 = (prev.x - g.x) * g.tx + (prev.z - g.z) * g.tz;
      const a1 = (cur.x - g.x) * g.tx + (cur.z - g.z) * g.tz;
      if ((a0 > 0) === (a1 > 0)) continue;
      const t = Math.abs(a1 - a0) > 1e-6 ? a0 / (a0 - a1) : 0;
      const x = prev.x + (cur.x - prev.x) * t, z = prev.z + (cur.z - prev.z) * t;
      if (Math.hypot(x - g.x, z - g.z) <= g.r) {
        g.passed = true;
        this._gateFrom = -1;
      }
    }
  }

  /** The next gates to go through, put where they stand; a missed one orange. */
  _placeGates() {
    if (!this.gateMeshes) return;
    const first = this._nextGate();
    const missed = this.missed;
    if (first === this._gateFrom && missed === this._gateMissed) return;
    this._gateFrom = first;
    this._gateMissed = missed;
    let shown = 0;
    for (let k = first; k < this.gates.length && shown < this.gateMeshes.length; k++) {
      const g = this.gates[k];
      if (g.passed) continue;
      const m = this.gateMeshes[shown];
      // Half a torus standing on the road, spanning it: the ring's plane across the direction of travel.
      m.scale.setScalar(g.r);
      m.position.set(g.x, this.game.groundAt(g.x, g.z), g.z);
      m.rotation.set(0, Math.atan2(g.tx, g.tz), 0);
      m.material.color.setHex(shown === 0 && missed ? 0xff8a3d : 0x3fa9ff);
      m.material.opacity = shown === 0 && missed ? 0.9 : 0.7 - shown * 0.2;
      m.visible = true;
      shown++;
    }
    for (let i = shown; i < this.gateMeshes.length; i++) this.gateMeshes[i].visible = false;
  }

  /** Average speed down a route in each car, m/s: see DAILY_PACE and tests/daily.js. */
  _pace() {
    return DAILY_PACE[this.plan.car] || 22;
  }

  _finishMarker() {
    const end = this.route.pts[this.route.pts.length - 1];
    const y = this.game.groundAt(end.x, end.z);
    const geo = new THREE.CylinderGeometry(FINISH_R * 0.6, FINISH_R * 0.6, 60, 24, 1, true);
    const mat = new THREE.MeshBasicMaterial({ color: 0x3fa9ff, transparent: true, opacity: 0.18, depthWrite: false, side: THREE.DoubleSide });
    this.marker = new THREE.Mesh(geo, mat);
    this.marker.position.set(end.x, y + 30, end.z);
    this.game.scene.add(this.marker);
  }

  /** Where a run starts, and everything put back as it was. Called at the start and on R. */
  begin() {
    const g = this.game;
    this.state = 'ready';
    this.failedBy = null;
    this.time = 0;
    this.progress = 0;
    this._idx = 0;
    for (const o of this.obstacles) { this._drop(o); o.done = false; }
    this._gateFrom = -1;
    for (const gt of this.gates || []) gt.passed = false;
    this.missed = false;
    this._prevPos = null;
    this._wasOff = null;
    this.offRoute = 0;
    this._offRoute();
    g.score && g.score.freeze && g.score.freeze();
    // Five stars, with the helicopter: through bump() so the chase starts properly. Game._setWanted
    // grounds the helicopter for stars that were typed in; these were not.
    g.heliGrounded = false;
    if (g.heat.value <= 0) g.heat.bump(1, 'the daily challenge');
    g.heat.value = 5;
    g.heat.peak = Math.max(g.heat.peak, 5);
    // And already on you: the helicopter overhead with its light on the car, and the force knowing where
    // you are, from the first frame. A run started by getting clear before it locked on.
    // Over the start, not over g.player.position, which after R still says where the last run ended.
    const at = this.route.start;
    if (g.helicopter && g.player) g.helicopter.overhead(g.player, at);
    const k = g.dispatcher && g.dispatcher.knowledge;
    if (k && g.player) {
      k.seen = true;
      k.position.set(at.position.x, at.position.y, at.position.z);
      k.velocity.set(0, 0, 0);
      k.confidence = 1;
      k.timeSinceSeen = 0;
    }
    this._paint();
  }

  /** Once a frame, after the physics. */
  update(dt) {
    const g = this.game, p = g.player;
    if (!p || !this.route) return;
    if (this.state === 'won' || this.state === 'failed') { this._paint(); return; }
    // The clock starts when you do.
    // Off the throttle or the brake, or moving properly: not the car settling on its springs, which
    // started it at once.
    const c = p.controls || {};
    if (this.state === 'ready' && (c.throttle > 0.05 || c.brake > 0.05 || p.speed > 3)) this.state = 'running';
    if (this.state === 'running') this.time += dt;
    // And the stars stay where they were put.
    if (g.heat.value < 5) g.heat.value = 5;

    this._track(p);
    this._obstacles();
    this._throughGates(p);
    const next = this._nextGate();
    this.missed = next < this.gates.length && this.progress > this.gates[next].s + GATE_MISSED;
    this._placeGates();
    this._offRoute();

    // Nothing ends it on touch any more: "even if I hit a building, I don't want you to instantly end it."
    // A hit costs damage as it does in any chase, and 100% is the end. (_hitWhat is kept for tests/daily.js,
    // which counts what the game's own driver touches.)
    if ((p.damage || 0) >= 0.999 || p.disabled) { this._fail('wrecked'); return; }
    if (g.outcome === 'busted') { this._fail('busted'); return; }
    if (this.state === 'running' && this.time > this.limit) { this._fail('time'); return; }
    const end = this.route.pts[this.route.pts.length - 1];
    // Driven there: running, and for longer than the route could be driven at 100 m/s.
    // And every gate driven through: "otherwise it won't allow you to [finish]."
    if (this.state === 'running' && this._nextGate() >= this.gates.length && this.time > this.route.length / 100
      && Math.hypot(p.position.x - end.x, p.position.z - end.z) < FINISH_R && this.progress > this.route.length - 120) {
      this._win();
      return;
    }
    this._paint();
  }

  /** How far along the line you are, m: the nearest point, looking a little either side of the last one. */
  _track(p) {
    const pts = this.route.pts;
    let best = this._idx, bd = Infinity;
    const lo = Math.max(0, this._idx - 20), hi = Math.min(pts.length - 1, this._idx + 60);
    for (let i = lo; i <= hi; i++) {
      const d = (pts[i].x - p.position.x) ** 2 + (pts[i].z - p.position.z) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    // Lost the line altogether (a short cut, a different road): look everywhere.
    if (bd > 60 * 60) {
      for (let i = 0; i < pts.length; i++) {
        const d = (pts[i].x - p.position.x) ** 2 + (pts[i].z - p.position.z) ** 2;
        if (d < bd) { bd = d; best = i; }
      }
    }
    this._idx = best;
    this.progress = pts[best].s;
    this.offRoute = Math.sqrt(bd);
  }

  /** The obstacle a little ahead goes in; the one behind comes out. */
  _obstacles() {
    const rb = this.game.roadblocks;
    for (const o of this.obstacles) {
      if (!o.block && !o.done && o.s - this.progress < OBSTACLE_AHEAD && o.s > this.progress) {
        const site = this._siteAt(o.s);
        o.block = site && rb.buildDaily(site, o.kind, o.side);
        if (!o.block) o.done = true;
      } else if (o.block && this.progress - o.s > OBSTACLE_BEHIND) {
        this._drop(o);
        o.done = true;
      }
    }
  }

  /**
   * The warning in the middle of the screen: GO BACK while a gate has been missed ("it'll say on the screen
   * once you like miss one, go back"), or OFF ROUTE while you are far from the line.
   */
  _offRoute() {
    const live = this.state === 'running';
    const say = live && this.missed ? 'missed' : live && this.offRoute > OFF_ROUTE ? 'off' : '';
    if (say === this._wasOff) return;
    this._wasOff = say;
    const w = document.getElementById('dailywarn');
    if (!w) return;
    w.hidden = !say;
    if (say === 'missed') w.innerHTML = 'MISSED A GATE<small>go back through the orange arch</small>';
    else if (say === 'off') w.innerHTML = 'OFF ROUTE<small>back to the blue line</small>';
  }

  _drop(o) {
    if (o.block) this.game.roadblocks.dropDaily(o.block);
    o.block = null;
  }

  /** The point on the line `s` metres along, facing the way you will be going, and how wide the road is. */
  _siteAt(s) {
    const pts = this.route.pts;
    let i = 1;
    while (i < pts.length - 1 && pts[i].s < s) i++;
    const a = pts[i - 1], b = pts[i];
    const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    const u = clamp((s - a.s) / l, 0, 1);
    const width = (b.edge && b.edge.width) || 9;
    return { x: a.x + (b.x - a.x) * u, z: a.z + (b.z - a.z) * u, tx: (b.x - a.x) / l, tz: (b.z - a.z) / l, width, name: (b.edge && b.edge.name) || 'the route' };
  }

  /**
   * What the car is touching that ends the run, or null: anything in GROUP.BUILDING or GROUP.PROP (houses,
   * walls, the train, trees, barriers, posts), or another car. Lamp posts and the rest of the street
   * furniture are GROUP.STREET, hedges GROUP.HEDGE, cones GROUP.DEBRIS, the ground TERRAIN and HILL: all fine.
   */
  _hitWhat(p) {
    const w = this.game.world;
    let what = null;
    for (const c of [p.collider, p.keel]) {
      if (!c || what) continue;
      w.contactPairsWith(c, (o) => {
        if (what) return;
        let touching = false;
        w.contactPair(c, o, (m) => { if (m.numContacts() > 0) touching = true; });
        if (!touching) return;
        // Police cars are allowed to hit you, and you them: what they cost is damage, and at 100% it is
        // over (update). "When you get to 100% damage, you fail the challenge ... make police cars do the
        // same amount of damage [as] at the moment." Any other car still ends it.
        if (o.__vehicle && o.__vehicle !== p) { if (!o.__vehicle.isPolice) what = 'a car'; return; }
        const member = o.collisionGroups ? (o.collisionGroups() >>> 16) : 0;
        if (member & GROUP.BUILDING) what = 'a building';
        else if (member & GROUP.PROP) what = 'a tree';
      });
    }
    return what;
  }

  _fail(why) {
    const g = this.game;
    this.state = 'failed';
    this._offRoute();
    this.failedBy = why;
    if (!g.outcome) g.outcome = 'daily';
    const line = why === 'time' ? `Out of time at <b>${fmtTime(this.limit)}</b>`
      : why === 'busted' ? 'Busted'
        : why === 'wrecked' ? 'Wrecked: <b>100%</b> damage'
        : `You hit <b>${why}</b>`;
    const best = dailyBest(this.day);
    g.hud.showOverlay('CHALLENGE FAILED', [
      line,
      `<b>${Math.round(this.progress)}</b> of ${Math.round(this.route.length)} m`,
      best !== null ? `Your best today <b>${fmtTime(best)}</b>` : 'Not finished yet today',
    ].join(' &nbsp;·&nbsp; '));
    if (g.audio) g.audio.impact(0.6);
    this._paint();
  }

  _win() {
    const g = this.game;
    this.state = 'won';
    this._offRoute();
    if (!g.outcome) g.outcome = 'daily';
    const t = Math.round(this.time * 100) / 100;
    const before = dailyBest(this.day);
    saveBest(this.day, t);
    const best = before === null || t < before;
    const name = savedName();
    g.hud.showOverlay('CHALLENGE COMPLETE', [
      `<div class="dwin">Time <b>${fmtTime(t)}</b>${best ? ' &nbsp;<b class="best">YOUR BEST TODAY</b>' : ` &nbsp;(best ${fmtTime(before)})`}</div>`,
      '<div class="dsend"><input id="dname" maxlength="16" placeholder="YOUR NAME" autocomplete="off" spellcheck="false" '
        + `value="${escapeHtml(name)}"><button id="dpost" class="setbtn" type="button">POST TIME</button></div>`,
      '<div id="dtable"></div>',
    ].join(''));
    this._wireSend(t);
    this._paint();
  }

  async _wireSend(t) {
    const table = document.getElementById('dtable');
    const btn = document.getElementById('dpost'), box = document.getElementById('dname');
    if (table) table.innerHTML = boardHtml(await fetchBoard(this.day), savedName());
    if (!btn || !box) return;
    // Typing a name must not drive the car or open the menu.
    box.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') btn.click(); });
    box.addEventListener('keyup', (e) => e.stopPropagation());
    btn.addEventListener('click', async () => {
      const name = box.value.trim().toUpperCase().replace(/[^A-Z0-9 _-]/g, '').slice(0, 16);
      if (!name) { box.focus(); return; }
      btn.disabled = true;
      btn.textContent = 'SENDING…';
      const rows = await postTime(this.day, name, t, this.plan.car);
      if (rows === 'taken') {
        btn.textContent = 'NAME TAKEN';
        btn.disabled = false;
        box.focus();
        box.select();
        return;
      }
      saveName(name);
      btn.textContent = rows ? 'POSTED' : 'COULD NOT POST';
      if (!rows) btn.disabled = false;
      if (rows && table) table.innerHTML = boardHtml(rows, name);
    });
  }

  /** The panel at the top: the clock against the limit, and how far there is to go. */
  _paint() {
    if (!this.el || !this.route) return;
    this.el.hidden = false;
    const left = Math.max(0, this.limit - this.time);
    const togo = Math.max(0, this.route.length - this.progress);
    const warn = left < 10 && this.state === 'running';
    const html = `<b>DAILY</b> <span class="${warn ? 'warn' : ''}">${fmtTime(left)}</span>`
      + ` <small>${(togo / 1000).toFixed(2)} km to go</small>`;
    if (html !== this._last) { this.el.innerHTML = html; this._last = html; }
  }

  /** Taken down: back to the menu, or a different game. */
  dispose() {
    for (const o of this.obstacles) this._drop(o);
    if (this.marker) {
      this.game.scene.remove(this.marker);
      this.marker.geometry.dispose();
      this.marker.material.dispose();
    }
    if (this.el) this.el.hidden = true;
    for (const m of this.gateMeshes || []) { this.game.scene.remove(m); m.material.dispose(); }
    if (this.gateMeshes && this.gateMeshes[0]) this.gateMeshes[0].geometry.dispose();
    const w = document.getElementById('dailywarn');
    if (w) w.hidden = true;
  }
}

/**
 * The average speed the clock asks of each car, m/s: the clock is the route's length over this, times
 * DAILY_SLACK. The game's own driver, with an empty road, kept 16.7 (Badger), 17.1 (Runner) and 17.4
 * (Stiletto) down 1.62 km of Wexbury (tests/daily.js) -- it keeps to the roads' speeds -- so these ask for a
 * run 8% (Badger) to 38% (Stiletto) quicker than that, with five stars after you.
 */
const DAILY_PACE = { runner: 21, supercar: 24, offroad: 18 };
