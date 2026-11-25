// Police going through the traffic where nobody is looking (Officer._ghosting). "If they're chasing me and I'm going pretty fast
// and I'm not looking behind me ... the police cars can literally just go straight through civilian cars. Don't let me see."
//   const m = await import('/tests/ghosttraffic.js');  await m.ghostTraffic({ secs: 120 })      // window.__gt
// The car is carried round the map at 86 km/h and four stars, the camera behind the car as a player's is (`look: 'back'` for one
// that looks behind all the time). Run with window.__noGhost = true, and after a reload without. Every step:
//   hits      knocks between a police car and a civilian one, a minute
//   kmh       the police cars' mean speed while after you, and near: the share of the time one is within 60 m of you
//   ghost     the share of police time spent going through traffic; inside: how many times one was inside a civilian car
//   seen      steps with a police car inside a civilian car and the two in sight, how long the worst was, s, and how far off
//   thrown    ghosts made solid inside a civilian car: either's speed changing 6 m/s in a step just after
const breathe = () => new Promise((r) => { const c = new MessageChannel(); c.port1.onmessage = () => { c.port1.close(); r(); }; c.port2.postMessage(0); });

export async function ghostTraffic(opts = {}) {
  const g = window.__game, gr = g.graph, p = g.player;
  g.paused = true;
  g.onBusted = () => { g.outcome = null; g.heat.bustTimer = 0; };
  g.onEscaped = () => { g.outcome = null; };
  g.heat._checkBust = () => {};
  g.heat.bump(1, 'a probe');
  let seed = opts.seed || 2027;
  const rng = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return ((seed >>> 0) % 1e6) / 1e6; };
  // Carried along the roads at `speed`, meeting nothing: the same ride every time. Driven, it was pinned within the minute in one
  // run of two, at 22 and 55 km/h over two minutes, and nothing could be compared.
  let pts = null, at = 0, node = null;
  const speed = opts.speed || 24;
  const route = () => {
    for (let k = 0; k < 60; k++) {
      const a = node === null ? gr.nearestNode(p.position.x, p.position.z, p.position.y) : gr.nodes[node], b = gr.randomNode(rng, 'street'), path = a && b && gr.route(a.id, b.id);
      if (path && path.length > 6) { pts = gr.pathToPoints(path, 2.5, true); at = 0; node = b.id; return; }
    }
  };
  let px = 0, pz = 0;
  const ride = () => {
    if (!pts || at >= pts.length - 2) { route(); px = pts[0].x; pz = pts[0].z; }
    let left = speed / 60;
    while (left > 0 && at < pts.length - 2) {
      const q = pts[at + 1], d = Math.hypot(q.x - px, q.z - pz);
      if (d <= left) { px = q.x; pz = q.z; left -= d; at++; } else { px += (q.x - px) / d * left; pz += (q.z - pz) / d * left; left = 0; }
    }
    const q = pts[Math.min(at + 1, pts.length - 1)], d = Math.hypot(q.x - px, q.z - pz) || 1, hx = (q.x - px) / d, hz = (q.z - pz) / d;
    const e = pts[at].edge, y = (e && e.deck ? gr.levelOn(e, px, pz) : g.sim.heightAt(px, pz)) + 0.55;
    p.body.setTranslation({ x: px, y, z: pz }, true);
    const h = Math.atan2(hx, hz) / 2;
    p.body.setRotation({ x: 0, y: Math.sin(h), z: 0, w: Math.cos(h) }, true);
    p.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    p._readState();
    p.setVelocity({ x: hx * speed, y: 0, z: hz * speed });
    p._readState();
  };
  p.meets(0);
  const out = window.__gt = { secs: 0, hits: 0, kmh: 0, near: 0, ghost: 0, inside: 0, seen: 0, seenWorst: 0, seenAt: [], thrown: 0, units: 0, stuck: 0, player: 0, traffic: 0 };
  const inside = new Map(), was = new Map(), touching = new Set();
  let n = 0, un = 0;
  const cam = () => {
    const c = g.camera, s = opts.look === 'back' ? -1 : 1, f = p.forward;
    c.position.set(p.position.x - f.x * 8 * s, p.position.y + 3, p.position.z - f.z * 8 * s);
    c.lookAt(p.position.x + f.x * 10 * s, p.position.y + 1, p.position.z + f.z * 10 * s);
    c.updateMatrixWorld(true);
  };
  for (let t = 0; t < (opts.secs || 120) * 60; t++) {
    g.heat.value = 4;
    if (p.damage > 0.3) p.repair();
    cam();
    ride();
    g.stepHeadless(1 / 60, { throttle: 0.3, brake: 0, steer: 0, handbrake: 0 });
    out.player += p.speed;
    out.traffic += g.traffic.cars.filter((q) => Math.hypot(q.v.position.x - p.position.x, q.v.position.z - p.position.z) < 150).length;
    n++;
    let near = false;
    const now = new Set();
    for (const u of g.dispatcher.units) {
      const v = u.vehicle;
      if (v.disabled || u.role === 'patrol' || u.role === 'hold') continue;
      un++;
      out.kmh += v.speed * 3.6;
      if (v.speed < 1) out.stuck++;
      if (v.ghost) out.ghost++;
      const d = Math.hypot(v.position.x - p.position.x, v.position.z - p.position.z);
      if (d < 60) near = true;
      for (const q of g.traffic.cars) {
        const o = q.v;
        if (o.dormant) continue;
        const dx = o.position.x - v.position.x, dz = o.position.z - v.position.z;
        if (Math.hypot(dx, dz) > 6 || Math.abs(o.position.y - v.position.y) > 2) continue;
        const key = `${v.id}|${o.id}`;
        // The two outlines, in each other: the centres nearer than the sum of half-widths whichever way they lie, or so.
        const a = Math.abs(dx * v.forward.x + dz * v.forward.z), b = Math.abs(dx * v.left.x + dz * v.left.z);
        if (v.ghost && a < 3.6 && b < 1.5) {
          if (!inside.has(key)) out.inside++;
          const k = (inside.get(key) || 0) + 1;
          inside.set(key, k);
          now.add(key);
          if (g.inView(v.position) && g.inView(o.position)) {
            out.seen++;
            if (k / 60 > out.seenWorst) out.seenWorst = +(k / 60).toFixed(2);
            if (out.seenAt.length < 12) out.seenAt.push([Math.round(d), +(k / 60).toFixed(2), Math.round(v.speed)]);
          }
        } else if (!v.ghost) {
          let hit = false;
          g.world.contactPair(v.collider, o.collider, (m) => { if (m.numContacts() > 0) hit = true; });
          if (hit) { now.add('h' + key); if (!touching.has(key)) { touching.add(key); out.hits++; } } else touching.delete(key);
        }
      }
      const w = was.get(v);
      if (w && w.ghost && !v.ghost) w.left = 6;
      if (w && w.left > 0) { w.left--; if (Math.abs(v.speed - w.speed) > 6) out.thrown++; }
      was.set(v, { ghost: v.ghost, speed: v.speed, left: w ? w.left : 0 });
    }
    for (const k of [...inside.keys()]) if (!now.has(k)) inside.delete(k);
    if (near) out.near++;
    if (t % 30 === 0) { out.secs = t / 60; await breathe(); }
  }
  out.secs = n / 60;
  const f = { secs: out.secs, hitsAMinute: +(out.hits / (n / 3600)).toFixed(2), kmh: +(out.kmh / Math.max(1, un)).toFixed(1), near: +(out.near / n).toFixed(3), ghost: +(out.ghost / Math.max(1, un)).toFixed(3),
    inside: out.inside, seen: out.seen, seenWorst: out.seenWorst, seenAt: out.seenAt, thrown: out.thrown, stood: +(out.stuck / Math.max(1, un)).toFixed(3), units: +(un / n).toFixed(1), playerKmh: +(out.player / n * 3.6).toFixed(0), traffic: +(out.traffic / n).toFixed(1), done: true };
  window.__gt = f;
  return f;
}
