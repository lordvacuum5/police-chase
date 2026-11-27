// Photographs of the maps, for the menu's cards.
//
// "Update the look of the maps on the menu, because obviously they're pretty out of date." The cards were drawings made by
// hand (core/menu.js drawCity, drawTown, drawCountry), and the maps have been rebuilt under them: Wexbury is a 3 km town
// with a river and a railway now, and its card still showed the old one. So, as the cars' cards are (game/cards.js), the
// game takes the picture itself: each time a map is loaded, one frame from high over it, with the main renderer -- whose
// shaders are already made, so it costs one render, not the seconds a second renderer took -- kept as a JPEG in
// localStorage. Taken every load, so it is never out of date. A map never loaded keeps its drawing.

import * as THREE from 'three';

const KEY = 'pc.mapshots';
/** Bumped when the framing changes, to drop pictures taken the old way. */
const VERSION = 1;
/** The card's canvas (core/menu.js buildMaps). */
const W = 620, H = 300;

/**
 * Where each map is looked at from: the camera's place and the point it looks at, as fractions of the map's half width (and
 * metres up). Ashfield: downtown's towers and the river from over the motorway. Wexbury: the market square and the old town
 * with the river beyond. Haldon: over the vale to the hills.
 */
const VIEWS = {
  city: { from: [-0.42, 330, 0.55], at: [0.02, 0, -0.05] },
  wexbury: { from: [-0.3, 230, 0.42], at: [0.02, 0, -0.06] },
  haldon: { from: [-0.55, 260, 0.6], at: [0.05, 0, -0.1] },
};
const DEFAULT_VIEW = { from: [-0.4, 280, 0.5], at: [0, 0, 0] };

/** The pictures taken so far, as { mapId: dataUrl }. */
export function mapShots() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const saved = JSON.parse(raw);
    return saved && saved.v === VERSION && saved.maps ? saved.maps : {};
  } catch (e) {
    return {};
  }
}

/** Photograph the map `game` has loaded and keep it. Quiet: any failure leaves the card as it was. */
export function takeMapShot(game) {
  const r = game.renderer, scene = game.scene, def = game.mapDef;
  if (!r || !scene || !def) return false;
  const fog = scene.fog, keepFog = fog && { near: fog.near, far: fog.far };
  // Everything, not what the fog culling has hidden round where the player is (Game._gatherFogCull).
  const hidden = (game._fogMeshes || []).filter((f) => !f.o.visible);
  try {
    const half = def.half || 1000, v = VIEWS[def.id] || DEFAULT_VIEW;
    const src = r.domElement;
    const cam = new THREE.PerspectiveCamera(38, src.width / Math.max(1, src.height), 2, half * 6);
    const gy = (x, z) => (game.groundAt ? game.groundAt(x, z) : 0);
    const fx = v.from[0] * half, fz = v.from[2] * half, ax = v.at[0] * half, az = v.at[2] * half;
    cam.position.set(fx, gy(fx, fz) + v.from[1], fz);
    cam.lookAt(ax, gy(ax, az), az);
    cam.updateMatrixWorld(true);
    if (fog) { fog.near = half * 2.2; fog.far = half * 6; }
    for (const f of hidden) f.o.visible = true;
    r.render(scene, cam);
    // Read in the same task as the render: the drawing buffer is not kept past it.
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    let cw = src.width, ch = (src.width * H) / W;
    if (ch > src.height) { ch = src.height; cw = (src.height * W) / H; }
    c.getContext('2d').drawImage(src, (src.width - cw) / 2, (src.height - ch) / 2, cw, ch, 0, 0, W, H);
    const all = mapShots();
    all[def.id] = c.toDataURL('image/jpeg', 0.82);
    localStorage.setItem(KEY, JSON.stringify({ v: VERSION, maps: all }));
    return true;
  } catch (e) {
    return false;
  } finally {
    if (fog) { fog.near = keepFog.near; fog.far = keepFog.far; }
    for (const f of hidden) f.o.visible = false;
  }
}
