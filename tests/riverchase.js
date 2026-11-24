// Do the police drive into the river after you?
//   const m = await import('/tests/riverchase.js'); await m.riverChase(90)   // window.__rc
// Your car parked on one bank, away from any bridge, three stars on it and known about; every car lost to the water
// is counted: police / traffic / suspects, with where, what it was doing and how fast.
export async function riverChase(secs = 90, spots = [[-640, 1], [-640, -1], [330, 1], [330, -1], [760, 1]]) {
  const g = window.__game, v = g.player, sim = g.sim, map = g.world.__map;
  g.onBusted = () => { g.outcome = null; g.heat.bustTimer = 0; };
  g.onEscaped = () => { g.outcome = null; };
  if (g.heat._checkBust) g.heat._checkBust = () => {};
  g.paused = true;
  const out = window.__rc = { police: 0, traffic: 0, at: [], arrived: 0, unitSecs: 0, done: false };
  const real = g._takeOut.bind(g);
  g._takeOut = (o, s) => {
    const u = g.dispatcher.units.find((q) => q.vehicle === o);
    if (u) { out.police++; if (out.at.length < 12) out.at.push([u.role, u._mode || null, Math.round(o.position.x), Math.round(o.position.z), Math.round(o.speed * 3.6)]); } else { out.traffic++; (out.tr = out.tr || []).length < 40 && out.tr.push([Math.round(o.position.x), +o.position.y.toFixed(1), Math.round(o.position.z), Math.round(o.speed * 3.6), !!o.isTraffic, +sim.terrainAt(o.position.x, o.position.z).toFixed(1)]); }
    real(o, s);
  };
  for (const [z, side] of spots) {
    // Just up from the bank: step out from the river's middle until dry and level.
    let x = 0, best = null;
    for (let d = 46; d < 120; d += 2) {
      for (let cx = -200; cx < 460; cx += 2) {
        if (map.clearAt(cx, z)) { x = cx; break; }
      }
      let lo = x, hi = x;
      while (map.clearAt(hi, z)) hi += 2;
      best = side > 0 ? hi + 22 : lo - 22;
      break;
    }
    v.teleport({ x: best, y: sim.terrainAt(best, z) + 1, z }, 0);
    v.setVelocity({ x: 0, y: 0, z: 0 });
    v._readState();
    g.heat.value = 3;
    for (let t = 0; t < secs; t++) {
      g.stepHeadless(1, { throttle: 0, brake: 1, steer: 0, handbrake: 1 });
      if (v.repair) v.repair();
      g.heat.value = Math.max(3, g.heat.value);
      g.dispatcher.knowledge.seen = true;
      g.dispatcher.knowledge.position.copy(v.position);
      out.unitSecs += g.dispatcher.units.length;
      await new Promise((r) => { const ch = new MessageChannel(); ch.port1.onmessage = () => { ch.port1.close(); r(); }; ch.port2.postMessage(0); });
    }
    for (const u of g.dispatcher.units) if (!u.vehicle.isAircraft && u.vehicle.position.distanceTo(v.position) < 30) out.arrived++;
    out.spot = [Math.round(best), z];
  }
  g._takeOut = real;
  out.done = true;
  return out;
}
