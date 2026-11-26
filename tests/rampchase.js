// Do they follow you up a ramp, or drive about under it? "I was on a on ramp to the motorway, and they didn't seem to understand about
// going to. They were underneath me."
//   const m = await import('/tests/rampchase.js');  await m.rampChase({ star: 1, legs: 6, kmh: 70 })      // window.__rc
// Ashfield. For each leg: the player carried from a street 150-300 m off, up a ramp and on along the motorway for 15 s, two units put
// on its trail behind it at the start. While it is on the ramp or up on the deck, every tenth of a second, the nearest chasing unit:
//   up      on its level (within 2.5 m of its height)          under: below it by more than 3 m, within 40 m across
//   upAt    how many seconds after the player was up on the deck a unit was too (null: never, in the 15 s)
const breathe = () => new Promise((r) => { const c = new MessageChannel(); c.port1.onmessage = () => { c.port1.close(); r(); }; c.port2.postMessage(0); });

export async function rampChase(opts = {}) {
  for (let i = 0; i < 600 && !(window.__game && window.__game.dispatcher); i++) await new Promise((r) => setTimeout(r, 100));
  const g = window.__game, gr = g.graph, p = g.player;
  { const lim = 40; Object.defineProperty(g, 'vehicleLimit', { get: () => lim, set: () => {}, configurable: true }); }
  g.paused = true;
  g.onBusted = () => { g.outcome = null; g.heat.bustTimer = 0; };
  g.heat._checkBust = () => {};
  g.heat.bump(1, 'a probe');
  let seed = opts.seed || 4242;
  const rng = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return ((seed >>> 0) % 1e6) / 1e6; };
  const ramps = gr.edges.filter((e) => e.kind === 'ramp' && (gr.nodes[e.a].elevated !== gr.nodes[e.b].elevated));
  const speed = (opts.kmh || 70) / 3.6;
  const levelAt = (q, x, z) => (q && q.edge && q.edge.deck ? gr.levelOn(q.edge, x, z) : g.sim.heightAt(x, z));
  const ground = (x, z) => (g.sim.terrainAt ? g.sim.terrainAt(x, z) : g.groundAt(x, z));
  const out = window.__rc = { legs: [] };
  for (let leg = 0; leg < (opts.legs || 6); leg++) {
    // A ramp, its foot and top; a street node 150-300 m from the foot; the way there and up, and on.
    let pts = null;
    for (let k = 0; k < 200 && !pts; k++) {
      const e = ramps[Math.floor(rng() * ramps.length)], foot = gr.nodes[e.a].elevated ? e.b : e.a, top = e.a === foot ? e.b : e.a;
      const from = gr.nodes.filter((n) => !n.elevated && n.edges.length >= 3 && Math.hypot(n.x - gr.nodes[foot].x, n.z - gr.nodes[foot].z) > 150 && Math.hypot(n.x - gr.nodes[foot].x, n.z - gr.nodes[foot].z) < 300);
      if (!from.length) continue;
      const a = from[Math.floor(rng() * from.length)], path1 = gr.route(a.id, foot);
      const on = gr.nodes[top].edges.map((id) => gr.edges[id]).find((x) => x.kind !== 'ramp' && x.elevated);
      if (!path1 || !on || path1.includes(top)) continue;
      const path = [...path1, top, gr.other(on, top)];
      pts = gr.pathToPoints(path, 2.5, true);
    }
    if (!pts) break;
    // The way, with each point told its road and height as the traffic's are.
    pts = g.traffic._onItsRoads ? g.traffic._onItsRoads(pts, 0) : pts;
    for (const u of g.dispatcher.units.slice()) g.dispatcher.retire(u);
    let at = 0, px = pts[0].x, pz = pts[0].z;
    const trail = [];
    const r = { up: 0, under: 0, samples: 0, upAt: null };
    let upSince = null, t = 0, put = false;
    for (; t < 60 * 60; t++) {
      g.heat.value = (opts.star || 1) + 0.05;
      let left = speed / 60;
      while (left > 0 && at < pts.length - 1) {
        const q = pts[at + 1], d = Math.hypot(q.x - px, q.z - pz);
        if (d <= left) { px = q.x; pz = q.z; left -= d; at++; } else { px += (q.x - px) / d * left; pz += (q.z - pz) / d * left; left = 0; }
      }
      if (at >= pts.length - 1) break;
      const q = pts[Math.min(at + 1, pts.length - 1)], d = Math.hypot(q.x - px, q.z - pz) || 1, hx = (q.x - px) / d, hz = (q.z - pz) / d;
      const py = levelAt(pts[at], px, pz) + 0.55;
      p.body.setTranslation({ x: px, y: py, z: pz }, true);
      const h = Math.atan2(hx, hz) / 2;
      p.body.setRotation({ x: 0, y: Math.sin(h), z: 0, w: Math.cos(h) }, true);
      p._readState();
      p.setVelocity({ x: hx * speed, y: 0, z: hz * speed });
      p._readState();
      trail.push({ x: px, y: py, z: pz, h: Math.atan2(hx, hz) });
      const c = g.camera;
      c.position.set(px - hx * 8, py + 3, pz - hz * 8);
      c.lookAt(px + hx * 10, py + 1, pz + hz * 10);
      c.updateMatrixWorld(true);
      // Two units on its trail, 40 and 60 m back, once it has one that long.
      // Or, with `side`: beside the ramp, as it starts up it, on a street 25-70 m off across, facing it.
      const onRampNow = pts[at].edge && pts[at].edge.kind === 'ramp';
      if (opts.side && !put && onRampNow) {
        const chase = g.dispatcher.units.filter((u) => !u.vehicle.disabled && u.role !== 'patrol' && u.role !== 'hold');
        const spots = gr.nodes.filter((n) => !n.elevated && n.edges.length >= 2 && Math.hypot(n.x - px, n.z - pz) > 25 && Math.hypot(n.x - px, n.z - pz) < 70
          && Math.abs((n.x - px) * hz - (n.z - pz) * hx) > 20);
        for (const u of chase.slice(0, 2)) {
          const n = spots.length && spots[Math.floor(rng() * spots.length)];
          if (!n) break;
          const hd = Math.atan2(px - n.x, pz - n.z);
          u.vehicle.teleport({ x: n.x, y: g.sim.heightAt(n.x, n.z) + 0.6, z: n.z }, hd);
          u.vehicle._readState();
          u.vehicle.setVelocity({ x: Math.sin(hd) * 10, y: 0, z: Math.cos(hd) * 10 });
        }
        put = chase.length > 0;
      }
      if (!opts.side && !put && trail.length > 220) {
        const chase = g.dispatcher.units.filter((u) => !u.vehicle.disabled && u.role !== 'patrol' && u.role !== 'hold');
        let k = trail.length - 1, along = 0, next = 40;
        for (const u of chase.slice(0, 2)) {
          while (k > 0 && along < next) { along += Math.hypot(trail[k].x - trail[k - 1].x, trail[k].z - trail[k - 1].z); k--; }
          const s = trail[k];
          u.vehicle.teleport({ x: s.x, y: s.y + 0.1, z: s.z }, s.h);
          u.vehicle._readState();
          u.vehicle.setVelocity({ x: Math.sin(s.h) * speed, y: 0, z: Math.cos(s.h) * speed });
          next += 20;
        }
        put = chase.length > 0;
      }
      g.stepHeadless(1 / 60, { throttle: 0, brake: 0, steer: 0, handbrake: 0 });
      const e = pts[at].edge, raised = e && (e.kind === 'ramp' || e.elevated);
      const deck = py - ground(px, pz) > 4;
      if (deck && upSince === null) upSince = t;
      if (upSince !== null && t - upSince > 15 * 60) break;
      if (t % 6 || !raised || !put) continue;
      let best = null, bd = Infinity;
      for (const u of g.dispatcher.units) {
        if (u.vehicle.disabled || u.role === 'patrol' || u.role === 'hold') continue;
        const dd = Math.hypot(u.vehicle.position.x - px, u.vehicle.position.z - pz);
        if (dd < bd) { bd = dd; best = u; }
      }
      if (!best) continue;
      r.samples++;
      const dy = best.vehicle.position.y - py;
      if (Math.abs(dy) < 2.5) r.up++;
      else if (dy < -3 && bd < 40) r.under++;
      if (deck && r.upAt === null && best.vehicle.position.y - ground(best.vehicle.position.x, best.vehicle.position.z) > 4) r.upAt = +((t - upSince) / 60).toFixed(1);
      if (t % 120 === 0) await breathe();
    }
    const why = g.dispatcher.units.map((u) => [u.role, u._mode, Math.round(u.distanceTo(p.position)), +(u.vehicle.position.y - p.position.y).toFixed(1), Math.round(u.vehicle.speed * 3.6)]);
    out.legs.push({ why, up: +(r.up / (r.samples || 1)).toFixed(2), under: +(r.under / (r.samples || 1)).toFixed(2), upAt: r.upAt, samples: r.samples });
    await breathe();
  }
  const m = (k) => +(out.legs.reduce((a, l) => a + l[k], 0) / (out.legs.length || 1)).toFixed(2);
  out.up = m('up'); out.under = m('under'); out.reached = out.legs.filter((l) => l.upAt !== null).length;
  out.errors = g.updateErrors || 0;
  out.done = true;
  return out;
}
