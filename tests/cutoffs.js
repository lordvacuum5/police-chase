// Cut off from side roads, and stingers thrown from cars. "1, 2, 8": a car comes out of a side road just ahead and blocks the lane, the radio
// says where, and a unit ahead drops a stinger.
//   const m = await import('/tests/cutoffs.js');  await m.cutOffs({ secs: 60, star: 4 })      // window.__co
// The car carried along the streets at `kmh` (as tests/ghosttraffic.js), the wanted level held. For each car put out to cut it off: the
// junction, how far ahead it was when put out, whether the car got there first (within 12 m of the junction while the target was still
// short of it), and how near the target passed it; the radio's line. Stingers: thrown, and whether the car went over one.
const breathe = () => new Promise((r) => { const c = new MessageChannel(); c.port1.onmessage = () => { c.port1.close(); r(); }; c.port2.postMessage(0); });

export async function cutOffs(opts = {}) {
  const g = window.__game, gr = g.graph, p = g.player;
  g.paused = true;
  g.onBusted = () => { g.outcome = null; g.heat.bustTimer = 0; };
  g.heat._checkBust = () => {};
  g.heat.bump(1, 'a probe');
  let seed = opts.seed || 555;
  const rng = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return ((seed >>> 0) % 1e6) / 1e6; };
  let pts = null, at = 0, node = null, px = 0, pz = 0;
  const speed = (opts.kmh || 70) / 3.6;
  const route = () => {
    for (let k = 0; k < 60; k++) {
      const a = node === null ? gr.nearestNode(p.position.x, p.position.z, p.position.y) : gr.nodes[node], b = gr.randomNode(rng, 'street'), path = a && b && gr.route(a.id, b.id);
      if (path && path.length > 6) { pts = gr.pathToPoints(path, 2.5, true); at = 0; node = b.id; return; }
    }
  };
  const ride = () => {
    if (!pts || at >= pts.length - 2) { route(); px = pts[0].x; pz = pts[0].z; }
    let left = speed / 60;
    while (left > 0 && at < pts.length - 2) {
      const q = pts[at + 1], d = Math.hypot(q.x - px, q.z - pz);
      if (d <= left) { px = q.x; pz = q.z; left -= d; at++; } else { px += (q.x - px) / d * left; pz += (q.z - pz) / d * left; left = 0; }
    }
    const q = pts[Math.min(at + 1, pts.length - 1)], d = Math.hypot(q.x - px, q.z - pz) || 1, hx = (q.x - px) / d, hz = (q.z - pz) / d;
    p.body.setTranslation({ x: px, y: g.sim.heightAt(px, pz) + 0.55, z: pz }, true);
    const h = Math.atan2(hx, hz) / 2;
    p.body.setRotation({ x: 0, y: Math.sin(h), z: 0, w: Math.cos(h) }, true);
    p._readState();
    p.setVelocity({ x: hx * speed, y: 0, z: hz * speed });
    p._readState();
  };
  p.meets(0);
  const out = window.__co = { cuts: [], lines: [], stingers: 0, stung: 0 };
  const said = g.say.bind(g);
  g.say = (key, ...rest) => { const t = said(key, ...rest); if (t && /cutoff|stinger-thrown/.test(key)) out.lines.push(t); return t; };
  const seen = new Map();
  const blocks0 = new Set();
  for (let t = 0; t < (opts.secs || 60) * 60; t++) {
    g.heat.value = (opts.star || 4) + 0.05;
    const c = g.camera, f = p.forward;
    c.position.set(p.position.x - f.x * 8, p.position.y + 3, p.position.z - f.z * 8);
    c.lookAt(p.position.x + f.x * 10, p.position.y + 1, p.position.z + f.z * 10);
    c.updateMatrixWorld(true);
    ride();
    g.stepHeadless(1 / 60, { throttle: 0, brake: 0, steer: 0, handbrake: 0 });
    for (const u of g.dispatcher.units) {
      if (!(u.orders && u.orders.cut)) continue;
      const n = gr.nodes[u.orders.node];
      let r = seen.get(u);
      if (!r) {
        r = { cs: u.callsign, junction: g.nodeName(n.id), ahead: Math.round(Math.hypot(n.x - p.position.x, n.z - p.position.z)), there: false, passed: null };
        seen.set(u, r); out.cuts.push(r);
      }
      const dn = Math.hypot(u.position.x - n.x, u.position.z - n.z), tn = Math.hypot(p.position.x - n.x, p.position.z - n.z);
      const toward = (n.x - p.position.x) * p.forward.x + (n.z - p.position.z) * p.forward.z > 0;
      if (dn < 12 && toward && !r.there) { r.there = true; r.targetAway = Math.round(tn); }
      if (tn < 20) r.passed = Math.min(r.passed ?? 1e9, Math.round(Math.hypot(u.position.x - p.position.x, u.position.z - p.position.z)));
    }
    for (const b of g.roadblocks.blocks) if (b.thrown && !blocks0.has(b)) { blocks0.add(b); out.stingers++; }
    if (p.wheels.some((w) => w.punctured)) { out.stung++; p.repair(); }
    if (t % 30 === 0) await breathe();
  }
  g.say = said;
  out.done = true;
  return out;
}
