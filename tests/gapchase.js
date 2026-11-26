// Police after a car cutting between houses. "If I'm just going through a few buildings, they ... stop a lot and then have to back
// out their situation and then go again."
//   const m = await import('/tests/gapchase.js');  await m.gapChase({ secs: 90 })      // window.__gc
// The player's car carried at `kmh` back and forth along straight lines off the road between houses: from a street, across the
// gardens through a gap no narrower than 6 m, to the next street, and back by the road. Three stars. For every chasing unit within
// 90 m, each tenth of a second: stopped (under 1 m/s), reversing, which planner mode; and how far behind the nearest is.
import { boxesNear } from '../src/ai/localplan.js';
// What is solid near (x, z), as the planner sees it (physics/world.js's own lookup is let go once the map is built).
function solidNear(g, x, z, r) {
  for (const b of boxesNear(g, x, z, r)) {
    const dx = x - b.x, dz = z - b.z;
    const lx = Math.abs(dx * b.c - dz * b.s) - b.hx, lz = Math.abs(dx * b.s + dz * b.c) - b.hz;
    if (Math.hypot(Math.max(lx, 0), Math.max(lz, 0)) < r) return true;
  }
  return false;
}
const breathe = () => new Promise((r) => setTimeout(r));

export async function gapChase(opts = {}) {
  for (let i = 0; i < 600 && !(window.__game && window.__game.player); i++) await new Promise((r) => setTimeout(r, 100));
  const g = window.__game, gr = g.graph, p = g.player;
  g.paused = true;
  g.onBusted = () => { g.outcome = null; g.heat.bustTimer = 0; };
  g.heat._checkBust = () => {};
  g.heat.bump(1, 'a probe');
  // Lines across the blocks: from a point on a street out at right angles, clear of buildings by 3 m all the way, passing within
  // 7 m of one (between houses), ending on another road.
  let seed = opts.seed || 5;
  const rng = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return ((seed >>> 0) % 1e6) / 1e6; };
  const lines = [];
  const streets = gr.edges.filter((e) => !e.dead && (e.kind === 'street' || e.kind === 'lane') && e.length > 60);
  for (let k = 0; k < 4000 && lines.length < 12; k++) {
    const e = streets[Math.floor(rng() * streets.length)], q = gr.pointAt(e, e.length * (0.2 + rng() * 0.6)), side = rng() < 0.5 ? 1 : -1;
    const nx = -q.tz * side, nz = q.tx * side;
    let ok = true, close = false, end = null;
    for (let d = e.width * 0.5 + 8; d < 240; d += 2) {
      const x = q.x + nx * d, z = q.z + nz * d;
      if (solidNear(g, x, z, 2)) { ok = false; break; }
      if (solidNear(g, x, z, 9)) close = true;
      const r = gr.nearestEdge(x, z, 8);
      if (d > 30 && r && r.edge !== e && r.dist < r.edge.width * 0.5 + 2) { end = { x, z }; break; }
    }
    if (ok && close && end) lines.push({ a: { x: q.x, z: q.z }, b: end });
  }
  const out = window.__gc = { lines: lines.length, samples: 0, stopped: 0, reversing: 0, modes: {}, revModes: {}, behind: [] };
  if (!lines.length) { out.done = true; return out; }
  const speed = (opts.kmh || 45) / 3.6;
  let li = 0, t01 = 0, dir = 1;
  for (let t = 0; t < (opts.secs || 90) * 60; t++) {
    g.heat.value = (opts.star || 3) + 0.05;
    const L = lines[li], len = Math.hypot(L.b.x - L.a.x, L.b.z - L.a.z);
    t01 += (speed / 60 / len) * dir;
    if (t01 >= 1 || t01 <= 0) { dir = -dir; t01 = Math.min(1, Math.max(0, t01)); if (dir > 0) li = (li + 1) % lines.length; }
    const x = L.a.x + (L.b.x - L.a.x) * t01, z = L.a.z + (L.b.z - L.a.z) * t01;
    const hx = (L.b.x - L.a.x) / len * dir, hz = (L.b.z - L.a.z) / len * dir;
    p.body.setTranslation({ x, y: g.sim.heightAt(x, z) + 0.55, z }, true);
    const h = Math.atan2(hx, hz) / 2;
    p.body.setRotation({ x: 0, y: Math.sin(h), z: 0, w: Math.cos(h) }, true);
    p._readState();
    p.setVelocity({ x: hx * speed, y: 0, z: hz * speed });
    p._readState();
    const c = g.camera;
    c.position.set(x - hx * 8, g.sim.heightAt(x, z) + 3, z - hz * 8); c.lookAt(x, g.sim.heightAt(x, z) + 1, z); c.updateMatrixWorld(true);
    g.stepHeadless(1 / 60, { throttle: 0, brake: 0, steer: 0, handbrake: 0 });
    if (t < 600 || t % 6) continue;
    let best = Infinity;
    for (const u of g.dispatcher.units) {
      const v = u.vehicle;
      if (v.disabled || u.role === 'patrol' || u.role === 'hold') continue;
      const d = Math.hypot(v.position.x - x, v.position.z - z);
      best = Math.min(best, d);
      if (d > 90) continue;
      out.samples++;
      if (v.speed < 1) out.stopped++;
      if (v.forwardSpeed < -0.5) { out.reversing++; const k = (u._mode || 'none') + (u.driver.reverseTimer > 0 ? '+unstick' : ''); out.revModes[k] = (out.revModes[k] || 0) + 1; }
      out.modes[u._mode || 'none'] = (out.modes[u._mode || 'none'] || 0) + 1;
    }
    if (Number.isFinite(best)) out.behind.push(best);
    if (t % 120 === 0) await breathe();
  }
  const b = out.behind.sort((a, c) => a - c);
  out.behind = { median: Math.round(b[Math.floor(b.length / 2)] || 0), p90: Math.round(b[Math.floor(b.length * 0.9)] || 0) };
  out.stoppedShare = +(out.stopped / (out.samples || 1)).toFixed(3);
  out.reversingShare = +(out.reversing / (out.samples || 1)).toFixed(3);
  out.done = true;
  return out;
}
