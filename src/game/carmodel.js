// Imported car bodies.
//
// Every car in the game is generated geometry (see game/vehicles.js): boxes
// assembled into a body, painted with vertex colours and a livery atlas. This
// is the way in for a car that is not -- a .glb dropped into resources/models
// replaces the *body* of one kind of car and nothing else.
//
// What stays the game's:
//
//   * the collider, which comes from `spec.dims` and never from the model;
//   * the wheels, which are one shared instanced mesh that the physics spins
//     and steers, so any wheels in the file are thrown away;
//   * the flashing lights, which are instanced boxes placed each frame at
//     body-local offsets (see effects.js, LightBars) -- the model may keep its
//     own light bar as unlit plastic and the flashers sit on top of it.
//
// The model is fitted by its own wheels when it has them -- wheelbase to the
// game's wheelbase, axles to the game's axles, tyres on the game's ground --
// and to the box the generated body occupies when it does not. Either way a
// file in centimetres, or at twice life size, still lands on the road at the
// right size. What it cannot fix is a car modelled facing backwards: set `yaw`
// for that.
//
// Nothing here is required. A missing file is not an error -- the generated
// body is used, exactly as before.

import * as THREE from 'three';
import { GLTFLoader } from '../../vendor/addons/loaders/GLTFLoader.js';
import { SPECS } from './vehicles.js';

/**
 * Which kinds of car may be replaced, and by what.
 *
 * `yaw` turns a model that faces the wrong way (radians; Math.PI for one
 * modelled nose-to-negative-Z). `lift` nudges it up or down in metres after
 * fitting, for when the sills end up buried or floating. `lamps` overrides
 * where the flashing lights go, in body-local metres, for a model whose light
 * bar is not where the fitted roof line suggests.
 *
 * `police` says which generated body the model is fitted against. It matters:
 * the police fit-out adds a push bar at the nose and a bar on the roof, so a
 * police target is longer and taller than the plain one, and a car fitted to
 * the wrong one comes out the wrong size.
 */
export const CAR_MODELS = {
  patrol: { url: 'resources/models/police-patrol.glb', police: true, yaw: 0, lift: 0, lamps: null },
  interceptor: { url: 'resources/models/police-interceptor.glb', police: true, yaw: 0, lift: 0, lamps: null },
  suv: { url: 'resources/models/police-suv.glb', police: true, yaw: 0, lift: 0, lamps: null },
  van: { url: 'resources/models/police-van.glb', police: true, yaw: 0, lift: 0, lamps: null },
  supercar: { url: 'resources/models/supercar.glb', police: false, yaw: 0, lift: 0, lamps: null },
  runner: { url: 'resources/models/runner.glb', police: false, yaw: 0, lift: 0, lamps: null },
  // The Badger. No file yet, which is the ordinary case: the generated body
  // is used until one turns up.
  offroad: { url: 'resources/models/offroad.glb', police: false, yaw: 0, lift: 0, lamps: null },
};

const _box = new THREE.Box3();
const _size = new THREE.Vector3();
const _centre = new THREE.Vector3();

/** Anything in the file that is a wheel: the game supplies its own. */
const WHEEL_NAME = /wheel|tyre|tire|rim|hubcap/i;

/**
 * Load one model and fit it to the car it replaces. Returns null if there is
 * no file there, which is the normal case.
 */
export async function loadCarModel(url, targetGeometry, opts = {}, spec = null) {
  // Fetched here rather than handed to the loader, so that "there is no file"
  // is an ordinary answer instead of an exception -- and with GET, because the
  // little PowerShell dev server answers HEAD with a 500.
  let buf;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    buf = await res.arrayBuffer();
  } catch (e) {
    return null;                       // no server, no file, no model
  }

  const base = url.slice(0, url.lastIndexOf('/') + 1);
  const gltf = await new GLTFLoader().parseAsync(buf, base);
  const scene = gltf.scene;

  // ---- face the right way ----
  if (opts.yaw) scene.rotateY(opts.yaw);
  scene.updateMatrixWorld(true);

  const wheels = [];
  scene.traverse((o) => { if (o.name && WHEEL_NAME.test(o.name)) wheels.push(o); });

  // ---- fit ----
  // By its own wheels if it has them and the spec is known: that is the only
  // fit that puts the game's wheels in the arches the modeller cut. Otherwise
  // by the box of the generated body it replaces.
  const fit = (spec && wheels.length >= 4 && fitByWheels(scene, wheels, spec, targetGeometry))
    || fitByBox(scene, targetGeometry);
  if (!fit) return null;
  if (opts.lift) scene.position.y += opts.lift;
  scene.updateMatrixWorld(true);

  // ---- the game's own wheels are the only wheels ----
  // Only now: the fit above needed them.
  for (const o of wheels) if (o.parent) o.parent.remove(o);
  scene.updateMatrixWorld(true);
  const scale = scene.scale.x;

  scene.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true;
    o.receiveShadow = false;
    // The car is always near the camera and its own mesh is cheap to draw;
    // culling it per part costs more than it saves.
    o.frustumCulled = false;
  });

  // ---- where the flashing lights go ----
  _box.setFromObject(scene);
  const lamps = opts.lamps
    ? opts.lamps.map((p) => new THREE.Vector3(p[0], p[1], p[2]))
    : findLightBar(scene, _box);

  // The fitted transform goes on a child, never on the root: the render loop
  // writes the physics position and rotation straight onto whatever it is
  // handed each frame (`v.view.position.copy(v.position)`), so a scale and a
  // ride-height offset left on the root are wiped on the first frame -- which
  // is a car sunk into the road with its lights hovering above it.
  const root = new THREE.Group();
  root.name = `model:${url}`;
  root.add(scene);
  return { scene: root, lamps, scale, url, fit };
}

/**
 * Where the game will put this car's wheels, in body-local metres, with the
 * car sitting still on level ground -- the same numbers Vehicle._buildWheels
 * and the suspension settle to. The sag is the static load over the spring
 * rate; checked against a patrol car parked in the game, it agrees to a
 * centimetre.
 */
export function wheelLayout(spec) {
  const sus = spec.suspension;
  const g = 9.81;
  const front = spec.wheelbase * (1 - spec.frontWeight);
  const rear = -spec.wheelbase * spec.frontWeight;
  const sagF = Math.min(sus.travel, (spec.mass * g * spec.frontWeight * 0.5) / sus.stiffness);
  const sagR = Math.min(sus.travel, (spec.mass * g * (1 - spec.frontWeight) * 0.5) / sus.stiffness);
  const centreY = sus.mountY - sus.rest + (sagF + sagR) * 0.5;
  return { front, rear, centreY, ground: centreY - spec.wheelRadius };
}

/**
 * Fit by the model's own wheels: scale so its wheelbase is the game's, slide it
 * so its axles are where the game's are, and stand its tyres on the game's
 * ground. Returns false -- leaving the box fit to do it -- if the wheels do
 * not look like a car's wheels, rather than trusting a badly named node.
 */
function fitByWheels(scene, wheels, spec, targetGeometry) {
  /**
   * The four corners the wheel parts sit in, and where each corner's wheel
   * centres.
   *
   * A wheel is not always one mesh. On the Badger each one is an assembly --
   * a tyre, a disc, six spokes and twenty-four lug nuts, every part named
   * after the wheel it belongs to -- so 140 nodes matched the wheel name and
   * every one of them was treated as a whole wheel. The "front axle" came out
   * as the frontmost lug nut on the front tyre and the "rear axle" as the
   * rearmost one on the back, which is a wheelbase a whole wheel too long:
   * the car was scaled down by a quarter, failed the sanity check below, and
   * fell back to being fitted by its box -- which stands the body *and its
   * wheels* in the space meant for the body alone, so it came out oversized
   * and floating three quarters of a metre off the road.
   *
   * So the parts are grouped by which corner of the car they are in, and each
   * corner is measured as one wheel, whether it arrived as one mesh or forty.
   */
  const measure = () => {
    scene.updateMatrixWorld(true);
    const parts = [];
    for (const w of wheels) {
      const b = new THREE.Box3().setFromObject(w);
      if (b.isEmpty() || !Number.isFinite(b.min.x)) continue;   // an empty group
      parts.push(b);
    }
    if (parts.length < 4) return null;

    const mid = (b) => ({ x: (b.min.x + b.max.x) * 0.5, z: (b.min.z + b.max.z) * 0.5 });
    const mx = parts.reduce((t, b) => t + mid(b).x, 0) / parts.length;
    const mz = parts.reduce((t, b) => t + mid(b).z, 0) / parts.length;

    // Front or rear, left or right, about the middle of the set: four corners.
    const corners = [[], [], [], []];
    for (const b of parts) {
      const c = mid(b);
      corners[(c.z >= mz ? 0 : 2) + (c.x >= mx ? 0 : 1)].push(b);
    }
    if (corners.some((c) => !c.length)) return null;   // not four wheels

    // Each corner as one box, so a wheel centres on its hub however its parts
    // are distributed.
    const hub = (list) => {
      const u = list[0].clone();
      for (const b of list) u.union(b);
      return { x: (u.min.x + u.max.x) * 0.5, z: (u.min.z + u.max.z) * 0.5, low: u.min.y };
    };
    const [fr, fl, rr, rl] = corners.map(hub);
    return {
      front: (fl.z + fr.z) * 0.5,
      rear: (rl.z + rr.z) * 0.5,
      midX: (fl.x + fr.x + rl.x + rr.x) * 0.25,
      low: Math.min(fl.low, fr.low, rl.low, rr.low),
    };
  };

  let m = measure();
  if (!m) return false;
  const modelBase = m.front - m.rear;
  if (!(modelBase > 0.1)) return false;
  const scale = spec.wheelbase / modelBase;
  scene.scale.multiplyScalar(scale);

  // Sanity: the car that comes out has to be roughly the size of the car it
  // replaces. A model whose "wheels" are something else ends up absurd here,
  // and the box fit is the better answer for it.
  scene.updateMatrixWorld(true);
  _box.setFromObject(scene);
  _box.getSize(_size);
  targetGeometry.computeBoundingBox();
  const wantLen = targetGeometry.boundingBox.max.z - targetGeometry.boundingBox.min.z;
  if (_size.z < wantLen * 0.8 || _size.z > wantLen * 1.2) {
    scene.scale.multiplyScalar(1 / scale);
    return false;
  }

  const game = wheelLayout(spec);
  m = measure();
  if (!m) { scene.scale.multiplyScalar(1 / scale); return false; }
  scene.position.x -= m.midX;
  scene.position.z += (game.front + game.rear) * 0.5 - (m.front + m.rear) * 0.5;
  scene.position.y += game.ground - m.low;
  return 'wheels';
}

/**
 * Fit by the box of the generated body: scaled by length, held to its width,
 * centred, and stood on the same plane. For a model that has no wheels to go
 * by -- it gets the right size and place, but nothing lines up the arches.
 */
function fitByBox(scene, targetGeometry) {
  targetGeometry.computeBoundingBox();
  const want = targetGeometry.boundingBox;
  want.getSize(_size);
  const wantLen = _size.z, wantWide = _size.x, wantLow = want.min.y;
  const wantMidX = (want.min.x + want.max.x) * 0.5;
  const wantMidZ = (want.min.z + want.max.z) * 0.5;

  scene.updateMatrixWorld(true);
  _box.setFromObject(scene);
  _box.getSize(_size);
  if (!(_size.x > 0 && _size.z > 0)) return false;

  // Length decides the scale -- it is the dimension a car is judged by -- but
  // never at the cost of a body wider than the one it replaces by more than a
  // few per cent, which would put the flanks through the kerb.
  let scale = wantLen / _size.z;
  if (_size.x * scale > wantWide * 1.06) scale = (wantWide * 1.06) / _size.x;
  scene.scale.multiplyScalar(scale);
  scene.updateMatrixWorld(true);

  _box.setFromObject(scene);
  _box.getCenter(_centre);
  scene.position.x += wantMidX - _centre.x;
  scene.position.z += wantMidZ - _centre.z;
  scene.position.y += wantLow - _box.min.y;
  return 'box';
}

/**
 * Where to put the flashing lights on a body nobody here modelled.
 *
 * Most police models come with a light bar on the roof already, and the game's
 * flashers belong on it. "Just above the highest point of the car" sounds like
 * the answer and is not: on the first real model the highest point was a
 * spoiler over the tailgate, which put the flashers in the air behind the car.
 *
 * So the roof is found instead -- the front edge of the upper body, where the
 * windscreen meets it -- and the lamps go a little way behind that edge, at
 * the height of the roof *at that end*. That is where a crew fits a bar, and
 * it is right whether or not the model has one.
 */
function findLightBar(scene, fitted) {
  const top = fitted.max.y;
  const p = new THREE.Vector3();
  scene.updateMatrixWorld(true);

  // Everything in the top half-metre of the car: the roof panel, and whatever
  // stands on it. Measured on the first real model, the *highest* thing was a
  // spoiler over the tailgate, so aiming at the highest point put the flashers
  // out in the air behind the car. The roof panel is the thing to find.
  const upper = [];
  scene.traverse((o) => {
    if (!o.isMesh || !o.geometry || !o.geometry.attributes.position) return;
    const pos = o.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      p.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      if (p.y >= top - 0.5) upper.push(p.clone());
    }
  });
  if (!upper.length) {
    return [
      new THREE.Vector3(+0.38, top + 0.04, -0.14),
      new THREE.Vector3(-0.38, top + 0.04, -0.14),
    ];
  }

  // The front edge of the roof is where the windscreen meets it: the furthest
  // forward the upper body reaches along the car's centre.
  let zFront = -Infinity;
  for (const q of upper) if (Math.abs(q.x) < 0.6 && q.z > zFront) zFront = q.z;
  if (!isFinite(zFront)) zFront = 0;

  // How high the roof is at that end -- not at the back, where the spoiler is.
  let roofY = -Infinity;
  for (const q of upper) if (q.z > zFront - 0.9 && q.z <= zFront + 0.05 && q.y > roofY) roofY = q.y;
  if (!isFinite(roofY)) roofY = top;

  // A bar sits just behind the windscreen, which is where a crew would fit one.
  const z = zFront - 0.3;
  return [
    new THREE.Vector3(+0.34, roofY + 0.03, z),
    new THREE.Vector3(-0.34, roofY + 0.03, z),
  ];
}

/**
 * Load every model named in CAR_MODELS that is actually there. Never throws:
 * a broken or missing file leaves that kind on its generated body and says so
 * on the console.
 */
export async function loadCarModels(game, table = CAR_MODELS) {
  const out = {};
  for (const [specKey, opts] of Object.entries(table)) {
    try {
      const target = game._geometryFor(specKey, specKey, !!opts.police, !!opts.unmarked);
      const model = await loadCarModel(opts.url, target, opts, SPECS[specKey]);
      if (model) out[specKey] = model;
    } catch (e) {
      console.warn(`[carmodel] ${specKey}: ${opts.url} failed to load --`, e.message);
    }
  }
  return out;
}
