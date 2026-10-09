// The imported helicopter body.
//
// Like the cars (see carmodel.js), the helicopter is generated geometry by
// default -- a faceted cabin, a tail boom, skids and two translucent discs for
// rotors -- and this is the way in for a .glb that replaces it. A missing file
// is not an error: with nothing there the generated one is used exactly as
// before.
//
// What this does that the car loader does not is place and spin the rotors.
// The brief (resources/models/HELICOPTER.md) asks for them as two separate
// nodes with their origins on their own hubs, because the game turns them in
// code every frame, and a node whose origin is anywhere else orbits instead of
// spinning.

import * as THREE from 'three';
import { GLTFLoader } from '../../vendor/addons/loaders/GLTFLoader.js';

export const HELI_MODEL = {
  url: 'resources/models/police_helicopter.glb',
  /** Radians, if the aircraft is modelled facing the wrong way. */
  yaw: 0,
  /** Metres up or down, if it floats or sinks on the pad. */
  lift: 0,
};

/**
 * Where the rotors go, in model-local metres, for a file that leaves them at
 * the origin.
 *
 * The supplied one does not -- it mounts them properly, at (0, 3.503, 0.100)
 * and (0.04, 2.003, -4.45) -- so this is a fallback and nothing more. It is
 * kept because a rotor modelled at the origin is an easy mistake to make and
 * an annoying one to debug: the aircraft flies along with its blades spinning
 * neatly around its own belly.
 *
 * The figures were worked out from the body's geometry before the model was
 * read properly, and are worth keeping for that reason too: the topmost point
 * of the hull is the mast cap, and the fin is a 34 cm plate running from y 1.5
 * to 2.5 at the back, so the tail rotor sits just outboard of it. That put the
 * main hub within 3 mm of where the modeller had actually placed it.
 */
const MAIN_HUB = new THREE.Vector3(0, 3.50, 0.10);
const TAIL_HUB = new THREE.Vector3(0.26, 2.00, -4.78);

const _box = new THREE.Box3();
const _size = new THREE.Vector3();
const _centre = new THREE.Vector3();

let pending = null;

/**
 * Load the helicopter body, once. Returns the loaded scene or null if there is
 * no file, and caches either answer -- the result is cloned per use, so one
 * fetch serves every helicopter in the game.
 */
export function loadHelicopterModel(url = HELI_MODEL.url) {
  if (!pending) pending = fetchModel(url).catch(() => null);
  return pending;
}

async function fetchModel(url) {
  // GET rather than HEAD, and the failure swallowed: "there is no model" is an
  // ordinary answer here, and the little PowerShell dev server answers HEAD
  // with a 500 anyway. Same reasoning as carmodel.js.
  let buf;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    buf = await res.arrayBuffer();
  } catch (e) {
    return null;
  }

  const base = url.slice(0, url.lastIndexOf('/') + 1);
  const gltf = await new GLTFLoader().parseAsync(buf, base);
  const scene = gltf.scene;
  if (HELI_MODEL.yaw) scene.rotateY(HELI_MODEL.yaw);
  if (HELI_MODEL.lift) scene.position.y += HELI_MODEL.lift;
  scene.updateMatrixWorld(true);

  scene.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true;
    o.receiveShadow = false;
    // There is only ever one of these and it is usually the thing you are
    // looking at; culling it part by part costs more than it saves.
    o.frustumCulled = false;
  });

  return scene;
}

/**
 * A fresh instance of the imported body, wired the way the renderer expects:
 * `userData.main` and `.tail` are the rotors, and `.mainAxis` / `.tailAxis`
 * say which way each one turns.
 *
 * Returns null when there is no model, which is the caller's signal to build
 * the generated one.
 */
export function buildImportedHelicopter(scene) {
  if (!scene) return null;
  const group = new THREE.Group();
  const body = scene.clone(true);
  group.add(body);

  const main = body.getObjectByName('rotor_main');
  const tail = body.getObjectByName('rotor_tail');
  if (main) mount(main, MAIN_HUB);
  if (tail) mount(tail, TAIL_HUB);

  group.userData.main = main || null;
  group.userData.tail = tail || null;
  group.userData.mainAxis = spinAxis(main, 'y');
  group.userData.tailAxis = spinAxis(tail, 'x');
  group.userData.imported = true;
  return group;
}

/** Put a rotor on its hub, unless the file already placed it. */
function mount(rotor, at) {
  if (rotor.position.lengthSq() > 1e-4) return;
  rotor.position.copy(at);
}

/**
 * Which way a rotor turns: about whichever axis it is flattest on.
 *
 * A rotor is a disc, so its own proportions say this and there is nothing to
 * configure -- a main rotor is wide and flat and turns about the vertical, a
 * tail rotor is a disc on its side and turns about the lateral. Reading it off
 * the geometry means a re-export that changes the convention still spins the
 * right way.
 */
function spinAxis(rotor, fallback) {
  if (!rotor) return fallback;
  _box.setFromObject(rotor);
  if (_box.isEmpty()) return fallback;
  _box.getSize(_size);
  if (_size.x <= _size.y && _size.x <= _size.z) return 'x';
  if (_size.y <= _size.x && _size.y <= _size.z) return 'y';
  return 'z';
}

/** Overall length of an imported body, for the record and for sanity checks. */
export function modelSpan(scene) {
  if (!scene) return null;
  _box.setFromObject(scene);
  _box.getSize(_size);
  _box.getCenter(_centre);
  return { size: _size.clone(), centre: _centre.clone() };
}
