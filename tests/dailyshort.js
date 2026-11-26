// How long is the day's challenge, driven? "Every single daily challenge should only be 1 minute ... I want it to take like 30 seconds ...
// or maybe like 40 ... maybe your tests aren't fast enough, so maybe for you, make it 1 minute."
//   const m = await import('/tests/dailyshort.js');  await m.dailyShort({ days: 6 })      // window.__ds
// For each of the next `days` days whose daily is an Escape on the map that is loaded: its route's length, and the game's own driver
// (the police kept off it, so it is the route that is timed) from GO to the finish, s; then the police and blocks as they are, at
// most at once, and whether it got through.
import { dailyPlan, pickRoute } from '/src/game/daily.js';
const breathe = () => new Promise((r) => setTimeout(r));

export async function dailyShort(opts = {}) {
  const g = window.__game, out = window.__ds = { map: g.mapDef.id, days: [] };
  const start = new Date(Date.UTC(2026, 10, 26));
  for (let i = 0, n = 0; i < 60 && n < (opts.days || 6); i++) {
    const day = new Date(start.getTime() + i * 864e5).toISOString().slice(0, 10), plan = dailyPlan(day);
    if (plan.mapId !== g.mapDef.id) continue;
    const r = pickRoute(g, day, g.mapDef.id);
    n++;
    out.days.push({ day, type: plan.type, length: r ? Math.round(r.pts.reduce((a, p, k) => a + (k ? Math.hypot(p.x - r.pts[k - 1].x, p.z - r.pts[k - 1].z) : 0), 0)) : null });
  }
  // Today's (or `day`'s) driven, if it is on this map.
  const d = g.daily;
  if (d && d.route) {
    const { Driver, SKILL } = window.__modules, p = g.player;
    g.paused = true;
    d.begin && d.begin();
    for (let k = 0; k < 300 && d.state === 'countdown'; k++) g.stepHeadless(1 / 60, { throttle: 0, brake: 1, steer: 0, handbrake: 0 });
    const drv = new Driver(p, SKILL.pursuit);
    drv.limitScale = 2.5;
    drv.setPath(d.route.pts.map((q) => ({ x: q.x, z: q.z, edge: q.edge, speed: q.speed || 20 })));
    let most = 0, blocks = 0;
    for (let k = 0; k < 60 * 150 && d.state === 'running'; k++) {
      g.graph.queryY = p.position.y - 0.9;
      const c = drv.followPath(1 / 60, 60);
      g.graph.queryY = null;
      g.stepHeadless(1 / 60, c);
      if (k % 60 === 0) (out.near = out.near || []).push(g.dispatcher.units.filter((u) => !u.vehicle.disabled && u.distanceTo(p.position) < 220).length);
      most = Math.max(most, g.dispatcher.units.filter((u) => !u.vehicle.disabled).length);
      blocks = Math.max(blocks, g.roadblocks.blocks ? g.roadblocks.blocks.length : 0);
      if (k % 60 === 0) await breathe();
    }
    out.driven = { day: d.day, state: d.state, failedBy: d.failedBy, secs: +d.time.toFixed(1), length: Math.round(d.route.length), mostPolice: most, blocks, obstacles: d.obstacles.length, limit: d.limit, panel: document.getElementById('daily').innerText };
  }
  out.done = true;
  return out;
}
