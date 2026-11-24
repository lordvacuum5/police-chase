// Off the motorway's open edges (world/jumps.js).
//   const m = await import('/tests/jumpoff.js');
//   await m.flights()     your car off each, both ways, at 25, 35 and 50 m/s and 14 and 24 degrees:
//                         down, hurt (worst damage), over (ended on its roof or side), sunk (the bodywork's lowest corner
//                         under the drawn ground after it has landed, worst m, and frames over 5 cm)
//   await m.chases()      a police car up on the motorway 450 m before each, or on the streets 900 m off, with you below by
//                         the landing: seconds to get within 25 m of you, with jumps and without
import { drawnGround } from '/tests/ridecheck.js';

const breathe = () => new Promise((r) => { const c = new MessageChannel(); c.port1.onmessage = () => { c.port1.close(); r(); }; c.port2.postMessage(0); });

function quiet(g) {
  g.onBusted = () => { g.outcome = null; g.heat.bustTimer = 0; };
  g.onEscaped = () => { g.outcome = null; };
  g.paused = true;
  g.vehicleLimit = 8;
  for (const u of g.dispatcher.units.slice()) g.dispatcher.retire(u);
  if (g.traffic) { g.traffic.preset = true; g.traffic.clear(); }
  g.dispatcher.update = () => {};
}

export async function flights(opts = {}) {
  const g = window.__game, v = g.player, J = g.world.__map.jumps;
  quiet(g);
  const ground = await drawnGround(g);
  const THREE = await import('three');
  const tmp = new THREE.Vector3(), d = v.spec.dims, cy = v.spec.colliderY === undefined ? 0.1 : v.spec.colliderY;
  const out = window.__jf = { n: 0, down: 0, hurt: 0, dmg: 0, over: 0, sunk: 0, sunkFrames: 0, wheel: 0, stuck: 0, at: [] };
  for (const j of J) for (const dir of [1, -1]) for (const sp of opts.speeds || [25, 35, 50]) for (const deg of [14, 24]) {
    const a = deg * Math.PI / 180, hx = j.tx * dir * Math.cos(a) + j.nx * Math.sin(a), hz = j.tz * dir * Math.cos(a) + j.nz * Math.sin(a);
    const x = j.x - hx * 6, z = j.z - hz * 6;
    v.teleport({ x, y: j.y + 0.7, z }, Math.atan2(hx, hz));
    v.setVelocity({ x: hx * sp, y: 0, z: hz * sp });
    v._readState();
    v.repair();
    let worst = 0, frames = 0, landed = 0, wheel = 0;
    for (let i = 0; i < 360; i++) {
      g.stepHeadless(1 / 60, { throttle: landed ? 0.3 : 0.2, brake: 0, steer: 0, handbrake: 0 });
      const gy = g.sim.terrainAt(v.position.x, v.position.z);
      if (!landed && v.grounded > 0 && v.position.y < gy + 2.5) landed = i;
      if (landed && v.up.y > 0.7) {
        let low = 9;
        // As drawn.
        v.view.position.copy(v.position); v.view.quaternion.copy(v.quaternion);
        const lift = g._landedLift && !opts.raw ? g._landedLift(v) : 0;
        out.lift = Math.max(out.lift || 0, lift);
        for (let k = 0; k < 4; k++) {
          tmp.set(k & 1 ? d.w * 0.45 : -d.w * 0.45, cy - d.h * 0.5, k & 2 ? d.l * 0.45 : -d.l * 0.45).applyQuaternion(v.quaternion).add(v.position);
          const [y] = ground(tmp.x, tmp.z, tmp.y + 1.2);
          if (y > -1e6) low = Math.min(low, tmp.y + lift - y);
        }
        for (let k = 0; k < 4; k++) {
          v.wheelCentre(k, tmp, { position: v.position, quaternion: v.quaternion, up: v.up });
          const [y] = ground(tmp.x, tmp.z, tmp.y + 0.8);
          if (y > -1e6 && v.wheels[k].grounded) wheel = Math.min(wheel, tmp.y + lift - v.spec.wheelRadius - y);
        }
        worst = Math.min(worst, low);
        if (low < -0.05) frames++;
      }
    }
    out.n++;
    if (landed) out.down++;
    if (v.damage > 0.05) out.hurt++;
    out.dmg = Math.max(out.dmg, v.damage);
    if (v.up.y < 0.6) out.over++;
    out.sunk = Math.min(out.sunk, worst); out.sunkFrames += frames; out.wheel = Math.min(out.wheel, wheel);
    if (v.speed < 2) out.stuck++;
    if (v.damage > 0.4 || v.up.y < 0.6 || !landed || worst < -0.1) out.at.push([Math.round(j.x), Math.round(j.z), dir, sp, deg, +v.damage.toFixed(2), +v.up.y.toFixed(1), +worst.toFixed(2), Math.round(v.speed)]);
    await breathe();
  }
  return out;
}

export async function chases(opts = {}) {
  const g = window.__game, G = g.graph, p = g.player, J = g.world.__map.jumps;
  const { SKILL, ROLE, Officer } = window.__modules;
  quiet(g);
  const out = window.__jc = { up: [], far: [] };
  const run = (place, at, secs) => {
    const car = g.createVehicle('interceptor', 'interceptor', { x: place.x, y: place.y + 0.9, z: place.z }, place.h, { police: true });
    if (!car) return null;
    const o = new Officer(g, car, { skill: SKILL.pursuit, kind: 'interceptor' });
    o.setRole(ROLE.PURSUE);
    car.setVelocity({ x: Math.sin(place.h) * 20, y: 0, z: Math.cos(place.h) * 20 });
    car._readState();
    const log = [];
    let t = null, jumped = false, dmg = 0, best = 9e9, top = 0, up = false;
    for (let i = 0; i < secs * 60; i++) {
      p.teleport({ x: at.x, y: g.groundAt(at.x, at.z) + 0.6, z: at.z }, 0);
      p.setVelocity({ x: 0, y: 0, z: 0 });
      p._readState();
      p.repair();
      g.heat.value = 5;
      const k = g.dispatcher.knowledge;
      k.seen = true; k.position.copy(p.position); k.velocity.set(0, 0, 0); k.confidence = 1;
      o.update(1 / 60, p);
      g.stepHeadless(1 / 60);
      const h = car.position.y - g.sim.terrainAt(car.position.x, car.position.z);
      if (h > 4) up = true;
      if (h > 2 && car.grounded === 0) jumped = true;
      dmg = Math.max(dmg, car.damage); top = Math.max(top, car.speed);
      best = Math.min(best, o.distanceTo(p.position));
      if (opts.log && i % 60 === 0) { const pt = (o.driver.path || [])[o.driver.pathIndex]; log.push([i / 60, Math.round(car.position.x), Math.round(car.position.z), +h.toFixed(1), Math.round(car.speed * 3.6), o._mode, Math.round(o.distanceTo(p.position)), (o.driver.path || []).some((q) => q.edge && q.edge.jump) ? 1 : 0, pt && pt.edge && pt.edge.jump ? 1 : 0, Math.round(o.driver.caps.out * 3.6)]); }
      if (o.distanceTo(p.position) < 25) { t = i / 60; break; }
    }
    g.despawnPolice(o);
    return { t: t === null ? null : +t.toFixed(1), jumped, up, dmg: +dmg.toFixed(2), best: Math.round(best), top: Math.round(top * 3.6), ...(opts.log ? { log } : {}) };
  };
  for (const j of J) {
    const w = j.ways[0];
    if (!w || (opts.only && !opts.only.includes(J.indexOf(j)))) continue;
    const n = G.nodes[w.b], at = { x: n.x, z: n.z };
    // Up on the motorway, 450 m before it, coming on.
    let node0 = w.a, left = 260, e = null, s = 0, fwd = false;
    {
      const A = G.nodes[w.a], q1 = w.points[1];
      e = A.edges.map((id) => G.edges[id]).filter((o) => o.kind === 'motorway' && o.elevated).sort((a, b) => { const d = (o) => { const r = G.pointAt(o, o.a === w.a ? 10 : o.length - 10); return (r.x - A.x) * (q1.x - A.x) + (r.z - A.z) * (q1.z - A.z); }; return d(a) - d(b); })[0];
      fwd = e.a === node0; s = fwd ? 0 : e.length;
    }
    while (left > 0) {
      const room = fwd ? e.length - s : s;
      if (left <= room) { s += (fwd ? 1 : -1) * left; left = 0; break; }
      left -= room;
      const node = fwd ? e.b : e.a, nx = G.nodes[node].edges.map((id) => G.edges[id]).find((q) => q !== e && q.kind === 'motorway' && q.elevated);
      if (!nx) break;
      fwd = nx.a === node; e = nx; s = fwd ? 0 : nx.length;
    }
    const q = G.pointAt(e, s), h = Math.atan2(q.tx * (fwd ? -1 : 1), q.tz * (fwd ? -1 : 1));
    const place = { x: q.x, y: G.levelOn(e, q.x, q.z), z: q.z, h };
    const row = { x: Math.round(j.x), z: Math.round(j.z) };
    for (const [key, no] of (opts.log ? [['with', false]] : [['with', false], ['without', true]])) { window.__noJumps = no; row[key] = run(place, at, 70); }
    window.__noJumps = false;
    out.up.push(row);
    await breathe();
  }
  if (opts.far !== false) {
    let seed = 5;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let i = 0; i < (opts.n || 10); i++) {
      const j = J[i % J.length], w = j.ways[0];
      if (!w) continue;
      const n = G.nodes[w.b], at = { x: n.x, z: n.z };
      const c = G.nodes.filter((m) => !m.elevated && G.roadDegree(m) > 2 && Math.hypot(m.x - n.x, m.z - n.z) > 900 && Math.hypot(m.x - n.x, m.z - n.z) < 1500);
      const a = c[Math.floor(rnd() * c.length)];
      const place = { x: a.x, y: g.groundAt(a.x, a.z), z: a.z, h: Math.atan2(n.x - a.x, n.z - a.z) };
      const row = { from: [Math.round(a.x), Math.round(a.z)], to: [Math.round(n.x), Math.round(n.z)], d: Math.round(Math.hypot(a.x - n.x, a.z - n.z)) };
      for (const [key, no] of [['with', false], ['without', true]]) { window.__noByMotorway = no; window.__noJumps = no; row[key] = run(place, at, 120); }
      window.__noByMotorway = false; window.__noJumps = false;
      out.far.push(row);
      await breathe();
    }
  }
  out.done = true;
  return out;
}
