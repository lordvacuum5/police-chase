// "Sometimes the police cars try to turn, but they almost can't turn far enough, and they end up crashing."
//
// One pursuit car behind a car carried round right-angle corners on the streets, each from 75 m out and 25 m behind it:
//   const m = await import('/tests/wideturn.js');  await m.wideTurn([80, 110])      // window.__wt
// The car ahead slows to 50 km/h for the corner, as a driver would, and is off up the side street at `kph` again.
//   made    reached 25 m down the side street inside 8 s          t   mean time to there, s
//   hits    knocks over 4 m/s on anything but the car ahead       hard   over 10
//   locked  share of frames within 45 m of the corner at all the lock it may ask for, wanting 20 degrees more
//   wide    mean of the furthest each got off the two roads' lines past the carriageway's edge, m
//   low     mean of the slowest each went within 30 m of the corner, km/h
export function sites(count = 24) {
  const G = window.__game.graph, out = [];
  for (const n of G.nodes) {
    if (n.elevated) continue;
    const es = n.edges.map((id) => G.edges[id]).filter((e) => !e.dead && !e.elevated && !e.cut && !e.turningHead && e.length > 80 && (e.kind === 'street' || e.kind === 'avenue'));
    if (es.length < 2 || n.edges.length < 3) continue;
    const dir = (e) => { const p = G.pointAt(e, e.a === n.id ? 20 : e.length - 20), l = Math.hypot(p.x - n.x, p.z - n.z); return { x: (p.x - n.x) / l, z: (p.z - n.z) / l }; };
    const pair = [];
    for (const a of es) for (const b of es) if (a !== b && Math.abs(dir(a).x * dir(b).x + dir(a).z * dir(b).z) < 0.25) pair.push({ n, a, b });
    if (pair.length) out.push(pair[(n.id * 7) % pair.length]);
  }
  const step = Math.max(1, Math.floor(out.length / count)), pick = [];
  for (let i = 0; i < out.length && pick.length < count; i += step) pick.push(out[i]);
  return pick;
}

function line(site) {
  const G = window.__game.graph, { n, a, b } = site, pts = [];
  // Along a to the corner, in the lane, round it on a 9 m arc, and up b.
  const p = (e, d) => G.pointAt(e, e.a === n.id ? Math.min(d, e.length) : Math.max(0, e.length - d));
  for (let d = Math.min(78, a.length - 1); d >= 12; d -= 2) { const q = p(a, d); pts.push({ x: q.x, z: q.z }); }
  const s = p(a, 12), e = p(b, 12);
  for (let k = 1; k < 8; k++) { const u = k / 8, iu = 1 - u; pts.push({ x: iu * iu * s.x + 2 * iu * u * n.x + u * u * e.x, z: iu * iu * s.z + 2 * iu * u * n.z + u * u * e.z }); }
  for (let d = 12; d < b.length; d += 2) { const q = p(b, d); pts.push({ x: q.x, z: q.z }); }
  const S = [0];
  for (let i = 1; i < pts.length; i++) S.push(S[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
  return { pts, S, corner: S[pts.findIndex((q, i) => i > 30 && Math.hypot(q.x - n.x, q.z - n.z) < 10)] || 72 };
}

function distTo(e, x, z) {
  let d = Infinity;
  for (const sg of e.segs) {
    const dx = sg.b.x - sg.a.x, dz = sg.b.z - sg.a.z, l2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((x - sg.a.x) * dx + (z - sg.a.z) * dz) / l2));
    d = Math.min(d, Math.hypot(sg.a.x + dx * t - x, sg.a.z + dz * t - z));
  }
  return d - e.width * 0.5;
}

export async function wideTurn(speeds = [80, 110], opts = {}) {
  const g = window.__game, p = g.player;
  const { SKILL, ROLE, Officer } = window.__modules;
  g.onBusted = () => { g.outcome = null; g.heat.bustTimer = 0; };
  g.onEscaped = () => { g.outcome = null; };
  g.paused = true;
  g.vehicleLimit = 8;
  for (const u of g.dispatcher.units.slice()) g.dispatcher.retire(u);
  if (g.traffic) { g.traffic.preset = true; g.traffic.clear(); }
  g.dispatcher.update = () => {};
  const out = window.__wt = [], list = sites(opts.count || 24);
  for (const kph of speeds) {
    const r = { kph, n: 0, made: 0, t: 0, hits: 0, hard: 0, locked: 0, wide: 0, low: 0, dmg: 0, at: [] };
    let lf = 0, ln = 0;
    for (const site of list) {
      const L = line(site), at = (s) => {
        let i = 0;
        while (i < L.S.length - 2 && L.S[i + 1] < s) i++;
        const a = L.pts[i], b = L.pts[i + 1], l = Math.max(1e-6, L.S[i + 1] - L.S[i]), t = Math.min(1, (s - L.S[i]) / l);
        return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, hx: (b.x - a.x) / l, hz: (b.z - a.z) / l };
      };
      const put = (v, s, sp) => {
        const q = at(s);
        v.teleport({ x: q.x, y: g.groundAt(q.x, q.z) + 0.8, z: q.z }, Math.atan2(q.hx, q.hz));
        v.setVelocity({ x: q.hx * sp, y: 0, z: q.hz * sp });
        v._readState();
      };
      const q0 = at(2);
      const car = g.createVehicle('interceptor', 'interceptor', { x: q0.x, y: g.groundAt(q0.x, q0.z) + 0.9, z: q0.z }, Math.atan2(q0.hx, q0.hz), { police: true });
      if (!car) continue;
      const o = new Officer(g, car, { skill: SKILL.pursuit, kind: 'interceptor' });
      o.setRole(ROLE.PURSUE);
      const top = kph / 3.6, slow = 50 / 3.6;
      put(car, 2, top);
      let s = 27, sp = top, hit = 0, wide = 0, low = 999, made = 0, seen = null;
      const end = L.S[L.S.length - 1] - 2;
      for (let i = 0; i < 480 && !made; i++) {
        const toCorner = L.corner - s;
        const want = toCorner > 0 ? Math.min(top, Math.sqrt(slow * slow + 2 * 8 * toCorner)) : Math.min(top, sp + 5 / 60);
        sp = toCorner > 0 ? want : Math.max(slow, want);
        s = Math.min(end, s + sp / 60);
        put(p, s, s < end ? sp : 0);
        p.repair();
        g.heat.value = 5;
        const k = g.dispatcher.knowledge;
        k.seen = true; k.position.copy(p.position); k.velocity.copy(p.linvel); k.confidence = 1;
        o.update(1 / 60, p);
        if (opts.tweak) opts.tweak(o.driver, o);
        g.stepHeadless(1 / 60);
        const v = car, d = Math.hypot(v.position.x - site.n.x, v.position.z - site.n.z);
        if (v.lastImpactAt && v.lastImpactAt !== seen && v.lastImpact > 4) {
          seen = v.lastImpactAt;
          if (o.distanceTo(p.position) > 6.5) { r.hits++; hit = Math.max(hit, v.lastImpact); if (v.lastImpact > 10) r.hard++; }
        }
        if (d < 45) {
          ln++;
          const ceil = v.speed > 20 ? 0.8 : 0.98;
          if (Math.abs(o.driver.out.steer) > ceil * 0.98 && Math.abs(o.driver.aimError || 0) > 0.35) lf++;
          wide = Math.max(wide, Math.min(distTo(site.a, v.position.x, v.position.z), distTo(site.b, v.position.x, v.position.z)));
        }
        if (d < 30) low = Math.min(low, v.speed * 3.6);
        const bd = distTo(site.b, v.position.x, v.position.z);
        if (bd < 0 && d > 25 && distTo(site.a, v.position.x, v.position.z) > 8) { made = 1; r.made++; r.t += i / 60; }
      }
      r.n++;
      r.wide += Math.max(0, wide);
      r.low += low < 999 ? low : 0;
      r.dmg = Math.max(r.dmg, car.damage);
      if (hit > 4 || !made) r.at.push([Math.round(site.n.x), Math.round(site.n.z), +hit.toFixed(0), made]);
      g.despawnPolice(o);
      await new Promise((res) => { const c = new MessageChannel(); c.port1.onmessage = () => { c.port1.close(); res(); }; c.port2.postMessage(0); });
    }
    r.t = +(r.t / Math.max(1, r.made)).toFixed(2); r.locked = +(lf / Math.max(1, ln)).toFixed(3);
    r.wide = +(r.wide / r.n).toFixed(2); r.low = Math.round(r.low / r.n); r.dmg = +r.dmg.toFixed(2);
    out.push(r);
  }
  g.heat.reset();
  return out;
}
