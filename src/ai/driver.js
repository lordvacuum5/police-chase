// The low-level driving controller.
//
// Officers do not get magic grip or scripted movement -- they get this, which
// produces the same four control inputs a player has: throttle, brake, steer,
// handbrake. Everything downstream (pursuit, intercepts, PIT manoeuvres) is
// expressed as "drive to this point at this speed" and handed to a Driver.
//
// Three things make it feel like a person rather than a waypoint follower:
//   * a pure-pursuit geometry that aims at a lookahead point scaled by speed,
//   * an explicit counter-steer term, so a driver who has stepped the back out
//     catches it -- or, if their skill is low, does not,
//   * a speed planner that brakes for corners it can see coming, using the
//     same friction limit the tyre model actually enforces.

import * as THREE from 'three';
import { clamp, clamp01, lerp, sign, angleDelta, curveRadius, dist2, smoothstep } from '../util/math.js';
import { cornerSpeedLimit, TYRE_GRASS } from '../physics/tyre.js';
import { raycast, sweepBox, RAY_GROUNDS, RAY_SOLID } from '../physics/world.js';

const _p = new THREE.Vector3();
const _origin = new THREE.Vector3();
const _probe = new THREE.Vector3();
const _run = new THREE.Vector3();

/**
 * How far ahead the travel-direction checks look, and how finely the surface
 * is sampled. 110 m is a little over the braking distance from motorway speed,
 * so a road that carries on past it imposes no limit at all.
 */
const RUNOUT_PROBE = 110;
const RUNOUT_STEP = 2.5;

/**
 * Nominal radius a unit assumes it may need to turn through once it is off the
 * carriageway. Sets the pace it aims to be down to by the time it gets there.
 */
const OFF_ROAD_ARC = 45;

/**
 * Headings tried when looking for a way through, as offsets from the straight
 * line to the goal. Straight on first so a clear line always wins ties.
 */
const GAP_FAN = [
  0, -0.20, 0.20, -0.42, 0.42, -0.66, 0.66, -0.92, 0.92, -1.22, 1.22, -1.5, 1.5,
];

/** Skill presets. A rookie overdrives corners and cannot catch a slide. */
export const SKILL = {
  rookie:   { grip: 0.86, counter: 0.50, react: 0.24, aggression: 0.82, throttleControl: 0.55, look: 0.9 },
  regular:  { grip: 0.96, counter: 0.75, react: 0.16, aggression: 0.95, throttleControl: 0.80, look: 1.0 },
  advanced: { grip: 1.03, counter: 0.95, react: 0.10, aggression: 1.06, throttleControl: 0.92, look: 1.1 },
  pursuit:  { grip: 1.08, counter: 1.05, react: 0.07, aggression: 1.15, throttleControl: 0.97, look: 1.15 },
};

export class Driver {
  constructor(vehicle, skill = SKILL.regular) {
    this.v = vehicle;
    this.skill = skill;
    this.path = [];
    this.pathIndex = 0;
    this.out = { throttle: 0, brake: 0, steer: 0, handbrake: 0, clutchKick: false };

    this.stuckTimer = 0;
    this.reverseTimer = 0;
    this.reactTimer = 0;
    this._clear = 70;
    this._clearTravel = RUNOUT_PROBE;
    this._runout = RUNOUT_PROBE;
    this._clearTimer = 0;
    this.crossTrack = 0;
    this._laneKeep = false;
    this.needsRepath = false;
    this.reverseFrom = null;
    this.steerHold = 0;
    this.speedTarget = 0;
    this.avoidBias = 0;
    // Steering push away from scenery, and how close the nearest solid thing
    // is along the line of travel.
    this.wallBias = 0;
    this.wallNear = 999;
    // Speed ceiling while making way for a unit running a manoeuvre. Infinity
    // when nobody needs to come past.
    this.wayCap = Infinity;

    // How much of the available grip this driver currently believes it can
    // use. Starts optimistic and is knocked down by evidence -- see
    // _updateGrip. This is the difference between a driver who slides once and
    // one who slides all the way to the next junction.
    this.gripEstimate = 1;
    this.slideTimer = 0;
    this.strayTimer = 0;

    // Whether this driver may leave the carriageway to cut a corner or take a
    // line across open ground. Everything in a pursuit may; a patrol car
    // pottering about on its beat may not, and that difference in how they
    // move is part of how you tell them apart.
    this.allowOffRoad = false;

    // How far over the posted limit this driver is willing to go. 1 is a
    // patrol car obeying the signs; a unit in pursuit sets this high and is
    // then bounded only by grip and by what its car will do.
    this.limitScale = 1;
  }

  setPath(points) {
    this.path = points || [];
    this.pathIndex = 0;
    // Stale cross-track from a discarded path would otherwise be applied to
    // the next one for a frame.
    this.crossTrack = 0;
  }

  get hasPath() { return this.path.length > 1; }

  /** Distance remaining along the current path, in metres. */
  remaining() {
    let d = 0;
    for (let i = this.pathIndex; i < this.path.length - 1; i++) {
      d += dist2(this.path[i].x, this.path[i].z, this.path[i + 1].x, this.path[i + 1].z);
    }
    return d;
  }

  /** Advance pathIndex to the closest point that is not behind the car. */
  _trackPath() {
    const v = this.v;
    let best = this.pathIndex;
    let bestD = Infinity;
    const scan = Math.min(this.path.length, this.pathIndex + 24);
    for (let i = this.pathIndex; i < scan; i++) {
      const d = dist2(v.position.x, v.position.z, this.path[i].x, this.path[i].z);
      if (d < bestD) { bestD = d; best = i; }
    }
    this.pathIndex = best;

    // Signed distance from the path, positive when the car is to the left of
    // it. Pure pursuit corrects this eventually, but only slowly on a long
    // lookahead -- which is why units sit a lane or two wide through curves.
    const i = Math.min(best, this.path.length - 2);
    const a = this.path[i], b = this.path[i + 1];
    let dx = b.x - a.x, dz = b.z - a.z;
    const dl = Math.hypot(dx, dz) || 1; dx /= dl; dz /= dl;
    const rx = v.position.x - a.x, rz = v.position.z - a.z;
    this.crossTrack = rx * dz - rz * dx;

    // Come off the route far enough and following it stops being a plan.
    //
    // Nothing used to notice this. A unit shoved off line by a collision, or
    // one that overshot a junction, went on aiming at a lookahead point on a
    // road it was no longer on -- and drove straight across whatever lay
    // between, which on the town map meant a quarter of the pursuit's time was
    // spent on grass a median of 25 m from its own path. The routes were never
    // the problem: not one planned waypoint was off-road. Ask for a new line
    // from where the car actually is instead.
    // Wider tolerance for a unit that is allowed to cut: leaving the line is
    // what it is for, and repathing every time it did would be constant churn.
    if (Math.abs(this.crossTrack) > (this.allowOffRoad ? 22 : 10)) {
      this.strayTimer += 1 / 60;
      if (this.strayTimer > 0.6) { this.needsRepath = true; this.strayTimer = 0; }
    } else {
      this.strayTimer = 0;
    }

    // Never aim at a waypoint that is behind us or sitting on the bonnet:
    // pure pursuit responds to a target behind the car by turning as hard as
    // it can, which in a city means into the nearest wall.
    const limit = Math.min(this.path.length - 1, best + 14);
    while (this.pathIndex < limit) {
      const q = this.path[this.pathIndex];
      const dx = q.x - v.position.x, dz = q.z - v.position.z;
      const ahead = dx * v.forward.x + dz * v.forward.z;
      if (ahead > 0 && dx * dx + dz * dz > 6) break;
      this.pathIndex++;
    }
    return bestD;
  }

  /** The point `dist` metres further along the path from the current index. */
  _pointAhead(dist) {
    let acc = 0;
    for (let i = this.pathIndex; i < this.path.length - 1; i++) {
      const a = this.path[i], b = this.path[i + 1];
      const seg = dist2(a.x, a.z, b.x, b.z);
      if (acc + seg >= dist) {
        const t = seg > 1e-4 ? (dist - acc) / seg : 0;
        return { x: lerp(a.x, b.x, t), z: lerp(a.z, b.z, t), speed: a.speed || 20, index: i };
      }
      acc += seg;
    }
    const last = this.path[this.path.length - 1];
    return last ? { x: last.x, z: last.z, speed: last.speed || 20, index: this.path.length - 1 } : null;
  }

  /**
   * How fast we can be going at the current point and still make everything
   * we can see. Walks forward along the path, converts each curve into a grip
   * limit, and backs that limit up through the braking distance.
   */
  /**
   * Keep track of how much grip this car is really getting.
   *
   * Two separate failures were making units slide indefinitely. They planned
   * every corner against the dry-road figure even with two wheels on a verge,
   * where there is less than half that; and having started to slide they went
   * on asking for exactly the speed that caused it, so the slide simply
   * continued to the next junction.
   *
   * `gripEstimate` falls quickly while the car is actually sliding and comes
   * back slowly once it has hooked up again, so a driver who has just been
   * caught out spends the next few seconds driving within itself.
   */
  _updateGrip(dt) {
    const v = this.v;
    const sliding = v.maxSlip > 0.62 || Math.abs(v.slipAngleBody) > 0.20;
    if (sliding) {
      this.slideTimer = Math.min(this.slideTimer + dt, 3);
      // A better driver reads it earlier and gives away less.
      const give = lerp(1.1, 0.5, this.skill.throttleControl);
      // Floored well short of a crawl. The point is to stop chasing grip that
      // is not there, not to turn every unit that steps out once into a
      // learner -- these still have a pursuit to win.
      this.gripEstimate = Math.max(0.72, this.gripEstimate - give * dt);
    } else {
      this.slideTimer = Math.max(0, this.slideTimer - dt * 1.5);
      this.gripEstimate = Math.min(1, this.gripEstimate + 0.55 * dt);
    }
  }

  /**
   * What fraction of the available friction this car can actually turn into
   * deceleration.
   *
   * A car without anti-lock has to leave a margin: brake past the limit and
   * the wheels lock, and a locked tyre slides at the sliding-friction fraction
   * of peak, so the last part of the pedal makes the stop *longer*. A car with
   * ABS can be planned right up against the limit, because the modulation
   * holds it there. Without this the fleet's better brakes would sit unused --
   * the planner would go on asking for the same speeds it always did.
   */
  _brakeFraction(base) {
    const b = this.v.spec.brakes;
    const abs = b.abs || 0;
    // Only four fifths of the braking advantage is planned against. Planning
    // on all of it means arriving at every junction on the limit with nothing
    // in hand, and the measured cost was five times as much car-to-car contact
    // -- a unit stops in the distance it promised itself and the one behind
    // does not.
    const bonus = 1 + ((b.gripBonus || 1) - 1) * 0.8;
    return (base + (1 - base) * 0.92 * abs) * bonus;
  }

  /**
   * The cornering friction this driver should plan against: what is actually
   * under the tyres, trimmed by skill, by the combined-slip budget, and by
   * how much grip recent evidence says it is really getting.
   */
  _mu() {
    const v = this.v;
    const assist = v.assist || { grip: 1, boost: 1 };
    // The car's own tyres count too: surfaceMu is the road, gripScale is the rubber.
    // Leaving it out meant a unit given more grip took every corner at the same
    // speed as before and simply had more in hand.
    return v.surfaceMu * (v.spec.gripScale || 1) * this.skill.grip * 0.87 * assist.grip * this.gripEstimate;
  }

  /**
   * Speed ceiling while the car is sideways.
   *
   * Asking a car that is already sliding for the speed that put it there just
   * prolongs the slide -- which is exactly what these units were doing, all
   * the way across the verge and into whatever was on the other side. This
   * demands a genuine lift: a target below what the car is doing now, scaled
   * by how far gone it is and by whether this driver can hold a slide at all.
   */
  slideLift() {
    const v = this.v;
    const slip = Math.abs(v.slipAngleBody);
    if (slip <= 0.20 || v.speed <= 7) return Infinity;
    const severity = clamp01((slip - 0.20) / 0.45);
    const keep = lerp(0.96, 0.68, severity * lerp(1.15, 0.75, this.skill.throttleControl));
    return v.speed * keep;
  }

  planSpeed(roadCap = Infinity) {
    const v = this.v;
    const skill = this.skill;
    // Traction budget. The tyre model resolves force along the combined slip
    // direction, so a car that is also accelerating or braking cannot spend
    // 100% of its grip on cornering. Planning corner speeds against full mu
    // means arriving with nothing left and running wide.
    // Assisted units may plan against their boosted grip, or they would never
    // use the help they have been given.
    const assist = v.assist || { grip: 1, boost: 1 };
    const mu = this._mu();
    const aBrake = mu * 9.81 * this._brakeFraction(0.9);

    let limit = roadCap;
    let acc = 0;
    const horizon = clamp(28 + v.speed * 2.6, 45, 190);

    for (let i = this.pathIndex; i < this.path.length - 2 && acc < horizon; i++) {
      const a = this.path[i], b = this.path[i + 1], c = this.path[i + 2];
      acc += dist2(a.x, a.z, b.x, b.z);
      const R = curveRadius(a.x, a.z, b.x, b.z, c.x, c.z);
      let vc = cornerSpeedLimit(R, mu);
      if (b.speed) {
        vc = Math.min(vc, b.speed * this.limitScale * lerp(1.0, 1.35, skill.aggression - 0.7));
      }
      // Highest speed now that still allows braking to vc by the time we arrive.
      const allowed = Math.sqrt(Math.max(0, vc * vc + 2 * aBrake * acc));
      if (allowed < limit) limit = allowed;
    }

    // Never plan past what the car can actually do.
    return Math.min(limit, v.spec.topSpeedHint * assist.boost);
  }

  /**
   * How much clear road is in front of the car, in metres, up to `maxDist`.
   *
   * Three rays rather than one, because a single centre ray misses a building
   * corner the car's shoulder is about to clip. Vehicles are deliberately not
   * included: this is about the scenery, and other cars are handled by avoid().
   */
  clearAhead(dir, maxDist = 70) {
    const v = this.v;
    let best = maxDist;
    const hw = this.halfWidth;
    for (const lateral of [-hw, 0, hw]) {
      _origin.copy(v.position)
        .addScaledVector(v.forward, v.spec.dims.l * 0.5)
        .addScaledVector(v.left, lateral);
      _origin.y += 0.6;
      const hit = raycast(v.world, _origin, dir, maxDist, RAY_GROUNDS, v.body);
      if (hit && hit.toi < best) best = hit.toi;
    }
    return best;
  }

  /**
   * The fastest this driver should be going right now, given what it can see
   * and how hard it is being asked to turn.
   *
   * Path following gets this from planSpeed, but driving straight at a target
   * bypasses all of that -- which is how units ended up flat out into a
   * building because the car they were chasing happened to be behind it.
   */
  safeSpeed(alpha, aimDist, aimX, aimZ) {
    const v = this.v;
    const mu = this._mu();
    const aBrake = mu * 9.81 * this._brakeFraction(0.85);

    this._clearTimer -= 1;
    if (this._clearTimer <= 0) {
      this._clearTimer = 3;

      // Probe toward where we are actually going, not along the nose. A nose
      // probe reads the building on the outside of every corner as a wall to
      // brake for, and the unit crawls round the city at 30 km/h.
      _probe.set(aimX - v.position.x, 0, aimZ - v.position.z);
      if (_probe.lengthSq() < 1) _probe.copy(v.forward);
      _probe.normalize();
      this._clear = this.clearAhead(_probe, Math.min(70, aimDist + 25));

      // And a second probe along the direction the car is genuinely
      // travelling. The aim probe answers "is the way I want to go clear";
      // this answers "is the way I am going clear", and at speed those are
      // different questions. The second one is the one that ends with a car
      // in a wall: a unit running alongside its target commits to a speed on
      // the strength of a clear line to the target, the target turns, and the
      // unit arrives at the junction far too fast to take it.
      this._travelDir(_probe);
      this._clearTravel = this.clearAhead(_probe, RUNOUT_PROBE);
      this._runout = this.roadRunout(RUNOUT_PROBE);
    }

    const usable = Math.max(0, this._clear - 7);
    let limit = Math.sqrt(2 * aBrake * usable);

    // Stopping distance along the line of travel.
    limit = Math.min(limit, Math.sqrt(2 * aBrake * Math.max(0, this._clearTravel - 7)));

    // How much road is left in front of us, which is the junction question:
    // arriving somewhere the carriageway ends in thirty metres means being
    // slow enough to *turn* within thirty metres, whether or not there is
    // anything solid there to hit. Open ground has no collider at all, so
    // nothing above this notices a bend with a field on the outside of it.
    if (this._runout < RUNOUT_PROBE) {
      if (this.allowOffRoad) {
        // Running out of road is not a wall for these, it is a change of
        // surface: they are allowed to go across it. What is still required is
        // arriving at a speed the verge can actually hold, so this brakes
        // toward a grass-appropriate pace rather than toward a stop. Buildings
        // and trees are somebody else's problem -- they have colliders, and
        // the travel probe above sees them.
        const off = cornerSpeedLimit(OFF_ROAD_ARC,
          TYRE_GRASS.mu * (v.spec.offRoadGrip || 1) * 0.87 * this.skill.grip);
        limit = Math.min(limit, Math.sqrt(off * off + 2 * aBrake * this._runout));
      } else {
        limit = Math.min(limit, cornerSpeedLimit(Math.max(9, this._runout), mu));
      }
    }

    // And no faster than the corner we are turning into. Pure pursuit follows
    // an arc of radius Ld / (2 sin alpha), so that arc sets a grip limit too.
    const sa = Math.abs(Math.sin(alpha));
    if (sa > 0.05) {
      limit = Math.min(limit, cornerSpeedLimit(Math.max(6, aimDist / (2 * sa)), mu));
    }
    return limit;
  }

  /**
   * Find a way through, rather than a reason to stop.
   *
   * Sweeps a fan of headings either side of where the car wants to go and
   * picks the one that actually gets somewhere: mostly clear, mostly toward
   * the goal. This is what a driver does when the direct line is blocked --
   * look for the gap and take it -- and it is the difference between arriving
   * and giving up.
   *
   * Returns { x, z } a point to aim at, and sets `gapClear` to how far that
   * heading runs before anything is in the way. A short `gapClear` in every
   * direction is the genuine "boxed in" case and the only one worth abandoning.
   */
  pickGap(wantX, wantZ, reach) {
    const v = this.v;
    const hw = this.halfWidth;

    let dx = wantX - v.position.x, dz = wantZ - v.position.z;
    const goalDist = Math.hypot(dx, dz) || 1;
    dx /= goalDist; dz /= goalDist;
    const span = Math.min(reach, goalDist);

    _origin.copy(v.position).addScaledVector(v.forward, v.spec.dims.l * 0.45);
    _origin.y += 0.5;

    let bestScore = -Infinity, bestAng = 0, bestClear = 0;
    // Widest deviation worth taking. Beyond about eighty degrees the car is no
    // longer heading for the target at all, and would be better reversing.
    for (const ang of GAP_FAN) {
      const ca = Math.cos(ang), sa = Math.sin(ang);
      _probe.set(dx * ca - dz * sa, 0, dx * sa + dz * ca);
      const clear = sweepBox(v.world, _origin, _probe, span, RAY_GROUNDS, v.body, hw);

      // Score by *progress*, not by openness. How far this heading actually
      // carries the car toward the goal is `clear * cos(deviation)` -- so a
      // long run that points away scores nothing, and a short run straight at
      // the target beats a wide detour. Scoring openness alone made units
      // wander off down whichever direction happened to be emptiest, which is
      // how a courtyard entrance got ignored in favour of open road behind.
      const heading = Math.atan2(v.forward.x, v.forward.z);
      const want = Math.atan2(_probe.x, _probe.z);
      const swing = Math.abs(angleDelta(heading, want));
      const score = clear * Math.cos(ang) - swing * 4;
      if (score > bestScore) {
        bestScore = score; bestAng = ang; bestClear = clear;
      }
    }

    this.gapClear = bestClear;
    this.gapAngle = bestAng;
    const ca = Math.cos(bestAng), sa = Math.sin(bestAng);
    const gx = dx * ca - dz * sa, gz = dx * sa + dz * ca;
    // Aim into the gap rather than at its far end, so the car keeps steering
    // as the geometry opens up.
    const reachTo = Math.min(bestClear * 0.85, span);
    return { x: v.position.x + gx * reachTo, z: v.position.z + gz * reachTo };
  }

  /**
   * Half the car's width, plus the margin a driver would want before
   * committing to a gap at speed. Every lateral check goes through this so
   * they are all sized off the actual car -- a probe wider than the car makes
   * it refuse gaps it would sail through, and a probe narrower than the car
   * makes it clip the ones it takes.
   */
  get halfWidth() {
    return this.v.spec.dims.w * 0.5 + 0.10;
  }

  /** Unit vector along the way the car is actually moving. */
  _travelDir(out) {
    const v = this.v;
    if (v.speed > 2.5) {
      out.set(v.linvel.x / v.speed, 0, v.linvel.z / v.speed);
      if (out.lengthSq() > 0.25) return out.normalize();
    }
    return out.copy(v.forward);
  }

  /**
   * How far the car can carry on along its current trajectory before it runs
   * out of road.
   *
   * Walks the surface raster rather than casting rays, because the thing being
   * looked for is the absence of carriageway, not the presence of an obstacle
   * -- and the two are not the same. A bend with a field on the outside of it
   * has nothing solid anywhere near it, so every collider-based check says the
   * way ahead is completely clear right up until the car is in the field.
   *
   * The probe follows an *arc*, not a straight line, curving at whatever rate
   * the car is turning at right now. That distinction is the whole value of
   * it: probed straight, a car correctly following a bend is forever about to
   * leave the road, and on the town map the check fired 84% of the time and
   * simply became a speed limit. Along the arc, a car that is turning enough
   * to make the bend sees clear road, and a car that is not sees the field it
   * is about to arrive in -- which is exactly the difference between making a
   * junction and going straight on at it.
   */
  roadRunout(maxDist) {
    const v = this.v;
    const sim = v.sim;
    if (!sim || !sim.surfaceAt) return maxDist;

    this._travelDir(_run);
    let hx = _run.x, hz = _run.z;
    const nose = v.spec.dims.l * 0.5;
    let x = v.position.x + hx * nose;
    let z = v.position.z + hz * nose;

    // Curvature of the current trajectory, radians per metre, clamped to a
    // radius no tighter than the car could actually hold.
    const k = v.speed > 3
      ? clamp(v.yawRate / v.speed, -1 / 8, 1 / 8)
      : 0;
    const a = k * RUNOUT_STEP;
    const ca = Math.cos(a), sa = Math.sin(a);

    for (let d = 0; d <= maxDist; d += RUNOUT_STEP) {
      if (sim.surfaceAt(x, z) === 0) return d;
      x += hx * RUNOUT_STEP;
      z += hz * RUNOUT_STEP;
      const nx = hx * ca - hz * sa;
      hz = hx * sa + hz * ca;
      hx = nx;
    }
    return maxDist;
  }

  /**
   * Drive toward a world point. This is the only steering primitive in the
   * game; pursuit, intercept and PIT all reduce to a point and a speed.
   */
  steerToward(x, z, dt) {
    const v = this.v;
    const skill = this.skill;

    const dx = x - v.position.x;
    const dz = z - v.position.z;
    const distance = Math.hypot(dx, dz) || 1e-3;

    const noseHeading = Math.atan2(v.forward.x, v.forward.z);
    const targetHeading = Math.atan2(dx, dz);
    const alpha = angleDelta(noseHeading, targetHeading);

    // Pure pursuit: the steering angle that puts the car on an arc through the
    // aim point. Lookahead grows with speed or the car saws at motorway pace.
    const Ld = clamp(distance, 5, clamp(5 + v.speed * 0.62 * skill.look, 6, 40));
    let deltaRad = Math.atan2(2 * v.spec.wheelbase * Math.sin(alpha), Ld);

    // Counter-steer. v.slipAngleBody is positive when the car is travelling to
    // its own left, i.e. the rear has stepped out to the left, and the correct
    // response is to steer left -- the same sign.
    deltaRad += v.slipAngleBody * skill.counter * smoothstep(6, 14, v.speed);
    // A little yaw damping stops good drivers from oscillating.
    deltaRad -= v.yawRate * 0.10 * skill.counter;
    // Lane keeping. Pure pursuit alone leaves a standing cross-track error
    // through curves -- the car tracks a chord inside the bend rather than the
    // lane. This pulls it back onto the line, scaled down with speed so it
    // does not become a twitch at motorway pace.
    // A unit allowed off the carriageway keeps far less of it: lane keeping is
    // precisely the term that stops a car cutting a corner, and cutting the
    // corner is the point. Enough is left to stop it wandering.
    if (this._laneKeep) {
      const pull = this.allowOffRoad ? 0.14 : 0.55;
      deltaRad -= Math.atan2(this.crossTrack * pull, v.speed + 4);
    }

    // Lateral bias injected by collision avoidance, and by scenery the car is
    // about to touch. The scenery term is deliberately the stronger of the
    // two: hitting a building ends a unit's chase, being untidy around another
    // car does not.
    deltaRad += this.avoidBias + this.wallBias;

    // Scale against the lock currently available, not the absolute maximum.
    // The car limits steering by speed, so normalising by maxAngle would make
    // every command a fraction of what the driver actually asked for, and the
    // unit would quietly run wide out of every corner.
    const maxAngle = Math.max(0.03, v.steerLimit || v.spec.steering.maxAngle);
    let steer = clamp(deltaRad / maxAngle, -1, 1);

    // Reaction lag: the command is held for a short window rather than being
    // recomputed perfectly every frame.
    this.reactTimer -= dt;
    if (this.reactTimer <= 0) {
      this.steerHold = steer;
      this.reactTimer = skill.react;
    }
    steer = lerp(this.steerHold, steer, 0.45);

    return { steer, alpha, distance };
  }

  /**
   * Full update. `aim` is { x, z } and `speed` is the desired speed in m/s.
   * Returns the control object to hand to the vehicle.
   */
  driveTo(aim, speed, dt, opts = {}) {
    const v = this.v;
    const out = this.out;
    const skill = this.skill;

    this._updateGrip(dt);
    this._laneKeep = opts.lane === true;
    const s = this.steerToward(aim.x, aim.z, dt);
    out.steer = s.steer;

    // What the caller actually asked for, before the safety clamp. Stuck
    // detection has to use this: a car pinned against a wall is correctly told
    // to target zero speed, and testing the clamped value means it is never
    // considered stuck and never reverses out.
    const requested = speed;

    // Never ask for more speed than the surroundings allow. Callers say where
    // they want to go and how quickly; this is what stops that being a licence
    // to drive into a wall.
    if (opts.ignoreSurroundings !== true) {
      speed = Math.min(speed, this.safeSpeed(s.alpha, s.distance, aim.x, aim.z));
    }

    // Something solid is genuinely close along the line of travel. This is not
    // the planned braking distance -- by the time this fires, the plan has
    // already failed -- it is the last-resort clamp that keeps a unit which has
    // run wide from carrying its mistake into a wall. It applies even when the
    // caller asked to ignore the surroundings, because "get back to the road"
    // is not a good enough reason to drive through a house on the way.
    // Deliberately pessimistic, unlike the planners above. Those may assume
    // the car's full straight-line braking; this one fires when the plan has
    // already gone wrong, which usually means the car is also turning and the
    // friction budget is being spent on that instead. Assuming three quarters
    // of the grip and keeping six metres in hand is what stops a marginal stop
    // from being a contact.
    // Kept to close range on purpose. Extending it into a general "be slow
    // enough to turn within whatever you can see" rule was tried and made
    // things worse in the city, where there is a building about thirty metres
    // ahead at every junction: units simply became timid, the nearest one sat
    // 50 m back instead of 28, and the scenery contacts went *up* rather than
    // down as they bunched up behind each other.
    if (this.wallNear < 34) {
      const mu = this._mu();
      const usable = Math.max(0, this.wallNear - 6);
      speed = Math.min(speed, Math.sqrt(2 * mu * 9.81 * 0.75 * usable));
    }

    // Making way for a unit running a manoeuvre -- see avoid(). Moving over is
    // half of it; the other half is not staying in front of them at the same
    // speed all the way to the junction.
    if (this.wayCap < Infinity && opts.holdStill !== true) {
      speed = Math.min(speed, this.wayCap);
    }

    speed = Math.min(speed, this.slideLift());
    this.speedTarget = speed;

    // ---- unstick ----
    // Only counts as stuck if we are actually asking the car to move; a unit
    // deliberately holding a junction is not stuck.
    if (v.speed < 1.2 && requested > 3 && !opts.holdStill) this.stuckTimer += dt;
    else this.stuckTimer = Math.max(0, this.stuckTimer - dt * 2);

    if (this.stuckTimer > 1.2) {
      this.reverseTimer = 2.6;
      this.reverseFrom = v.position.clone();
      this.stuckTimer = 0;
    }
    if (this.reverseTimer > 0) {
      this.reverseTimer -= dt;

      // Holding the brake at a standstill selects reverse and then drives
      // backwards, so this both stops and backs out of whatever we hit.
      // Reversing with lock on swings the nose the opposite way to forwards,
      // so the sign here points the nose back toward where we want to go.
      out.throttle = 0;
      out.brake = 1;
      out.steer = clamp(-s.alpha * 1.2, -0.9, 0.9);
      out.handbrake = 0;

      // Stop early once we have actually made room, and force a fresh route --
      // otherwise the unit drives straight back into whatever it just left.
      if (this.reverseFrom && v.position.distanceTo(this.reverseFrom) > 7) {
        this.reverseTimer = 0;
        this.needsRepath = true;
      }
      if (this.reverseTimer <= 0) this.needsRepath = true;
      return out;
    }

    // ---- longitudinal ----
    const err = speed - Math.abs(v.forwardSpeed);
    if (err > 0.4) {
      out.throttle = clamp01(err * 0.42);
      out.brake = 0;
    } else if (err < -1.2) {
      out.brake = clamp01(-err * 0.20);
      out.throttle = 0;
    } else {
      out.throttle = clamp01(err * 0.42);
      out.brake = 0;
    }

    // Do not stand on the throttle in the middle of a slide unless this driver
    // is good enough to hold it. This is the main difference between a rookie
    // spinning off and a pursuit driver carrying the drift through.
    if (v.maxSlip > 0.55 && Math.abs(v.slipAngleBody) > 0.22) {
      out.throttle *= lerp(0.25, 1.0, skill.throttleControl);
    }
    // Never brake and steer at maximum simultaneously -- the friction ellipse
    // would take the front grip away and the car would plough straight on.
    if (Math.abs(out.steer) > 0.7) out.brake *= 0.55;

    // ---- handbrake turn for genuinely tight corners at moderate speed ----
    out.handbrake = 0;
    if (opts.allowHandbrake !== false
        && Math.abs(s.alpha) > 1.15 && v.speed > 5 && v.speed < 19 && s.distance < 26) {
      out.handbrake = 1;
      out.throttle *= 0.3;
    }

    out.clutchKick = false;
    return out;
  }

  /** Follow the assigned path at the planned speed. */
  followPath(dt, speedCap = Infinity, opts = {}) {
    if (!this.hasPath) {
      this.out.throttle = 0; this.out.brake = 1; this.out.steer = 0; this.out.handbrake = 0;
      return this.out;
    }
    this._trackPath();

    const here = this.path[this.pathIndex];
    const roadCap = (here && here.speed ? here.speed : 20)
      * this.limitScale * lerp(1.0, 1.3, this.skill.aggression - 0.7);
    const planned = Math.min(this.planSpeed(roadCap), speedCap);

    // Aim from the speed we are *about* to be doing, not the speed we are doing
    // now. Otherwise a car braking hard for a junction still aims 30 m past it
    // and cuts the corner it was slowing down for.
    const ref = Math.min(this.v.speed, planned + 4);
    const look = clamp(4.5 + ref * 0.55 * this.skill.look, 5.5, 26);
    const aim = this._pointAhead(look) || this.path[this.path.length - 1];
    return this.driveTo(aim, planned, dt, Object.assign({ lane: true }, opts));
  }

  /**
   * Steer around cars directly ahead. Cheap and local -- it only nudges the
   * steering bias, letting the pursuit logic keep control of where the unit is
   * actually going.
   */
  /**
   * Steer away from scenery, rather than only braking for it.
   *
   * Every clearance check up to now answers "how hard must I brake", and
   * braking is not always the answer -- a car that has run wide is going to
   * touch the wall on its outside whatever it does with the pedal, because the
   * wall is not in front of it. This casts a fan either side of the line of
   * travel and pushes the steering away from whichever side is closer, which
   * is what actually keeps a unit out of a building it is sliding towards.
   *
   * Allowed to run off the carriageway makes this more important, not less:
   * cutting a corner means deliberately pointing at ground the road planner
   * was keeping the car away from.
   */
  _avoidScenery(dt) {
    const v = this.v;
    const reach = clamp(9 + v.speed * 1.5, 12, 60);
    this._travelDir(_run);

    // Clearance either side of the line of travel, and dead ahead. Measuring
    // both flanks and steering toward the roomier one is what handles the case
    // that matters: a wall square in front. Summing per-ray pushes does not --
    // a centre ray has no side to push toward, so a building directly ahead
    // produced a bias of exactly zero and the car drove into it at 60 km/h.
    // The wide rays feed the steering only. They must not feed the braking
    // clamp: on any ordinary street there is a building about seven metres to
    // either side, and braking for those would reduce the whole force to a
    // crawl everywhere. What they are for is the blocker sliding across the
    // carriageway to stay in front of you, which puts its flank into a wall
    // that nothing looking forward ever sees.
    // Swept boxes, not rays. A ray is a line with no width, and a fan of them
    // threads either side of a tree or clips the corner of a building and
    // reports open road -- which is how a car two metres wide ends up wrapped
    // round a lamp post that nothing ever saw. Sweeping the car's own footprint
    // asks the question the car actually cares about: will this fit through
    // there. The three sweeps give both the distance to slow for and a side to
    // steer toward.
    _origin.copy(v.position).addScaledVector(v.forward, v.spec.dims.l * 0.45);
    _origin.y += 0.5;
    const hw = this.halfWidth;
    let leftClear = reach, rightClear = reach, nearest = reach;
    for (const ang of [-0.42, 0, 0.42]) {
      const ca = Math.cos(ang), sa = Math.sin(ang);
      _probe.set(_run.x * ca - _run.z * sa, 0, _run.x * sa + _run.z * ca);
      const toi = sweepBox(v.world, _origin, _probe, reach, RAY_GROUNDS, v.body, hw);
      // Only the straight-ahead sweep is allowed to set the braking distance.
      //
      // The angled pair point twenty-four degrees off, which on any ordinary
      // street runs them into the buildings along the kerb: on a fifteen-metre
      // road that is a hit at about twenty metres with the way ahead totally
      // clear. Feeding that to the brake clamp had cars hauling down to 50 km/h
      // for a building they were never going to touch. They exist to say which
      // side has more room, and that is all they are for.
      if (ang === 0) {
        nearest = toi;
        leftClear = Math.min(leftClear, toi);
        rightClear = Math.min(rightClear, toi);
      } else if (ang < 0) {
        leftClear = Math.min(leftClear, toi);
      } else {
        rightClear = Math.min(rightClear, toi);
      }
    }
    // A hit dead ahead lands on both flanks, so the difference is zero and the
    // tie has to be broken by looking further round.
    if (nearest < reach * 0.7 && Math.abs(leftClear - rightClear) < 0.5) {
      for (const ang of [-1.05, 1.05]) {
        const ca = Math.cos(ang), sa = Math.sin(ang);
        _probe.set(_run.x * ca - _run.z * sa, 0, _run.x * sa + _run.z * ca);
        const toi = sweepBox(v.world, _origin, _probe, reach, RAY_GROUNDS, v.body, hw);
        if (ang < 0) leftClear = toi; else rightClear = toi;
      }
    }

    // Urgency from how close the nearest thing is; direction from which side
    // has more room. Squared so distant scenery is ignored and something about
    // to be hit dominates.
    // Urgency from whichever flank is tightest, not from the forward-only
    // figure, so a wall alongside is reacted to even with open road ahead.
    const tightest = Math.min(leftClear, rightClear, nearest);
    const urgency = clamp01(1 - tightest / reach);
    const bias = ((leftClear - rightClear) / reach) * urgency * urgency * 2.4;

    this.wallBias = lerp(this.wallBias, clamp(bias, -0.8, 0.8), 1 - Math.exp(-12 * dt));

    // Braking distance comes from a separate sweep that ignores props. A tree
    // is something to miss, not something to stop for, and counting them here
    // had units crawling through anywhere wooded.
    this._travelDir(_probe);
    this.wallNear = sweepBox(v.world, _origin, _probe, reach, RAY_SOLID, v.body, hw);
    return this.wallBias;
  }

  avoid(others, dt) {
    const v = this.v;
    this._avoidScenery(dt);
    let bias = 0;
    const range = clamp(9 + v.speed * 0.85, 12, 45);

    // ---- give way to a manoeuvre ----
    //
    // A PIT or a box only works if the car running it can get where it needs
    // to be, and in a pursuit of seven cars the main thing in its way is the
    // pursuit. Nothing used to say this: every unit treated every other unit
    // as scenery to nudge around, so a car authorised to strike had to thread
    // its way through the pack at whatever speed the pack was doing.
    //
    // Anyone not running a manoeuvre themselves moves off the line of one that
    // is coming through, and gives up enough speed to let it past. Deliberately
    // short-range and only for the car behind: a unit two hundred metres back
    // is not being held up by anybody.
    this.wayCap = Infinity;
    if (!v.priority) {
      for (const o of others) {
        if (o === v || !o.priority || o.disabled) continue;
        _p.copy(o.position).sub(v.position);
        const behind = -_p.dot(v.forward);          // + when they are behind us
        if (behind < -4 || behind > 32) continue;
        const side = _p.dot(v.left);
        if (Math.abs(side) > 6) continue;
        // Only for someone actually coming through. A car sitting at the same
        // speed two lengths back is just part of the pack.
        const closing = o.linvel.dot(v.forward) - v.forwardSpeed;
        if (closing < 1.0 && behind > 7) continue;
        const urgency = clamp01(1 - behind / 32);
        // Move off their line. Dead astern there is no side to move to, so
        // take whichever way the scenery leaves room.
        //
        // Most of the giving way is done with the throttle, not the wheel. A
        // firm lateral push was tried first and it does let the manoeuvre car
        // through -- at the cost of putting the rest of the pursuit on the
        // verge: on the town map the units well off the carriageway went from
        // 5% of the chase to 15%. On a street with a house either side there
        // is nowhere to move *to*, and easing off works there as well as it
        // does on a dual carriageway.
        const away = Math.abs(side) > 0.8 ? (side >= 0 ? -1 : 1)
          : (this.wallBias >= 0 ? 1 : -1);
        bias += away * urgency * 0.16;
        this.wayCap = Math.min(this.wayCap, Math.max(8, o.speed - 4));
      }
    }

    for (const o of others) {
      if (o === v) continue;
      _p.copy(o.position).sub(v.position);
      const ahead = _p.dot(v.forward);
      if (ahead < 1 || ahead > range) continue;
      const side = _p.dot(v.left);
      // Both cars' widths, not a constant: what counts as "in the way" depends
      // on how much room the pair of them actually need.
      const clearance = this.halfWidth + (o.spec ? o.spec.dims.w * 0.5 : 0.97) + 0.3
        + v.speed * 0.02;
      if (Math.abs(side) > clearance) continue;
      // Closing speed matters: a car pulling away is not an obstacle.
      const closing = v.forwardSpeed - o.linvel.dot(v.forward);
      if (closing < 1.5) continue;
      const urgency = (1 - ahead / range) * clamp01(closing / 12);
      bias += (side >= 0 ? -1 : 1) * urgency * 0.22;
    }
    this.avoidBias = lerp(this.avoidBias, clamp(bias, -0.35, 0.35), 1 - Math.exp(-8 * dt));
    return this.avoidBias;
  }
}
