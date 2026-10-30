// Do cars appear where the player can see them?
//
// "I think you think that I can't see over hedges. And I can. So you just
// keep on spawning cars almost right in front of me, but I can just see over
// the hedge." Drives the player down the roads (as tests/trafficseen.js) and,
// the moment each traffic car is made, asks whether it could be seen -- from
// the camera or from the driving seat, with nothing but buildings, trees and
// the hills in the way, which is what a player actually sees past.
//
// `old`: spawn under the rule as it was, hedges hiding a spot, to compare.
//
// window.__runSpawnSight(seconds, old) -> window.__res

window.__runSpawnSight = async function (seconds = 120, old = false) {
  for (let i = 0; i < 200 && !(window.__game && window.__game.player); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const g = window.__game, gr = g.graph, p = g.player;
  const { hasLineOfSight, groups, GROUP } = await import('/src/physics/world.js');
  const THREE = window.__modules.THREE;
  g.heat.value = 0;
  g.onBusted = () => { g.outcome = null; };
  const HONEST = groups(0xFFFF, GROUP.BUILDING | GROUP.PROP | GROUP.HILL);
  const OLD = groups(0xFFFF, GROUP.BUILDING | GROUP.PROP | GROUP.HEDGE | GROUP.HILL);
  const eye = new THREE.Vector3(), at = new THREE.Vector3();
  const frustum = new THREE.Frustum(), mat = new THREE.Matrix4(), sphere = new THREE.Sphere();
  const sees = (mask, pos) => {
    at.set(pos.x, g.groundAt(pos.x, pos.z) + 1.2, pos.z);
    const cam = g.camera;
    cam.updateMatrixWorld(true);
    const d = cam.position.distanceTo(at);
    if (d < 700) {
      mat.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
      frustum.setFromProjectionMatrix(mat);
      sphere.center.copy(at); sphere.radius = 4 + d * 0.2;
      if (frustum.intersectsSphere(sphere) && hasLineOfSight(g.world, eye.copy(cam.position), at, 0.3, mask)) return true;
    }
    const me = p.position;
    if (Math.hypot(me.x - pos.x, me.z - pos.z) < 600) {
      eye.set(me.x, me.y + 1.3, me.z);
      if (hasLineOfSight(g.world, eye, at, 0.3, mask)) return true;
    }
    return false;
  };
  const keep = g.seenByAnyone;
  if (old) g.seenByAnyone = (pos) => g.nearHuman(pos) || sees(OLD, pos);
  let made = 0, seen = 0;
  const T = g.traffic, spawn = T._spawn.bind(T);
  T._spawn = (w, n) => {
    const before = T.cars.length;
    spawn(w, n);
    if (T.cars.length > before) {
      made++;
      if (sees(HONEST, T.cars[T.cars.length - 1].v.position)) seen++;
    }
  };
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const pick = () => {
    const ns = gr.nodes.filter((n) => n.edges.length >= 2);
    const n = ns[Math.floor(rnd() * ns.length)];
    const a = rnd() * Math.PI * 2;
    return { x: n.x, z: n.z, dx: Math.sin(a), dz: Math.cos(a) };
  };
  let here = pick();
  for (let i = 0; i < seconds * 60; i++) {
    g.heat.value = 0;
    let next = gr.walkAhead(here.x, here.z, here.dx, here.dz, 18 / 60);
    if (!next || Math.hypot(next.x - here.x, next.z - here.z) < 0.05) next = pick();
    here = next;
    p.teleport({ x: here.x, y: g.groundAt(here.x, here.z) + 0.6, z: here.z }, Math.atan2(here.dx, here.dz));
    p.setVelocity({ x: here.dx * 18, y: 0, z: here.dz * 18 });
    g._update(1 / 60);
    g.camera3.update(1 / 60, p, 0);
  }
  T._spawn = spawn;
  g.seenByAnyone = keep;
  window.__res = `${g.mapDef.id} ${old ? 'old rule (hedges hide)' : 'new rule'} ${seconds}s: `
    + `traffic made ${made}, in plain sight when made ${seen} (${(100 * seen / Math.max(1, made)).toFixed(0)}%), cars ${T.cars.length}`;
  return window.__res;
};
