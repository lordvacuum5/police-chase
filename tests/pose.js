// Browser-side helper: parks one car on a long straight and photographs it
// from four angles. Injected by the shot rig; not part of the game.
window.__shoot = async function (name, pos, look, W, H) {
  const g = window.__game, r = g.renderer, cam = g.camera;
  W = W || 1280; H = H || 720;
  r.setSize(W, H, false); cam.aspect = W / H; cam.updateProjectionMatrix();
  cam.position.set(pos[0], pos[1], pos[2]); cam.lookAt(look[0], look[1], look[2]);
  cam.updateMatrixWorld(true);
  r.setRenderTarget(null); r.render(g.scene, cam);
  const d = r.domElement.toDataURL('image/jpeg', 0.92);
  const res = await fetch('/__shot?name=' + name, { method: 'POST', body: d });
  return d.length + ':' + res.status;
};

window.__pose = async function (prefix, specKey, opts, views) {
  const g = window.__game, gr = g.graph, p = g.player;
  let best = null;
  for (const ed of gr.edges) {
    if (ed.width < 14 || ed.length < 110) continue;
    if (!best || ed.length > best.length) best = ed;
  }
  const s = gr.pointAt(best, 30), h = Math.atan2(s.tx, s.tz);
  p.teleport({ x: s.x - 40, y: 0.95, z: s.z }, h); p.setVelocity({ x: 0, y: 0, z: 0 });
  const v = g.createVehicle(specKey, specKey, { x: s.x, y: 0.95, z: s.z }, h, opts || {});
  for (let i = 0; i < 40; i++) {
    g.stepHeadless(1 / 60, { throttle: 0, brake: 1, steer: 0, handbrake: 1 });
  }
  g._render(1 / 60);
  const c = v.position, fx = Math.sin(h), fz = Math.cos(h), rx = fz, rz = -fx;
  const out = [];
  const want = views || ['34', 'side', 'nose', 'tail'];
  const cams = {
    '34':   [[c.x + fx * 6.0 + rx * 4.2, 1.95, c.z + fz * 6.0 + rz * 4.2], [c.x, 0.60, c.z]],
    'side': [[c.x + rx * 7.5, 1.30, c.z + rz * 7.5], [c.x, 0.62, c.z]],
    'nose': [[c.x + fx * 6.2, 1.15, c.z + fz * 6.2], [c.x, 0.64, c.z]],
    'tail': [[c.x - fx * 6.2, 1.15, c.z - fz * 6.2], [c.x, 0.64, c.z]],
    'r34':  [[c.x - fx * 6.0 + rx * 4.2, 1.95, c.z - fz * 6.0 + rz * 4.2], [c.x, 0.60, c.z]],
    'top':  [[c.x + fx * 3.0, 5.2, c.z + fz * 3.0], [c.x, 0.60, c.z]],
  };
  for (const k of want) out.push(await window.__shoot(prefix + '_' + k, cams[k][0], cams[k][1]));
  return out.join(' ');
};
'pose ready';

/** Dismiss the map chooser, if it is up, by picking the first map. */
window.__start = function (which) {
  const card = document.querySelectorAll(".mapcard")[which || 0];
  if (card) card.click();
  return !!card;
};

/**
 * Skip the map chooser. main.js reads sessionStorage["pc.map"] before it
 * decides whether to show the menu, so setting it and reloading lands
 * straight in the world.
 */
window.__pickMap = function (id) {
  sessionStorage.setItem("pc.map", id);
  location.reload();
};
