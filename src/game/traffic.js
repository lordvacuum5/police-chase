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
import { DRIVE_SIDE, LANES } from '../world/roadgraph.js';
import { groups, GROUP } from '../physics/world.js';

/** Which maps have traffic. */
export const TRAFFIC_MAPS = ['haldon', 'wexbury', 'city'];
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
/** On a raised road (Ashfield's motorway): spawned as far out as this, and past DECK_HAZE even in view, m. */
const DECK_FAR = 460;
const DECK_HAZE = 300;
/**
 * On a map with fog, up on a raised road, further: out past where the fog has all but hidden it, a share of its end. Made at
 * 300 m in plain view they "fade into existence too close to the player": 29 in a minute at 240 km/h, as near as 276 m
 * (tests/seenahead.js). Those behind go sooner, for more ahead.
 */
const FOG_HID = 0.9;
const BEHIND_GONE = 340;
/** On the motorway and expressway, m/s: by the lane, inside first. */
const LANE_PACE = { motorway: [30, 27, 23], dual: [25, 21] };
/** Which side of the road, m off the middle (clamped to the road's width). */
const LANE = 2.4;
/** Within this of a player, m, a traffic car is simulated; beyond it, moved along its route. */
const SIM_RANGE = 150;
/** Nearer anybody than this, m, a car's driver thinks every frame. */
const DRIVE_NEAR = 90;
/** How far from a player in the air a car may come on to the road, m. */
const SKY_CLEAR = 160;
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
/** The chance a car runs a red light it comes to, when a patrol car is close enough to see. */
const RED_RUN = 0.1;
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
/**
 * The road graph's spurs: road that leads only to dead ends -- a lane up to a
 * farm, a drive, a close. The leaves pruned off over and over until there are
 * none; whatever went is spur, whatever is left is through road. Traffic is
 * made only on through road and only sent to it. "Suddenly there were like a
 * line of cars, civilian cars, seemingly all come from this farm building
 * ... if it's a tiny road, and the only place that road leads it to was a
 * farm building, like, that's not very realistic." A car was made at any node
 * out of sight, a farm lane's end as soon as any; and while the farm stayed
 * out of sight, the next one too. Once per graph.
 */
const _spurs = new WeakMap();
export function spurNodes(gr) {
  let out = _spurs.get(gr);
  if (out && out.edges === gr.edges.length) return out.nodes;
  const live = (e) => !e.cut && !e.quarry;
  const deg = new Map();
  for (const n of gr.nodes) {
    let k = 0;
    for (const id of n.edges) if (live(gr.edges[id])) k++;
    deg.set(n.id, k);
  }
  const spur = new Set();
  let leaves = gr.nodes.filter((n) => deg.get(n.id) === 1);
  while (leaves.length) {
    const next = [];
    for (const n of leaves) {
      if (spur.has(n.id)) continue;
      spur.add(n.id);
      for (const id of n.edges) {
        const e = gr.edges[id];
        if (!live(e)) continue;
        const o = e.a === n.id ? e.b : e.a;
        if (spur.has(o)) continue;
        deg.set(o, deg.get(o) - 1);
        if (deg.get(o) === 1) next.push(gr.nodes[o]);
      }
    }
    leaves = next;
  }
  _spurs.set(gr, { edges: gr.edges.length, nodes: spur });
  return spur;
}

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

/** Is this point of a route on a big raised road? */
const onBig = (at) => !!(at && at.edge && at.edge.elevated && LANES[at.edge.kind]);

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

    const map = (g.world && g.world.__map) || {};
    // Gone: far off, or wrecked or stuck -- and in every case out of sight.
    for (const c of this.cars.slice()) {
      const p = c.v.position;
      const far = nearest(p);
      // Up on a raised road it may be further off before it goes: it can have come into being out there.
      const up = p.y - g.groundAt(p.x, p.z) > 3;
      const done = far > (up ? this._deckFar() + 80 : Math.max(TRAFFIC_GONE, (map.trafficFar || 0) + 100))
        || (far > BEHIND_GONE && (map.trafficFar || up) && this._behind(p))
        || (map.trafficFar && !up && far > TRAFFIC_GONE && !this._behind(p, -0.8))
        || (c.v.disabled && far > TRAFFIC_NEAR)
        || (c.stuckFor > 20 && far > 80)
        || p.y < -10;
      // Under the ground: its bodywork ignores the hills (see adopt), so one off the edge of a raised road goes
      // through where it lands, to the plate beneath, and sat there for the rest of the game. Nobody sees it go.
      const buried = !c.v.dormant && g.sim.terrainAt && p.y < g.sim.terrainAt(p.x, p.z) - 1.5;
      if (buried || (done && !g.seenByAnyone(p))) this._remove(c);
    }

    // New: one at a time, a few a second, until there are enough.
    this._spawnIn -= dt;
    // Fewer on a machine that has already had to shed police cars to hold its
    // frame rate (Game's quality ladder lowers vehicleLimit).
    // A map can ask for more (Ashfield City, 3 km across: "ideally add in more cars, because it just seems so
    // empty"). Most are gliding, out of anyone's sight, which costs next to nothing.
    const count = window.__trafficCount || map.trafficCount || TRAFFIC_COUNT;
    const want = g.vehicleLimit < 30 ? Math.round(count / 2) : count;
    if (!this.preset && this.cars.length < want && this._spawnIn <= 0 && watchers.length) {
      // Oftener the faster they are going through it, on the map that has it out to the fog.
      this._spawnIn = map.trafficFar ? Math.max(0.1, 0.35 - (g.player ? g.player.speed : 0) * 0.005) : 0.35;
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
    const simRange = window.__trafficSim || map.trafficSim || SIM_RANGE;
    for (const c of this.cars) {
      // Asked as this car, at its height: on the raised motorway, not the street under it (RoadGraph.levelOn).
      g.graph.queryY = c.v.position.y - 0.9;
      const far = nearest(c.v.position);
      if (c.v.dormant && far < simRange) this._wake(c);
      else if (!c.v.dormant && far > simRange + SIM_SLACK && !g.seenByAnyone(c.v.position)) this._sleep(c);
      if (c.v.dormant) this._glide(c, dt);
      else if (far < DRIVE_NEAR) this._drive(c, dt);
      else {
        // Far enough off that nobody can tell, its driver thinks a third as often: the
        // car still runs on the controls it was given. A traffic car's thinking was a
        // quarter of a millisecond a frame, a dozen of them a frame's worth of judder.
        c.driveDt = (c.driveDt || 0) + dt;
        c.driveTick = ((c.driveTick || 0) + 1) % 3;
        if (c.driveTick === 0) { this._drive(c, c.driveDt); c.driveDt = 0; }
      }
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
    if (!d.hasPath || d.remaining(40) < 40) this._route(c);
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
    // But not on the motorway, where what is coming through has two more lanes.
    c.cruise = !onBig(at) && this._sirenNear(v) ? 0 : this._pace(c, at);
    // On the ground and with it: at the height a settled car of this kind
    // rides, tilted to the slope. "A car came down the hill ... almost
    // floating a few metres above the ground, level instead of going down":
    // a glide used whatever height the car had when it fell asleep -- most
    // fell asleep just after appearing, still dropping onto their wheels, and
    // rode 0.95 m up instead of 0.46 -- and was always level.
    // Up on a raised road's deck when the route is (Ashfield City's motorway): the ground's height there
    // is the street under it.
    const on = pts[Math.min(i, pts.length - 1)] && pts[Math.min(i, pts.length - 1)].edge;
    const h = on && on.deck ? (px, pz) => g.graph.levelOn(on, px, pz) : (px, pz) => g.sim.heightAt(px, pz);
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
    const spur = spurNodes(gr);
    const through = (e) => !spur.has(e.a) && !spur.has(e.b);
    // From the junctions near enough, not twelve picked from the whole map: on Ashfield City's 3 km a random
    // twelve were almost never within reach, and with the player up on the motorway no car came at all in two
    // minutes -- "the civilian car routing system, it doesn't work on highways". A raised road may have them
    // further off (DECK_FAR): from up there everything nearer is in plain view, and nothing may appear in view.
    const cands = [];
    const map = (g.world && g.world.__map) || {}, deckFar = this._deckFar(), ground = map.trafficFar || TRAFFIC_FAR;
    const up = !!map.trafficFar && w.y - g.groundAt(w.x, w.z) > 3;
    // Going anywhere, three in four of them ahead.
    const me = g.player && g.player.speed > 12 && dist2(g.player.position.x, g.player.position.z, w.x, w.z) < 5 ? g.player.linvel : null;
    const ahead = me && g.rng() < 0.75;
    for (const n of gr.nodes) {
      if (!n.edges.length || spur.has(n.id)) continue;
      const d = dist2(n.x, n.z, w.x, w.z);
      const far = n.elevated ? deckFar : ground;
      if (d < TRAFFIC_NEAR || d > far) continue;
      // Up there, the streets under it are not what is seen coming.
      if (up && !n.elevated && d > 160) continue;
      // On the streets, that far only up the one they are on: all round, it thinned those near by to four in 150 m.
      if (!n.elevated && d > TRAFFIC_FAR && !(me && (n.x - w.x) * me.x + (n.z - w.z) * me.z > 0.9 * d * g.player.speed)) continue;
      if (ahead && (n.x - w.x) * me.x + (n.z - w.z) * me.z < 0) continue;
      cands.push(n);
    }
    for (let i = 0; i < (map.trafficFar ? 20 : 12) && cands.length; i++) {
      const n = cands[Math.floor(g.rng() * cands.length)];
      const d = dist2(n.x, n.z, w.x, w.z);
      if (nearest(n) < TRAFFIC_NEAR) continue;
      // Out along any of its roads, not the first: on the motorway that was all one way.
      const outs = n.edges.map((id) => gr.edges[id]).filter((e) => !e.cut && through(e));
      const pickE = outs.length ? outs[Math.floor(g.rng() * outs.length)] : null;
      const place = g._placeOnRoad(n, pickE ? (e) => e === pickE : through);
      if (!place) continue;
      const lanes = pickE && pickE.elevated && LANES[pickE.kind];
      const lane = lanes ? Math.floor(g.rng() * lanes.length) : 0;
      if (lanes) {
        // Into its lane from the one _placeOnRoad uses.
        const over = (lanes[lane] - Math.min(3, pickE.width * 0.25)) * DRIVE_SIDE, h = place.heading;
        place.position.x += -Math.cos(h) * over;
        place.position.z += Math.sin(h) * over;
      }
      // Far out, where the fog has it, it may come into being even in view.
      // Ahead along a raised road is in view whatever the barrier says: it hides the road, not a car over it.
      const open = up && n.elevated && me && (n.x - w.x) * me.x + (n.z - w.z) * me.z > 0;
      if (open && d < FOG_HID * g.scene.fog.far) continue;
      const hazy = map.trafficFar ? d > FOG_HID * g.scene.fog.far : n.elevated && d > DECK_HAZE;
      // From a helicopter that is most of the map, so nothing ever came: "when I'm the
      // helicopter ... there's literally no traffic spawns." From up there a car coming on
      // to a road SKY_CLEAR off is a dot nobody is watching appear.
      const flying = g.player && g.player.isAircraft;
      if (flying ? dist2(place.position.x, place.position.z, w.x, w.z) < SKY_CLEAR : (!hazy && g.seenByAnyone(place.position))) continue;
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
      const c = { v, driver: new Driver(v, SKILL.regular), id, stuckFor: 0, pullFor: 0, rideY, lane, paint: trafficPaint(id) };
      this.cars.push(c);
      this._route(c);
      return;
    }
  }

  /**
   * A traffic car of `kind` at a given place, driving off from it: for the daily challenge's preset traffic
   * (DailyChallenge.begin), which sets `preset` so nothing else is spawned. Null if there is no room.
   */
  place(position, heading, kind) {
    const g = this.game;
    const id = `t${++this._made}`;
    const v = g.createVehicle(kind, kind, position, heading, { spawn: true, paint: trafficPaint(id) });
    if (!v) return null;
    v.isTraffic = true;
    v.setVelocity({ x: Math.sin(heading) * 9, y: 0, z: Math.cos(heading) * 9 });
    const rideY = RIDE + (v.spec.wheelRadius - 0.32);
    const c = { v, driver: new Driver(v, SKILL.regular), id, stuckFor: 0, pullFor: 0, rideY, paint: trafficPaint(id) };
    this.cars.push(c);
    this._route(c);
    return c;
  }

  _route(c) {
    const g = this.game, gr = g.graph, v = c.v;
    // On somewhere, never back. "They should just be going in loops and
    // around the map and stuff. They should really never be turning around."
    // A new goal used to be anywhere, and the router would turn the car round
    // for one behind it -- where it stood, or at the next junction and
    // straight back down the same road -- or send it to the end of a dead end
    // to turn round there, onto the verge. Now: not a dead end, the route
    // never turning round (`noUTurn`), and a goal it has to turn round for
    // passed over for another.
    // Nor up a spur to get there (spurNodes): a goal on through road can be
    // reached without one.
    const spur = spurNodes(gr);
    const deadEnd = (n) => spur.has(n.id) || gr.roadDegree(n) < 2 || n.edges.some((id) => gr.edges[id].turningHead);
    let pts = null;
    for (let i = 0; i < 12; i++) {
      const n = gr.randomNode(g.rng);
      const d = dist2(n.x, n.z, v.position.x, v.position.z);
      if (d < 150 || d > 800 || deadEnd(n)) continue;
      const p = gr.pathFromPosition(
        v.position.x, v.position.z, v.forward.x, v.forward.z, n.id, LANE,
        Infinity, v.speed, 9, { cuts: false, noUTurn: true },
      );
      if (p.length >= 2 && !turnsBack(p, v.forward)) { pts = p; break; }
      if (!pts && p.length >= 2) pts = p;
    }
    if (pts) c.driver.setPath(this._inLane(c, pts));
  }

  /**
   * Its route moved over into its own lane where it runs along a big raised road, 90 m to get across at either end of that.
   * The router's one offset (LANE) had both directions' traffic nose to tail either side of the middle line.
   */
  _inLane(c, pts) {
    let i = 0;
    while (i < pts.length) {
      const kind = (e) => (e && e.elevated && LANES[e.kind] ? e.kind : null);
      const k = kind(pts[i].edge);
      if (!k) { i++; continue; }
      let j = i;
      while (j + 1 < pts.length && kind(pts[j + 1].edge)) j++;
      const S = [0];
      for (let n = i + 1; n <= j; n++) S.push(S[n - i - 1] + Math.hypot(pts[n].x - pts[n - 1].x, pts[n].z - pts[n - 1].z));
      const L = S[S.length - 1], out = [];
      for (let n = i; n <= j; n++) {
        const a = pts[Math.max(i, n - 1)], b = pts[Math.min(j, n + 1)], l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
        const lanes = LANES[kind(pts[n].edge)], want = lanes[Math.min(c.lane || 0, lanes.length - 1)] - LANE;
        // From where it is, when it starts up here; across from the slip road, when it does not.
        const s = S[n - i], ease = Math.min(i === 0 ? 1 : s / 90, j === pts.length - 1 ? 1 : (L - s) / 90, 1), off = want * ease * DRIVE_SIDE;
        out.push({ x: pts[n].x - (b.z - a.z) / l * off, z: pts[n].z + (b.x - a.x) / l * off });
      }
      for (let n = i; n <= j; n++) { pts[n].x = out[n - i].x; pts[n].z = out[n - i].z; }
      i = j + 1;
    }
    return pts;
  }

  /** The pace it keeps at a point of its route, m/s. */
  _pace(c, at) {
    const e = at && at.edge, l = e && e.elevated && LANE_PACE[e.kind];
    return l ? l[Math.min(c.lane || 0, l.length - 1)] : Math.min(((at && at.speed) || 15) * PACE, TOP_SPEED);
  }

  /** How far out on a raised road they are, m. */
  _deckFar() {
    const map = (this.game.world && this.game.world.__map) || {}, fog = this.game.scene && this.game.scene.fog;
    return map.trafficFar && fog ? fog.far + 60 : DECK_FAR;
  }

  /** Behind everyone playing, as they are going; with `cos` -0.8, ahead of them, within the angle of that cosine. */
  _behind(p, cos = 0) {
    const me = this.game.player;
    return !!me && me.speed > 12 && this.game.humanPositions().length === 0
      && ((p.x - me.position.x) * me.linvel.x + (p.z - me.position.z) * me.linvel.z) * (cos < 0 ? 1 : -1) > -cos * me.speed * dist2(p.x, p.z, me.position.x, me.position.z);
  }

  /** Blue lights near enough to get out of the way of. */
  _sirenNear(v) {
    const g = this.game;
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
    if (g.heat && g.heat.value > 0) {
      for (const u of g.dispatcher.units) {
        if (u.role === ROLE.PATROL || !u.vehicle || u.vehicle.disabled) continue;
        if (coming(u.vehicle)) return true;
      }
    }
    // One after a civilian is coming through whoever is wanted, and is on its list.
    if (g.suspects) {
      for (const u of g.suspects.units()) {
        if (u.vehicle && !u.vehicle.disabled && coming(u.vehicle)) return true;
      }
    }
    // A police player's car, when its siren is on (Q / SIRENS) -- whatever
    // anybody's wanted level, so the open world's traffic gets out of the way
    // of a car on a call too.
    const me = g.player;
    return !!(me && me.isPolice && me.sirenOn && me !== v && coming(me));
  }

  _drive(c, dt) {
    const g = this.game, v = c.v, d = c.driver;
    if (v.disabled) { v.setControls({ throttle: 0, brake: 0, steer: 0, handbrake: 1 }); return; }
    if (c.pullFor <= 0 && (!d.hasPath || d.remaining(40) < 40)) this._route(c);

    const was = c.pullFor > 0;
    // Once it starts, it finishes: a few seconds at least, so a car that
    // began to pull over is stopped on the verge rather than drifting back
    // into the lane the moment the police car is past.
    c.pullFor = !onBig(d.path[d.pathIndex]) && this._sirenNear(v) ? Math.max(c.pullFor, PULL_HOLD) : Math.max(0, c.pullFor - dt);
    if (c.pullFor <= 0 && was) this._route(c);
    if (c.pullFor > 0) { this._pullOver(c, dt); return; }

    const here = d.path[d.pathIndex];
    let cap = this._pace(c, here);
    // Red lights, the same way a patrol car stops for them (Officer._signalCap).
    if (g.signals) {
      const s = g.signals.stopDistanceAt(v.position.x, v.position.z, v.forward.x, v.forward.z, v.speed);
      if (Number.isFinite(s)) {
        // Now and then one goes through it, with a patrol car there to see:
        // "very, very, very occasionally a traffic car will say run a red
        // light in front of a police officer." Decided once a light. Then it
        // is a suspect (game/suspects.js), and the getaway driver has it.
        if (c.redCall === undefined) {
          const w = g.suspects && g.rng() < RED_RUN ? g.suspects.witnessAt(v.position.x, v.position.z) : null;
          c.redCall = !!w;
          if (w && g.suspects.offence(c, 'red', w)) return;
        }
        cap = Math.min(cap, Math.sqrt(2 * 3.4 * Math.max(0, s - 1.0)));
      } else {
        c.redCall = undefined;
      }
    }

    // Queueing behind what is in front, and nothing else: Driver.avoid sweeps
    // for scenery and other cars to dodge, which a car keeping to its lane at
    // the limit does not need, and it was the dearest thing a traffic car did.
    d.holdBehind(d.carInWay(g.vehicles, 45, g.world.__map && g.world.__map.movers), dt);
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
    // On a raised road or a bridge there is no verge: in to its edge and stop there. Aimed past the edge as
    // anywhere else, a car on a ramp "kind of just drove off the edge and then couldn't get back on".
    const deck = here && (here.edge.elevated || here.edge.bridge);
    const onVerge = !here || here.dist > here.edge.width * 0.5 + (deck ? -1.9 : 0.3);
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
    const off = snap.edge.width * 0.5 + (deck || snap.edge.elevated || snap.edge.bridge ? -1.5 : VERGE);
    const aim = { x: snap.x + -tz * off * DRIVE_SIDE, z: snap.z + tx * off * DRIVE_SIDE };
    const out = d.driveTo(aim, CRAWL, dt, {});
    if (v.forwardSpeed > CRAWL + 1.5) { out.throttle = 0; out.brake = 0.4; }
    v.setControls(out);
  }

  /** Its record in `cars`, for a traffic vehicle. */
  /**
   * A car back from the suspects (Suspects._free): traffic again, under its old id, on its old spec,
   * routed on from where it is. False if this map has no traffic.
   */
  adopt(v, id, spec) {
    if (!this.enabled || !v || v.removed) return false;
    if (spec) v.spec = spec;
    v.isTraffic = true;
    v.fleeing = false;
    // Traffic's bodywork ignores the hills, as when it was made (Vehicle, and Suspects._groundIt).
    if (this.game.sim.terrainAt) v.meets(0xFFFF & ~GROUP.HILL);
    const rideY = RIDE + (v.spec.wheelRadius - 0.32);
    const c = { v, driver: new Driver(v, SKILL.regular), id: id || `t${++this._made}`, stuckFor: 0, pullFor: 0, rideY, paint: trafficPaint(id) };
    this.cars.push(c);
    this._route(c);
    return true;
  }

  recordOf(v) {
    return this.cars.find((c) => c.v === v) || null;
  }

  /**
   * Hand a car over to something else -- the suspects (game/suspects.js) --
   * still in the world, no longer traffic: not driven, counted or removed
   * from here.
   */
  release(c) {
    if (c.v.dormant) { c.v.body.setEnabled(true); c.v.dormant = false; }
    const i = this.cars.indexOf(c);
    if (i >= 0) this.cars.splice(i, 1);
    c.v.isTraffic = false;
    // Drawn like any car again (Game._cullTraffic).
    if (c.v.view) { c.v.view.visible = true; if (c.v._shadowOn === false) c.v.view.traverse((o) => { if (o.isMesh) o.castShadow = this.game.renderer.shadowMap.enabled; }); }
    c.v._shadowOn = undefined;
    c.v._far = false;
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

/**
 * Does a path send the car back the way it is pointing from? Anywhere in it a
 * stretch that runs against `fwd` -- the car's heading -- within its first
 * 60 m, which is a turn round, not a corner.
 */
function turnsBack(pts, fwd) {
  let run = 0;
  for (let i = 1; i < pts.length && run < 60; i++) {
    const dx = pts[i].x - pts[i - 1].x, dz = pts[i].z - pts[i - 1].z, l = Math.hypot(dx, dz);
    if (l < 1e-3) continue;
    if ((dx * fwd.x + dz * fwd.z) / l < -0.7) return true;
    run += l;
  }
  return false;
}
