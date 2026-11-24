// With the chase up on the motorway, do the force's blocks come up there too?
//
// The player's car put at speed on each raised road in turn (and on the street under one), nothing in view of
// anybody, and the dispatcher's ahead-of-you tactics called: the rolling block, its wingmen, the head-on van, a
// roadblock with its cones and stinger.
//   const m = await import('/tests/deckspawn.js');  m.deckSpawn()
//   placed / wrong   how many of each were put down, and how many more than 4 m above or below the car's road
export function deckSpawn() {
  const g = window.__game, G = g.graph, v = g.player, sim = g.sim;
  g.onBusted = () => { g.outcome = null; };
  g.paused = true;
  if (g.traffic) { g.traffic.preset = true; g.traffic.clear(); }
  for (const u of g.dispatcher.units.slice()) g.dispatcher.retire(u);
  g.vehicleLimit = 40;
  const keep = { inView: g.inView, seenByAnyone: g.seenByAnyone, nearHuman: g.nearHuman };
  g.inView = () => false; g.seenByAnyone = () => false; g.nearHuman = () => false;
  const out = {};
  const add = (k, y, level, where) => {
    const o = out[k] = out[k] || { placed: 0, wrong: 0, at: [] };
    o.placed++;
    if (Math.abs(y - level) > 4) { o.wrong++; if (o.at.length < 3) o.at.push(where); }
  };
  const test = (tag, x, y, z, tx, tz) => {
    v.teleport({ x, y: y + 0.9, z }, Math.atan2(tx, tz));
    v.setVelocity({ x: tx * 30, y: 0, z: tz * 30 });
    v._readState();
    g.stepHeadless(1 / 30, { throttle: 1, brake: 0, steer: 0, handbrake: 0 });
    const L = v.position.y;
    const mark = new Set(g.vehicles);
    const fresh = () => g.vehicles.filter((q) => !mark.has(q));
    const a = g.spawnPoliceAhead(v, 3);
    if (a) {
      add(tag + ' block', a.vehicle.position.y, L, [Math.round(a.vehicle.position.x), Math.round(a.vehicle.position.z)]);
      const m = g.spawnBlockMates(a, 3);
      if (m) for (const q of m.mates) add(tag + ' wingman', q.officer.vehicle.position.y, L, null);
    }
    const r = g.spawnRhino(v, 5);
    if (r) add(tag + ' van', r.vehicle.position.y, L, [Math.round(r.vehicle.position.x), Math.round(r.vehicle.position.z)]);
    const site = g.roadblocks._findSite(v);
    if (site) {
      const b = g.roadblocks._build(site);
      if (b) {
        for (const u of b.units) add(tag + ' roadblock', u.vehicle.position.y, L, [Math.round(site.x), Math.round(site.z)]);
        for (const m of b.meshes) add(tag + ' stinger', m.position.y, L, null);
        for (const c of b.cones) { add(tag + ' cone', c.body.translation().y, L, null); g.scene.remove(c.mesh); g.world.removeRigidBody(c.body); }
        for (const m of b.meshes) g.scene.remove(m);
        for (const u of b.units) { const i = g.dispatcher.units.indexOf(u); if (i >= 0) g.dispatcher.units.splice(i, 1); }
      }
    }
    for (const q of fresh()) g.removeVehicle(q);
  };
  let k = 0;
  for (const e of G.edges) {
    if (!e.elevated || e.kind === 'ramp' || e.length < 80 || (k++ % 4)) continue;
    const p = G.pointAt(e, e.length * 0.5);
    for (const s of [1, -1]) test('up', p.x, G.levelOn(e, p.x, p.z), p.z, p.tx * s, p.tz * s);
  }
  // On the streets that pass under one.
  k = 0;
  for (const e of G.edges) {
    if (e.elevated || e.length < 50 || !['street', 'avenue'].includes(e.kind)) continue;
    const p = G.pointAt(e, e.length * 0.5);
    const over = G.edgesNear(p.x, p.z, 30).find((o) => o.elevated && o.segs.some((sg) => { const dx = sg.b.x - sg.a.x, dz = sg.b.z - sg.a.z, l2 = dx * dx + dz * dz; let u = l2 ? ((p.x - sg.a.x) * dx + (p.z - sg.a.z) * dz) / l2 : 0; u = Math.max(0, Math.min(1, u)); return Math.hypot(sg.a.x + dx * u - p.x, sg.a.z + dz * u - p.z) < o.width * 0.5; }));
    if (!over) continue;
    if (k++ > 10) break;
    for (const s of [1, -1]) test('under', p.x, sim.terrainAt(p.x, p.z), p.z, p.tx * s, p.tz * s);
  }
  Object.assign(g, keep);
  return out;
}
