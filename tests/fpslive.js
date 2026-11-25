// The game as played, as fast as it goes: ms between frames, and how much of it is the simulation and how much the drawing.
//   const m = await import('/tests/fpslive.js');  await m.fpsLive()      // window.__fl
// From the same three places as simcost.js, driven along at the size of the window (`w`, `h` to set one). The frames are the
// rig's own, one straight after another: a page not in view is given none.
import { places } from './drawcost.js';
// Straight back, not after the 4 ms a timer waits.
const chan = new MessageChannel(), queue = [];
chan.port1.onmessage = () => queue.shift()();
const breathe = () => new Promise((r) => { queue.push(r); chan.port2.postMessage(0); });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export async function fpsLive(opts = {}) {
  const g = window.__game, R = g.renderer, out = window.__fl = {};
  if (opts.w) { R.setPixelRatio(1); R.setSize(opts.w, opts.h, false); g.camera.aspect = opts.w / opts.h; g.camera.updateProjectionMatrix(); }
  const track = g._trackPerformance;
  g._trackPerformance = () => {};
  let up = 0, dr = 0;
  const U = g._update, D = g._render;
  g._update = function (...a) { const t = performance.now(); const r = U.apply(this, a); up += performance.now() - t; return r; };
  g._render = function (...a) { const t = performance.now(); const r = D.apply(this, a); dr += performance.now() - t; return r; };
  const P = places();
  try {
    for (const [name, stars, key] of [['motorway', 0, 'motorway'], ['street', 0, 'downtown'], ['street5', 5, 'downtown']]) {
      if (opts.only && !opts.only.includes(name)) continue;
      const v = P[key];
      g.paused = true;
      g.player.repair();
      g.player.teleport({ x: v[0], y: v[1] - 2, z: v[2] }, Math.atan2(v[3], v[4]));
      g.forceControls = { throttle: 0.35, brake: 0, steer: 0, handbrake: 0 };
      for (let k = 0; k < (stars ? 60 : 24); k++) { if (stars) g.heat.value = stars; g.stepHeadless(0.25, g.forceControls); if (k % 4 === 0) await wait(0); }
      // Everything handed to the graphics card first (Game._warmStep), which a player's first seconds pay for.
      for (let k = 0; k < 400 && g._warmQueue && g._warmQueue.length; k++) { g._render(0.016); await wait(0); }
      for (let k = 0; k < 40; k++) { g._render(0.016); await wait(0); }
      up = dr = 0;
      const gaps = [], gl = R.getContext(), fences = [];
      const until = performance.now() + (opts.secs || 10) * 1000;
      let last = performance.now();
      while (performance.now() < until) {
        if (stars) g.heat.value = stars;
        const dt = Math.min(0.05, Math.max(0.008, (gaps[gaps.length - 1] || 16) / 1000));
        g._update(dt);
        g._render(dt);
        // Two frames on their way to the screen at most, as a browser allows.
        fences.push(gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0));
        gl.flush();
        do { await breathe(); } while (fences.length > 1 && gl.getSyncParameter(fences[0], gl.SYNC_STATUS) !== gl.SIGNALED);
        while (fences.length > 1) gl.deleteSync(fences.shift());
        const n = performance.now();
        gaps.push(n - last);
        last = n;
      }
      for (const f of fences) gl.deleteSync(f);
      const s = gaps.slice(2).sort((a, b) => a - b), q = (f) => +s[Math.floor(f * (s.length - 1))].toFixed(1);
      out[name] = { frames: s.length, fps: +(1000 / (s.reduce((a, b) => a + b, 0) / s.length)).toFixed(1), median: q(0.5), p95: q(0.95), worst: q(1), sim: +(up / gaps.length).toFixed(1), draw: +(dr / gaps.length).toFixed(1), size: [R.domElement.width, R.domElement.height], tris: Math.round(R.info.render.triangles / 1000), calls: R.info.render.calls, cars: g.vehicles.length };
      g.heat.value = 0;
      g.outcome = null;
    }
  } finally {
    g._update = U; g._render = D; g._trackPerformance = track; g.forceControls = null;
  }
  out.done = true;
  return out;
}
