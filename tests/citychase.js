// A long chase round a map, watching for police and traffic that stop and never get going again.
//
// "Police car got stuck." The game's own driver takes your car down long routes between random places, three
// stars after it held on, and every second each police car and each traffic car is checked:
//
//   await import('/tests/citychase.js');  __runCityChase(300);   // then window.__cc
//
//   copStuck   police cars that moved under 5 m in 15 s while more than 60 m from you (a roadblock or hold excepted):
//              each with where, its role and mode, and the last line of its flight recorder
//   carStuck   traffic cars that moved under 3 m in 30 s away from a red light, with where
//   fell       any car more than 3 m under the ground or the deck it is over
export async function runCityChase(secs = 300, seed = 12345) {
  const g = window.__game, p = g.player, gr = g.graph;
  const { Driver, SKILL } = window.__modules;
  g.onBusted = () => { g.outcome = null; g.heat.bustTimer = 0; };
  g.onEscaped = () => { g.outcome = null; };
  if (g.heat._checkBust) g.heat._checkBust = () => {};
  g.heat.bump(1, 'a probe');
  g.heat.value = 3;
  const rng = (() => { let s = seed; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 1e6) / 1e6; }; })();
  let drv = null, routes = 0, t = 0, moves = 0;
  const newRoute = () => {
    for (let k = 0; k < 30; k++) {
      const a = gr.nearestNode(p.position.x, p.position.z, p.position.y);
      const b = gr.randomNode(rng);
      const path = a && b && gr.route(a.id, b.id);
      if (path && path.length > 4) {
        drv = new Driver(p, SKILL.pursuit);
        drv.setPath(gr.pathToPoints(path, 2.5, true));
        routes++;
        return;
      }
    }
  };
  const hist = new Map();           // vehicle -> [{t, x, z}]
  const copStuck = [], carStuck = [], fell = [];
  const flagged = new Set();
  const keep = (v, n) => {
    let h = hist.get(v);
    if (!h) hist.set(v, (h = []));
    h.push({ t, x: v.position.x, z: v.position.z });
    while (h.length > n) h.shift();
    return h;
  };
  const moved = (h) => Math.hypot(h[h.length - 1].x - h[0].x, h[h.length - 1].z - h[0].z);
  newRoute();
  while (t < secs) {
    for (let j = 0; j < 60; j++) {
      if (!drv || drv.remaining() < 15) newRoute();
      gr.queryY = p.position.y - 0.9;
      const c = drv.followPath(1 / 60);
      gr.queryY = null;
      g.stepHeadless(1 / 60, c);
    }
    t += 1;
    // Pinned (busting is off here, so a boxed-in car stays boxed in and everything round it stops): put down
    // somewhere 400 m or more off, and the police's histories started again, their target having jumped.
    const ph = keep(p, 9);
    if (ph.length >= 9 && moved(ph) < 5) {
      for (let k = 0; k < 50; k++) {
        const n = gr.randomNode(rng);
        if (!n || n.elevated || Math.hypot(n.x - p.position.x, n.z - p.position.z) < 400) continue;
        const place = g._placeOnRoad(n);
        if (!place) continue;
        p.teleport(place.position, place.heading);
        p.setVelocity({ x: 0, y: 0, z: 0 });
        if (p.repair) p.repair();
        p._readState();
        hist.clear();
        drv = null;
        moves++;
        break;
      }
    }
    g.heat.value = Math.max(g.heat.value, 3);
    g.dispatcher.knowledge.seen = true;
    g.dispatcher.knowledge.position.copy(p.position);
    const pp = p.position;
    for (const u of g.dispatcher.units) {
      const v = u.vehicle;
      if (!v || v.isAircraft) continue;
      const h = keep(v, 16);
      if (h.length < 16 || flagged.has(v)) continue;
      const far = Math.hypot(v.position.x - pp.x, v.position.z - pp.z);
      // An interceptor at its junction waits there on purpose (Officer._intercept, holdStill).
      const waiting = u.role === 'intercept' && u.driver && u.driver.remaining() < 26;
      if (moved(h) < 5 && far > 60 && !waiting && !/block|hold/i.test(String(u.role))) {
        flagged.add(v);
        const last = u.trace && u.trace[u.trace.length - 1];
        // And the whole flight recorder, for working out what held it.
        (window.__ccTraces = window.__ccTraces || []).push({ t, callsign: u.callsign, trace: (u.trace || []).slice() });
        copStuck.push({ t, x: Math.round(v.position.x), y: +v.position.y.toFixed(1), z: Math.round(v.position.z), role: u.role, mode: u._mode || null, far: Math.round(far), last });
      }
    }
    for (const c of g.traffic.cars) {
      const v = c.v;
      const h = keep(v, 31);
      if (h.length < 31 || flagged.has(v)) continue;
      if (moved(h) < 3 && !(c.driver && c.driver.heldBy)) {
        flagged.add(v);
        carStuck.push({ t, x: Math.round(v.position.x), y: +v.position.y.toFixed(1), z: Math.round(v.position.z), dormant: !!v.dormant, far: Math.round(Math.hypot(v.position.x - pp.x, v.position.z - pp.z)) });
      }
    }
    for (const v of g.vehicles) {
      const gy = g.sim.terrainAt ? g.sim.terrainAt(v.position.x, v.position.z) : 0;
      if (v.position.y < gy - 3 && fell.length < 10) fell.push({ t, kind: v.specKey, x: Math.round(v.position.x), y: +v.position.y.toFixed(1), z: Math.round(v.position.z), ground: +gy.toFixed(1) });
    }
    for (const v of hist.keys()) if (!g.vehicles.includes(v)) hist.delete(v);
    window.__ccT = t;
    // A breath for the page every 10 s of game, not every one: a hidden page's timers wait a second each.
    if (t % 10 === 0) await new Promise((r) => setTimeout(r, 0));
  }
  window.__cc = { map: g.mapDef.id, secs, routes, moves, units: g.dispatcher.units.length, cars: g.traffic.cars.length, copStuck, carStuck, fell, damage: +p.damage.toFixed(2) };
  return window.__cc;
}
window.__runCityChase = runCityChase;
