// Civilian cars in heaps on the ramps, and coming at you from everywhere at the junctions.
// "The civilian cars seem to spawn a lot on the on ramps, and there's so many that they were almost on top. Some of them were on top of
// each other ... It almost feels intentional ... it needs to be a bit more natural."
//   const m = await import('/tests/crowds.js');  await m.crowds({ secs: 90 })      // window.__cr
// The player carried along the streets and up and down the ramps at `kmh` (nobody wanted). Each half second: civilian cars on top of
// one another (within 3.5 m, at one level), the most on any one ramp, and how many are within 60 m of the player, and of those how many
// are coming at them from a side road (heading across theirs). Made: how many new ones came within 120 m of the player.
const breathe = () => new Promise((r) => { const c = new MessageChannel(); c.port1.onmessage = () => { c.port1.close(); r(); }; c.port2.postMessage(0); });

export async function crowds(opts = {}) {
  for (let i = 0; i < 600 && !(window.__game && window.__game.dispatcher); i++) await new Promise((r) => setTimeout(r, 100));
  const g = window.__game, gr = g.graph, p = g.player;
  g.paused = true;
  g.onBusted = () => { g.outcome = null; };
  for (const u of g.dispatcher.units.slice()) g.dispatcher.retire(u);
  g.dispatcher.update = () => {};
  // As many as a machine that has not had to shed any: the pane's frame rate had cut this to 14 and the traffic to half.
  { const lim = opts.limit || 40; Object.defineProperty(g, 'vehicleLimit', { get: () => lim, set: () => {}, configurable: true }); }
  let seed = opts.seed || 99;
  const rng = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return ((seed >>> 0) % 1e6) / 1e6; };
  const ramps = gr.edges.filter((e) => e.kind === 'ramp');
  const rampNodes = [...new Set(ramps.flatMap((e) => [e.a, e.b]))];
  let pts = null, at = 0, px = p.position.x, pz = p.position.z, py = p.position.y, leg = 0;
  const speed = (opts.kmh || 60) / 3.6;
  const route = () => {
    for (let k = 0; k < 80; k++) {
      const a = gr.nearestNode(px, pz, py);
      // Every other leg to a ramp's end, so the ramps get driven.
      const b = leg % 2 === 0 && rampNodes.length ? gr.nodes[rampNodes[Math.floor(rng() * rampNodes.length)]] : gr.randomNode(rng, 'street');
      const path = a && b && a.id !== b.id && gr.route(a.id, b.id);
      if (path && path.length > 3) { pts = gr.pathToPoints(path, 2.5, true); at = 0; leg++; return; }
    }
  };
  const levelAt = (q, x, z) => (q && q.edge && q.edge.deck ? gr.levelOn(q.edge, x, z) : g.sim.heightAt(x, z));
  const ride = (dt) => {
    if (!pts || at >= pts.length - 2) { route(); px = pts[0].x; pz = pts[0].z; }
    let left = speed * dt;
    while (left > 0 && at < pts.length - 2) {
      const q = pts[at + 1], d = Math.hypot(q.x - px, q.z - pz);
      if (d <= left) { px = q.x; pz = q.z; left -= d; at++; } else { px += (q.x - px) / d * left; pz += (q.z - pz) / d * left; left = 0; }
    }
    const q = pts[Math.min(at + 1, pts.length - 1)], d = Math.hypot(q.x - px, q.z - pz) || 1, hx = (q.x - px) / d, hz = (q.z - pz) / d;
    py = levelAt(pts[at], px, pz) + 0.55;
    p.body.setTranslation({ x: px, y: py, z: pz }, true);
    const h = Math.atan2(hx, hz) / 2;
    p.body.setRotation({ x: 0, y: Math.sin(h), z: 0, w: Math.cos(h) }, true);
    p._readState();
    p.setVelocity({ x: hx * speed, y: 0, z: hz * speed });
    p._readState();
    return pts[at] && pts[at].edge && pts[at].edge.kind === 'ramp';
  };
  p.meets(0);
  const out = window.__cr = { map: g.mapDef.id, samples: 0, overlaps: 0, worstOverlaps: 0, rampMost: 0, rampMean: 0, near: [], across: [], made: 0, madeNear: 0, onRampSecs: 0, nearOnRamp: [], kinds: {}, stopped: [] };
  const known = new Set(g.traffic.cars.map((c) => c.v));
  let rampSum = 0;
  const warm = (opts.warm ?? 20) * 60;
  for (let t = -warm; t < (opts.secs || 90) * 60; t++) {
    const c = g.camera, f = p.forward;
    c.position.set(p.position.x - f.x * 8, p.position.y + 3, p.position.z - f.z * 8);
    c.lookAt(p.position.x + f.x * 10, p.position.y + 1, p.position.z + f.z * 10);
    c.updateMatrixWorld(true);
    const onRamp = ride(1 / 60);
    g.stepHeadless(1 / 60, { throttle: 0, brake: 0, steer: 0, handbrake: 0 });
    if (t < 0) { for (const tc of g.traffic.cars) known.add(tc.v); if (t % 120 === 0) await breathe(); continue; }
    for (const tc of g.traffic.cars) {
      if (known.has(tc.v)) continue;
      known.add(tc.v); out.made++;
      if (Math.hypot(tc.v.position.x - p.position.x, tc.v.position.z - p.position.z) < 120) out.madeNear++;
    }
    if (t % 30) continue;
    out.samples++;
    if (onRamp) out.onRampSecs += 0.5;
    const cars = g.traffic.cars.map((tc) => tc.v);
    let ov = 0;
    for (let i = 0; i < cars.length; i++) for (let j = i + 1; j < cars.length; j++) {
      const a = cars[i].position, b = cars[j].position;
      if (Math.abs(a.x - b.x) < 3.5 && Math.abs(a.z - b.z) < 3.5 && Math.hypot(a.x - b.x, a.z - b.z) < 3.5 && Math.abs(a.y - b.y) < 2) {
        ov++;
        // Which: both far off and gliding, or one awake; the same way, or across one another; and near you.
        const k = `${cars[i].dormant && cars[j].dormant ? 'gliding' : 'awake'} ${Math.abs(cars[i].forward.dot(cars[j].forward)) > 0.7 ? 'along' : 'across'}${Math.hypot(a.x - p.position.x, a.z - p.position.z) < 150 ? ' near' : ''}`;
        out.kinds[k] = (out.kinds[k] || 0) + 1;
      }
    }
    out.overlaps += ov; out.worstOverlaps = Math.max(out.worstOverlaps, ov);
    const per = new Map();
    for (const tc of g.traffic.cars) {
      const d = tc.driver, q = d.path && d.path[Math.min(d.pathIndex, d.path.length - 1)];
      if (q && q.edge && q.edge.kind === 'ramp') per.set(q.edge, (per.get(q.edge) || 0) + 1);
    }
    const most = Math.max(0, ...per.values());
    out.rampMost = Math.max(out.rampMost, most); rampSum += most;
    let near = 0, across = 0;
    for (const v of cars) {
      const dx = v.position.x - p.position.x, dz = v.position.z - p.position.z, dd = Math.hypot(dx, dz);
      if (dd > 60 || Math.abs(v.position.y - p.position.y) > 4) continue;
      near++;
      if (Math.abs(v.forward.x * p.forward.x + v.forward.z * p.forward.z) < 0.5) across++;
    }
    out.near.push(near); out.across.push(across);
    out.stopped.push(g.traffic.cars.filter((tc) => !tc.v.dormant && tc.v.speed < 0.5 && !tc.pullFor && Math.hypot(tc.v.position.x - p.position.x, tc.v.position.z - p.position.z) < 150).length);
    if (onRamp) out.nearOnRamp.push(near);
    if (onRamp && near > (out.worst ? out.worst.length : 0)) {
      out.worst = g.traffic.cars.filter((tc) => Math.hypot(tc.v.position.x - p.position.x, tc.v.position.z - p.position.z) < 60).map((tc) => {
        const q = tc.driver.path && tc.driver.path[Math.min(tc.driver.pathIndex, tc.driver.path.length - 1)], gw = g.traffic._giveWay(tc);
        return [tc.id, tc.v.dormant ? 'z' : 'a', Math.round(tc.v.speed), q && q.edge ? q.edge.kind : '?', Number.isFinite(gw) ? +gw.toFixed(1) : '-', tc.driver.heldBy ? (tc.driver.heldBy.isTraffic ? 'T' : 'X') : '', Math.round(tc.v.position.y - p.position.y), Math.round((tc.v.position.x - p.position.x) * p.forward.x + (tc.v.position.z - p.position.z) * p.forward.z)];
      });
    }
    if (t % 120 === 0) await breathe();
  }
  const sum = (a) => { const s = a.slice().sort((x, y) => x - y); return { mean: +(a.reduce((x, y) => x + y, 0) / (a.length || 1)).toFixed(1), p95: s[Math.floor(s.length * 0.95)] || 0, max: s[s.length - 1] || 0 }; };
  out.rampMean = +(rampSum / out.samples).toFixed(1);
  out.near = sum(out.near); out.across = sum(out.across); out.nearOnRamp = sum(out.nearOnRamp); out.stopped = sum(out.stopped);
  out.overlapsPerMin = +(out.overlaps / (out.samples / 120)).toFixed(1);
  out.cars = g.traffic.cars.length;
  out.errors = g.updateErrors || 0;
  out.done = true;
  return out;
}
