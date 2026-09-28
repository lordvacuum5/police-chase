// Portraits of the cars, for the menu.
//
// The menu drew each car as a flat schematic in a colour picked by hand, which
// was honest while every car was generated geometry in that colour and stopped
// being honest the moment three of them got imported bodies with their own
// paint: the card promised an orange saloon and the game handed you a grey
// coupe. "The pictures of the cars don't mirror the actual cars."
//
// So the game takes the photographs itself. Once a session, as soon as the
// world is built and the models are loaded, each car is put down out past the
// edge of the map, rendered side-on into the card's own strip, and kept as a
// JPEG in localStorage. The menu draws whatever is in there. Nothing is
// committed to the repo, so a new model cannot leave a stale picture behind --
// change the .glb and the next run re-takes the photograph.
//
// It costs three renders at a moment when the boot screen is still up, and
// about 20 KB of localStorage.

import * as THREE from 'three';

const KEY = 'pc.cards';
/** Bumped when the framing changes, to retake pictures that are still fine. */
const VERSION = 1;
/** The card's canvas: 620 x 168 backing pixels for a 310 px wide card. */
const W = 620, H = 168;

/** The pictures taken last time, as { runner: dataUrl, ... }. */
export function carCards() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const saved = JSON.parse(raw);
    return saved && saved.v === VERSION && saved.cars ? saved.cars : {};
  } catch (e) {
    return {};                      // storage blocked, or something else's key
  }
}

/**
 * Photograph the cars, unless it has already been done.
 *
 * Deliberately quiet: every failure here -- no WebGL context to spare, storage
 * full, a car that will not build -- leaves the menu drawing its schematic,
 * which is what it did before any of this existed.
 */
export function takeCarCards(game, kinds = ['runner', 'supercar', 'offroad']) {
  const have = carCards();
  if (kinds.every((k) => have[k])) return false;

  const scene = game.scene;
  const keepBg = scene.background, keepFog = scene.fog;
  let renderer = null;
  const cars = Object.assign({}, have);
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(1);
    renderer.setSize(W, H, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    // The card's own background, and no fog: the car is a few metres from the
    // lens and fog is for a city.
    scene.background = new THREE.Color(0x0d1116);
    scene.fog = null;

    for (const kind of kinds) {
      if (cars[kind]) continue;
      cars[kind] = shoot(game, renderer, kind);
    }
    localStorage.setItem(KEY, JSON.stringify({ v: VERSION, cars }));
    return true;
  } catch (e) {
    return false;
  } finally {
    scene.background = keepBg;
    scene.fog = keepFog;
    if (renderer) renderer.dispose();
  }
}

function shoot(game, renderer, kind) {
  const v = game.createVehicle(kind, kind, { x: 1040, y: 0.9, z: -420 }, 0, {});
  try {
    v.setVelocity({ x: 0, y: 0, z: 0 });
    // Settle it on its springs, so it sits at the height it really sits at and
    // the wheels are where the game puts them.
    for (let i = 0; i < 90; i++) {
      v.setControls({ throttle: 0, brake: 1, steer: 0, handbrake: 1 });
      game.stepHeadless(1 / 120);
    }
    // The drawn car follows the physics one in _render, not in the step, so
    // ask for a frame before measuring where it is. Without this the body is
    // still at the origin, in the middle of the city, with a patrol car parked
    // in front of the lens.
    game._render(1 / 60);
    v.view.updateMatrixWorld(true);

    // Nothing but the car. The world has to stay in the scene -- the wheels
    // are one instanced mesh shared by every vehicle in it -- so everything
    // else is hidden for the length of one frame and put back.
    const hidden = [];
    for (const o of game.scene.children) {
      if (o === v.view || o === game.wheelMesh || o.isLight) continue;
      if (o.visible) { hidden.push(o); o.visible = false; }
    }

    const box = new THREE.Box3().setFromObject(v.view);
    const centre = new THREE.Vector3();
    box.getCenter(centre);
    const size = new THREE.Vector3();
    box.getSize(size);
    const cam = new THREE.PerspectiveCamera(22, W / H, 0.5, 300);

    // Framed by measurement rather than by trigonometry: put the camera on the
    // viewing line, project the corners of the car's box, and move it out until
    // the widest of them sits just inside the frame. It does not care what
    // shape the car is, which matters -- one of the three is a foot taller.
    const dir = new THREE.Vector3(-0.97, 0.17, 0.22).normalize();
    const corners = [];
    for (const x of [box.min.x, box.max.x]) {
      for (const y of [box.min.y, box.max.y]) {
        for (const z of [box.min.z, box.max.z]) corners.push(new THREE.Vector3(x, y, z));
      }
    }
    let dist = size.length() * 1.6;
    for (let pass = 0; pass < 4; pass++) {
      cam.position.copy(centre).addScaledVector(dir, dist);
      cam.lookAt(centre);
      cam.updateMatrixWorld(true);
      cam.updateProjectionMatrix();
      let worst = 0;
      for (const c of corners) {
        const q = c.clone().project(cam);
        worst = Math.max(worst, Math.abs(q.x), Math.abs(q.y));
      }
      dist *= worst / 0.95;          // a twentieth of the frame as air
    }
    cam.position.copy(centre).addScaledVector(dir, dist);
    cam.lookAt(centre);

    renderer.render(game.scene, cam);
    for (const o of hidden) o.visible = true;

    // JPEG: nothing here needs transparency, the background is the card's own
    // colour, and it is about 7 KB rather than 150.
    return renderer.domElement.toDataURL('image/jpeg', 0.84);
  } finally {
    game.removeVehicle(v);
  }
}
