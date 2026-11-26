// Civilian cars as the host of a multiplayer game sees them. "Lots of civilian cars are really, really laggy on the host's end."
//   const m = await import('/tests/hostjudder.js');  await m.hostJudder({ secs: 20, other: true })      // window.__hj
// The player driven down the roads at 60 km/h with the camera behind, as a real frame is made (Game._update and _render, 1/60), with
// `other` a second player 500 m off as a guest's car is to the host (Game.humanPositions). For every civilian car within 120 m of the
// camera and drawn, frame on frame: how far it moved against how far it moved the frame before (jerk, m: 0 for a car going steadily,
// a jump of a frame's travel is about 0.3 at 60 km/h); and the frame's own cost, ms.
const breathe = () => new Promise((r) => { const c = new MessageChannel(); c.port1.onmessage = () => { c.port1.close(); r(); }; c.port2.postMessage(0); });

export async function hostJudder(opts = {}) {
  const g = window.__game, gr = g.graph, p = g.player, { Driver, SKILL } = window.__modules;
  g.paused = true;
  g.onBusted = () => { g.outcome = null; };
  const was = g.humanPositions;
  const far = { x: p.position.x + 500, y: p.position.y, z: p.position.z + 60 };
  if (opts.other) g.humanPositions = function () { return [far]; };
  let seed = 99, drv = null;
  const rng = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return ((seed >>> 0) % 1e6) / 1e6; };
  const hist = new Map(), jerks = [], cost = [];
  let jumps = 0, n = 0, awake = 0, glide = 0, half = 0;
  try {
    for (let t = 0; t < (opts.secs || 20) * 60; t++) {
      if (!drv || !drv.hasPath || drv.remaining(20) < 20) {
        for (let k = 0; k < 40; k++) {
          const a = gr.nearestNode(p.position.x, p.position.z, p.position.y), b = gr.randomNode(rng, 'street'), path = a && b && gr.route(a.id, b.id);
          if (path && path.length > 6) { drv = new Driver(p, SKILL.regular); drv.setPath(gr.pathToPoints(path, 2.5, true)); break; }
        }
      }
      g.forceControls = drv.followPath(1 / 60, 17);
      const c = g.camera, f = p.forward;
      const t0 = performance.now();
      g._update(1 / 60);
      c.position.set(p.position.x - f.x * 9, p.position.y + 3.5, p.position.z - f.z * 9);
      c.lookAt(p.position.x + f.x * 12, p.position.y + 1, p.position.z + f.z * 12);
      c.updateMatrixWorld(true);
      const R = g.renderer.render; g.renderer.render = () => {}; g._render(1 / 60); g.renderer.render = R;
      if (t > 120) cost.push(performance.now() - t0);
      for (const q of g.traffic.cars) {
        const v = q.v, vp = v.view.position;
        if (!v.view.visible || vp.distanceTo(c.position) > 120) { hist.delete(v); continue; }
        const h = hist.get(v);
        if (h && h.length === 2 && t > 120) {
          const ax = vp.x - 2 * h[1].x + h[0].x, az = vp.z - 2 * h[1].z + h[0].z, ay = vp.y - 2 * h[1].y + h[0].y, j = Math.hypot(ax, ay, az);
          jerks.push(j); n++;
          if (j > 0.15) jumps++;
          if (v.dormant) glide++; else awake++;
          if (v._half) half++;
        }
        const s = { x: vp.x, y: vp.y, z: vp.z };
        hist.set(v, h ? [h[h.length - 1], s] : [s]);
      }
      if (t % 30 === 0) await breathe();
    }
  } finally { g.humanPositions = was; g.forceControls = null; }
  jerks.sort((a, b) => a - b); cost.sort((a, b) => a - b);
  const q = (a, f) => +(a[Math.floor(f * (a.length - 1))] || 0).toFixed(3);
  return (window.__hj = { other: !!opts.other, looks: n, jerkMedian: q(jerks, 0.5), jerk95: q(jerks, 0.95), jerkMax: q(jerks, 1), jumps, glide, awake, half, frameMs: q(cost, 0.5), frame95: q(cost, 0.95), cars: g.traffic.cars.length });
}
