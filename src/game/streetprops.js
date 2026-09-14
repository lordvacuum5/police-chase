// Street furniture you can knock over.
//
// Lamp posts, bollards, bins and signs along the kerb. Standing, they are
// instanced meshes with a thin static collider, so a thousand of them cost
// four draw calls and nothing per frame. Hit one hard enough and it becomes a
// real dynamic body: it topples, slides, and the car takes a small, honest
// momentum hit for it -- a lamp post is sixty kilos against your fourteen
// hundred, so it should shove you a little and cost you a little, not stop you.
//
// They are in GROUP.STREET, which no ray or sweep in the game looks at. That
// is deliberate: the police AI must not brake for a bollard, and a suspension
// ray must not climb a lamp post. All the interaction happens here instead,
// where it can be tuned.

import * as THREE from 'three';
import { MeshBuilder, vertexColorMaterial } from '../util/meshbuild.js';
import { GROUP, groups, addStaticBox } from '../physics/world.js';
import { rand } from '../util/math.js';
import RAPIER from 'rapier';

/**
 * The catalogue. `mass` is what the car actually trades momentum with, and
 * `bite` scales how much of the hit turns into damage rather than just a shove.
 */
const KINDS = {
  lamp: {
    mass: 62, radius: 0.16, height: 4.6, bite: 0.5,
    spacing: 34, chance: 1.0, out: 2.2,
  },
  // Heavier than it looks, as a real one is -- cast iron set in concrete -- so
  // flat out it knocks about 20 km/h off and does about 5% damage to the
  // Stiletto. It was 24 kg and 0.25, which went through for 9 km/h and 1%.
  bollard: {
    mass: 95, radius: 0.13, height: 0.95, bite: 0.30,
    spacing: 9, chance: 0.55, out: 1.1,
  },
  bin: {
    mass: 26, radius: 0.30, height: 1.05, bite: 0.2,
    spacing: 70, chance: 0.8, out: 2.0,
  },
  sign: {
    mass: 18, radius: 0.11, height: 2.3, bite: 0.2,
    spacing: 55, chance: 0.7, out: 1.9,
  },
};

/** Roads that get a kerb worth furnishing. */
const FURNISHED = new Set(['street', 'avenue', 'dual', 'lane']);

const MAX_LIVE = 26;          // toppled props kept simulating at once
const HIT_SPEED = 2.4;        // m/s below which you just nudge past
const SUBSTEP = 1 / 120;      // the physics substep, as in main.js
const MAX_SUBSTEP_TIME = 5 / 120;   // the most physics one frame can run

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _pos = new THREE.Vector3();
const _one = new THREE.Vector3(1, 1, 1);
const _up = new THREE.Vector3(0, 1, 0);
const _off = new THREE.Vector3();

export class StreetProps {
  constructor(game) {
    this.game = game;
    this.props = [];
    this.live = [];
    this.byKind = new Map();
    this.cell = 24;
    this.grid = new Map();

    this._place();
    this._build();
  }

  // ------------------------------------------------------------- placement

  /**
   * Walk every furnished kerb and drop things along it.
   *
   * Lamp posts alternate sides the way they actually do, so a street is lit
   * from both kerbs without being lined with posts on each.
   */
  _place() {
    const { graph, rng } = this.game;
    for (const e of graph.edges) {
      if (e.dead || e.turningHead || !FURNISHED.has(e.kind)) continue;
      const half = e.width * 0.5;
      // Keep clear of the junction mouths at either end.
      const from = (e.trimA || 0) + 4;
      const to = e.length - (e.trimB || 0) - 4;
      if (to - from < 12) continue;

      for (const [key, def] of Object.entries(KINDS)) {
        let side = rng() < 0.5 ? 1 : -1;
        for (let s = from + rand(rng, 0, def.spacing); s < to; s += def.spacing) {
          if (rng() > def.chance) continue;
          const p = pointAlong(e, s);
          if (!p) continue;
          const off = half + def.out;
          const x = p.x - p.nx * off * side;
          const z = p.z - p.nz * off * side;
          // Face the road.
          const rot = Math.atan2(p.nx * side, p.nz * side);
          this._add(key, def, x, z, rot);
          if (key === 'lamp') side = -side;
        }
      }
    }
  }

  _add(kind, def, x, z, rot) {
    // Never in the carriageway, and never inside something solid.
    if (this.game.graph.overlapsRoad(x, z, def.radius * 2, def.radius * 2, 0, 0.4)) return;
    // Nor across the way into the garage.
    if (this.game.garage && this.game.garage.covers(x, z, 1.5)) return;

    // Street furniture stands on the footway, which is a kerb height above the
    // road. Planting it at zero buries a bollard to its knees.
    const base = this.game.sim.heightAt ? this.game.sim.heightAt(x, z) : 0;

    const p = {
      kind, def, x, z, rot, base,
      index: -1,
      body: null,
      down: false,
    };
    p.collider = addStaticBox(
      this.game.world, x, base + def.height * 0.5, z,
      def.radius, def.height * 0.5, def.radius, GROUP.STREET, rot,
    );
    this.props.push(p);

    const key = this._key(x, z);
    let bucket = this.grid.get(key);
    if (!bucket) { bucket = []; this.grid.set(key, bucket); }
    bucket.push(p);
  }

  _key(x, z) {
    return `${Math.floor(x / this.cell)},${Math.floor(z / this.cell)}`;
  }

  /**
   * Take on furniture somebody else built.
   *
   * Traffic signals are placed by the junction planner, not by walking a kerb,
   * and their lamps have to go dark when one goes over -- but everything about
   * *toppling* one is identical to a lamp post, and there is no reason to have
   * two copies of that. The caller supplies its own instanced mesh and its own
   * entries, already carrying `x`, `z`, `rot`, `index` and a static `collider`,
   * plus optional `onDown` / `onUp` hooks.
   */
  adopt(kind, def, mesh, list) {
    for (const p of list) {
      p.kind = kind;
      p.def = def;
      p.body = null;
      p.down = false;
      this.props.push(p);
      const key = this._key(p.x, p.z);
      let bucket = this.grid.get(key);
      if (!bucket) { bucket = []; this.grid.set(key, bucket); }
      bucket.push(p);
    }
    this.byKind.set(kind, { mesh, list });
  }

  // -------------------------------------------------------------- geometry

  _build() {
    for (const key of Object.keys(KINDS)) {
      const list = this.props.filter((p) => p.kind === key);
      if (!list.length) continue;
      const geo = geometryFor(key, KINDS[key]);
      const mesh = new THREE.InstancedMesh(geo, vertexColorMaterial(), list.length);
      mesh.name = `props-${key}`;
      mesh.castShadow = true;
      mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      list.forEach((p, i) => {
        p.index = i;
        _q.setFromAxisAngle(_up, p.rot);
        _pos.set(p.x, p.base || 0, p.z);
        _m.compose(_pos, _q, _one);
        mesh.setMatrixAt(i, _m);
      });
      mesh.instanceMatrix.needsUpdate = true;
      this.game.scene.add(mesh);
      this.byKind.set(key, { mesh, list });
    }
  }

  // ----------------------------------------------------------------- knock

  /**
   * Check every vehicle against the furniture near it.
   *
   * Cheaper and far more controllable than letting the solver do it: standing
   * props have no dynamic body at all, so nothing is being simulated until
   * something actually hits one.
   */
  update(dt) {
    // How far ahead to look: everything the car will cover before this is
    // checked again. It runs once a frame, but physics runs up to five
    // substeps in that frame. Checking only where the car is now let a fast
    // car on a slow frame -- 250 km/h at 30 frames a second is 2.1 m a frame
    // -- reach the post's static collider before it was ever knocked, and a
    // static collider is an immovable wall: 230 km/h down to 21 in one substep
    // and the car wrecked. Sweeping the footprint along the velocity for the
    // frame, plus a substep to spare, knocks it over before contact instead.
    const ahead = Math.min(dt, MAX_SUBSTEP_TIME) + SUBSTEP;
    for (const v of this.game.vehicles) {
      const sp = v.speed;
      if (sp < HIT_SPEED) continue;
      const reach = v.spec.dims.l * 0.5 + 0.9;
      const halfW = v.spec.dims.w * 0.5 + 0.5;
      const px = v.position.x, pz = v.position.z;
      const fx = v.forward.x, fz = v.forward.z;
      const ux = v.linvel.x / sp, uz = v.linvel.z / sp;
      const travel = sp * ahead;
      const samples = Math.ceil(travel / 0.5);

      const cx = Math.floor(px / this.cell), cz = Math.floor(pz / this.cell);
      for (let j = cz - 1; j <= cz + 1; j++) {
        for (let i = cx - 1; i <= cx + 1; i++) {
          const bucket = this.grid.get(`${i},${j}`);
          if (!bucket) continue;
          for (const p of bucket) {
            if (p.down) continue;
            for (let k = 0; k <= samples; k++) {
              const s = samples ? (travel * k) / samples : 0;
              const dx = p.x - (px + ux * s), dz = p.z - (pz + uz * s);
              // Into the car's own frame: forward and lateral offsets.
              const f = dx * fx + dz * fz;
              const l = dx * fz - dz * fx;
              if (Math.abs(f) > reach || Math.abs(l) > halfW + p.def.radius) continue;
              this._knock(p, v, f);
              break;
            }
          }
        }
      }
    }
    this._syncLive(dt);
  }

  _knock(p, v, forward) {
    p.down = true;
    if (p.onDown) p.onDown(p);

    // Momentum exchange with a mostly inelastic collision. Sixty kilos into
    // fourteen hundred at 30 m/s is about a metre and a half a second off --
    // a shove, which is what it should be.
    const m = p.def.mass;
    const dv = (m * 1.35) / (v.spec.mass + m) * v.speed;
    v.applySpeedLoss(dv * (forward > 0 ? 1 : 0.4));
    // A little damage too, so a street furnished with bollards is not a free
    // shortcut, but nothing like hitting a wall.
    v.applyDamage(dv * p.def.bite * 0.045);
    // Felt, not just counted: the speed loss is taken quietly so it cannot be
    // mistaken for a crash (see Vehicle.applySpeedLoss), so the jolt and the
    // thud are given here, sized to the hit.
    if (v === this.game.player && dv > 0.8) {
      const s = Math.min(0.55, dv * 0.09);
      if (this.game.camera3) this.game.camera3.impulse(s);
      if (this.game.audio) this.game.audio.impact(s);
    }

    this.game.world.removeRigidBody(p.collider);
    p.collider = null;

    // Replace it with a real body, thrown the way the car was going.
    const def = p.def;
    const body = this.game.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(p.x, (p.base || 0) + def.height * 0.5, p.z)
        .setRotation({ x: 0, y: Math.sin(p.rot * 0.5), z: 0, w: Math.cos(p.rot * 0.5) })
        .setLinearDamping(0.5)
        .setAngularDamping(0.7)
        .setCcdEnabled(true),
    );
    const vol = def.radius * 2 * def.height * def.radius * 2;
    const col = RAPIER.ColliderDesc.cuboid(def.radius, def.height * 0.5, def.radius)
      .setDensity(Math.max(4, def.mass / Math.max(0.02, vol)))
      .setFriction(0.7)
      .setRestitution(0.05)
      .setCollisionGroups(groups(GROUP.STREET, GROUP.TERRAIN | GROUP.VEHICLE));
    this.game.world.createCollider(col, body);

    const vv = v.linvel;
    const push = Math.min(1, v.speed / 26);
    // Sent off a little faster than the car, the way a struck post goes: the
    // hit has already been paid for above. Thrown slower than the car -- as it
    // was, at a couple of metres a second -- the car ran into it again a moment
    // later, and once bollards weighed what they should that second hit cost
    // as much again as the first.
    body.setLinvel({ x: vv.x * 1.1, y: 2.5 * push, z: vv.z * 1.1 }, true);
    // Off-centre, so it spins as it goes over rather than sliding upright.
    body.applyTorqueImpulse({
      x: -vv.z * m * 0.020 * push, y: 0, z: vv.x * m * 0.020 * push,
    }, true);

    p.body = body;
    p.rest = 0;
    this.live.push(p);
    // Oldest first: a long chase should not end up simulating half the town.
    while (this.live.length > MAX_LIVE) this._settle(this.live.shift());
  }

  /** Freeze a toppled prop where it lies and stop paying for it. */
  /**
   * Copy a toppled prop's body pose onto its instance.
   *
   * The geometry is modelled with its base at the origin but the collider is
   * centred on the body, so the mesh sits half a height *below* the body --
   * along the body's own up axis, not the world's. Subtracting on world Y
   * instead is what buried a fallen lamp post in the road: once it is lying
   * flat the correct offset is horizontal, and taking 2.3 m off its height
   * drops it straight through the floor.
   */
  _writeInstance(p) {
    const entry = this.byKind.get(p.kind);
    if (!entry || !p.body) return;
    const t = p.body.translation();
    const r = p.body.rotation();
    _q.set(r.x, r.y, r.z, r.w);
    _off.set(0, -p.def.height * 0.5, 0).applyQuaternion(_q);
    _pos.set(t.x + _off.x, t.y + _off.y, t.z + _off.z);
    _m.compose(_pos, _q, _one);
    entry.mesh.setMatrixAt(p.index, _m);
    entry.mesh.instanceMatrix.needsUpdate = true;
  }

  _settle(p) {
    if (!p.body) return;
    this._writeInstance(p);
    this.game.world.removeRigidBody(p.body);
    p.body = null;
  }

  _syncLive(dt) {
    for (let i = this.live.length - 1; i >= 0; i--) {
      const p = this.live[i];
      if (!p.body) { this.live.splice(i, 1); continue; }
      this._writeInstance(p);
      // Once it has stopped moving there is no reason to keep solving it.
      const lv = p.body.linvel();
      const still = Math.hypot(lv.x, lv.y, lv.z) < 0.25;
      p.rest = still ? p.rest + dt : 0;
      if (p.rest > 1.5) { this._settle(p); this.live.splice(i, 1); }
    }
  }

  /** Stand everything back up. */
  reset() {
    for (const p of this.live) if (p.body) { this.game.world.removeRigidBody(p.body); p.body = null; }
    this.live.length = 0;
    for (const p of this.props) {
      if (!p.down) continue;
      p.down = false;
      p.rest = 0;
      if (p.onUp) p.onUp(p);
      p.collider = addStaticBox(
        this.game.world, p.x, (p.base || 0) + p.def.height * 0.5, p.z,
        p.def.radius, p.def.height * 0.5, p.def.radius, GROUP.STREET, p.rot,
      );
      const entry = this.byKind.get(p.kind);
      if (entry) {
        _q.setFromAxisAngle(_up, p.rot);
        _pos.set(p.x, p.base || 0, p.z);
        _m.compose(_pos, _q, _one);
        entry.mesh.setMatrixAt(p.index, _m);
        entry.mesh.instanceMatrix.needsUpdate = true;
      }
    }
    for (const { mesh } of this.byKind.values()) mesh.instanceMatrix.needsUpdate = true;
  }
}

// ------------------------------------------------------------------ shapes

/**
 * Each prop's geometry, built with its base at the origin so the instance
 * matrix can just be "stand here, facing there".
 */
function geometryFor(kind, def) {
  const b = new MeshBuilder();
  if (kind === 'lamp') {
    const h = def.height;
    b.addTaperedBox(0.30, 0.16, 0.30, 0, 0.08, 0, 0x3a3f45, 0.72, 0.72);
    b.addTaperedBox(0.17, h - 0.16, 0.17, 0, 0.16 + (h - 0.16) * 0.5, 0, 0x4a5058, 0.62, 0.62);
    // Gooseneck out over the carriageway, then the lantern under it.
    b.addBox(0.11, 0.10, 0.95, 0, h - 0.06, 0.46, 0x4a5058);
    b.addTaperedBox(0.34, 0.16, 0.52, 0, h - 0.19, 0.86, 0x353a40, 0.7, 0.7);
    b.addBox(0.26, 0.05, 0.42, 0, h - 0.29, 0.86, 0xd8cfae);
  } else if (kind === 'bollard') {
    b.addTaperedBox(0.26, def.height * 0.90, 0.26, 0, def.height * 0.45, 0, 0x2c3138, 0.82, 0.82);
    b.addBox(0.23, 0.07, 0.23, 0, def.height * 0.94, 0, 0xc9ccd1);
    b.addBox(0.24, 0.05, 0.05, 0, def.height * 0.62, 0.11, 0xd6d9dd);
  } else if (kind === 'bin') {
    b.addTaperedBox(0.52, def.height * 0.86, 0.44, 0, def.height * 0.43, 0, 0x2f3a33, 1.06, 1.06);
    b.addBox(0.58, 0.07, 0.50, 0, def.height * 0.89, 0, 0x22282a);
    b.addBox(0.30, 0.04, 0.20, 0, def.height * 0.93, 0, 0x14181a);
  } else {
    // Sign: a post with a plate on top.
    b.addBox(0.10, def.height, 0.10, 0, def.height * 0.5, 0, 0x585e66);
    b.addBox(0.62, 0.46, 0.05, 0, def.height - 0.30, 0.02, 0xdadde1);
    b.addBox(0.50, 0.34, 0.02, 0, def.height - 0.30, 0.045, 0x2b4a86);
  }
  return b.build();
}

/** A point `s` metres along an edge, with the left normal there. */
function pointAlong(e, s) {
  let acc = 0;
  for (const seg of e.segs) {
    if (s <= acc + seg.len) {
      const t = seg.len > 1e-6 ? (s - acc) / seg.len : 0;
      const dx = (seg.b.x - seg.a.x) / (seg.len || 1);
      const dz = (seg.b.z - seg.a.z) / (seg.len || 1);
      return {
        x: seg.a.x + (seg.b.x - seg.a.x) * t,
        z: seg.a.z + (seg.b.z - seg.a.z) * t,
        nx: -dz, nz: dx,
      };
    }
    acc += seg.len;
  }
  return null;
}

