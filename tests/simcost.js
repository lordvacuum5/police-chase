// Where a frame of simulation goes. "It is still laggy. Like on my laptop."
//   const m = await import('/tests/simcost.js');  await m.simCost()      // window.__sc
// Headless at 1/60 from the motorway, a street, and a street at five stars: ms a frame, all told and in each of the
// methods wrapped (nested ones are inside their callers). The wrapping itself costs a little.
import { places } from './drawcost.js';
const breathe = () => new Promise((r) => setTimeout(r));

export async function simCost(opts = {}) {
  const g = window.__game;
  g.paused = true;
  const acc = {}, n = {}, undo = [];
  // Never caught, and driven along random routes by the game's own driver: a car stood still is soon busted, and a force
  // with nobody to chase costs nothing.
  const bust = g.heat._checkBust, on = [g.onBusted, g.onEscaped];
  g.heat._checkBust = () => {};
  g.onBusted = g.onEscaped = () => { g.outcome = null; };
  undo.push(() => { g.heat._checkBust = bust; [g.onBusted, g.onEscaped] = on; });
  const { Driver, SKILL } = window.__modules;
  let seed = opts.seed || 4711, drv = null;
  const rng = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return ((seed >>> 0) % 1e6) / 1e6; };
  const drive = (dt) => {
    const p = g.player, gr = g.graph;
    if (p.damage > 0.4) p.repair();
    for (let k = 0; k < 30 && (!drv || !drv.hasPath || drv.remaining(20) < 20); k++) {
      const a = gr.nearestNode(p.position.x, p.position.z, p.position.y), b = gr.randomNode(rng), path = a && b && gr.route(a.id, b.id);
      if (path && path.length > 4) { drv = new Driver(p, SKILL.pursuit); drv.setPath(gr.pathToPoints(path, 2.5, true)); }
    }
    return drv ? drv.followPath(dt, 30) : { throttle: 0.3, brake: 0, steer: 0, handbrake: 0 };
  };
  const wrap = (o, k, name = k) => {
    const d = o && Object.getOwnPropertyDescriptor(o, k), f = o && (d ? d.value : o[k]);
    if (typeof f !== 'function') return;
    o[k] = function (...a) { const t = performance.now(); const r = f.apply(this, a); acc[name] = (acc[name] || 0) + performance.now() - t; n[name] = (n[name] || 0) + 1; return r; };
    undo.push(() => { if (d) o[k] = f; else delete o[k]; });
  };
  const all = (o, pre, skip = []) => { for (const k of Object.getOwnPropertyNames(o)) { const d = Object.getOwnPropertyDescriptor(o, k); if (k !== 'constructor' && typeof d.value === 'function' && !skip.includes(k)) wrap(o, k, `${pre}.${k}`); } };
  const V = Object.getPrototypeOf(g.player);
  all(V, 'v', ['_gearRatio', '_tractionFactor', 'wheelCentre', '_bestGear']);
  for (const k of ['update', '_glide', '_route', '_sirenNear', '_pace', '_spawn', '_trySpawn']) wrap(Object.getPrototypeOf(g.traffic), k, `traffic.${k}`);
  all(Object.getPrototypeOf(g.dispatcher), 'd');
  if (opts.police) {
    const u = g.dispatcher.units[0] || (g.heat.value = 2, g.stepHeadless(12), g.dispatcher.units[0]);
    if (u) {
      for (let o = Object.getPrototypeOf(u); o && o !== Object.prototype; o = Object.getPrototypeOf(o)) all(o, 'o');
      for (let o = Object.getPrototypeOf(u.driver); o && o !== Object.prototype; o = Object.getPrototypeOf(o)) all(o, 'dr', ['remaining']);
    }
    for (const k of ['castRay', 'castShape', 'castRayAndGetNormal', 'intersectionsWithShape', 'contactPairsWith', 'projectPoint', 'intersectionWithShape']) wrap(g.world, k, `w.${k}`);
    for (const k of Object.keys(g.sim)) if (typeof g.sim[k] === 'function') wrap(g.sim, k, `sim.${k}`);
    for (const k of ['nearestEdgeTo', 'nearestNode', 'levelOn', 'pointAt', 'findPath', 'route']) wrap(Object.getPrototypeOf(g.graph), k, `graph.${k}`);
  }
  wrap(g.world, 'step', 'physics');
  for (const k of ['suspects', 'props', 'signals', 'roadblocks', 'parkedCars', 'helicopter', 'heat', 'score', 'dents', 'known']) if (g[k] && g[k].update) wrap(g[k], 'update', k);
  const G = Object.getPrototypeOf(g);
  for (const k of Object.getOwnPropertyNames(G)) { const d = Object.getOwnPropertyDescriptor(G, k); if (/^_/.test(k) && typeof d.value === 'function' && !/^_(update|loop|render|init|boot)/.test(k)) wrap(G, k, `g.${k}`); }
  const out = window.__sc = {};
  try {
    const P = places();
    for (const [name, stars, key] of [['motorway', 0, 'motorway'], ['street', 0, 'downtown'], ['street5', 5, 'downtown']]) {
      if (opts.only && !opts.only.includes(name)) continue;
      const v = P[key];
      g.player.teleport({ x: v[0], y: v[1] - 2, z: v[2] }, Math.atan2(v[3], v[4]));
      drv = null;
      const cam = () => { const q = g.player, c = g.camera; c.position.set(q.position.x - q.forward.x * 8, q.position.y + 3, q.position.z - q.forward.z * 8); c.lookAt(q.position.x, q.position.y, q.position.z); };
      const step = () => { if (stars) g.heat.value = stars; cam(); g.stepHeadless(1 / 60, drive(1 / 60)); };
      for (let k = 0; k < (stars ? 1500 : 450); k++) { step(); if (k % 60 === 0) await breathe(); }
      for (const k in acc) { acc[k] = 0; n[k] = 0; }
      const per = [];
      for (let k = 0; k < 20; k++) {
        for (let f = 0; f < 30; f++) { const t = performance.now(); step(); per.push(performance.now() - t); }
        await breathe();
      }
      per.sort((a, b) => a - b);
      out[name] = {
        mean: +(per.reduce((a, b) => a + b, 0) / per.length).toFixed(2), median: +per[300].toFixed(2), p95: +per[570].toFixed(2), worst: +per[599].toFixed(1), cars: g.vehicles.length, awake: g.vehicles.filter((q) => !q.dormant).length, half: g.vehicles.filter((q) => q._half).length, units: g.dispatcher.units.map((u) => `${Math.round(u.vehicle.speed)}@${Math.round(u.distanceTo ? Math.hypot(u.position.x - g.player.position.x, u.position.z - g.player.position.z) : 0)}`).join(' '),
        top: Object.entries(acc).map(([k, x]) => [k, +(x / per.length).toFixed(2), +(n[k] / per.length).toFixed(1)]).sort((a, b) => b[1] - a[1]).slice(0, opts.top || 34).map((x) => x.join(' ')),
      };
      g.heat.value = 0;
    }
  } finally { for (const u of undo.reverse()) u(); }
  out.done = true;
  return out;
}
