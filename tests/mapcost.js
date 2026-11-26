// What a frame costs on the map that is loaded, at the same sort of places on any map: "Try to make sure it doesn't lag."
//   const m = await import('/tests/mapcost.js');  await m.mapCost()      // window.__mc
// At 1280x720, three stars, traffic about. In the middle of town on a street, out in the suburbs, and 120 m up over it all:
// a frame's simulation (stepHeadless, ms, mean of 120) and drawing (the render call on the main thread, ms, median of 30),
// and the triangles and draw calls in it.
const breathe = () => new Promise((r) => setTimeout(r));

export async function mapCost(opts = {}) {
  for (let i = 0; i < 600 && !(window.__game && window.__game.player); i++) await new Promise((r) => setTimeout(r, 100));
  const g = window.__game, R = g.renderer, G = g.graph, at = (x, z) => g.sim.terrainAt ? g.sim.terrainAt(x, z) : 0;
  g.paused = true;
  g.onBusted = () => { g.outcome = null; g.heat.bustTimer = 0; };
  R.setPixelRatio(1);
  R.setSize(1280, 720, false);
  g.camera.aspect = 1280 / 720;
  g.camera.updateProjectionMatrix();
  const st = G.edges.filter((e) => e.kind === 'street' && !e.dead && !e.elevated && e.length > 60);
  const near = (x, z) => st.map((e) => ({ e, p: G.pointAt(e, e.length / 2) })).sort((a, b) => Math.hypot(a.p.x - x, a.p.z - z) - Math.hypot(b.p.x - x, b.p.z - z))[0].p;
  const t = near(opts.tx ?? 120, opts.tz ?? 120), s = near(opts.sx ?? 650, opts.sz ?? 500);
  const P = { town: [t.x, at(t.x, t.z) + 3, t.z, t.tx, t.tz], suburb: [s.x, at(s.x, s.z) + 3, s.z, s.tx, s.tz], high: [-250, 140, -600, 0.5, 0.86] };
  const out = window.__mc = { map: g.mapDef.id };
  g.heat.bump(1, 'a probe');
  for (const [name, v] of Object.entries(P)) {
    const set = () => {
      const c = g.camera;
      c.position.set(v[0], v[1], v[2]);
      c.lookAt(v[0] + v[3] * 40, v[1] - (name === 'high' ? 14 : 1), v[2] + v[4] * 40);
      c.updateMatrixWorld(true);
    };
    g.player.teleport({ x: v[0] + v[3] * 8, y: at(v[0] + v[3] * 8, v[2] + v[4] * 8) + 1, z: v[2] + v[4] * 8 }, Math.atan2(v[3], v[4]));
    let sim = 0, n = 0;
    for (let k = 0; k < 240; k++) {
      g.heat.value = 3.05;
      const t0 = performance.now();
      g.stepHeadless(1 / 60, { throttle: 0, brake: 1, steer: 0, handbrake: 1 });
      if (k >= 120) { sim += performance.now() - t0; n++; }
      if (k % 20 === 0) await breathe();
    }
    set();
    g._fogTick = 14; if (g._fogCull) g._fogCull();
    const times = [];
    for (let k = 0; k < 30; k++) {
      set();
      const t0 = performance.now();
      R.render(g.scene, g.camera);
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    out[name] = { simMs: +(sim / n).toFixed(2), drawMs: +times[15].toFixed(2), tris: R.info.render.triangles, calls: R.info.render.calls, cars: g.vehicles.length };
    await breathe();
  }
  out.done = true;
  return out;
}
