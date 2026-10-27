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

import * as THREE from 'three';
import { Driver, SKILL } from '../ai/driver.js';
import { ROLE } from '../ai/officer.js';
import { dist2 } from '../util/math.js';
import { DRIVE_SIDE } from '../world/roadgraph.js';

/** Which maps have traffic. */
export const TRAFFIC_MAPS = ['haldon', 'wexbury'];
/** How many cars, and the ring round the players they live in, m. */
// Five more than the first trial's twelve, paid for by five fewer police
// cars at five stars (Dispatcher.PACK_CAP 30 -> 25).
// The ring was 160-460 m (gone at 640): "I saw hardly any traffic" -- in
// Wexbury's streets nobody sees 160 m, and seventeen cars spread to 640 m left
// under two within 150 m of a driving player. Still only ever out of sight.
const TRAFFIC_COUNT = 17;
const TRAFFIC_NEAR = 70;
const TRAFFIC_FAR = 260;
const TRAFFIC_GONE = 360;
/** Which side of the road, m off the middle (clamped to the road's width). */
const LANE = 2.4;
/** Within this of a player, m, a traffic car is simulated; beyond it, moved along its route. */
const SIM_RANGE = 150;
const SIM_SLACK = 40;
/**
 * How far past the edge of the road a car pulls over onto the verge, m: short
 * of Haldon Vale's hedges, which stand 1.8 m off the tarmac.
 */
const VERGE = 0.9;
/** And how fast it goes on getting there, m/s. */
const CRAWL = 3;
/** How long a car stays pulled over once it has started, s. */
const PULL_HOLD = 4;
/** Pull over for blue lights within this, m. */
const PULL_RANGE = 70;
/**
 * Of the road's speed limit, how much a traffic car drives at, and never more
 * than TOP_SPEED, m/s. "Sometimes the cars seem to go way too fast": at 85%
 * of Haldon's country roads they were doing 80-86 km/h between the hedges.
 */
const PACE = 0.75;
const TOP_SPEED = 20;

/** A gliding car re-routes rather than heading for a route point further off than this, m. */
const GLIDE_GAP = 30;
/** How high a settled hatchback rides, m, body origin above the ground. */
const RIDE = 0.46;
const _e = new THREE.Euler();
const _q = new THREE.Quaternion();

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
    // Waking does not wait until nobody is looking: a dormant car has no body,
    // and one that stayed asleep because it was in view was a ghost -- "there
    // were like two, and I went straight through them." Waking moves nothing
    // the player can see; only sleeping waits for nobody to be looking.
    for (const c of this.cars) {
      const far = nearest(c.v.position);
      if (c.v.dormant && far < SIM_RANGE) this._wake(c);
      else if (!c.v.dormant && far > SIM_RANGE + SIM_SLACK && !g.seenByAnyone(c.v.position)) this._sleep(c);
      if (c.v.dormant) this._glide(c, dt);
      else this._drive(c, dt);
    }
  }

  _sleep(c) {
    const v = c.v;
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
      // A route point far off is not one to glide straight at -- that went
      // across the fields. A fresh route from here instead.
      if (l > GLIDE_GAP) { this._route(c); return; }
      if (l < 1e-3) { i++; continue; }
      hx = dx / l; hz = dz / l;
      if (l <= step) { x = q.x; z = q.z; step -= l; i++; } else { x += hx * step; z += hz * step; step = 0; }
    }
    d.pathIndex = i;
    // At the road's pace from here on, as it would be driving.
    const at = pts[Math.min(i, pts.length - 1)];
    // Gives way to blue lights while gliding too: it simply waits.
    c.cruise = this._sirenNear(v) ? 0 : Math.min(((at && at.speed) || 15) * PACE, TOP_SPEED);
    // On the ground and with it: at the height a settled car of this kind
    // rides, tilted to the slope. "A car came down the hill ... almost
    // floating a few metres above the ground, level instead of going down":
    // a glide used whatever height the car had when it fell asleep -- most
    // fell asleep just after appearing, still dropping onto their wheels, and
    // rode 0.95 m up instead of 0.46 -- and was always level.
    const h = (px, pz) => g.sim.heightAt(px, pz);
    const y = h(x, z) + c.rideY;
    const e = 1.6;
    const pitch = Math.atan2(h(x + hx * e, z + hz * e) - h(x - hx * e, z - hz * e), 2 * e);
    // The car's left is (hz, -hx); up on the left is a positive roll about Z.
    const roll = Math.atan2(h(x + hz * e, z - hx * e) - h(x - hz * e, z + hx * e), 2 * e);
    _e.set(-pitch, Math.atan2(hx, hz), roll, 'YXZ');
    _q.setFromEuler(_e);
    v.body.setTranslation({ x, y, z }, false);
    v.body.setRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w }, false);
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
      // The height it rides at, settled on its wheels: 0.46 m measured for
      // the hatchback and the estate, a little more on the SUV's bigger
      // wheels. Kept up to date while it is simulated (see _drive).
      const rideY = RIDE + (v.spec.wheelRadius - 0.32);
      const c = { v, driver: new Driver(v, SKILL.regular), id, stuckFor: 0, pullFor: 0, rideY };
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
    // Coming at it, not merely near it: a roadblock crew parked by the road,
    // or a unit going the other way, used to have every car within 70 m
    // stopped on the verge.
    const coming = (o) => {
      const dx = v.position.x - o.position.x, dz = v.position.z - o.position.z;
      const l = Math.hypot(dx, dz);
      if (l > PULL_RANGE || o.speed < 5) return false;
      const theirs = (o.linvel.x * dx + o.linvel.z * dz) / (l || 1);
      const mine = (v.linvel.x * dx + v.linvel.z * dz) / (l || 1);
      return theirs - mine > 2;
    };
    for (const u of g.dispatcher.units) {
      if (u.role === ROLE.PATROL || !u.vehicle || u.vehicle.disabled) continue;
      if (coming(u.vehicle)) return true;
    }
    // A police player's car, lights on, counts too.
    const me = g.player;
    return !!(me && me.isPolice && me !== v && coming(me));
  }

  _drive(c, dt) {
    const g = this.game, v = c.v, d = c.driver;
    if (v.disabled) { v.setControls({ throttle: 0, brake: 0, steer: 0, handbrake: 1 }); return; }
    if (c.pullFor <= 0 && (!d.hasPath || d.remaining() < 40)) this._route(c);

    const was = c.pullFor > 0;
    // Once it starts, it finishes: a few seconds at least, so a car that
    // began to pull over is stopped on the verge rather than drifting back
    // into the lane the moment the police car is past.
    c.pullFor = this._sirenNear(v) ? Math.max(c.pullFor, PULL_HOLD) : Math.max(0, c.pullFor - dt);
    if (c.pullFor <= 0 && was) this._route(c);
    if (c.pullFor > 0) { this._pullOver(c, dt); return; }

    const here = d.path[d.pathIndex];
    let cap = Math.min(((here && here.speed) || 15) * PACE, TOP_SPEED);
    // Red lights, the same way a patrol car stops for them (Officer._signalCap).
    if (g.signals) {
      const s = g.signals.stopDistanceAt(v.position.x, v.position.z, v.forward.x, v.forward.z, v.speed);
      if (Number.isFinite(s)) cap = Math.min(cap, Math.sqrt(2 * 3.4 * Math.max(0, s - 1.0)));
    }

    // Queueing behind what is in front, and nothing else: Driver.avoid sweeps
    // for scenery and other cars to dodge, which a car keeping to its lane at
    // the limit does not need, and it was the dearest thing a traffic car did.
    d.holdBehind(d.carInWay(g.vehicles), dt);
    v.setControls(d.followPath(dt, cap));

    c.stuckFor = v.speed < 0.5 && c.pullFor <= 0 && !d.heldBy ? c.stuckFor + dt : 0;
    if (v.grounded >= 4 && v.up.y > 0.9) {
      const up = v.position.y - g.sim.heightAt(v.position.x, v.position.z);
      if (Math.abs(up - c.rideY) < 0.3) c.rideY += (up - c.rideY) * 0.05;
    }
  }

  /**
   * Off the road for blue lights. "When they pull off the road, they don't
   * just pull to the side very well." Moving the route over sideways sent one
   * car eight metres out into a field and left others never stopping. Now it
   * steers for a point eight metres up the road and just past its near-side
   * edge -- measured from the road, so it cannot wander further -- at a crawl,
   * and once it is past the edge it stops, on the handbrake: the brake held
   * at a standstill is reverse in this game, and the first version backed
   * off down the lane at 36 km/h.
   */
  _pullOver(c, dt) {
    const g = this.game, v = c.v, d = c.driver;
    const here = g.graph.nearestEdge(v.position.x, v.position.z, 30);
    const onVerge = !here || here.dist > here.edge.width * 0.5 + 0.3;
    if (onVerge || v.forwardSpeed < -0.5) {
      v.setControls({ throttle: 0, brake: v.forwardSpeed > 2.5 ? 0.5 : 0, steer: 0, handbrake: v.forwardSpeed > 2.5 ? 0 : 1 });
      return;
    }
    const ax = v.position.x + v.forward.x * 8, az = v.position.z + v.forward.z * 8;
    const snap = g.graph.nearestEdge(ax, az, 30);
    if (!snap) { v.setControls({ throttle: 0, brake: 0, steer: 0, handbrake: 1 }); return; }
    const t = g.graph.edgeDirection(snap.edge, snap.along, { x: 0, z: 1 });
    const s = t.x * v.forward.x + t.z * v.forward.z >= 0 ? 1 : -1;
    const tx = t.x * s, tz = t.z * s;
    const off = snap.edge.width * 0.5 + VERGE;
    const aim = { x: snap.x + -tz * off * DRIVE_SIDE, z: snap.z + tx * off * DRIVE_SIDE };
    const out = d.driveTo(aim, CRAWL, dt, {});
    if (v.forwardSpeed > CRAWL + 1.5) { out.throttle = 0; out.brake = 0.4; }
    v.setControls(out);
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
