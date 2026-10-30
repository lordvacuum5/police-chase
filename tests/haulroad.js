// The quarry's haul road: can a car drive from the floor up every ledge to
// the rim? "The terracing on the quarry, you can't actually go on individual
// ones ... I seem to just kind of slide off all of them."
//
// Steers the player along the road -- each rise round the foot of its face,
// then out onto the ledge for the next -- at a steady speed, and reports how
// high it got (and on which ledge), the worst it dropped in one go (a fall
// off a ledge shows here), the time, and the damage. Also parks a car on each
// ledge, handbrake off, and says how far it slid in five seconds.
//
// window.__runHaulRoad(kmh) -> window.__res

window.__runHaulRoad = async function (kmh = 35) {
  for (let i = 0; i < 200 && !(window.__game && window.__game.player); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const g = window.__game, p = g.player, q = g.world.__map.quarry;
  g.heat.value = 0;
  g.onBusted = () => { g.outcome = null; };
  const T = q.tiers;
  // The foot of face k, as buildQuarry has it.
  const rAt = (a, k) => q.r - 6 - (T - 1 - k) * q.bench + (k < T - 1 ? Math.sin(a * 5 + k * 2.1) * q.bench * 0.1 : 0);
  const P = (a, r) => ({ x: q.x + Math.cos(a) * r, z: q.z + Math.sin(a) * r });
  const way = [];
  // Up each rise along the foot of its face, then easing out across the
  // landing (the last 0.3 rad, HAUL_LANDING) onto the ledge it comes out on --
  // over the rim, for the last.
  for (const h of q.haul) {
    const land = h.to - 0.3;
    for (let a = h.from; a <= h.to; a += 0.03) {
      const out = h.tier < T - 1 ? rAt(a, h.tier + 1) - 3.5 : q.r + 12;
      const u = Math.max(0, Math.min(1, (a - land) / 0.3));
      way.push({ ...P(a, (rAt(a, h.tier) - 3.5) * (1 - u) + out * u), tier: h.tier });
    }
  }
  const start = P(q.haul[0].from - 0.12, rAt(q.haul[0].from, 0) - 3.5);
  const h0 = Math.atan2(way[0].x - start.x, way[0].z - start.z);
  p.repair();
  p.teleport({ x: start.x, y: g.sim.heightAt(start.x, start.z) + 0.7, z: start.z }, h0);
  p.setVelocity({ x: 0, y: 0, z: 0 });
  const v = kmh / 3.6;
  let k = 0, top = -1e9, worstDrop = 0, lastY = null, t = 0;
  for (let i = 0; i < 60 * 240 && k < way.length; i++) {
    while (k < way.length - 1 && Math.hypot(way[k].x - p.position.x, way[k].z - p.position.z) < 6) k++;
    const w = way[k];
    let err = Math.atan2(p.forward.x, p.forward.z) - Math.atan2(w.x - p.position.x, w.z - p.position.z);
    err = Math.atan2(Math.sin(err), Math.cos(err));
    g.forceControls = { throttle: p.speed < v ? 1 : 0, brake: p.speed > v + 3 ? 0.4 : 0, steer: Math.max(-1, Math.min(1, -err * 2.5)), handbrake: 0 };
    g._update(1 / 60);
    t += 1 / 60;
    top = Math.max(top, p.position.y);
    if (i % 30 === 0) {
      if (lastY !== null && lastY - p.position.y > worstDrop) { worstDrop = lastY - p.position.y; window.__haulFall = { k, tier: way[k].tier, x: p.position.x | 0, z: p.position.z | 0, y: +p.position.y.toFixed(1), d: +Math.hypot(p.position.x - q.x, p.position.z - q.z).toFixed(1), a: +Math.atan2(p.position.z - q.z, p.position.x - q.x).toFixed(2) }; }
      lastY = p.position.y;
    }
    if (k === way.length - 1 && Math.hypot(w.x - p.position.x, w.z - p.position.z) < 6) break;
  }
  g.forceControls = null;
  const reached = Math.min(k, way.length - 1);
  const drive = `haul road at ${kmh} km/h: waypoint ${reached + 1} of ${way.length} (ledge ${way[reached].tier} of ${T}), `
    + `up ${(top - q.floor).toFixed(0)} m of ${(q.cliff).toFixed(0)}, worst drop in half a second ${worstDrop.toFixed(1)} m, `
    + `${t.toFixed(0)} s, damage ${p.damage.toFixed(2)}`;
  // Parked on each ledge, in the middle of it.
  const parked = [];
  for (let j = 0; j < T - 1; j++) {
    const a = q.high + 0.3;
    const r = (rAt(a, j) + rAt(a, j + 1)) / 2;
    const s = P(a, r);
    const y = q.floor + 200;
    p.repair();
    // Dropped from above onto the ledge, nose along it.
    p.teleport({ x: s.x, y, z: s.z }, a + Math.PI / 2);
    p.setVelocity({ x: 0, y: 0, z: 0 });
    // Find the ledge: fall until it lands.
    for (let i = 0; i < 60 * 8; i++) { g.forceControls = { throttle: 0, brake: 0, steer: 0, handbrake: 0 }; g._update(1 / 60); if (p.grounded >= 4 && p.speed < 0.3) break; }
    const s0 = { x: p.position.x, y: p.position.y, z: p.position.z };
    for (let i = 0; i < 60 * 5; i++) { g.forceControls = { throttle: 0, brake: 0, steer: 0, handbrake: 0 }; g._update(1 / 60); }
    parked.push(`ledge ${j}: slid ${Math.hypot(p.position.x - s0.x, p.position.z - s0.z).toFixed(2)} m, down ${(s0.y - p.position.y).toFixed(2)} m`);
  }
  g.forceControls = null;
  window.__res = drive + '\n' + parked.join('\n');
  return window.__res;
};
