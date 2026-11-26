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
import { AirRescue } from './airrescue.js';

const DAILY_KEY = 'pc.daily';
const BEST_KEY = 'pc.dailybest';
const NAME_KEY = 'pc.name';
const KEY_KEY = 'pc.key';

/** The cars a day can give you, and how fast each covers a route on average, m/s, for the clock (DAILY_PACE). */
export const DAILY_CARS = ['runner', 'supercar', 'offroad'];
const CAR_NAMES = { runner: 'Runner', supercar: 'Stiletto', offroad: 'Badger', interceptor: 'Interceptor', suv: 'Police SUV', helicopter: 'Helicopter' };
/** Lone Unit and Eyes in the Sky: the clock, s; the getaway car starts this far up the route, m; and how long in sight wins Eyes in the Sky, s. */
const STOP_LIMIT = 150;
const AIR_LIMIT = 150;
const RUNNER_START = 140;
const AIR_NEED = 30;
/** Lone Unit: police cars sent to help you at GO, and no more. */
const STOP_BACKUP = 2;
/** The clock, as a share of the route's length over DAILY_PACE. Was 1: "the time limit seems a little bit too easy." */
const DAILY_SLACK = 0.85;
/** And this many seconds on top: "add like 10 more seconds onto the timer because it is really hard now." */
const DAILY_EXTRA = 10;
/** The countdown at the start, s; and how long GO stays up once the clock is running, s. */
const COUNT_FROM = 3;
/** The preset police (see _planSpawns): at the start; then one for each this many metres of route, this far up the route, about this far off it. */
const SPAWN_START = 4;
const SPAWN_EVERY = 110;
const SPAWN_AHEAD = 160;
const SPAWN_OFF = 140;
/** Preset traffic cars along the route. */
const TRAFFIC_ALONG = 14;
/** The ghost's line is a sample every this many seconds of the run. */
const GHOST_EVERY = 0.2;
const GO_FOR = 0.8;
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
/**
 * From SHORT_FROM: "make the daily challenge much shorter ... remove the time limit ... no police roadblocks ... max 5 police cars to be
 * chasing me ... it should only, every single daily challenge should only be 1 minute ... to make it more appealing to the wider public
 * ... my dad had a go and he was like, 'Whoa, that's way too hard.'" A route of SHORT_ROUTE m, no clock, nothing put across the road,
 * SHORT_UNITS police at most.
 */
export const SHORT_FROM = '2026-11-26';
const SHORT_ROUTE = [600, 850];
export const SHORT_UNITS = 5;
/** pickRoute: the most a road's cost is multiplied by for a day (see there). */
const ROUTE_JITTER = 5;
/** The first obstacle this far along, then one every OBSTACLE_EVERY, none in the last OBSTACLE_END. */
const OBSTACLE_FIRST = 220, OBSTACLE_EVERY = 240, OBSTACLE_END = 120;
/** A roadblock wants the route straight for this far before it, m, no part of it more than STRAIGHT_DEG off; and looks this far either side of where it was wanted for such a place, m. */
// Haldon Vale's lanes wind: 110 m within 10 degrees was one spot in 115 on its route of 14 November, 70 m
// within 20 degrees 25. At 20 m/s that is three and a half seconds of a block in view.
const OBSTACLE_SIGHT = 70;
const STRAIGHT_DEG = 20;
const OBSTACLE_SEARCH = 90;
/** How far before a roadblock's cars its stinger lies, m (RoadblockManager._build's SPIKE_BACK). */
const STINGER_BACK = 19;
/** No obstacle within this of a gate, m: "don't set up spike strips like right next to a marker." */
const OBSTACLE_GATE_GAP = 30;
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

/** The first day the daily may be on Ashfield: Saturday, so from midnight at the end of Friday evening in the UK. */
const CITY_FROM = '2026-11-28';

/** The parts of a day that are chosen before a map is built: which map, and which car. */
export function dailyPlan(day = dayKey()) {
  const rng = makeRng(hash(`daily:${day}`));
  const maps = MAPS.filter((m) => !m.hidden);
  let map = maps[Math.floor(rng() * maps.length) % maps.length];
  // Not Ashfield yet: "until then, I don't want the American map being used for the daily challenge". A day that falls on it
  // is one of the others', from numbers of its own, and every other day is as it was. The days before this was asked are too.
  if (map.id === 'city' && day >= '2026-11-26' && day < CITY_FROM) {
    const rest = maps.filter((m) => m.id !== 'city');
    map = rest[hash(`instead:${day}`) % rest.length];
  }
  // And it starts with it: "you will start using the map for the daily challenge on Saturday" (that day fell on Wexbury).
  if (day === CITY_FROM) map = maps.find((m) => m.id === 'city') || map;
  let car = DAILY_CARS[Math.floor(rng() * DAILY_CARS.length) % DAILY_CARS.length];
  // What kind of challenge, from its own numbers so the map and car above are what they always were.
  // "Loads more different daily challenges ... where you're the police and you have to stop a criminal but
  // you have no police help ... a helicopter, where you have to ... stay on them for a certain amount of
  // time." Escape until 20 November, the day they came in, so that day's table stays the one it was.
  // The first few numbers from seeds this alike come out alike too (four helicopter days running), so
  // they are thrown away.
  const trng = makeRng(hash(`type:${day}`) ^ 0x9e3779b9);
  for (let i = 0; i < 6; i++) trng();
  const type = day <= '2026-11-20' ? 'escape' : DAILY_TYPES[Math.floor(trng() * DAILY_TYPES.length) % DAILY_TYPES.length];
  // The helicopter's day is Air Rescue (game/airrescue.js) from 25 November: "with the helicopter, like today, it's
  // kind of really easy". Eyes in the Sky up to then, so the day it was asked for keeps the table it had.
  if (type === 'air' && day >= '2026-11-25') return { day, type: 'rescue', typeName: TYPE_NAMES.rescue, mapId: map.id, mapName: map.name, car: 'helicopter', carName: CAR_NAMES.helicopter };
  if (type === 'stop') car = trng() < 0.5 ? 'interceptor' : 'suv';
  if (type === 'air') car = 'helicopter';
  return { day, type, typeName: TYPE_NAMES[type], mapId: map.id, mapName: map.name, car, carName: CAR_NAMES[car] };
}

/**
 * The day's route on the map that is loaded: a start and a finish ROUTE_MIN-ROUTE_MAX metres of road apart,
 * chosen by the day's own random numbers, so the same everywhere. Null if none was found. Exported for
 * tests/dailyroutes.js, which passes `mode` 'old' to see every day as it was up to 20 November.
 *
 * "It's basically the same route every single time on each map. It wasn't exactly the same route, but it
 * was very similar." The quickest way between two random places is mostly down the same main roads. For
 * days after 20 November (whose tables were set on the routes they had) every road costs 1 to ROUTE_JITTER
 * times its time, its own figure for the day, so the quickest way by the day's reckoning is not always the
 * bypass. See the README for what it did on each map, and what was tried and dropped.
 */
export function pickRoute(game, day, mapId, mode = 'new') {
  const g = game.graph;
  const weight = day > '2026-11-20' && mode !== 'old'
    ? (e) => 1 + (ROUTE_JITTER - 1) * (hash(`${day}:${e.id}`) % 1000) / 1000 : null;
  const rng = makeRng(hash(`route:${day}:${mapId}`));
  const [lo, hi] = day >= SHORT_FROM && mode !== 'old' ? SHORT_ROUTE : [ROUTE_MIN, ROUTE_MAX];
  const ok = (n) => n.edges.length > 0 && !n.quarry && n.edges.some((id) => !g.edges[id].cut && g.edges[id].width >= 7);
  const nodes = g.nodes.filter(ok);
  for (let tries = 0; tries < 400; tries++) {
    const a = nodes[Math.floor(rng() * nodes.length) % nodes.length];
    const b = nodes[Math.floor(rng() * nodes.length) % nodes.length];
    const straight = Math.hypot(b.x - a.x, b.z - a.z);
    if (straight < lo * 0.6 || straight > hi) continue;
    const path = g.route(a.id, b.id, Infinity, weight && { weight });
    if (!path || path.length < 3) continue;
    let len = 0;
    for (let i = 0; i < path.length - 1; i++) {
      const e = g.edgeBetween(path[i], path[i + 1]);
      if (!e || e.cut || e.width < 7) { len = -1; break; }
      len += e.length;
    }
    if (len < lo || len > hi) continue;
    const pts = g.pathToPoints(path, 0, true);
    if (pts.length < 4) continue;
    // Every point needs a road under it to place a car at the start.
    const first = g.edgeBetween(path[0], path[1]);
    const place = game._placeOnRoad(a, (e) => e === first);
    if (!place) continue;
    return { path, pts, len, start: place };
  }
  return null;
}

/** The kinds of daily challenge, and what each is called. */
export const DAILY_TYPES = ['escape', 'stop', 'air'];
const TYPE_NAMES = { escape: 'Escape', stop: 'Lone Unit', air: 'Eyes in the Sky', rescue: 'Air Rescue' };
/** One line on the menu for each. */
export const TYPE_RULES = {
  escape: 'Five stars from the start. Through every gate to the finish before the clock runs out.',
  stop: 'You are the police, with two cars for backup and no more. Arrest the getaway car before the clock runs out.',
  rescue: 'There has been a crash. Pick up the doctor, then the casualty, and land them at the hospital: gently, inside each box. Wreck it and you start again.',
  air: 'You are in the helicopter. Keep the getaway car in sight for 30 seconds in all, as fast as you can.',
};

/** The day being played in this tab, if a daily challenge is on; null otherwise. A new day ends it. */
export function dailyActive() {
  try {
    // For trying another day's challenge in this tab only: sessionStorage pc.dailytest = 'YYYY-MM-DD'.
    const test = sessionStorage.getItem('pc.dailytest');
    if (test && sessionStorage.getItem(DAILY_KEY)) return test;
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

/** The day's best run's line, as [t, x, y, z, heading, ...], or null if nobody has posted one. */
async function fetchGhost(day) {
  try {
    const r = await fetch(`/api/daily/ghost?day=${encodeURIComponent(day)}`, { cache: 'no-store' });
    if (!r.ok) return null;
    const a = await r.json();
    return Array.isArray(a) && a.length >= 10 ? a : null;
  } catch (e) { return null; }
}

/** One more go at `day` on this machine; returns how many there have been. Kept for the last fortnight. */
function bumpAttempts(day) {
  try {
    const all = JSON.parse(localStorage.getItem('pc.dailytries') || '{}');
    all[day] = (all[day] || 0) + 1;
    for (const k of Object.keys(all).sort().slice(0, -14)) delete all[k];
    localStorage.setItem('pc.dailytries', JSON.stringify(all));
    return all[day];
  } catch (e) { return 0; }
}

/** Is the ghost wanted? On unless turned off in the pause menu. */
export function ghostOn() {
  try { return localStorage.getItem('pc.ghost') !== '0'; } catch (e) { return true; }
}

/** Rows on success, 'taken' if the name is someone else's, null if it could not be sent. */
async function postTime(day, name, time, car, ghost = null, attempts = 0) {
  try {
    const r = await fetch('/api/daily', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ day, name, time, car, key: deviceKey(), ghost, attempts }),
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
    const tries = r.attempts > 0 ? `<i>${r.attempts} ${r.attempts === 1 ? 'try' : 'tries'}</i>` : '<i></i>';
    return `<li${me}><span>${escapeHtml(r.name)}</span>${tries}<b>${fmtTime(r.time)}</b></li>`;
  }).join('') + '</ol>';
}

export class DailyChallenge {
  constructor(game, day) {
    this.game = game;
    this.plan = dailyPlan(day);
    this.day = day;
    /** The short daily: see SHORT_FROM. */
    this.short = day >= SHORT_FROM;
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
    this.route = pickRoute(this.game, this.day, this.plan.mapId);
    if (!this.route) return false;
    // Distance along the line at each point.
    const pts = this.route.pts;
    pts[0].s = 0;
    for (let i = 1; i < pts.length; i++) pts[i].s = pts[i - 1].s + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
    this.route.length = pts[pts.length - 1].s;
    this.limit = Math.round(this.route.length / this._pace() * DAILY_SLACK) + DAILY_EXTRA;
    // The obstacles, by the same numbers: a stinger or a half-block, on alternate sides.
    const orng = makeRng(hash(`obstacles:${this.day}`));
    // Proper roadblocks, the way the force puts them down in a chase: cars across the road, cones, and a
    // stinger kerb to kerb in front (RoadblockManager._build). "There are some spike strips ... way too hard.
    // I keep on forgetting they're there ... make sure they're on a straight road so you actually see them.
    // And make sure they're next to police cars ... more like normal roadblocks with spike strips fully
    // blocking the road ... not on very tight 90-degree corners, and also not right next to those ... hoops."
    // Each wanted spot moves to the nearest one, within OBSTACLE_SEARCH, where the route runs straight for
    // OBSTACLE_SIGHT before it; and no gate within OBSTACLE_GATE_GAP of the stinger or the cars (the gates
    // are placed after, round them: _buildGates).
    let lastAt = -Infinity;
    for (let s = OBSTACLE_FIRST; s < this.route.length - OBSTACLE_END; s += OBSTACLE_EVERY * (0.85 + orng() * 0.3)) {
      let at = null;
      for (let k = 0; k <= OBSTACLE_SEARCH && at === null; k += 10) {
        for (const c of k ? [s + k, s - k] : [s]) {
          if (c < OBSTACLE_SIGHT || c > this.route.length - OBSTACLE_END || c - lastAt < OBSTACLE_EVERY * 0.7) continue;
          if (!this._straight(c - OBSTACLE_SIGHT, c + 15)) continue;
          at = c;
          break;
        }
      }
      if (at === null) continue;
      lastAt = at;
      this.obstacles.push({ s: at, kind: 'full', side: 1, block: null, done: false });
    }
    this.type = this.plan.type || 'escape';
    if (this.short) this.obstacles = [];
    if (this.type === 'rescue') {
      this.obstacles = [];
      this.gates = [];
      this.spawnPlan = [];
      this.trafficPlan = [];
      this.rescue = new AirRescue(this.game, makeRng(hash(`rescue:${this.day}`)));
      this.limit = this.rescue.limit;
      return true;
    }
    if (this.type !== 'escape') {
      // No route to drive, and no blocks or gates on it: the route is only where you and the getaway car
      // start. The force sends nobody in either (see Game.spawnPoliceNear).
      this.obstacles = [];
      this.gates = [];
      this.limit = this.type === 'stop' ? STOP_LIMIT : AIR_LIMIT;
      this._planSpawns();
      // Lone Unit's backup: the first STOP_BACKUP of the units the plan puts round the start, the same for
      // everyone, sent in at GO (_goChase). "It's just really hard when you're a police car ... maybe it
      // should be like it gives you only two police cars backup." Nobody else is sent, and a wrecked one is
      // not replaced.
      this.backupPlan = this.type === 'stop' ? this.spawnPlan.filter((sp) => sp.s === 0).slice(0, STOP_BACKUP) : [];
      this.spawnPlan = [];
      return true;
    }
    this._buildGates();
    this._planSpawns();
    this._finishMarker();
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
      // Not on a roadblock: one whose stinger or cars it would stand in is left out; the block is on the
      // route itself.
      if (this.obstacles.some((o) => s > o.s - STINGER_BACK - OBSTACLE_GATE_GAP && s < o.s + OBSTACLE_GATE_GAP)) continue;
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
    const half = p.spec && p.spec.dims ? p.spec.dims.w * 0.5 : 1;
    for (const g of this.gates) {
      if (g.passed || Math.hypot(cur.x - g.x, cur.z - g.z) > g.r + 40) continue;
      const a0 = (prev.x - g.x) * g.tx + (prev.z - g.z) * g.tz;
      const a1 = (cur.x - g.x) * g.tx + (cur.z - g.z) * g.tz;
      if ((a0 > 0) === (a1 > 0)) continue;
      const t = Math.abs(a1 - a0) > 1e-6 ? a0 / (a0 - a1) : 0;
      const x = prev.x + (cur.x - prev.x) * t, z = prev.z + (cur.z - prev.z) * t;
      // Through it, or clipping its edge with the car: "as long as you clip the edge with your car, that's
      // fine." So the arch's reach plus half the car's width.
      if (Math.hypot(x - g.x, z - g.z) <= g.r + half) {
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
      m.position.set(g.x, this._y(g.x, g.z), g.z);
      m.rotation.set(0, Math.atan2(g.tx, g.tz), 0);
      m.material.color.setHex(shown === 0 && missed ? 0xff8a3d : 0x3fa9ff);
      m.material.opacity = shown === 0 && missed ? 0.9 : 0.7 - shown * 0.2;
      m.visible = true;
      shown++;
    }
    for (let i = shown; i < this.gateMeshes.length; i++) this.gateMeshes[i].visible = false;
  }

  /**
   * Every police car and every traffic car of the run, decided now from the day's numbers and the same for
   * everyone and every attempt: "make the traffic and police spawns the same ... every single police spawn
   * is like preset." Police: SPAWN_START at the start, round it, and then one at each SPAWN_EVERY of the
   * route you reach, put down SPAWN_OFF from the route point SPAWN_AHEAD further on, off the route, pointing
   * at it. Traffic: TRAFFIC_ALONG cars down the route, on alternate sides, laid out at every start. The
   * force spawns nothing of its own in the challenge (Game.spawnPoliceNear and friends); what each unit does
   * once it is there still follows what you do.
   */
  _planSpawns() {
    const g = this.game, gr = g.graph;
    const rng = makeRng(hash(`spawns:${this.day}`));
    const onRoute = new Set(this.route.path);
    const nodes = gr.nodes.filter((n) => n.edges.length && !n.quarry && !onRoute.has(n.id));
    const KIND = ['interceptor', 'suv', 'interceptor', 'patrol'];
    const near = (x, z, lo, hi) => {
      const c = nodes.filter((n) => { const d = Math.hypot(n.x - x, n.z - z); return d > lo && d < hi; });
      return c.length ? c[Math.floor(rng() * c.length) % c.length] : null;
    };
    const unitAt = (node) => {
      const place = node && g._placeOnRoad(node);
      // Its height with it: one on a raised road is not on the route's.
      return place && { x: place.position.x, y: place.position.y, z: place.position.z, heading: place.heading, kind: KIND[Math.floor(rng() * KIND.length) % KIND.length] };
    };
    this.spawnPlan = [];
    const st = this.route.start.position;
    // Short: SHORT_UNITS in all, two at the start and the rest spread along.
    const atStart = this.short ? 2 : SPAWN_START, every = this.short ? Math.max(SPAWN_EVERY, (this.route.length - 80) / (SHORT_UNITS - 1)) : SPAWN_EVERY;
    for (let i = 0; i < atStart; i++) {
      const u = unitAt(near(st.x, st.z, 90, 220));
      if (u) this.spawnPlan.push(Object.assign({ s: 0 }, u));
    }
    for (let s = every; s < this.route.length - 80 && this.spawnPlan.length < (this.short ? SHORT_UNITS : Infinity); s += every) {
      const q = this._siteAt(Math.min(this.route.length - 20, s + SPAWN_AHEAD));
      const u = unitAt(near(q.x, q.z, SPAWN_OFF * 0.5, SPAWN_OFF * 1.5));
      if (u) this.spawnPlan.push(Object.assign({ s }, u));
    }
    this.trafficPlan = [];
    const TK = ['hatchback', 'estate', 'civsuv'];
    for (let k = 0; k < TRAFFIC_ALONG; k++) {
      const s = 60 + (this.route.length - 120) * (k + rng() * 0.6) / TRAFFIC_ALONG;
      const q = this._siteAt(s);
      const back = rng() < 0.5;
      const lane = Math.min(3, q.width * 0.25) * (back ? -1 : 1);
      this.trafficPlan.push({
        x: q.x + q.tz * lane, z: q.z - q.tx * lane,
        heading: back ? Math.atan2(-q.tx, -q.tz) : Math.atan2(q.tx, q.tz),
        kind: TK[Math.floor(rng() * TK.length) % TK.length],
      });
    }
  }

  /** The planned police whose distance along the route you have reached. */
  _spawnDue() {
    const g = this.game;
    while (this._spawnNext < this.spawnPlan.length && this.spawnPlan[this._spawnNext].s <= this.progress) {
      const sp = this.spawnPlan[this._spawnNext++];
      const u = g.spawnUnitAt({ x: sp.x, y: g.sim.decks && sp.y !== undefined ? sp.y : 0.95 + this._y(sp.x, sp.z), z: sp.z }, sp.heading, sp.kind);
      if (u) g.dispatcher.adopt(u);
    }
  }

  /** Does the route run straight from `a` to `b` metres along it: no stretch of it more than STRAIGHT_DEG off the line at `b`? */
  _straight(a, b) {
    const end = this._siteAt(b);
    const cos = Math.cos(STRAIGHT_DEG * Math.PI / 180);
    for (let s = Math.max(0, a); s <= b; s += 10) {
      const q = this._siteAt(s);
      if (q.tx * end.tx + q.tz * end.tz < cos) return false;
    }
    return true;
  }

  /** Average speed down a route in each car, m/s: see DAILY_PACE and tests/daily.js. */
  _pace() {
    return DAILY_PACE[this.plan.car] || 22;
  }

  _finishMarker() {
    const end = this.route.pts[this.route.pts.length - 1];
    const y = this._y(end.x, end.z);
    const geo = new THREE.CylinderGeometry(FINISH_R * 0.6, FINISH_R * 0.6, 60, 24, 1, true);
    const mat = new THREE.MeshBasicMaterial({ color: 0x3fa9ff, transparent: true, opacity: 0.18, depthWrite: false, side: THREE.DoubleSide });
    this.marker = new THREE.Mesh(geo, mat);
    this.marker.position.set(end.x, y + 30, end.z);
    this.game.scene.add(this.marker);
  }

  /**
   * The ghost: "a ghost of the car of the best run on the daily challenge ... if no one's done it ...
   * don't show anything ... and an option to turn it off and on in the pause menu." Your own line is kept
   * every GHOST_EVERY seconds of the run and sent with your time; the server keeps the day's fastest. That
   * one, if there is one, is drawn as a see-through copy of the day's car, where it was at the same moment.
   */
  _ghostTick(dt) {
    const p = this.game.player;
    if (this.state !== 'running' || !p || this.type !== 'escape') return;
    if (this.time >= this._lineNext) {
      this._lineNext = this.time + GHOST_EVERY;
      const r = (v) => Math.round(v * 100) / 100;
      this._line.push(r(this.time), r(p.position.x), r(p.position.y), r(p.position.z), r(Math.atan2(p.forward.x, p.forward.z)));
    }
    const gd = this.ghostData;
    if (!gd || !ghostOn()) { if (this.ghostMesh) this.ghostMesh.visible = false; return; }
    if (!this.ghostMesh && p.view) {
      const m = p.view.clone(true);
      m.traverse((o) => {
        if (!o.isMesh) return;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        const ghost = mats.map((mt) => {
          const c = mt.clone();
          c.transparent = true; c.opacity = 0.35; c.depthWrite = false;
          return c;
        });
        o.material = Array.isArray(o.material) ? ghost : ghost[0];
        o.castShadow = false;
      });
      this.game.scene.add(m);
      this.ghostMesh = m;
    }
    if (!this.ghostMesh) return;
    // The samples either side of now.
    const t = this.time;
    let i = this._ghostI || 0;
    while (i + 5 < gd.length - 5 && gd[i + 5] <= t) i += 5;
    this._ghostI = i;
    const a = i, b = Math.min(gd.length - 5, i + 5);
    const span = gd[b] - gd[a];
    const u = span > 0 ? Math.min(1, Math.max(0, (t - gd[a]) / span)) : 0;
    let dh = gd[b + 4] - gd[a + 4];
    if (dh > Math.PI) dh -= Math.PI * 2; else if (dh < -Math.PI) dh += Math.PI * 2;
    const m = this.ghostMesh;
    m.visible = t <= gd[gd.length - 5] + 1;
    m.position.set(gd[a + 1] + (gd[b + 1] - gd[a + 1]) * u, gd[a + 2] + (gd[b + 2] - gd[a + 2]) * u, gd[a + 3] + (gd[b + 3] - gd[a + 3]) * u);
    m.rotation.set(0, gd[a + 4] + dh * u, 0);
  }

  /** Where a run starts, and everything put back as it was. Called at the start and on R. */
  begin() {
    const g = this.game;
    // The same chances every attempt, for everyone: "he basically just got insanely lucky ... about the police
    // spawns ... make the traffic and police spawns ... exactly the same every single time you run." The
    // game's random numbers (Game.rng: which car, where, which way, who runs a light) start again from the
    // day's seed, and the traffic from nothing, at every start -- the first included, which had the traffic
    // the boot left. What the force does still follows what you do, so driving the same way meets the same.
    // From an empty road: the last attempt's police (patrols the reset keeps, units off its roadblocks) and its
    // traffic went on drawing numbers and moving, and two identical drives met different cars.
    if (g.dispatcher) for (const u of g.dispatcher.units.slice()) if (!u.human) g.despawnPolice(u);
    // And a new force: its timers and what it knew (when the last block went in, how long you have held a
    // line) outlived a reset and made the second identical drive go differently from the first.
    if (g.dispatcher) g.dispatcher = new g.dispatcher.constructor(g);
    if (g.traffic) {
      g.traffic.clear();
      // The day's traffic, all of it, where it always is: see _planSpawns.
      g.traffic.preset = true;
      for (const t of this.trafficPlan || []) g.traffic.place({ x: t.x, y: 0.95 + this._y(t.x, t.z), z: t.z }, t.heading, t.kind);
    }
    this._spawnNext = 0;
    if (g.suspects && g.suspects.reset) g.suspects.reset();
    g.rng = makeRng(hash(`play:${this.day}`));
    this._line = [];
    this._lineNext = 0;
    this._ghostI = 0;
    if (this.ghostMesh) this.ghostMesh.visible = false;
    // The day's best, fetched afresh every start: it was fetched once a page, so a best you set yourself was
    // not there until a reload. "If I am the best player, I can't see the ghost ... when my friend became the
    // best, then I could see his ghost and he could see mine." Your own new best is used at once (_wireSend).
    fetchGhost(this.day).then((d) => { if (d) this.ghostData = d; });
    // No train: "disable the train, because it just ruined my run ... I had to wait for it to pass."
    const rail = g.world && g.world.__map && g.world.__map.railway;
    if (rail) rail.off = true;
    // Three, two, one first: "when you first load into the daily challenge ... 3, 2, 1 ... on phone you
    // have to press full screen, it takes a bit of time, and obviously otherwise you lose out time." Car and
    // police held, the clock not running, until GO.
    this.state = 'countdown';
    this.count = COUNT_FROM;
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
    if (this.type === 'rescue') { g.heat.reset(); this.rescue.begin(); this.limit = this.rescue.limit; this._paint(); return; }
    if (this.type !== 'escape') { this._beginChase(); this._paint(); return; }
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

  /**
   * Lone Unit and Eyes in the Sky: the getaway car where it always starts, RUNNER_START up the route, facing
   * along it, mended, waiting for GO; no wanted level yet; no helicopter of the force's, and nobody else.
   */
  _beginChase() {
    const g = this.game;
    g.heliGrounded = true;
    if (g.helicopter) g.helicopter.reset();
    g.heat.reset();
    this.watched = 0;
    const r = g.runner;
    if (!r) return;
    const q = this._siteAt(RUNNER_START);
    const v = r.vehicle;
    v.repair();
    v.teleport({ x: q.x, y: 0.95 + this._y(q.x, q.z), z: q.z }, Math.atan2(q.tx, q.tz));
    v.setVelocity({ x: 0, y: 0, z: 0 });
    r.running = false;
    r.breakIn = 1e9;
    r.driver.setPath([]);
    r.repathTimer = 0;
    r.goalNode = null;
  }

  /** GO, in Lone Unit and Eyes in the Sky: the getaway car runs, three stars on it, and the clock starts. */
  _goChase() {
    const g = this.game, r = g.runner;
    if (!r) return;
    r.running = true;
    r.breakIn = 0;
    if (this.type === 'stop' && g.selfUnit) g.dispatcher.adopt(g.selfUnit());
    g.heat.bump(1, 'the daily challenge');
    g.heat.value = 3;
    for (const sp of this.backupPlan || []) {
      const u = g.spawnUnitAt({ x: sp.x, y: g.sim.decks && sp.y !== undefined ? sp.y : 0.95 + this._y(sp.x, sp.z), z: sp.z }, sp.heading, sp.kind);
      if (u) g.dispatcher.adopt(u);
    }
    const k = g.dispatcher && g.dispatcher.knowledge;
    if (k) {
      k.seen = true;
      k.position.copy(r.vehicle.position);
      k.velocity.set(0, 0, 0);
      k.confidence = 1;
      k.timeSinceSeen = 0;
    }
  }

  /** Finished or failed: the force stops where it is (see Game._update and _halt). */
  get over() { return this.state === 'won' || this.state === 'failed'; }

  /** Over, or still counting down: the force is held where it is either way. */
  get frozen() { return this.over || this.state === 'countdown'; }

  /**
   * A point on the route `ahead` metres past where you are, on the left-hand lane going your way (`back`
   * false) or the other way (`back` true), for a car to be put down at: Game.spawnPoliceAhead and
   * Game.spawnRhino ask here in the challenge. "Some of the police were still not spawning ... on the
   * route. They were like spawning in random places." Null past the end of it.
   */
  siteAhead(ahead, back = false) {
    const s = this.progress + ahead;
    if (!this.route || s > this.route.length - 20) return null;
    const q = this._siteAt(s);
    const lane = Math.min(3, q.width * 0.25) * (back ? -1 : 1);
    // Left-hand traffic: the lane going your way is to the left of the line (+x of the direction of travel).
    const x = q.x + q.tz * lane, z = q.z - q.tx * lane;
    const heading = back ? Math.atan2(-q.tx, -q.tz) : Math.atan2(q.tx, q.tz);
    return { x, z, heading };
  }

  /**
   * Every police car on the brakes, and the force not told anything more: "when I completed the daily
   * challenge or I ran out of time, I wanted to stop all the police because otherwise they keep moving and
   * keep pushing me." Game._update skips the dispatcher while `over`, so these are the last controls they get.
   */
  _halt() {
    for (const v of this.game.vehicles) {
      if (v.isPolice && v !== this.game.player) v.setControls({ throttle: 0, brake: 1, steer: 0, handbrake: 1 });
    }
  }

  /** Once a frame, after the physics. */
  update(dt) {
    const g = this.game, p = g.player;
    if (!p || !this.route) return;
    // Every frame, not once: the police chasing the day's other suspects are driven by game/suspects.js,
    // not the dispatcher, and went on at full throttle. This runs after both, before the physics.
    if (this.state === 'won' || this.state === 'failed') { this._halt(); this._paint(); return; }
    if (this.state === 'countdown') {
      this.count -= dt;
      if (!p.isAircraft) p.setControls({ throttle: 0, brake: 1, steer: 0, handbrake: 1 });
      if (this.rescue) this.rescue.hold();
      this._halt();
      if (this.type === 'escape' && g.heat.value < 5) g.heat.value = 5;
      if (g.runner && this.type !== 'escape') g.runner.vehicle.setControls({ throttle: 0, brake: 1, steer: 0, handbrake: 1 });
      this._showCount();
      if (this.count <= 0) {
        this.state = 'running';
        if (this.type !== 'escape') this._goChase();
        // Another go at today's: "how many attempts it took ... it took me like 20 attempts today."
        this.attempt = bumpAttempts(this.day);
      }
      this._paint();
      return;
    }
    this._showCount();
    // The clock starts when you do.
    // (The clock starts at GO now, after the countdown, rather than on the first touch of the pedals.)
    if (this.state === 'running') this.time += dt;
    if (this.rescue) { this._updateRescue(dt); return; }
    if (this.type !== 'escape') { this._updateChase(dt); return; }
    // And the stars stay where they were put.
    if (g.heat.value < 5) g.heat.value = 5;

    this._ghostTick(dt);
    this._track(p);
    this._spawnDue();
    this._obstacles();
    this._throughGates(p);
    const next = this._nextGate();
    this.missed = next < this.gates.length && this.progress > this.gates[next].s + GATE_MISSED;
    this._placeGates();
    this._offRoute();

    // Nothing ends it on touch any more: "even if I hit a building, I don't want you to instantly end it."
    // A hit costs damage as it does in any chase, and 100% is the end. (_hitWhat is kept for tests/daily.js,
    // which counts what the game's own driver touches.)
    if (g.drowned) { this._fail('flooded'); return; }
    if ((p.damage || 0) >= 0.999 || p.disabled) { this._fail('wrecked'); return; }
    if (g.outcome === 'busted') { this._fail('busted'); return; }
    if (this.state === 'running' && !this.short && this.time > this.limit) { this._fail('time'); return; }
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

  /**
   * Lone Unit: arrested (the game's own BUSTED, made by you, there being nobody else) is the finish; lost
   * (the wanted level run out) or the clock is the end. Eyes in the Sky: every moment the crew can make the
   * car out (FlyingHelicopter.canSee) counts, and AIR_NEED of it is the finish; the car is kept wanted, so
   * it keeps running, and only the clock ends it.
   */
  _updateChase(dt) {
    const g = this.game, p = g.player, r = g.runner;
    if (this.type === 'stop') {
      if ((p.damage || 0) >= 0.999 || p.disabled) { this._fail('wrecked'); return; }
      if (g.outcome === 'busted' && r) { this._win(); return; }
      if (this.time > 3 && g.heat.value <= 0) { this._fail('lost'); return; }
    } else {
      if (g.heat.value < 3) g.heat.value = 3;
      if (r && p.canSee && p.canSee(r.vehicle)) this.watched += dt;
      if (this.watched >= AIR_NEED) { this._win(); return; }
    }
    if (!this.short && this.time > this.limit) { this._fail('time'); return; }
    this._paint();
  }

  /** Air Rescue: every landing made is the finish; a wreck is the whole thing from the top, at once; or the clock. */
  _updateRescue(dt) {
    const g = this.game;
    if (g.heat.value > 0) g.heat.reset();
    const r = this.rescue.update(dt);
    if (r === 'won') { this._win(); return; }
    if (r === 'wrecked') {
      g.restart();
      if (g.hud) g.hud.toast('AIRCRAFT DOWN: FROM THE TOP');
      return;
    }
    if (!this.short && this.time > this.limit) { this._fail('time'); return; }
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

  /** 3, 2, 1, GO in the middle of the screen; GO stays a moment after the clock starts. */
  _showCount() {
    const el = document.getElementById('dailycount');
    if (!el) return;
    let text = '';
    if (this.state === 'countdown') text = String(Math.max(1, Math.ceil(this.count)));
    else if (this.state === 'running' && this.time < GO_FOR) text = 'GO';
    if (text === this._countShown) return;
    this._countShown = text;
    el.hidden = !text;
    el.textContent = text;
    // Each number pops in afresh.
    el.classList.remove('pop');
    void el.offsetWidth;
    if (text) el.classList.add('pop');
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
  /** The height of the route's road at (x, z): its deck, where the route is up on a raised one there. */
  _y(x, z) {
    const g = this.game;
    if (!g.sim.decks) return g.groundAt(x, z);
    let best = null, bd = Infinity;
    for (const q of this.route.pts) { const d = (q.x - x) ** 2 + (q.z - z) ** 2; if (d < bd) { bd = d; best = q; } }
    return g.roadY(x, z, best && best.edge);
  }

  _siteAt(s) {
    const pts = this.route.pts;
    let i = 1;
    while (i < pts.length - 1 && pts[i].s < s) i++;
    const a = pts[i - 1], b = pts[i];
    const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    const u = clamp((s - a.s) / l, 0, 1);
    const width = (b.edge && b.edge.width) || 9;
    return { x: a.x + (b.x - a.x) * u, z: a.z + (b.z - a.z) * u, tx: (b.x - a.x) / l, tz: (b.z - a.z) / l, width, name: (b.edge && b.edge.name) || 'the route', edge: b.edge };
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
    this._halt();
    this._offRoute();
    this.failedBy = why;
    if (!g.outcome) g.outcome = 'daily';
    const line = why === 'time' ? `Out of time at <b>${fmtTime(this.limit)}</b>`
      : why === 'busted' ? 'Busted'
        : why === 'flooded' ? 'Engine flooded: you drowned'
        : why === 'wrecked' ? 'Wrecked: <b>100%</b> damage'
        : why === 'lost' ? 'They got away'
        : `You hit <b>${why}</b>`;
    const best = dailyBest(this.day);
    g.hud.showOverlay('CHALLENGE FAILED', [
      line,
      this.rescue ? `<b>${this.rescue.leg}</b> of 3 landings`
        : this.type === 'air' ? `<b>${Math.min(AIR_NEED, this.watched || 0).toFixed(1)}</b> of ${AIR_NEED}s in sight`
        : this.type === 'stop' ? `After <b>${fmtTime(this.time)}</b>`
          : `<b>${Math.round(this.progress)}</b> of ${Math.round(this.route.length)} m`,
      best !== null ? `Your best today <b>${fmtTime(best)}</b>` : 'Not finished yet today',
    ].join(' &nbsp;·&nbsp; '));
    if (g.audio) g.audio.impact(0.6);
    this._paint();
  }

  _win() {
    const g = this.game;
    this.state = 'won';
    this._halt();
    this._offRoute();
    if (!g.outcome) g.outcome = 'daily';
    const t = Math.round(this.time * 100) / 100;
    const before = dailyBest(this.day);
    saveBest(this.day, t);
    const best = before === null || t < before;
    const name = savedName();
    g.hud.showOverlay('CHALLENGE COMPLETE', [
      `<div class="dwin">Time <b>${fmtTime(t)}</b> &nbsp;·&nbsp; attempt <b>${this.attempt || 1}</b>${best ? ' &nbsp;<b class="best">YOUR BEST TODAY</b>' : ` &nbsp;(best ${fmtTime(before)})`}</div>`,
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
      const rows = await postTime(this.day, name, t, this.plan.car, this._line, this.attempt || 1);
      if (rows === 'taken') {
        btn.textContent = 'NAME TAKEN';
        btn.disabled = false;
        box.focus();
        box.select();
        return;
      }
      saveName(name);
      // Faster than the ghost there was: yours is the ghost now, from the next go.
      const gd = this.ghostData;
      const gEnd = gd && gd.length >= 5 ? gd[gd.length - 5] : Infinity;
      if (rows && this._line && this._line.length >= 10 && t < gEnd) this.ghostData = this._line.slice();
      btn.textContent = rows ? 'POSTED' : 'COULD NOT POST';
      if (!rows) btn.disabled = false;
      if (rows && table) table.innerHTML = boardHtml(rows, name);
    });
  }

  /** The panel at the top: the clock against the limit, and how far there is to go. */
  _paint() {
    if (!this.el || !this.route) return;
    this.el.hidden = false;
    // With no clock to beat, the time it is taking: the table is the quickest.
    const left = this.short ? this.time : Math.max(0, this.limit - this.time);
    const togo = Math.max(0, this.route.length - this.progress);
    const warn = !this.short && left < 10 && this.state === 'running';
    const what = this.rescue ? this.rescue.say : this.type === 'stop' ? 'arrest the getaway car'
      : this.type === 'air' ? `in sight ${Math.min(AIR_NEED, this.watched || 0).toFixed(1)} of ${AIR_NEED}s`
        : `${(togo / 1000).toFixed(2)} km to go`;
    const html = `<b>DAILY</b> <span class="${warn ? 'warn' : ''}">${fmtTime(left)}</span>`
      + ` <small>${what}</small>`;
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
    if (this.rescue) this.rescue.dispose();
    if (this.el) this.el.hidden = true;
    for (const m of this.gateMeshes || []) { this.game.scene.remove(m); m.material.dispose(); }
    if (this.gateMeshes && this.gateMeshes[0]) this.gateMeshes[0].geometry.dispose();
    const w = document.getElementById('dailywarn');
    if (w) w.hidden = true;
    const c = document.getElementById('dailycount');
    if (c) c.hidden = true;
    if (this.ghostMesh) this.game.scene.remove(this.ghostMesh);
  }
}

/**
 * The average speed the clock asks of each car, m/s: the clock is the route's length over this, times
 * DAILY_SLACK. The game's own driver, with an empty road, kept 16.7 (Badger), 17.1 (Runner) and 17.4
 * (Stiletto) down 1.62 km of Wexbury (tests/daily.js) -- it keeps to the roads' speeds -- so these ask for a
 * run 8% (Badger) to 38% (Stiletto) quicker than that, with five stars after you.
 */
const DAILY_PACE = { runner: 21, supercar: 24, offroad: 18 };
