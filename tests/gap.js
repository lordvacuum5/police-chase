// Can a police car take a gap between two buildings at speed?
//
// The map of the gaps turned out to be worth nothing on its own -- see CUTS_ON in
// world/cutgraph.js -- because a unit routed through one spends about a third of
// its time in there under 4 m/s. Knowing the way through is no use at a crawl.
//
// So this isolates the drive itself: one car, one gap, no target, no dispatcher,
// no roster. It is put on the approach at speed and told to follow the way
// through, and what comes back is what it managed and what stopped it. Driver.caps
// records every speed limit every frame, so the answer to "why is it slow here" is
// read rather than guessed -- the lesson of the first afternoon spent on the wall
// clamp, which was not the limit in force.
//
//   through      how many gaps it got out the far side of
//   in the gap   mean and slowest speed between entering and leaving
//   crawling     share of the time inside under 15 km/h
//   capped by    which limit was the binding one while inside
import { buildCutGraph } from '../src/world/cutgraph.js';

/** How close to the narrowest point counts as being in the gap. */
const INSIDE = 26;

window.__runGap = async function (kph = 70, tweak = null, label = '', limit = 20) {
  window.__gapDone = false;
  window.__res = null;
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.player); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const g = window.__game;
    // Built once. Building twice finds nothing the second time -- every pair is
    // already joined by the cut from the first run, so findCuts skips it -- which
    // is how this rig came to report zero gaps on a graph that had 41 in it.
    let have = g.graph.edges.filter((e) => e.cut && e.narrowest);
    if (!have.length) {
      g.world.step();
      buildCutGraph(g.graph, g.world, 1000);
      have = g.graph.edges.filter((e) => e.cut && e.narrowest);
    }
    const cuts = have.slice(0, limit).map((e) => ({
      a: e.a, b: e.b, width: e.width, narrowest: e.narrowest, points: e.points,
    }));

    const rows = [];
    let through = 0, n = 0, sum = 0, slowest = 99, crawl = 0, hits = 0;
    const bind = {};
    for (let i = 0; i < cuts.length; i++) {
      const r = run(cuts[i], kph, tweak);
      if (!r) continue;
      n++;
      if (r.through) through++;
      sum += r.mean; slowest = Math.min(slowest, r.min); crawl += r.crawl; hits += r.hits;
      for (const k of Object.keys(r.bind)) bind[k] = (bind[k] || 0) + r.bind[k];
      rows.push(r.line);
      await new Promise((res) => setTimeout(res, 0));
    }
    const total = Object.values(bind).reduce((a, b) => a + b, 0) || 1;
    const caps = Object.keys(bind).sort((a, b) => bind[b] - bind[a])
      .map((k) => `${k} ${Math.round((bind[k] * 100) / total)}%`).join(' ');
    rows.push(`${label ? label + '  ' : ''}${n} gaps:  through ${through}/${n}  `
      + `in the gap mean ${Math.round(sum / n)} kph, slowest ${Math.round(slowest)}  `
      + `crawling ${Math.round((crawl * 100) / n)}%  hits ${hits}  | capped by ${caps}`);
    window.__res = rows.join('\n');
    window.__gapDone = true;
    return window.__res;
  } catch (e) {
    window.__gapDone = true;
    window.__res = 'EX: ' + e.message + ' | ' + (e.stack || '').slice(0, 400);
    return window.__res;
  }
};

function run(cut, kph, tweak) {
  const g = window.__game;
  const gr = g.graph;
  const { SKILL, ROLE, Officer } = window.__modules;
  const a = gr.nodes[cut.a];
  if (!a) return null;

  g.onBusted = () => { g.outcome = null; g.heat.bustTimer = 0; };
  g.onEscaped = () => { g.outcome = null; };
  g.paused = true;
  g.heat.value = 5;

  // Facing the way through, at the mouth of it.
  const p1 = cut.points[1] || cut.points[0];
  const h = Math.atan2(p1.x - a.x, p1.z - a.z);
  const speed = kph / 3.6;

  const car = g.createVehicle('interceptor', 'interceptor',
    { x: a.x - Math.sin(h) * 6, y: 0.95, z: a.z - Math.cos(h) * 6 }, h, { police: true });
  if (!car) { g.paused = false; return null; }
  const o = new Officer(g, car, { skill: SKILL.pursuit, kind: 'interceptor' });
  o.setRole(ROLE.PURSUE);
  o.driver.allowOffRoad = true;
  car.setVelocity({ x: Math.sin(h) * speed, y: 0, z: Math.cos(h) * speed });
  car._readState();

  // The way through, as the router gives it.
  const path = gr.route(cut.a, cut.b, Infinity, { cuts: true, minWidth: 2.4 });
  if (!path || path.length < 2) { g.despawnPolice(o); g.paused = false; return null; }
  o.driver.setPath(gr.pathToPoints(path, 0, true, 9));

  const bEnd = gr.nodes[cut.b];
  let frames = 0, inside = 0, sum = 0, min = 999, crawl = 0, hits = 0;
  let got = false, lastImpact = 0;
  const bind = {};
  for (let i = 0; i < 22 * 60; i++) {
    // Band assistance needs a target to scale against; there is none here, so the
    // car runs on its own merits. That is the honest test of the driving.
    o.driver.allowOffRoad = true;
    const ctl = o.driver.followPath(1 / 60, car.spec.topSpeedHint);
    if (tweak) tweak(o.driver, o, car);
    car.setControls(ctl);
    g.stepHeadless(1 / 60);
    frames++;

    const d = Math.hypot(car.position.x - cut.narrowest.x, car.position.z - cut.narrowest.z);
    if (d < INSIDE) {
      inside++;
      const kmh = car.speed * 3.6;
      sum += kmh;
      min = Math.min(min, kmh);
      if (kmh < 15) crawl++;
      const c = o.driver.caps;
      let who = 'asked', low = c.asked;
      for (const k of ['safe', 'wall', 'way', 'slide']) if (c[k] < low - 0.01) { low = c[k]; who = k; }
      if (who === 'safe') {
        let w2 = 'sClear', l2 = c.sClear;
        for (const k of ['sTravel', 'sRunout', 'sArc', 'sBack']) if (c[k] < l2 - 0.01) { l2 = c[k]; w2 = k; }
        who = w2.slice(1);
      }
      bind[who] = (bind[who] || 0) + 1;
    }
    if (car.lastImpactAt && car.lastImpactAt !== lastImpact && car.lastImpact > 4) {
      lastImpact = car.lastImpactAt;
      hits++;
    }
    // Out the far side.
    if (bEnd && Math.hypot(car.position.x - bEnd.x, car.position.z - bEnd.z) < 14) { got = true; break; }
  }

  g.despawnPolice(o);
  g.paused = false;
  g.heat.reset();

  return {
    line: `  gap w ${cut.width.toFixed(1)} m  ${got ? 'through' : 'STUCK  '}  `
      + `in ${(inside / 60).toFixed(1)}s  mean ${Math.round(sum / Math.max(1, inside))} kph  `
      + `min ${Math.round(min)}  crawling ${Math.round((crawl * 100) / Math.max(1, inside))}%  `
      + `hits ${hits}  took ${(frames / 60).toFixed(1)}s`,
    through: got,
    mean: sum / Math.max(1, inside),
    min,
    crawl: crawl / Math.max(1, inside),
    hits,
    bind,
  };
}
