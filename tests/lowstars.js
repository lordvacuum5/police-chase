// One and two stars, the player carried at a steady speed so that only the police vary. "The ... level one police ... seem to be
// getting stuck by traffic quite a lot ... can you make the police cars a little bit better at cornering? Just like at ... level 1."
//   const m = await import('/tests/lowstars.js');  await m.lowStars({ star: 1, secs: 60, kmh: 60 })      // window.__ls
// The car carried along the streets (as tests/cutoffs.js), the wanted level held. Each tenth of a second, the nearest chasing unit:
//   behind   how far back it is, m, mean and p90;  near: the share of the time it is within 40 m
//   stuck    the share of unit-time a chasing unit more than 30 m back is under 2 m/s;  ghost: the share it is through traffic
//   puts     how many times units had to be put back on your trail (none within 120 m, at most every 8 s)
//   corner   the chasing units' mean speed while turning (yaw over 0.25 rad/s), km/h;  hits: police touching civilians, a minute
const breathe = () => new Promise((r) => { const c = new MessageChannel(); c.port1.onmessage = () => { c.port1.close(); r(); }; c.port2.postMessage(0); });

export async function lowStars(opts = {}) {
  for (let i = 0; i < 600 && !(window.__game && window.__game.dispatcher); i++) await new Promise((r) => setTimeout(r, 100));
  const g = window.__game, gr = g.graph, p = g.player;
  { const lim = 40; Object.defineProperty(g, 'vehicleLimit', { get: () => lim, set: () => {}, configurable: true }); }
  g.paused = true;
  g.onBusted = () => { g.outcome = null; g.heat.bustTimer = 0; };
  g.heat._checkBust = () => {};
  g.heat.bump(1, 'a probe');
  let seed = opts.seed || 777;
  const rng = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return ((seed >>> 0) % 1e6) / 1e6; };
  let pts = null, at = 0, px = p.position.x, pz = p.position.z;
  const speed = (opts.kmh || 60) / 3.6;
  const route = () => {
    for (let k = 0; k < 60; k++) {
      const a = gr.nearestNode(px, pz, p.position.y), b = gr.randomNode(rng, 'street'), path = a && b && gr.route(a.id, b.id);
      if (path && path.length > 6) { pts = gr.pathToPoints(path, 2.5, true); at = 0; return; }
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
  const behind = [], cornerKmh = [];
  let samples = 0, near = 0, unitT = 0, stuck = 0, ghost = 0, hits = 0;
  const touching = new Set(), trail = [];
  let sincePut = 480, puts = 0;
  const n = (opts.secs || 60) * 60;
  for (let t = 0; t < n; t++) {
    g.heat.value = (opts.star || 1) + 0.05;
    const c = g.camera, f = p.forward;
    c.position.set(p.position.x - f.x * 8, p.position.y + 3, p.position.z - f.z * 8);
    c.lookAt(p.position.x + f.x * 10, p.position.y + 1, p.position.z + f.z * 10);
    c.updateMatrixWorld(true);
    ride();
    // As tests/stars.js: never left behind for long. Up to three put back on your trail when none is within 120 m, every eight
    // seconds at most; how often is a measure of its own.
    trail.push({ x: p.position.x, y: p.position.y, z: p.position.z, h: Math.atan2(p.forward.x, p.forward.z) });
    if (trail.length > 400) trail.shift();
    sincePut++;
    const chase = g.dispatcher.units.filter((u) => !u.vehicle.disabled && u.role !== 'patrol' && u.role !== 'hold');
    if (sincePut > 480 && chase.length && !chase.some((u) => Math.hypot(u.position.x - p.position.x, u.position.z - p.position.z) < 120)) {
      sincePut = 0;
      let k = trail.length - 1, along = 0, next = 35;
      for (const u of chase.slice(0, 3)) {
        while (k > 0 && along < next) { along += Math.hypot(trail[k].x - trail[k - 1].x, trail[k].z - trail[k - 1].z); k--; }
        if (k <= 0) break;
        const q = trail[k];
        u.vehicle.teleport({ x: q.x, y: q.y + 0.1, z: q.z }, q.h);
        u.vehicle._readState();
        u.vehicle.setVelocity({ x: Math.sin(q.h) * speed, y: 0, z: Math.cos(q.h) * speed });
        next += 20;
        if (t >= 600) puts++;
      }
    }
    g.stepHeadless(1 / 60, { throttle: 0, brake: 0, steer: 0, handbrake: 0 });
    const units = g.dispatcher.units.filter((u) => !u.vehicle.disabled && !u.human && u.role !== 'patrol');
    for (const u of units) for (const o of g.vehicles) {
      if (!o.isTraffic || o.dormant) continue;
      const k = u.vehicle.id + '|' + o.id, d = Math.hypot(o.position.x - u.vehicle.position.x, o.position.z - u.vehicle.position.z);
      if (d < 3.2 && !u.vehicle.ghost) { if (!touching.has(k)) { touching.add(k); hits++; } } else if (d > 6) touching.delete(k);
    }
    if (t % 6 || t < 600) continue;
    samples++;
    let best = Infinity;
    for (const u of units) {
      const v = u.vehicle, d = Math.hypot(v.position.x - p.position.x, v.position.z - p.position.z);
      best = Math.min(best, d);
      unitT++;
      if (d > 30 && v.speed < 2) stuck++;
      if (v.ghost) ghost++;
      if (Math.abs(v.angvel ? v.angvel.y : 0) > 0.25 && d > 20) cornerKmh.push(v.speed * 3.6);
    }
    if (Number.isFinite(best)) { behind.push(best); if (best < 40) near++; }
    if (t % 120 === 0) await breathe();
  }
  const s = behind.slice().sort((a, b) => a - b), mean = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
  const out = window.__ls = {
    map: g.mapDef.id, star: opts.star || 1, behind: Math.round(mean(behind)), p90: Math.round(s[Math.floor(s.length * 0.9)] || 0), near: +(near / samples).toFixed(2),
    stuck: +(stuck / (unitT || 1)).toFixed(3), ghost: +(ghost / (unitT || 1)).toFixed(2), corner: Math.round(mean(cornerKmh)), hits: +(hits / ((n - 600) / 3600)).toFixed(1), puts, errors: g.updateErrors || 0, done: true,
  };
  return out;
}
