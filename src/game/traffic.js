// Traffic: ordinary cars going about their business.
//
// "I'm thinking of adding traffic ... my ideal thing would be add traffic on
// every single map." Started on Haldon Vale (TRAFFIC_MAPS), where the police
// have the room to go round it, and written so that turning it on for another
// map is adding its id to the list.
//
// A traffic car is a patrol car without the light bar: the same Driver, the
// same road graph, its own lane, the road's speed (a little under), red
// lights, and a queue behind whatever is in front of it. What it adds:
//
//   * it only ever appears and disappears out of everyone's sight
//     (Game.seenByAnyone), TRAFFIC_NEAR to TRAFFIC_FAR from a player, and goes
//     again past TRAFFIC_GONE -- a dozen cars round the people playing, not a
//     map full of them;
//   * it pulls over for a car running with blue lights, slowing to a stop in
//     its lane -- the near side of the road -- until the police are past -- which is what keeps
//     the chase moving: traffic is in the escapee's way, and gets out of the
//     police's;
//   * each car is one of three models in its own colour (opts.paint).
//
// Only the machine that runs the AI runs this; in a multiplayer game the other
// players are sent the cars like the AI police (Game._netSend), and each car's
// colour follows from its id, so it is the same colour on every screen.

import { Driver, SKILL } from '../ai/driver.js';
import { ROLE } from '../ai/officer.js';
import { dist2 } from '../util/math.js';
import { DRIVE_SIDE } from '../world/roadgraph.js';

/** Which maps have traffic. */
export const TRAFFIC_MAPS = ['haldon', 'wexbury'];
/** How many cars, and the ring round the players they live in, m. */
// Five more than the first trial's twelve, paid for by five fewer police
// cars at five stars (Dispatcher.PACK_CAP 30 -> 25).
const TRAFFIC_COUNT = 17;
const TRAFFIC_NEAR = 160;
const TRAFFIC_FAR = 460;
const TRAFFIC_GONE = 640;
/** Which side of the road, m off the middle (clamped to the road's width). */
const LANE = 2.4;
/** Within this of a player, m, a traffic car is simulated; beyond it, moved along its route. */
const SIM_RANGE = 150;
const SIM_SLACK = 40;
/** How far past the edge of the road a car pulls over onto the verge, m. */
const VERGE = 1.4;
/** And how fast it goes on getting there, m/s. */
const CRAWL = 3;
/** Pull over for blue lights within this, m. */
const PULL_RANGE = 70;
/** Of the road's speed limit, how much a traffic car drives at. */
const PACE = 0.85;

const KINDS = ['hatchback', 'hatchback', 'estate', 'estate', 'civsuv'];
/** Ordinary car colours: greys and silvers mostly, a few that are not. */
const PAINTS = [
  0xc9ccce, 0x8d9094, 0x4a4d52, 0x1d1f22, 0xf2f2ef, 0xe8e6e0,
  0x7d1d1f, 0x1f3550, 0x2e4a33, 0x9a8a6c, 0x5b6f86, 0xb0461f,
];

/** A car's colour from its id, so it is the same on every screen. */
export function trafficPaint(id) {
  let h = 2166136261;
  const s = String(id);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return PAINTS[(h >>> 0) % PAINTS.length];
}

export class Traffic {
  constructor(game) {
    this.game = game;
    /** { v, driver, id, stuckFor, pullFor } */
    this.cars = [];
    this._spawnIn = 1;
    this._made = 0;
  }

  get enabled() {
    const g = this.game;
    if (typeof window !== 'undefined' && window.__traffic === false) return false;
    return !!g.mapDef && TRAFFIC_MAPS.includes(g.mapDef.id);
  }

  /** The vehicles that are traffic, for anything that needs to tell. */
  has(v) { return this.cars.some((c) => c.v === v); }

  /** Where the people playing are. */
  _watchers() {
    const g = this.game;
    const out = g.player ? [g.player.position] : [];
    return out.concat(g.humanPositions());
  }

  update(dt) {
    if (!this.enabled) {
      if (this.cars.length) this.clear();
      return;
    }
    const g = this.game;
    const watchers = this._watchers();
    const nearest = (p) => {
      let best = Infinity;
      for (const w of watchers) best = Math.min(best, dist2(w.x, w.z, p.x, p.z));
      return best;
    };

    // Gone: far off, or wrecked or stuck -- and in every case out of sight.
    for (const c of this.cars.slice()) {
      const p = c.v.position;
      const far = nearest(p);
      const done = far > TRAFFIC_GONE
        || (c.v.disabled && far > TRAFFIC_NEAR)
        || (c.stuckFor > 20 && far > 80)
        || p.y < -10;
      if (done && !g.seenByAnyone(p)) this._remove(c);
    }

    // New: one at a time, a few a second, until there are enough.
    this._spawnIn -= dt;
    // Fewer on a machine that has already had to shed police cars to hold its
    // frame rate (Game's quality ladder lowers vehicleLimit).
    const want = g.vehicleLimit < 30 ? Math.round(TRAFFIC_COUNT / 2) : TRAFFIC_COUNT;
    if (this.cars.length < want && this._spawnIn <= 0 && watchers.length) {
      this._spawnIn = 0.35;
      this._spawn(watchers, nearest);
    }

    // Only the ones near somebody are simulated; the rest are moved along
    // their routes without physics until someone gets near (SIM_RANGE). Each
    // car costs about what a police car does -- twelve of them took a frame
    // from 4 to 11 ms -- and a car four hundred metres away and out of sight
    // has nothing to do but be somewhere sensible when it is next looked at.
    // With room between waking and sleeping, or a car hovering at the line
    // flips every frame -- and taking a body in and out of the simulation is
    // dear: it was most of what traffic cost.
    for (const c of this.cars) {
      const far = nearest(c.v.position);
      if (c.v.dormant && far < SIM_RANGE && !g.seenByAnyone(c.v.position)) this._wake(c);
      else if (!c.v.dormant && far > SIM_RANGE + SIM_SLACK && !g.seenByAnyone(c.v.position)) this._sleep(c);
      if (c.v.dormant) this._glide(c, dt);
      else this._drive(c, dt);
    }
  }

  _sleep(c) {
    const v = c.v, g = this.game;
    c.rideY = v.position.y - g.sim.heightAt(v.position.x, v.position.z);
    c.cruise = Math.max(8, v.speed);
    v.body.setEnabled(false);
    v.dormant = true;
  }

  _wake(c) {
    const v = c.v;
    v.body.setEnabled(true);
    v.dormant = false;
    v.setVelocity({ x: v.forward.x * c.cruise, y: 0, z: v.forward.z * c.cruise });
    v._readState();
  }

  /** A dormant car, moved along its route at its cruising speed, no physics. */
  _glide(c, dt) {
    const g = this.game, v = c.v, d = c.driver;
    if (!d.hasPath || d.remaining() < 40) this._route(c);
    const pts = d.path;
    if (!pts || pts.length < 2) return;
    let x = v.position.x, z = v.position.z, i = d.pathIndex, step = c.cruise * dt;
    let hx = v.forward.x, hz = v.forward.z;
    while (step > 0 && i < pts.length - 1) {
      const q = pts[i + 1];
      const dx = q.x - x, dz = q.z - z, l = Math.hypot(dx, dz);
      if (l < 1e-3) { i++; continue; }
      hx = dx / l; hz = dz / l;
      if (l <= step) { x = q.x; z = q.z; step -= l; i++; } else { x += hx * step; z += hz * step; step = 0; }
    }
    d.pathIndex = i;
    // At the road's pace from here on, as it would be driving.
    const at = pts[Math.min(i, pts.length - 1)];
    c.cruise = ((at && at.speed) || 15) * PACE;
    const y = g.sim.heightAt(x, z) + c.rideY;
    const yaw = Math.atan2(hx, hz);
    v.body.setTranslation({ x, y, z }, false);
    v.body.setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }, false);
    v._readState();
    v.linvel.set(hx * c.cruise, 0, hz * c.cruise);
    v.speed = c.cruise;
    v.forwardSpeed = c.cruise;
  }

  _spawn(watchers, nearest) {
    const g = this.game, gr = g.graph;
    const w = watchers[Math.floor(g.rng() * watchers.length)];
    for (let i = 0; i < 12; i++) {
      const n = gr.randomNode(g.rng);
      const d = dist2(n.x, n.z, w.x, w.z);
      if (d < TRAFFIC_NEAR || d > TRAFFIC_FAR || nearest(n) < TRAFFIC_NEAR) continue;
      const place = g._placeOnRoad(n);
      if (!place || g.seenByAnyone(place.position)) continue;
      const id = `t${++this._made}`;
      const kind = KINDS[Math.floor(g.rng() * KINDS.length)];
      const v = g.createVehicle(kind, kind, place.position, place.heading, {
        spawn: true, paint: trafficPaint(id),
      });
      if (!v) continue;
      v.isTraffic = true;
      v.setVelocity({ x: Math.sin(place.heading) * 9, y: 0, z: Math.cos(place.heading) * 9 });
      const c = { v, driver: new Driver(v, SKILL.regular), id, stuckFor: 0, pullFor: 0 };
      this.cars.push(c);
      this._route(c);
      return;
    }
  }

  _route(c) {
    const g = this.game, gr = g.graph, v = c.v;
    let goal = null;
    for (let i = 0; i < 12 && !goal; i++) {
      const n = gr.randomNode(g.rng);
      const d = dist2(n.x, n.z, v.position.x, v.position.z);
      if (d > 150 && d < 800) goal = n;
    }
    if (!goal) goal = gr.randomNode(g.rng);
    const pts = gr.pathFromPosition(
      v.position.x, v.position.z, v.forward.x, v.forward.z, goal.id, LANE,
      Infinity, v.speed, 9, { cuts: false },
    );
    if (pts.length >= 2) c.driver.setPath(pts);
  }

  /** Blue lights near enough to get out of the way of. */
  _sirenNear(v) {
    const g = this.game;
    if (!(g.heat && g.heat.value > 0)) return false;
    for (const u of g.dispatcher.units) {
      if (u.role === ROLE.PATROL || !u.vehicle || u.vehicle.disabled) continue;
      const p = u.vehicle.position;
      if (dist2(p.x, p.z, v.position.x, v.position.z) < PULL_RANGE) return true;
    }
    // A police player's car, lights on, counts too.
    const me = g.player;
    if (me && me.isPolice && me !== v
      && dist2(me.position.x, me.position.z, v.position.x, v.position.z) < PULL_RANGE) return true;
    return false;
  }

  _drive(c, dt) {
    const g = this.game, v = c.v, d = c.driver;
    if (v.disabled) { v.setControls({ throttle: 0, brake: 0, steer: 0, handbrake: 1 }); return; }
    if (c.pullFor <= 0 && (!d.hasPath || d.remaining() < 40)) this._route(c);

    const was = c.pullFor > 0;
    c.pullFor = this._sirenNear(v) ? 2.5 : Math.max(0, c.pullFor - dt);
    // Onto the verge to let them by, the way a driver does, not stopped in the
    // lane: on a single-track lane a car stopped in it is a wall, and a unit
    // coming up behind at speed drove into one. The route ahead is moved over
    // to the near side, past the edge of the road; when the lights have gone
    // it gets a fresh route back onto it.
    if (c.pullFor > 0 && !was) this._toVerge(c);
    if (c.pullFor <= 0 && was) this._route(c);

    const here = d.path[d.pathIndex];
    let cap = ((here && here.speed) || 15) * PACE;
    // Red lights, the same way a patrol car stops for them (Officer._signalCap).
    if (g.signals) {
      const s = g.signals.stopDistanceAt(v.position.x, v.position.z, v.forward.x, v.forward.z, v.speed);
      if (Number.isFinite(s)) cap = Math.min(cap, Math.sqrt(2 * 3.4 * Math.max(0, s - 1.0)));
    }
    // Pulled over: down to a crawl while it gets onto the verge, then a stop.
    let onVerge = false;
    if (c.pullFor > 0) {
      const sn = g.graph.nearestEdge(v.position.x, v.position.z, 30);
      onVerge = !sn || sn.dist > sn.edge.width * 0.5 + 0.4;
      cap = Math.min(cap, Math.max(onVerge ? 0 : CRAWL, v.speed - 4 * dt));
    }

    // Queueing behind what is in front, and nothing else: Driver.avoid sweeps
    // for scenery and other cars to dodge, which a car keeping to its lane at
    // the limit does not need, and it was the dearest thing a traffic car did.
    d.holdBehind(d.carInWay(g.vehicles), dt);
    const out = d.followPath(dt, cap);
    // Pulled over: the steering from the route, the pedals from here. Asked
    // for a stop, the driver's own unstick logic would sooner or later push
    // on through it -- a car told to give way drove off again at 29 km/h with
    // the police twenty metres behind.
    // Slowing on the footbrake; stopped, on the handbrake -- the brake held at
    // a standstill is reverse in this game, and a car "stopped" that way
    // backed off down the lane at 36 km/h.
    if (c.pullFor > 0 && (onVerge || v.forwardSpeed > CRAWL + 2)) {
      out.throttle = 0;
      if (v.forwardSpeed > 2.5) { out.brake = 0.35; out.handbrake = 0; } else { out.brake = 0; out.handbrake = 1; }
    }
    v.setControls(out);

    c.stuckFor = v.speed < 0.5 && c.pullFor <= 0 && !d.heldBy ? c.stuckFor + dt : 0;
  }

  /** Move the next stretch of route over onto the near-side verge. See _drive. */
  _toVerge(c) {
    const d = c.driver, pts = d.path, g = this.game;
    if (!pts || pts.length < 2) return;
    const here = pts[d.pathIndex] || pts[0];
    const snap = g.graph.nearestEdge(here.x, here.z, 30);
    const half = snap ? snap.edge.width * 0.5 : 4;
    // From the lane (already LANE, or less on a narrow road, to the near side)
    // to a little past the edge of the tarmac.
    const shift = Math.max(0.8, half + VERGE - Math.min(LANE, half - 1.6));
    let acc = 0;
    const out = pts.map((p) => ({ ...p }));
    for (let i = d.pathIndex; i < out.length - 1 && acc < 70; i++) {
      const a = pts[i], b = pts[i + 1];
      const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
      const tx = (b.x - a.x) / l, tz = (b.z - a.z) / l;
      // Eased in over the first 15 m, so it steers across rather than jumps.
      const k = Math.min(1, acc / 15);
      out[i + 1].x = b.x + -tz * shift * k * DRIVE_SIDE;
      out[i + 1].z = b.z + tx * shift * k * DRIVE_SIDE;
      acc += l;
    }
    const keep = d.pathIndex;
    d.setPath(out.slice(0, Math.min(out.length, keep + 1 + Math.ceil(acc / 4))));
  }

  _remove(c) {
    if (c.v.dormant) { c.v.body.setEnabled(true); c.v.dormant = false; }
    const i = this.cars.indexOf(c);
    if (i >= 0) this.cars.splice(i, 1);
    this.game.removeVehicle(c.v);
  }

  clear() {
    for (const c of this.cars.slice()) this._remove(c);
  }
}
