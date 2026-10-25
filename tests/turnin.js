// Right-angle junctions, one at a time, the way units actually arrive at them.
//
// "I'll come to a junction, and they'll do 90 degrees, instead of just kind of
// cutting the corner off." and "They need to like turn into the corners ...
// didn't they have a racing line?" tests/corners.js plans each leg once, so it
// never sees what a unit that re-plans every second and a half does at the
// junction ahead. This puts a pursuit unit 60 m short of each of fourteen
// right-angle junctions on Wexbury at 58 km/h, routes it round the corner,
// re-plans every 1.4 s as _goTo does, and reports per setting:
//
//   made      how many it got round to 30 m down the exit within 7 s
//   exit      mean time to get there -- the number that matters
//   slowest   mean of the lowest speed within 25 m of the junction
//   hits / grass / footway   contacts, and frames off the carriageway
//
//   await import('/tests/turnin.js');
//   __runTurnIn([[16, 2.4], [24, 0]]);   // [corner, lane] pairs; window.__res
import { freeLine } from '../src/ai/freeline.js';

window.__runTurnIn = async function (settings = [[16, 2.4]], count = 14, tweak = null) {
  window.__turnDone = false;
  window.__res = null;
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.player); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const g = window.__game;
    const { SKILL } = window.__modules;
    const gr = g.graph;
    g.paused = true;
    g.heat.value = 0;
    g.onBusted = () => { g.outcome = null; };

    const sites = [];
    for (const n of gr.nodes) {
      if (gr.roadDegree(n) < 3) continue;
      const es = n.edges.map((id) => gr.edges[id]).filter((e) => !e.cut && e.length > 60 && e.width < 11);
      for (const a of es) {
        for (const b of es) {
          if (a === b) continue;
          const pa = gr.pointAt(a, a.a === n.id ? 20 : a.length - 20);
          const pb = gr.pointAt(b, b.a === n.id ? 20 : b.length - 20);
          const ax = pa.x - n.x, az = pa.z - n.z, bx = pb.x - n.x, bz = pb.z - n.z;
          const c = (ax * bx + az * bz) / Math.hypot(ax, az) / Math.hypot(bx, bz);
          if (Math.abs(c) < 0.2) sites.push({ n, a, b });
        }
      }
      if (sites.length >= count + 2) break;
    }

    const run = (corner, lane, site) => {
      const { n, a, b } = site;
      const other = (e) => (e.a === n.id ? e.b : e.a);
      const endNode = gr.nodes[other(b)];
      const ps = gr.pointAt(a, a.a === n.id ? 60 : a.length - 60);
      const tw = { x: n.x - ps.x, z: n.z - ps.z };
      const L = Math.hypot(tw.x, tw.z);
      const h = Math.atan2(tw.x / L, tw.z / L);
      const o = g.spawnPoliceAt({ x: ps.x, y: 0.95, z: ps.z }, h, 2);
      if (!o) return null;
      o.skill = SKILL.pursuit;
      o.driver.allowOffRoad = true;
      o.driver.limitScale = 3;
      o.driver.arcFloor = 13;
      if (tweak) tweak(o);
      const v = o.vehicle;
      v.setVelocity({ x: Math.sin(h) * 16, y: 0, z: Math.cos(h) * 16 });
      v._readState();
      let minKph = 999, hit = 0, last = 0, grass = 0, paved = 0, t = 0, tExit = null;
      const pb = gr.pointAt(b, b.a === n.id ? 30 : b.length - 30);
      for (let f = 0; f < 7 * 60; f++) {
        if (f % 84 === 0) {
          const pts = gr.pathFromPosition(v.position.x, v.position.z, v.forward.x, v.forward.z,
            endNode.id, lane, Infinity, v.speed, corner);
          // The open-ground line, as Officer._routeTo would hand it over.
          if (pts.length > 1 && window.__freeLine !== false) {
            o.driver.setPath(freeLine(g, pts, v, { halfWidth: o.driver.halfWidth, grass: window.__freeGrass === true }));
            o.driver.freeLined = true;
          } else if (pts.length > 1) { o.driver.setPath(pts); o.driver.freeLined = false; }
        }
        v.setControls(o.driver.followPath(1 / 60, 60));
        g.stepHeadless(1 / 60);
        t += 1 / 60;
        const d = Math.hypot(v.position.x - n.x, v.position.z - n.z);
        if (d < 25) {
          minKph = Math.min(minKph, v.speed * 3.6);
          const s = g.sim.surfaceAt(v.position.x, v.position.z);
          if (s === 0) grass++;
          if (s === 2) paved++;
        }
        if (tExit === null && t > 2 && Math.hypot(v.position.x - pb.x, v.position.z - pb.z) < 12) tExit = t;
        if (v.lastImpactAt && v.lastImpactAt !== last && v.lastImpact > 4) { last = v.lastImpactAt; hit++; }
      }
      g.dispatcher.retire(o);
      return { minKph, grass, paved, hit, tExit };
    };

    const rows = [];
    for (const [corner, lane] of settings) {
      const s = { made: 0, t: 0, k: 0, hit: 0, grass: 0, paved: 0, n: 0 };
      for (const site of sites.slice(0, count)) {
        const r = run(corner, lane, site);
        if (!r) continue;
        s.n++;
        if (r.tExit !== null) { s.made++; s.t += r.tExit; }
        s.k += r.minKph; s.hit += r.hit; s.grass += r.grass; s.paved += r.paved;
        await new Promise((res) => setTimeout(res, 0));
      }
      rows.push(`corner ${corner} lane ${lane}: made ${s.made}/${s.n}, mean exit ${(s.t / Math.max(1, s.made)).toFixed(2)} s, `
        + `mean slowest ${Math.round(s.k / Math.max(1, s.n))} kph, hits ${s.hit}, grass ${s.grass}, footway ${s.paved}`);
    }
    g.paused = false;
    window.__res = rows.join('\n');
  } catch (e) {
    window.__res = 'EX: ' + e.message + ' | ' + (e.stack || '').slice(0, 300);
  }
  window.__turnDone = true;
  return window.__res;
};
