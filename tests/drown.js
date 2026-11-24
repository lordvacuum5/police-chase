// "When you go in the water, you just start taking huge amounts of damage. But only when like most of your car is submerged.
// It obviously depends on the car." Ashfield's river.
//   const m = await import('/tests/drown.js');  await m.drown()       // window.__dr
//   cars     every car driven off the bank into the river at 12 m/s: how deep the water was where it stood when damage began
//            (depth, m) and how much of it was under; seconds from then to wrecked; whether it was wrecked
//   wade     each stood on its wheels in the river, deeper by 10 cm at a time, to the first depth it floods at
//   dry      parked on the banks, and on every bridge: any damage?
const breathe = () => new Promise((r) => { const c = new MessageChannel(); c.port1.onmessage = () => { c.port1.close(); r(); }; c.port2.postMessage(0); });

export async function drown(kinds = ['runner', 'supercar', 'offroad', 'patrol', 'interceptor', 'suv', 'van', 'hatchback', 'estate', 'civsuv']) {
  const g = window.__game, G = g.graph, sim = g.sim, map = g.world.__map, at = map.waterAt, SPECS = window.__modules.SPECS;
  g.onBusted = () => { g.outcome = null; out.busted++; };
  g.paused = true;
  g.vehicleLimit = 30;
  for (const u of g.dispatcher.units.slice()) g.dispatcher.retire(u);
  if (g.traffic) { g.traffic.preset = true; g.traffic.clear(); }
  g.dispatcher.update = () => {};
  const out = window.__dr = { busted: 0, cars: [], wade: [], dry: { n: 0, hurt: 0, bridges: 0, bridgeHurt: 0 } };
  const took = g._takeOut.bind(g);
  let gone = null;
  g._takeOut = (v) => { gone = v; };
  // A stretch of river with no bridge near: straight across at this z, from the dry bank.
  let z = 0, x0 = 0, dir = 1;
  for (let zz = -1000; zz <= 1000; zz += 20) {
    const xs = [];
    for (let x = -1400; x < 1400; x += 2) if (at(x, zz) !== null) xs.push(x);
    if (xs.length < 10) continue;
    const mid = (xs[0] + xs[xs.length - 1]) / 2;
    if (sim.terrainAt(mid, zz) > map.water - 2) continue;
    if (G.edgesNear(mid, zz, 80).some((e) => e.bridge || e.elevated)) continue;
    // Dry and level to come from, nothing on it.
    const b = xs[0] - 16;
    if (sim.terrainAt(b, zz) < map.water + 0.6 || Math.abs(sim.terrainAt(b - 30, zz) - sim.terrainAt(b, zz)) > 2) continue;
    z = zz; x0 = b;
    break;
  }
  out.z = z;
  const make = (kind, x) => g.createVehicle(kind, SPECS[kind] && SPECS[kind].livery || kind, { x, y: sim.terrainAt(x, z) + 0.9, z }, Math.PI / 2 * dir, {});
  for (const kind of kinds) {
    if (!SPECS[kind]) continue;
    const v = make(kind, x0);
    if (!v) continue;
    g.player.teleport({ x: x0 - 40, y: sim.terrainAt(x0 - 40, z) + 1, z }, 0);
    v.setVelocity({ x: 12 * dir, y: 0, z: 0 });
    v._readState();
    const r = { kind, h: v.spec.dims.h, depth: null, under: null, secs: null, wrecked: false, most: 0 };
    let t0 = null;
    gone = null;
    for (let i = 0; i < 900 && !gone && !r.wrecked; i++) {
      v.setControls({ throttle: v.speed < 8 ? 0.6 : 0, brake: 0, steer: 0, handbrake: 0 });
      g.stepHeadless(1 / 60, { throttle: 0, brake: 1, steer: 0, handbrake: 1 });
      r.most = Math.max(r.most, v.flooded || 0);
      if (t0 === null && v._wetFor > 0) { t0 = i; r.depth = +(at(v.position.x, v.position.z) - sim.terrainAt(v.position.x, v.position.z)).toFixed(2); r.under = +v.flooded.toFixed(2); r.before = +(v.damage).toFixed(2); }
      if (t0 !== null && v.damage >= (v.spec.wreckAt === undefined ? 0.92 : v.spec.wreckAt)) { r.secs = +((i - t0) / 60).toFixed(1); r.wrecked = true; }
    }
    r.end = [Math.round(v.position.x - x0), +v.damage.toFixed(2)];
    out.cars.push(r);
    if (!gone || true) g.removeVehicle(v);
    await breathe();
    // Stood in it: the body as it rides on its wheels.
    const s = { kind, floods: null };
    const w = make(kind, x0 - 30);
    if (w) {
      for (let i = 0; i < 90; i++) { w.setControls({ throttle: 0, brake: 1, steer: 0, handbrake: 1 }); g.stepHeadless(1 / 60, { throttle: 0, brake: 1, steer: 0, handbrake: 1 }); }
      const gy = sim.terrainAt(w.position.x, w.position.z);
      for (let d = 0.3; d < 3 && s.floods === null; d += 0.1) if (g.submerged(w, gy + d) >= 0.6) s.floods = +d.toFixed(1);
      g.removeVehicle(w);
    }
    out.wade.push(s);
  }
  // Your own: to busted.
  {
    const p = g.player;
    p.repair();
    p.teleport({ x: x0, y: sim.terrainAt(x0, z) + 0.8, z }, Math.PI / 2 * dir);
    p.setVelocity({ x: 14 * dir, y: 0, z: 0 });
    p._readState();
    let t = null;
    for (let i = 0; i < 900 && !out.busted; i++) { g.stepHeadless(1 / 60, { throttle: 0.5, brake: 0, steer: 0, handbrake: 0 }); if (t === null && p._wetFor > 0) t = i; if (out.busted) out.player = +((i - t) / 60).toFixed(1); }
    p.repair();
  }
  // Dry places.
  const p = g.player;
  for (const e of G.edges) {
    if (!e.bridge || e.elevated) continue;
    for (let s = 4; s < e.length - 2; s += 10) {
      const q = G.pointAt(e, s);
      if (at(q.x, q.z) === null) continue;
      p.teleport({ x: q.x, y: sim.terrainAt(q.x, q.z) + 0.7, z: q.z }, Math.atan2(q.tx, q.tz));
      p.repair();
      for (let i = 0; i < 20; i++) g.stepHeadless(1 / 60, { throttle: 0, brake: 1, steer: 0, handbrake: 1 });
      out.dry.bridges++;
      if (p.damage > 0.01 || p.flooded > 0) out.dry.bridgeHurt++;
    }
    await breathe();
  }
  g._takeOut = took;
  out.done = true;
  return out;
}
