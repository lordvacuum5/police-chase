// The getaway driver: a car that is being chased and would rather not be.
//
// Everything else in src/ai drives *toward* something. The dispatcher sends
// units at a target, the officer closes on it, and the whole pursuit is built
// on knowing where the quarry is and going there. This is the other side of
// that, and it exists because of a request to be able to play the police on
// your own: "where you can be the police, but not chasing [a person], but
// chasing a computer that's driving a getaway vehicle... so I can easily test
// out and, you know, it's just a cool feature without having to play in
// multiplayer."
//
// The approach is deliberately the mirror of the intercept solver rather than
// anything new. RoadGraph.predict already expands the road network forward
// from a car -- every junction it could reach inside a horizon, when it would
// get there, and how likely that way is for a driver who mostly goes straight
// on. The dispatcher uses that to work out where to cut somebody off. Run the
// same expansion from the runner and score each junction by how far it is
// from the nearest police car instead, and "where do I go" answers itself:
// the best reachable corner of the map, re-asked every second or so.
//
// That one reused primitive is what keeps this file small. It also means the
// getaway car plans with exactly the same model of the road the force uses
// against it, which is the right kind of fair.

import { Driver, SKILL } from './driver.js';
import { clamp, dist2 } from '../util/math.js';

/**
 * How far ahead to plan, in seconds of driving.
 *
 * Long enough to commit to a direction and short enough to still be about
 * this chase. At 40 s the expansion reaches most of the map, every junction
 * scores about the same, and the car picks a corner and drives at it through
 * everything in between; at 8 s it never sees past the next pursuer and
 * dithers at junctions. Twenty-two is roughly a quarter of the way across
 * either map at the speed one of these actually travels.
 */
const HORIZON = 22;

/**
 * Seconds between plans. Quick enough to react to a car appearing ahead,
 * slow enough that it is not changing its mind at every junction -- the same
 * problem Officer._goTo documents, and the same answer.
 */
const REPATH = 1.2;

/**
 * How much a junction's distance from the police is worth against the time it
 * takes to get there, in metres per second of travel.
 *
 * This is the whole personality of the driver. At 0 it is pure greed for
 * distance and it will happily spend fifteen seconds driving to somewhere
 * fractionally safer; high, and it never commits to anything more than the
 * next corner. 6 m/s says "a second of driving is worth about six metres of
 * daylight", which is near enough the speed of the car itself -- so it will
 * take a longer road only when that road genuinely ends up further away.
 */
const TIME_COST = 6;

/**
 * Distance at which a police car ahead stops being a reason to turn, in
 * metres. Inside this a candidate junction is scored as if the pursuer were
 * sitting on it, which is what makes the car refuse to drive into a roadblock
 * it can see.
 */
const THREAT_NEAR = 60;

/**
 * Nothing has been seen for this long and the driver stops running flat out.
 *
 * A getaway car that keeps doing 200 km/h round an empty town twenty minutes
 * after it lost everybody is not evading, it is just a fast car. Once it has
 * been clear for a while it settles down -- which is also what lets the heat
 * decay and the chase actually end.
 */
const CALM_AFTER = 12;

/**
 * Being held against something by a police car, rather than merely stopped.
 *
 * Measured from a chase that would not end: the car was PITed onto a
 * pavement, a unit stopped a few metres off it, and then nothing happened for
 * the rest of the run. The Driver was doing its job -- a car asking to move
 * and not moving is stuck, so it reversed, which moved it a few centimetres,
 * which reset the arrest clock in heat.js, which wants the suspect under
 * 3 km/h. The two fought and the chase just stopped being one.
 *
 * So a pinned car gives up. The police side already does exactly this when it
 * is the one making the arrest (Officer._holdingArrest) and for the same
 * reason: the manoeuvre that opens the gap cancels the arrest it just earned.
 */
const PIN_GAP = 7;
const PIN_SPEED = 2.5;
const PIN_SECONDS = 1.2;

const _dir = { x: 0, z: 0 };

export class Runner {
  constructor(game, vehicle, opts = {}) {
    this.game = game;
    this.vehicle = vehicle;
    // Pursuit skill, because this is the one car in the world whose whole job
    // is to out-drive the pursuit. A rookie getaway driver is a short chase.
    this.driver = new Driver(vehicle, opts.skill || SKILL.pursuit);
    this.repathTimer = 0;
    this.goalNode = null;
    this.clearFor = 0;
    this.recoverTimer = 0;
    this.pinnedFor = 0;
    /** Set from outside: how hard it is being looked for. See Game._runnerSight. */
    this.hunted = true;
  }

  get position() { return this.vehicle.position; }

  /**
   * The cars worth running away from.
   *
   * Every police unit on the board, plus the player when the player is the
   * one doing the chasing -- which in this mode they are, and they are not in
   * the dispatcher's roster, so asking the dispatcher alone would leave the
   * runner ignoring the only car being driven by a person.
   */
  _threats() {
    const out = [];
    const player = this.game.player;
    if (player && player !== this.vehicle && !player.isAircraft) out.push(player);
    for (const u of this.game.dispatcher.units) {
      if (u.vehicle && !u.vehicle.disabled && u.vehicle !== this.vehicle) out.push(u.vehicle);
    }
    return out;
  }

  /** How far the nearest threat is from a point, in metres. */
  _clearanceAt(x, z, threats) {
    let worst = Infinity;
    for (const t of threats) {
      const d = dist2(x, z, t.position.x, t.position.z);
      if (d < worst) worst = d;
    }
    return worst;
  }

  /**
   * Choose somewhere to be, and route there.
   *
   * Scored over everything RoadGraph.predict says is reachable: clearance from
   * the nearest pursuer at that junction, less the time it takes to arrive,
   * nudged by how likely the way there is for a car that mostly goes straight
   * on. The probability term is not about realism here -- it is what stops the
   * planner picking a junction that is only reachable by a sequence of four
   * hard turns it will make a mess of.
   */
  _plan() {
    const g = this.game.graph;
    const v = this.vehicle;
    const threats = this._threats();
    const reach = g.predict(v.position.x, v.position.z, v.forward.x, v.forward.z,
      Math.max(v.speed, 10), 0.6, HORIZON);
    if (!reach.size) return false;

    let best = null, bestScore = -Infinity;
    for (const [id, rec] of reach) {
      const n = g.nodes[id];
      if (!n) continue;
      let clearance = this._clearanceAt(n.x, n.z, threats);
      // A junction with a police car sitting near it is not an escape, however
      // far away it looks on the clock. Collapsing everything inside THREAT_NEAR
      // to the same bad score means the planner treats "they are there" as a
      // wall rather than as a gradient it can shave.
      if (clearance < THREAT_NEAR) clearance = clearance * 0.25;
      const score = clearance - rec.eta * TIME_COST + rec.prob * 25;
      if (score > bestScore) { bestScore = score; best = { id, node: n }; }
    }
    if (!best) return false;

    // Centreline, not a lane: this car is not obeying anything. Same corner
    // cutting a pursuing unit gets, for the same reason -- it is in a hurry.
    const pts = g.pathFromPosition(
      v.position.x, v.position.z, v.forward.x, v.forward.z, best.id, 0,
      Infinity, v.speed, 16,
      { cuts: true, minWidth: v.spec.dims.w + 0.6 },
    );
    if (pts.length < 2) return false;
    this.driver.setPath(pts);
    this.goalNode = best.id;
    return true;
  }

  /**
   * Stopped, with a police car on top of it. See PIN_GAP.
   *
   * Deliberately a shade more generous than the arrest test in heat.js -- it
   * has to be, or the car starts struggling again in exactly the window the
   * arrest needs it still.
   */
  _pinned(dt) {
    const v = this.vehicle;
    if (Math.abs(v.forwardSpeed) * 3.6 > PIN_SPEED) { this.pinnedFor = 0; return false; }
    let near = Infinity;
    for (const t of this._threats()) {
      near = Math.min(near, dist2(v.position.x, v.position.z, t.position.x, t.position.z));
    }
    if (near > PIN_GAP) { this.pinnedFor = 0; return false; }
    this.pinnedFor = (this.pinnedFor || 0) + dt;
    return this.pinnedFor > PIN_SECONDS;
  }

  update(dt) {
    const v = this.vehicle;
    if (!v || !this.game.graph) return;

    // On its roof or wrecked: the same deal the police get. Righted where it
    // lies after a few seconds, because a getaway car that is permanently out
    // of action leaves the player driving around an empty town with no way to
    // finish the chase.
    if (v.disabled || v.flippedFor > 2.2) {
      this.recoverTimer += dt;
      v.setControls({ throttle: 0, brake: 1, steer: 0, handbrake: 1 });
      if (v.flippedFor > 2.2 && this.recoverTimer > 3.0) {
        const at = { x: v.position.x, y: v.position.y + 1.2, z: v.position.z };
        v.teleport(at, Math.atan2(v.forward.x, v.forward.z));
        v.damage = Math.min(v.damage, 0.55);
        v.disabled = false;
        this.recoverTimer = 0;
      }
      return;
    }
    this.recoverTimer = 0;

    // Caught. Everything stops, including this.
    if (this.game.outcome) {
      v.setControls({ throttle: 0, brake: 1, steer: 0, handbrake: 1 });
      return;
    }

    // How long since anyone was looking. Set from Game._runnerSight.
    this.clearFor = this.hunted ? 0 : this.clearFor + dt;

    // Caught and held: stop fighting it, so the arrest can actually complete.
    // See PIN_SECONDS.
    if (this._pinned(dt)) {
      v.setControls({ throttle: 0, brake: 1, steer: 0, handbrake: 0 });
      return;
    }

    // Getting wedged is the Driver's own problem and it already solves it:
    // Driver.planSpeed notices a car that is asking to move and not moving,
    // reverses out, and raises `needsRepath` when it has made room. All this
    // has to do is honour that flag, below -- a second recovery on top fought
    // the first one and left the car rocking against the wall it hit.
    this.driver.avoid(this.game.vehicles, dt, null);
    // Allowed everything a pursuing unit is allowed: the width of the road,
    // the verge, and the gaps between buildings. It is the one car with a
    // reason to use them.
    this.driver.allowOffRoad = true;
    this.driver.limitScale = this.clearFor > CALM_AFTER ? 1.2 : 3.0;

    if (this.driver.needsRepath) {
      this.driver.needsRepath = false;
      this.driver.setPath([]);
      this.repathTimer = 0;
      this.goalNode = null;
    }

    this.repathTimer -= dt;
    // Re-plan on the clock, when the path has run out, or when the junction it
    // was heading for has stopped being the safe one -- which is what happens
    // the moment a unit gets in front of it.
    if (this.repathTimer <= 0 || !this.driver.hasPath || this.driver.remaining() < 30) {
      if (this._plan()) this.repathTimer = REPATH;
      else this.repathTimer = 0.4;
    }

    if (!this.driver.hasPath) {
      // Nowhere to go by road -- off the network, usually. Drive at the
      // nearest piece of it and try again next tick.
      const snap = this.game.graph.nearestEdge(v.position.x, v.position.z, 220);
      if (snap) {
        const n = this.game.graph.nodes[snap.edge.b] || this.game.graph.nodes[snap.edge.a];
        if (n) { v.setControls(this.driver.driveTo(n, 22, dt)); return; }
      }
      v.setControls({ throttle: 0.4, brake: 0, steer: 0, handbrake: 0 });
      return;
    }

    // Flat out while it is being chased, briskly once it is not. `speedCap` is
    // the driver's own planner from there -- corners, grip and the road still
    // apply, so "flat out" means as fast as the car can actually go, not a
    // number that drives it into a wall.
    v.setControls(this.driver.followPath(dt, this.clearFor > CALM_AFTER ? 26 : Infinity));
  }

  /** Scrub the roster entry, so nothing holds a reference to a dead car. */
  dispose() {
    this.driver.setPath([]);
    this.goalNode = null;
  }
}

/** The cars a getaway driver turns up in, and how good the driver is. */
export const RUNNER_CARS = ['runner', 'supercar', 'offroad'];

/** Pick one, so two sessions in a row are not the same chase. */
export function pickRunnerCar(rng) {
  const r = typeof rng === 'function' ? rng() : Math.random();
  return RUNNER_CARS[Math.floor(r * RUNNER_CARS.length) % RUNNER_CARS.length];
}

export { HORIZON as RUNNER_HORIZON };
