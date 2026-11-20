// How alike are the daily challenge's routes from one day to the next, on the map that is loaded?
//
// "It needs to create loads of new routes because it's basically the same route every single time on each
// map. It wasn't exactly the same route, but it was very similar." The day's route for `days` days in a row
// on this map (pickRoute, which is what DailyChallenge.build uses), and for every pair of days how much of
// the shorter route is road the other one also drives:
//
//   const m = await import('/tests/dailyroutes.js');  m.routeOverlap(30, '2026-11-21', 'new')
//
// `days` is how many of the days that land on this map (dailyPlan) to take, from `from` on; `mode` is
// pickRoute's: 'old' (as every day up to 20 November) or 'new'.
//
//   pairs     mean share of road two days have in common, 0..1
//   next      the same, each day against the last day on this map
//   over50    pairs that share more than half their road
//   hot       the share of all route-metres that is on the most-driven tenth of the edges used
//   starts    distinct start nodes
import { pickRoute, dailyPlan } from '/src/game/daily.js';

export function routeOverlap(days = 30, from = '2026-11-21', mode = 'new') {
  const g = window.__game, gr = g.graph, mapId = g.mapDef.id;
  const d0 = new Date(from + 'T00:00:00Z');
  const sets = [];
  const use = new Map();
  let missing = 0;
  const starts = new Set();
  for (let i = 0, n = 0; n < days && i < 400; i++) {
    const day = new Date(d0.getTime() + i * 86400000).toISOString().slice(0, 10);
    if (dailyPlan(day).mapId !== mapId) continue;
    n++;
    const r = pickRoute(g, day, mapId, mode);
    if (!r) { missing++; continue; }
    const m = new Map();
    for (let k = 0; k < r.path.length - 1; k++) {
      const e = gr.edgeBetween(r.path[k], r.path[k + 1]);
      if (e) m.set(e.id, e.length);
    }
    starts.add(r.path[0]);
    sets.push(m);
    for (const [id, l] of m) use.set(id, (use.get(id) || 0) + l);
  }
  const len = (m) => { let s = 0; for (const l of m.values()) s += l; return s; };
  let sum = 0, n = 0, over = 0;
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      let shared = 0;
      for (const [id, l] of sets[i]) if (sets[j].has(id)) shared += l;
      const share = shared / Math.min(len(sets[i]), len(sets[j]));
      sum += share; n++;
      if (share > 0.5) over++;
    }
  }
  // One day on this map against the one before it on this map: what a player who comes back sees.
  let next = 0;
  for (let i = 1; i < sets.length; i++) {
    let shared = 0;
    for (const [id, l] of sets[i]) if (sets[i - 1].has(id)) shared += l;
    next += shared / Math.min(len(sets[i]), len(sets[i - 1]));
  }
  const total = [...use.values()].reduce((a, b) => a + b, 0);
  const top = [...use.values()].sort((a, b) => b - a);
  const hot = top.slice(0, Math.max(1, Math.round(top.length * 0.1))).reduce((a, b) => a + b, 0) / total;
  return { map: mapId, mode, days, found: sets.length, missing, pairs: +(sum / n).toFixed(3), next: +(next / Math.max(1, sets.length - 1)).toFixed(3), over50: `${over}/${n}`, hot: +hot.toFixed(2), edgesUsed: use.size, starts: starts.size };
}
