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

export const CAM_MODES = ['chase', 'close', 'hood', 'cinematic'];

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

  update(dt, v) {
    const mode = CAM_MODES[this.mode];
    this.shake = Math.max(0, this.shake - dt * 2.2);

    // ---- which way is "behind"? ----
    const noseHeading = Math.atan2(v.forward.x, v.forward.z);
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
      // Out over the bonnet, and measured from the car rather than in fixed
      // metres. Sitting where a driver's head goes put the camera inside the
      // cabin of the taller bodies -- in a police interceptor you looked
      // straight through the car at the back of its own boot. Every car knows
      // how long and how tall it is, so the viewpoint is taken from that: far
      // enough forward to be ahead of the screen, high enough to see over the
      // bonnet, and it lands in the right place on a saloon, an SUV and an
      // imported body alike.
      const nose = v.spec.dims.l * 0.16;
      const eye = (v.spec.colliderY === undefined ? 0.1 : v.spec.colliderY) + v.spec.dims.h * 0.62;
      _pos.copy(v.position)
        .addScaledVector(v.forward, nose)
        .addScaledVector(v.up, eye);
      _look.copy(_pos).addScaledVector(v.forward, 30).addScaledVector(v.up, -1.4);
      this.pos.copy(_pos);
      this.look.lerp(_look, 1 - Math.exp(-18 * dt));
      this.fov = damp(this.fov, 66 + clamp(v.speed * 0.32, 0, 20), 4, dt);
    } else if (mode === 'cinematic') {
      this.orbit += dt * 0.25;
      const r = 13 + v.speed * 0.16;
      _pos.set(
        v.position.x + Math.sin(this.orbit) * r,
        v.position.y + 4.5 + Math.sin(this.orbit * 0.6) * 1.6,
        v.position.z + Math.cos(this.orbit) * r,
      );
      this.pos.lerp(_pos, 1 - Math.exp(-3.0 * dt));
      this.look.lerp(v.position, 1 - Math.exp(-6 * dt));
      this.fov = damp(this.fov, 52, 3, dt);
    } else {
      const close = mode === 'close';
      const dist = (close ? 5.6 : 7.4) + clamp(v.speed * 0.075, 0, 3.2);
      const height = (close ? 2.2 : 3.05) + clamp(v.speed * 0.012, 0, 0.7);

      const sh = Math.sin(this.heading), ch = Math.cos(this.heading);
      _pos.set(
        v.position.x - sh * dist,
        v.position.y + height,
        v.position.z - ch * dist,
      );
      // Follow position with a spring so kerbs and jumps read as movement.
      this.pos.lerp(_pos, 1 - Math.exp(-(close ? 11 : 8.5) * dt));

      // Look slightly ahead of the car, further the faster it is going.
      _look.copy(v.position)
        .addScaledVector(v.forward, 3.5 + v.speed * 0.16)
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
