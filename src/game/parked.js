// Cars parked on the drives.
//
// "Street clutter: parked cars." Wexbury's streets had nothing standing in them but lamp posts and bins.
// The town generator picks a drive beside about a third of the houses, off the road and the pavement, and
// makes each one solid (world/towngen.js, `parked`); this draws them, once the car models are in. Not in
// the road: a car parked in a lane would change every chase down it.
//
// One traffic model each (hatchback, estate, SUV), its paint from the traffic's colours, sitting on its
// springs as a parked car does, with the game's own wheel. Drawn in batches -- one per part of each model, so
// a few draws for all of them -- in cells of PARK_CELL metres, each hidden past PARK_FAR: a model is about
// 5,500 triangles, and 170 of them drawn twice a frame would cost more than the whole town.

import * as THREE from 'three';
import { SPECS } from './vehicles.js';
import { trafficPaint } from './traffic.js';

const KINDS = ['hatchback', 'estate', 'civsuv'];
const PARK_CELL = 120;
const PARK_FAR = 230;

const _m = new THREE.Matrix4();
const _at = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const Y = new THREE.Vector3(0, 1, 0);

/** The parts of a kind's model, and where its body and wheels sit, from the spec. */
function kindParts(game, kind) {
  const model = game.carModels && game.carModels[kind];
  const spec = SPECS[kind];
  if (!model || !spec) return null;
  model.scene.updateMatrixWorld(true);
  const parts = [];
  model.scene.traverse((o) => {
    if (!o.isMesh) return;
    let mat = o.material;
    const paint = mat && mat.name === 'paint';
    if (paint) { mat = mat.clone(); mat.color.setRGB(1, 1, 1); }
    parts.push({ geo: o.geometry, mat, local: o.matrixWorld.clone(), paint });
  });
  // The wheels as Vehicle._buildWheels lays them out, settled as far into the springs as a remote car's
  // (Game: compression 0.6 of rest), and the body as high as puts their tyres on the ground.
  const sus = spec.suspension;
  const a = spec.wheelbase * (1 - spec.frontWeight), b = spec.wheelbase * spec.frontWeight;
  const drop = sus.rest - sus.rest * 0.6;
  const wy = sus.mountY - drop;
  const wheels = [
    [spec.trackFront / 2, wy, a, true], [-spec.trackFront / 2, wy, a, true],
    [spec.trackRear / 2, wy, -b, false], [-spec.trackRear / 2, wy, -b, false],
  ];
  return { parts, wheels, bodyY: spec.wheelRadius - wy, spec };
}

/** Draw `spots` ({x, z, heading, i}) as parked cars; returns the group added to the scene, or null. */
export function addParkedCars(game, spots) {
  if (!spots || !spots.length || !game.wheelMesh || window.__noParked) return null;
  const kinds = {};
  for (const k of KINDS) { const p = kindParts(game, k); if (p) kinds[k] = p; }
  const have = Object.keys(kinds);
  if (!have.length) return null;
  // Into cells, and each car its kind.
  const cells = new Map();
  for (const s of spots) {
    const key = `${Math.floor(s.x / PARK_CELL)},${Math.floor(s.z / PARK_CELL)}`;
    let list = cells.get(key);
    if (!list) cells.set(key, (list = []));
    list.push(s);
  }
  const root = new THREE.Group();
  root.name = 'parked';
  for (const [key, list] of cells) {
    const [ci, cj] = key.split(',').map(Number);
    const ox = (ci + 0.5) * PARK_CELL, oz = (cj + 0.5) * PARK_CELL;
    const cell = new THREE.Group();
    const byKind = {};
    for (const s of list) (byKind[have[s.i % have.length]] || (byKind[have[s.i % have.length]] = [])).push(s);
    let wheels = 0;
    for (const k of Object.keys(byKind)) wheels += byKind[k].length * 4;
    const wm = new THREE.InstancedMesh(game.wheelMesh.geometry, game.wheelMesh.material, wheels);
    wm.castShadow = true;
    let wi = 0;
    for (const [k, cars] of Object.entries(byKind)) {
      const K = kinds[k];
      for (const part of K.parts) {
        const im = new THREE.InstancedMesh(part.geo, part.mat, cars.length);
        im.castShadow = true;
        im.receiveShadow = true;
        cars.forEach((s, n) => {
          const ground = game.groundAt ? game.groundAt(s.x, s.z) : 0;
          _q.setFromAxisAngle(Y, s.heading);
          _at.compose(_p.set(s.x - ox, ground + K.bodyY, s.z - oz), _q, _s.set(1, 1, 1));
          im.setMatrixAt(n, _m.multiplyMatrices(_at, part.local));
          if (part.paint) im.setColorAt(n, _c.setHex(trafficPaint(`p${s.i}`)));
        });
        im.computeBoundingSphere();
        cell.add(im);
      }
      const rs = K.spec.wheelRadius / 0.34;
      for (const s of cars) {
        const ground = game.groundAt ? game.groundAt(s.x, s.z) : 0;
        _q.setFromAxisAngle(Y, s.heading);
        _at.compose(_p.set(s.x - ox, ground + K.bodyY, s.z - oz), _q, _s.set(1, 1, 1));
        for (const [wx, wy, wz, front] of K.wheels) {
          const width = !front && K.spec.wheelWidthRear ? K.spec.wheelWidthRear : K.spec.wheelWidth;
          _m.compose(_p.set(wx, wy, wz), _q.identity(), _s.set(width / 0.26, rs, rs));
          wm.setMatrixAt(wi++, _m.premultiply(_at));
        }
      }
    }
    wm.computeBoundingSphere();
    cell.add(wm);
    const lod = new THREE.LOD();
    lod.position.set(ox, 0, oz);
    lod.addLevel(cell, 0);
    lod.addLevel(new THREE.Object3D(), PARK_FAR);
    root.add(lod);
  }
  game.scene.add(root);
  return root;
}
