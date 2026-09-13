// How quickly does a police car get across town?
//
// Routing and driving on their own, with nothing else going on: no pursuit, no
// other police, the player parked out of the way. A patrol car is put on a road
// and sent to a junction 380-650 m away as the crow flies, the way a unit responding to a
// call is, and timed until it is within 25 m. The same trips every run (their
// own seeded random numbers, not the game's), so the numbers can be compared
// between versions of the game -- this file only uses what the game has
// exposed for a long time, so it can be pointed at an older copy.
//
//   average speed   route length / time taken, the number that says "slow"
//   route ratio     distance actually driven / shortest road route
//   off road        share of time more than 6 m outside the carriageway
//   stuck           seconds spent below 1.5 m/s
window.__runResponse = async function (trips = 12, timeout = 80, seedValue = 0x5eed1234) {
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.player); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const g = window.__game, M = window.__modules, gr = g.graph, p = g.player;
    if (g.audio) g.audio.muted = true;
    g.onBusted = () => { g.outcome = null; };
    g.onEscaped = () => { g.outcome = null; };

    // A quiet town: no chase, no roster, nobody else on the road.
    g.heat.reset && g.heat.reset();
    g.heat.value = 0;
    for (const u of g.dispatcher.units.slice()) g.dispatcher.retire(u);
    const realDispatch = g.dispatcher.update;
    g.dispatcher.update = () => {};
    if (g.roadblocks && g.roadblocks.reset) g.roadblocks.reset();

    // Park the player well outside the road network.
    let maxX = -1e9, maxZ = -1e9;
    for (const n of gr.nodes) { if (n.x > maxX) maxX = n.x; if (n.z > maxZ) maxZ = n.z; }
    const parked = { x: maxX + 60, y: 1, z: maxZ + 60 };
    const park = () => { p.teleport(parked, 0); p.setVelocity({ x: 0, y: 0, z: 0 }); };
    park();

    // Seeded, so every version of the game gets the same trips.
    let seed = seedValue;
    const rnd = () => {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    // Trips are chosen as places on the map, not as node numbers: the road
    // graph gains and loses nodes between versions (crossings stitched in, for
    // one), and the same index is a different junction in each.
    let minX = 1e9, minZ = 1e9;
    for (const n of gr.nodes) { if (n.x < minX) minX = n.x; if (n.z < minZ) minZ = n.z; }
    const junctionNear = (x, z) => {
      let best = null, bd = Infinity;
      for (const n of gr.nodes) {
        if (!n || !n.edges || n.edges.length < 3) continue;
        const d = Math.hypot(n.x - x, n.z - z);
        if (d < bd) { bd = d; best = n; }
      }
      return best;
    };
    const somewhere = () => junctionNear(minX + rnd() * (maxX - minX), minZ + rnd() * (maxZ - minZ));
    const routeLength = (pts) => {
      let L = 0;
      for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
      return L;
    };

    const rows = [];
    let unit = null;
    const origU = g._update.bind(g);
    g._update = (dt) => {
      origU(dt);
      if (unit) unit.update(dt, p);
    };

    let attempts = 0;
    while (rows.length < trips && attempts++ < 400) {
      const a = somewhere();
      const b = somewhere();
      if (!a || !b || a === b) continue;
      const crow = Math.hypot(a.x - b.x, a.z - b.z);
      if (crow < 380 || crow > 650) continue;
      const place = g._placeOnRoad(a);
      if (!place) continue;
      const pos = place.position;
      const fx = Math.sin(place.heading), fz = Math.cos(place.heading);
      const route = gr.pathFromPosition(pos.x, pos.z, fx, fz, b.id, 0);
      const L = routeLength(route);
      if (route.length < 2) continue;

      park();
      unit = g.spawnPoliceAt({ x: pos.x, y: 0.95, z: pos.z }, place.heading, 3);
      if (!unit) continue;
      const goal = new M.THREE.Vector3(b.x, 0, b.z);
      unit.setRole(M.ROLE.RESPOND, { point: goal });

      const v = unit.vehicle;
      let t = 0, driven = 0, stuck = 0, off = 0, samples = 0, top = 0;
      let lx = v.position.x, lz = v.position.z;
      const speeds = [];
      let reached = false;
      while (t < timeout) {
        g.stepHeadless(0.1);
        t += 0.1;
        driven += Math.hypot(v.position.x - lx, v.position.z - lz);
        lx = v.position.x; lz = v.position.z;
        speeds.push(v.speed);
        top = Math.max(top, v.speed);
        if (v.speed < 1.5) stuck += 0.1;
        const snap = gr.nearestEdge(v.position.x, v.position.z);
        if (snap) {
          const d = Math.hypot(v.position.x - snap.x, v.position.z - snap.z);
          if (d - snap.edge.width * 0.5 > 6) off++;
        }
        samples++;
        if (Math.hypot(v.position.x - goal.x, v.position.z - goal.z) < 25) { reached = true; break; }
        if (samples % 100 === 0) await new Promise((r) => setTimeout(r, 0));
      }
      speeds.sort((x, y) => x - y);
      rows.push({
        from: [Math.round(a.x), Math.round(a.z)], to: [Math.round(b.x), Math.round(b.z)],
        route: Math.round(L), reached, secs: +t.toFixed(1),
        avgKph: reached ? +((L / t) * 3.6).toFixed(1) : null,
        medianKph: +(speeds[speeds.length >> 1] * 3.6).toFixed(1),
        topKph: +(top * 3.6).toFixed(0),
        routeRatio: +(driven / L).toFixed(2),
        offRoadPct: +(100 * off / samples).toFixed(1),
        stuckSecs: +stuck.toFixed(1),
        damage: +v.damage.toFixed(2),
      });
      g.dispatcher.retire(unit);
      unit = null;
    }

    g._update = origU;
    g.dispatcher.update = realDispatch;
    if (g.audio) g.audio.muted = false;

    const ok = rows.filter((r) => r.reached);
    const sum = (f) => rows.reduce((s, r) => s + f(r), 0);
    const med = (arr) => { const s = arr.slice().sort((x, y) => x - y); return s.length ? s[s.length >> 1] : null; };
    window.__res = JSON.stringify({
      trips: rows.length,
      reached: ok.length,
      totalSecs: +sum((r) => r.secs).toFixed(1),
      avgKph: ok.length ? +((ok.reduce((s, r) => s + r.route, 0) / ok.reduce((s, r) => s + r.secs, 0)) * 3.6).toFixed(1) : null,
      medianKph: med(rows.map((r) => r.medianKph)),
      routeRatioMedian: med(rows.map((r) => r.routeRatio)),
      offRoadPct: +(sum((r) => r.offRoadPct) / rows.length).toFixed(1),
      stuckSecs: +sum((r) => r.stuckSecs).toFixed(1),
      rows,
    });
  } catch (e) {
    window.__res = 'EX: ' + e.message + ' | ' + (e.stack || '').slice(0, 300);
  }
};
