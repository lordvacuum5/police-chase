// "They're kind of sometimes slow on like on the motorway when it's a bit of straight. They should just be able to
// absolutely send it." Two interceptors `back` m behind a car carried along a raised road at a steady speed (the ring both
// ways, the expressway both ways), five stars. Their own officers drive them, nothing else about.
//   const m = await import('/tests/motorpace.js');  await m.motorPace([200, 240])      // window.__mp as it goes
//   per run: kph    mean speed of the two (after 4 s)      low    slowest in that time      behind   m behind at the end
//            caps   which limit set the speed, share of frames, only while it asked for less than the car's most
//            hits (log), ghost, each   knocks over 4 m/s: on the road and walls, on the car carried, on the other unit
//            dmg, off   worst damage, fallen off the deck
export function ringPath(which) {
  const G = window.__game.graph;
  const kind = which.startsWith('ring') ? 'motorway' : 'dual';
  const es = G.edges.filter((e) => e.kind === kind && e.elevated && !e.dead);
  // Chain them end to end.
  const start = kind === 'dual' ? es.reduce((b, e) => (Math.min(G.nodes[e.a].x, G.nodes[e.b].x) < Math.min(G.nodes[b.a].x, G.nodes[b.b].x) ? e : b)) : es[0];
  let at = kind === 'dual' ? (G.nodes[start.a].x < G.nodes[start.b].x ? start.a : start.b) : start.a;
  const used = new Set(), pts = [];
  let e = start;
  while (e && !used.has(e)) {
    used.add(e);
    const fwd = e.a === at;
    for (let s = 0; s < e.length; s += 4) {
      const p = G.pointAt(e, fwd ? s : e.length - s);
      pts.push({ x: p.x, z: p.z, y: G.levelOn(e, p.x, p.z), w: e.width });
    }
    at = fwd ? e.b : e.a;
    e = G.nodes[at].edges.map((id) => G.edges[id]).find((o) => o.kind === kind && o.elevated && !used.has(o));
  }
  return which.endsWith('-') ? pts.reverse() : pts;
}

function run(kph, which, secs, back, tweak, lane) {
  const g = window.__game, p = g.player;
  const { SKILL, ROLE, Officer } = window.__modules;
  const raw = ringPath(which);
  // Arc length, and the nearside lane's middle.
  const S = [0];
  for (let i = 1; i < raw.length; i++) S.push(S[i - 1] + Math.hypot(raw[i].x - raw[i - 1].x, raw[i].z - raw[i - 1].z));
  const L = S[S.length - 1];
  const at = (s) => {
    let i = 0, j = S.length - 1;
    while (j - i > 1) { const m = (i + j) >> 1; if (S[m] <= s) i = m; else j = m; }
    const u = Math.min(1, Math.max(0, (s - S[i]) / Math.max(1e-6, S[i + 1] - S[i])));
    const a = raw[i], b = raw[i + 1], l = Math.hypot(b.x - a.x, b.z - a.z) || 1, hx = (b.x - a.x) / l, hz = (b.z - a.z) / l;
    const o = lane * a.w * 0.22;
    return { x: a.x + (b.x - a.x) * u - hz * o, z: a.z + (b.z - a.z) * u + hx * o, y: a.y + (b.y - a.y) * u, hx, hz };
  };
  const sp = kph / 3.6;
  const put = (v, s, speed) => {
    const q = at(s);
    v.teleport({ x: q.x, y: q.y + 0.75, z: q.z }, Math.atan2(q.hx, q.hz));
    v.setVelocity({ x: q.hx * speed, y: 0, z: q.hz * speed });
    v._readState();
  };
  const units = [];
  for (const k of [0, 1]) {
    const q = at(40 + k * 14);
    const car = g.createVehicle('interceptor', 'interceptor', { x: q.x, y: q.y + 0.9, z: q.z }, Math.atan2(q.hx, q.hz), { police: true });
    if (!car) continue;
    const o = new Officer(g, car, { skill: SKILL.pursuit, kind: 'interceptor' });
    o.setRole(ROLE.PURSUE);
    put(car, 40 + k * 14, sp);
    units.push(o);
  }
  let s = 40 + 14 + back;
  const r = { road: which, kph, mean: 0, low: 999, behind: 0, hits: 0, dmg: 0, off: 0, caps: {}, modes: {} };
  let n = 0;
  const seen = new Map();
  for (let i = 0; i < secs * 60 && s < L - 30; i++) {
    s += sp / 60;
    put(p, s, sp);
    p.repair();
    g.heat.value = window.__mpHeat || 5;
    const k = g.dispatcher.knowledge;
    k.seen = true; k.position.copy(p.position); k.velocity.copy(p.linvel); k.confidence = 1;
    for (const o of units) { o.update(1 / 60, p); if (tweak) tweak(o.driver, o); }
    g.stepHeadless(1 / 60);
    for (const o of units) {
      const v = o.vehicle;
      r.dmg = Math.max(r.dmg, v.damage);
      if (v.lastImpactAt && v.lastImpactAt !== seen.get(o) && v.lastImpact > 4) {
        seen.set(o, v.lastImpactAt);
        // The ghost is carried, so a knock on it costs what no real car's would; the other unit apart too.
        const other = units.find((q) => q !== o);
        if (Math.hypot(p.position.x - v.position.x, p.position.z - v.position.z) < 9) r.ghost = (r.ghost || 0) + 1;
        else if (other && o.distanceTo(other.vehicle.position) < 7) r.each = (r.each || 0) + 1;
        else { r.hits++; (r.log = r.log || []).push([+(i / 60).toFixed(1), Math.round(v.position.x), Math.round(v.position.z), +v.lastImpact.toFixed(0), Math.round(v.speed * 3.6), o._mode]); }
      }
      if (p.position.y - v.position.y > 5 && !o._mpOff) { o._mpOff = 1; r.off++; }
      if (i < 240) continue;
      n++;
      r.mean += v.speed * 3.6;
      r.low = Math.min(r.low, v.speed * 3.6);
      r.modes[o._mode] = (r.modes[o._mode] || 0) + 1;
      const c = o.driver.caps;
      let low = c.asked, who = 'asked';
      for (const key of ['safe', 'wall', 'way', 'slide']) if (c[key] < low - 0.01) { low = c[key]; who = key; }
      if (who === 'safe') { let l2 = c.sClear; who = 'Clear'; for (const key of ['sTravel', 'sRunout', 'sArc', 'sBack']) if (c[key] < l2 - 0.01) { l2 = c[key]; who = key.slice(1); } }
      if (low < v.spec.topSpeedHint * 0.98) r.caps[who] = (r.caps[who] || 0) + 1;
    }
  }
  for (const key of Object.keys(r.caps)) r.caps[key] = Math.round(r.caps[key] * 100 / Math.max(1, n));
  r.mean = Math.round(r.mean / Math.max(1, n)); r.low = Math.round(r.low); r.dmg = +r.dmg.toFixed(2);
  r.behind = units.map((o) => Math.round(o.distanceTo(p.position)));
  for (const o of units) g.despawnPolice(o);
  return r;
}

export async function motorPace(speeds = [200, 240], opts = {}) {
  const g = window.__game;
  g.onBusted = () => { g.outcome = null; g.heat.bustTimer = 0; };
  g.onEscaped = () => { g.outcome = null; };
  g.paused = true;
  g.vehicleLimit = 8;
  for (const u of g.dispatcher.units.slice()) g.dispatcher.retire(u);
  if (g.traffic) { g.traffic.preset = true; g.traffic.clear(); }
  g.dispatcher.update = () => {};
  const out = window.__mp = [];
  for (const kph of speeds) {
    for (const which of opts.roads || ['ring+', 'ring-', 'ex+', 'ex-']) {
      for (const back of opts.back || [60]) {
        out.push({ back, ...run(kph, which, opts.secs || 40, back, opts.tweak, opts.lane || 1) });
        await new Promise((res) => { const c = new MessageChannel(); c.port1.onmessage = () => { c.port1.close(); res(); }; c.port2.postMessage(0); });
      }
    }
  }
  g.heat.reset();
  return out;
}
