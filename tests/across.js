// Across the open ground, or round by road?
//
// "There was this like break in buildings, quite a big gap, and then it could
// literally have just gone across the grass to the last known location ... but
// instead it just went all the way around." Officer._crossCountry lets a unit
// heading for a point drive straight at it when the line there is open and the
// road is the long way round. This finds such places on the map -- a point
// 60-200 m away with nothing standing on the straight line, and a road route
// at least 1.5 times as long -- puts a responding unit there, and times it.
//
//   await import('/tests/across.js');
//   await __runAcross(12);         // -> window.__res; window.__crossCountry = false for the old way
window.__runAcross = async function (cases = 12, timeout = 40) {
  window.__acrossDone = false;
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.player); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const g = window.__game, gr = g.graph;
    const { SKILL, ROLE, Officer } = window.__modules;
    const W = await import('/src/physics/world.js');
    g.paused = true;
    g.heat.value = 0;
    g.onBusted = () => { g.outcome = null; };
    let seed = 4242;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

    // Places: a road point and a target point with an open straight line and
    // a long road way round.
    const found = [];
    for (let tries = 0; tries < 4000 && found.length < cases; tries++) {
      const e = gr.edges[Math.floor(rnd() * gr.edges.length)];
      if (e.cut || e.length < 30) continue;
      const a = gr.pointAt(e, 10 + rnd() * (e.length - 20));
      const ang = rnd() * Math.PI * 2, dist = 60 + rnd() * 140;
      const b = { x: a.x + Math.sin(ang) * dist, z: a.z + Math.cos(ang) * dist };
      const sv = g.sim.surfaceAt(b.x, b.z);
      if (sv === undefined) continue;
      const dir = { x: Math.sin(ang), y: 0, z: Math.cos(ang) };
      const toi = W.sweepBox(g.world, { x: a.x, y: 1.2, z: a.z }, dir, dist, W.RAY_GROUNDS, null, 1.6);
      if (toi < dist - 2) continue;
      const goal = gr.nearestNode(b.x, b.z);
      const pts = gr.pathFromPosition(a.x, a.z, dir.x, dir.z, goal.id, 0);
      if (!pts || pts.length < 2) continue;
      let L = 0;
      for (let k = 1; k < pts.length; k++) L += Math.hypot(pts[k].x - pts[k - 1].x, pts[k].z - pts[k - 1].z);
      if (L < dist * 1.5 + 30) continue;
      found.push({ a, b, ang, dist, road: L });
    }

    const rows = [];
    let reached = 0, tSum = 0, hits = 0;
    for (const c of found) {
      const car = g.createVehicle('interceptor', 'interceptor', { x: c.a.x, y: 0.95, z: c.a.z }, c.ang, { police: true });
      const o = new Officer(g, car, { skill: SKILL.pursuit, kind: 'interceptor' });
      o.setRole(ROLE.RESPOND, { point: { x: c.b.x, y: 0, z: c.b.z } });
      o.orders.point = { x: c.b.x, y: 0, z: c.b.z };
      car._readState();
      let t = 0, got = null, lastAt = 0, h = 0, across = 0;
      for (let f = 0; f < timeout * 60; f++) {
        o.update(1 / 60, g.player);
        g.stepHeadless(1 / 60);
        t += 1 / 60;
        if (o._mode === 'across') across++;
        if (car.lastImpactAt && car.lastImpactAt !== lastAt && car.lastImpact > 4) { lastAt = car.lastImpactAt; h++; }
        if (Math.hypot(car.position.x - c.b.x, car.position.z - c.b.z) < 25) { got = t; break; }
      }
      g.despawnPolice(o);
      if (got !== null) { reached++; tSum += got; }
      hits += h;
      rows.push(`${Math.round(c.dist)} m straight, ${Math.round(c.road)} m by road: `
        + `${got === null ? 'not there' : got.toFixed(1) + ' s'}, across ${(across / 60).toFixed(1)} s, hits ${h}`);
      await new Promise((r) => setTimeout(r, 0));
    }
    g.paused = false;
    window.__res = `${found.length} places, reached ${reached}, mean ${(tSum / Math.max(1, reached)).toFixed(1)} s, hits ${hits}\n`
      + rows.join('\n');
  } catch (e) {
    window.__res = 'EX: ' + e.message + ' | ' + (e.stack || '').slice(0, 300);
  }
  window.__acrossDone = true;
  return window.__res;
};
