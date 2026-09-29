// Chase camera.
//
// The camera tracks the direction the car is *travelling*, not the direction
// it is pointing. That one decision is what makes a drift readable: the car
// rotates in front of you and you can see how much opposite lock you are
// carrying, instead of the world swinging around a nose-locked view.

import * as THREE from 'three';
import { clamp, clamp01, lerp, damp, angleDelta, smoothstep } from '../util/math.js';

const _pos = new THREE.Vector3();
const _look = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _dir = new THREE.Vector3();
// The car as it is being drawn this frame, rather than as the solver left it.
const _carPos = new THREE.Vector3();
const _carQuat = new THREE.Quaternion();
const _fwd = new THREE.Vector3();
const _upv = new THREE.Vector3();
const AXIS_F = new THREE.Vector3(0, 0, 1);
const AXIS_U = new THREE.Vector3(0, 1, 0);

export const CAM_MODES = ['chase', 'close', 'hood', 'cinematic'];

/**
 * How far below the horizon the car's own bodywork may first appear in the
 * bonnet view before the camera is moved, in degrees.
 *
 * The bottom of the frame is about 36 degrees down. Measured at the settings
 * that were already there, every car in the game sits between 20 and 28 --
 * a strip of bonnet across the bottom of the screen -- except one:
 *
 *   Stiletto 23.5    interceptor 20.5    patrol 24
 *   Runner   26.5    SUV         28      Badger 38.5
 *
 * which is the bug, and the number is the line those numbers already drew.
 */
const HOOD_BODY_DEG = 28;
const _hoodEye = new Map();
const _ray = new THREE.Raycaster();

/**
 * Where to put the bonnet camera: the old arithmetic, checked against the car.
 *
 * The viewpoint is a fraction of the car's own size -- far enough forward to
 * be ahead of the screen, 62% of the way up the body -- and for five of the
 * six cars that is right and stays exactly as it was. It fails on a Land
 * Rover, whose bonnet is nearly as high as its roof: the camera came out five
 * centimetres above the bonnet surface, looking straight along it, and the
 * view had no car in it at all. "I can't quite see the bonnet on the cam on
 * the Land Rover."
 *
 * So the sum is checked by looking. A ray from the viewpoint, swept downward,
 * finds the angle at which the body first gets in the way. Inside
 * HOOD_BODY_DEG the answer stands and nothing moves. Past it the bonnet has
 * dropped off the bottom of the screen, and the camera goes back over the
 * scuttle and climbs until the body is in frame again -- on a tall cab that
 * ends up above the screen line, because inside that cabin there is nowhere
 * you can see the bonnet from at all. A body imported later gets caught the
 * same way without anybody tuning it.
 *
 * Measured once per kind of car and remembered: it is a property of the shape,
 * and a sweep of rays is not something to do every frame.
 */
function hoodEye(v) {
  const key = v.specKey || v.spec.name;
  const had = _hoodEye.get(key);
  if (had) return had;

  // The mesh follows the physics in the render step, which has not run yet on
  // the frame a car is created -- so put it where the car is before asking it
  // anything, or the rays are cast at where it used to be.
  v.view.position.copy(v.position);
  v.view.quaternion.copy(v.quaternion);
  v.view.updateMatrixWorld(true);

  const bodyAt = (fwd, eye) => {
    _pos.copy(v.position).addScaledVector(v.forward, fwd).addScaledVector(v.up, eye);
    for (let deg = 2; deg <= 44; deg += 1) {
      _dir.copy(v.forward).addScaledVector(v.up, -Math.tan((deg * Math.PI) / 180)).normalize();
      _ray.set(_pos, _dir);
      _ray.far = 12;
      if (_ray.intersectObject(v.view, true).length) return deg;
    }
    return 90;                       // nothing in the way at all
  };

  const base = (v.spec.colliderY === undefined ? 0.1 : v.spec.colliderY);
  let out = { fwd: v.spec.dims.l * 0.16, eye: base + v.spec.dims.h * 0.62 };
  if (bodyAt(out.fwd, out.eye) > HOOD_BODY_DEG) {
    // Back over the scuttle, then bisect on height. The angle climbs with the
    // eye -- the higher you sit the further down the screen your own bodywork
    // appears -- so this is the highest seat that still has the car in frame:
    // low enough to see over the bonnet, high enough not to be looking at the
    // inside of the windscreen.
    const fwd = -0.25;
    let lo = base, hi = base + v.spec.dims.h * 1.6;
    for (let i = 0; i < 14; i++) {
      const mid = (lo + hi) * 0.5;
      if (bodyAt(fwd, mid) > HOOD_BODY_DEG) hi = mid; else lo = mid;
    }
    out = { fwd, eye: lo };
  }
  _hoodEye.set(key, out);
  return out;
}

export class ChaseCamera {
  constructor(camera) {
    this.camera = camera;
    this.mode = 0;
    this.heading = 0;
    this.pos = new THREE.Vector3(0, 5, -12);
    this.look = new THREE.Vector3();
    this.fov = 62;
    this.shake = 0;
    this.orbit = 0;
  }

  cycle() { this.mode = (this.mode + 1) % CAM_MODES.length; }
  get modeName() { return CAM_MODES[this.mode]; }

  /** Add a jolt -- called on impacts. */
  impulse(strength) { this.shake = Math.min(1.2, this.shake + strength); }

  /**
   * `alpha` is how far through the current physics substep the frame is being
   * drawn (Game._render). The camera has to follow the car that is on screen,
   * not the one the solver last wrote down: in the bonnet view the camera is
   * bolted to the body, and following the raw pose there would have the car
   * sliding about in front of a camera that is meant to be inside it.
   */
  update(dt, v, alpha = 1) {
    const mode = CAM_MODES[this.mode];
    this.shake = Math.max(0, this.shake - dt * 2.2);

    _carPos.copy(v.prevPos).lerp(v.position, alpha);
    _carQuat.copy(v.prevQuat).slerp(v.quaternion, alpha);
    _fwd.copy(AXIS_F).applyQuaternion(_carQuat);
    _upv.copy(AXIS_U).applyQuaternion(_carQuat);

    // ---- which way is "behind"? ----
    const noseHeading = Math.atan2(_fwd.x, _fwd.z);
    let targetHeading = noseHeading;
    if (v.speed > 6) {
      const velHeading = Math.atan2(v.linvel.x, v.linvel.z);
      // Blend toward the velocity vector as speed rises, but never all the way
      // -- a pure velocity camera looks unmoored during a slow spin.
      const blend = smoothstep(6, 22, v.speed) * 0.75;
      targetHeading = noseHeading + angleDelta(noseHeading, velHeading) * blend;
    }
    // Reversing should not whip the camera around to face the boot.
    if (v.forwardSpeed < -1.5) targetHeading = noseHeading;

    const turnRate = mode === 'cinematic' ? 1.6 : 5.0;
    this.heading += angleDelta(this.heading, targetHeading) * (1 - Math.exp(-turnRate * dt));

    if (mode === 'hood') {
      // Out over the bonnet, from a seat the car itself decides: see hoodEye.
      const seat = hoodEye(v);
      _pos.copy(_carPos)
        .addScaledVector(_fwd, seat.fwd)
        .addScaledVector(_upv, seat.eye);
      _look.copy(_pos).addScaledVector(_fwd, 30).addScaledVector(_upv, -1.4);
      this.pos.copy(_pos);
      this.look.lerp(_look, 1 - Math.exp(-18 * dt));
      this.fov = damp(this.fov, 66 + clamp(v.speed * 0.32, 0, 20), 4, dt);
    } else if (mode === 'cinematic') {
      this.orbit += dt * 0.25;
      const r = 13 + v.speed * 0.16;
      _pos.set(
        _carPos.x + Math.sin(this.orbit) * r,
        _carPos.y + 4.5 + Math.sin(this.orbit * 0.6) * 1.6,
        _carPos.z + Math.cos(this.orbit) * r,
      );
      this.pos.lerp(_pos, 1 - Math.exp(-3.0 * dt));
      this.look.lerp(_carPos, 1 - Math.exp(-6 * dt));
      this.fov = damp(this.fov, 52, 3, dt);
    } else {
      const close = mode === 'close';
      const dist = (close ? 5.6 : 7.4) + clamp(v.speed * 0.075, 0, 3.2);
      const height = (close ? 2.2 : 3.05) + clamp(v.speed * 0.012, 0, 0.7);

      const sh = Math.sin(this.heading), ch = Math.cos(this.heading);
      _pos.set(
        _carPos.x - sh * dist,
        _carPos.y + height,
        _carPos.z - ch * dist,
      );
      // Follow position with a spring so kerbs and jumps read as movement.
      this.pos.lerp(_pos, 1 - Math.exp(-(close ? 11 : 8.5) * dt));

      // Look slightly ahead of the car, further the faster it is going.
      _look.copy(_carPos)
        .addScaledVector(_fwd, 3.5 + v.speed * 0.16)
        .add(_tmp.set(0, 1.15, 0));
      this.look.lerp(_look, 1 - Math.exp(-9 * dt));

      this.fov = damp(this.fov, 60 + clamp(v.speed * 0.42, 0, 26), 3.5, dt);
    }

    // ---- apply ----
    this.camera.position.copy(this.pos);
    if (this.shake > 0.001) {
      const s = this.shake * this.shake * 0.45;
      this.camera.position.x += (Math.random() - 0.5) * s;
      this.camera.position.y += (Math.random() - 0.5) * s;
      this.camera.position.z += (Math.random() - 0.5) * s;
    }
    this.camera.lookAt(this.look);

    // A touch of roll in the direction of the slide sells the lateral load.
    if (mode !== 'cinematic') {
      const roll = clamp(-v.lateralSpeed * 0.006, -0.07, 0.07);
      this.camera.rotateZ(roll);
    }

    // The field of view is vertical, so on a screen taller than it is wide --
    // a phone held upright -- the same number leaves a sliver of road either
    // side of the car. Widen it there by the square root of how tall the
    // screen is: 66 degrees on a phone becomes about 88, which is a wide view
    // rather than a fisheye, and a landscape screen is untouched.
    let fov = this.fov;
    const aspect = this.camera.aspect;
    if (aspect < 1) {
      const half = Math.atan(Math.tan((fov * Math.PI) / 360) / Math.sqrt(aspect));
      fov = Math.min(96, (half * 360) / Math.PI);
    }
    if (Math.abs(this.camera.fov - fov) > 0.05) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }

  snapTo(v) {
    this.heading = Math.atan2(v.forward.x, v.forward.z);
    const sh = Math.sin(this.heading), ch = Math.cos(this.heading);
    this.pos.set(v.position.x - sh * 7.4, v.position.y + 3.05, v.position.z - ch * 7.4);
    this.look.copy(v.position);
    this.camera.position.copy(this.pos);
    this.camera.lookAt(this.look);
  }
}
