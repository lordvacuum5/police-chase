// How long the graphics chip takes to draw a frame, from the chip's own clock.
//
// Timing a frame with performance.now() round a render and a one-pixel readback swung 14-98 ms from one
// turn to the next on this laptop, far more than anything being compared. The GPU's timer query
// (EXT_disjoint_timer_query_webgl2) times only the drawing, and held to about a millisecond.
//
//   const m = await import('/tests/gputime.js');  await m.gpuTime(40)
//   await m.atWood()   // Haldon Vale: the car put 75 m short of the wood tests/hillwall.js drove into, facing it
//
//   gpuMed, gpuMin   ms of drawing a frame, the median and the least of `n`
//   cpuMed           ms the render call itself took on the main thread
export async function gpuTime(n = 40) {
  const g = window.__game, R = g.renderer, gl = R.getContext();
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  if (!ext) return 'no timer query in this browser';
  const was = g.paused;
  g.paused = true;
  const qs = [], cpu = [];
  for (let i = 0; i < n; i++) {
    const q = gl.createQuery();
    gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
    const t0 = performance.now();
    R.render(g.scene, g.camera);
    cpu.push(performance.now() - t0);
    gl.endQuery(ext.TIME_ELAPSED_EXT);
    qs.push(q);
    await new Promise((r) => setTimeout(r, 0));
  }
  const res = [];
  for (const q of qs) {
    for (let k = 0; k < 200 && !gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE); k++) await new Promise((r) => setTimeout(r, 5));
    if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) res.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);
    gl.deleteQuery(q);
  }
  g.paused = was;
  const med = (a) => { const s = a.slice().sort((x, y) => x - y); return +s[Math.floor(s.length / 2)].toFixed(2); };
  return { gpuMed: med(res), gpuMin: +Math.min(...res).toFixed(2), cpuMed: med(cpu), n: res.length };
}

export async function atWood() {
  const g = window.__game, v = g.player;
  const tx = 32.66, tz = 478.21, ux = 0.84, uz = 0.55;
  const sx = tx - ux * 75, sz = tz - uz * 75;
  v.teleport({ x: sx, y: g.sim.heightAt(sx, sz) + 0.9, z: sz }, Math.atan2(ux, uz));
  v.setVelocity({ x: 0, y: 0, z: 0 });
  for (let i = 0; i < 20; i++) g.stepHeadless(1 / 60, { throttle: 0, brake: 1, steer: 0, handbrake: 1 });
  if (g.camera3 && g.camera3.snapTo) g.camera3.snapTo(v);
  await new Promise((r) => setTimeout(r, 300));
}
