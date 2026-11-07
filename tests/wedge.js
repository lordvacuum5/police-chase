// Wedged between two houses, where a police car cannot come close enough to arrest you.
//
// "You can wedge yourself in between two houses in certain spots on the map, on each map, and
// obviously then the police actually can't bust you ... by petrol stations ... you can kind of fit in
// between ... a relatively tight gap in between the petrol pumps and stuff, and the police can't
// actually get to you."
//
//   await import('/tests/wedge.js');
//   await __wedgeRun(6, 60);    // parked in the tightest gaps found: arrested? how, how soon
//   await __wedgeOpen(10, 45);  // parked out on the roads: the new rule must keep out of these
//   await __wedgeGarage(45);    // parked in the tightest places on a garage forecourt, by the pumps
import { raycast, groups, GROUP } from '../src/physics/world.js';
import { obstacleIndex } from '../src/ai/localplan.js';

const SOLID = groups(0xFFFF, GROUP.BUILDING | GROUP.PROP);

function clearRay(world, x, y, z, dx, dz, max) {
  const hit = raycast(world, { x, y, z }, { x: dx, y: 0, z: dz }, max, SOLID);
  return hit ? hit.toi : Infinity;
}

/**
 * Spots between two buildings. From the middle of each wall of each building, out: another solid thing
 * within 2.2 to 6 m is a gap, and the middle of that is where a car goes, along it.
 */
const STATS = window.__gapStats = { rays: 0, hits: 0, fit: 0, offRoad: 0 };
export function findGaps(g, want, centre = null, span = Infinity) {
  const w = g.world, H = g.sim.heightAt;
  const out = [];
  const boxes = new Set();
  for (const list of obstacleIndex(g).buckets.values()) for (const b of list) boxes.add(b);
  for (const b of boxes) {
    if (out.length >= want * 8) break;
    if (b.hx < 1.5 && b.hz < 1.5 && !centre) continue;
    if (b.hx > 200 || b.hz > 200) continue;
    if (centre && Math.hypot(b.x - centre.x, b.z - centre.z) > span) continue;
    // Every 3 m along each wall, in world space, whichever way the frame turns.
    for (const [lx, lz, along, reach] of [[1, 0, b.hz, b.hx], [-1, 0, b.hz, b.hx], [0, 1, b.hx, b.hz], [0, -1, b.hx, b.hz]]) {
      for (let u = -along + 1; u <= along - 1; u += 3) {
        const wx = lx ? lx * (reach + 0.05) : u, wz = lz ? lz * (reach + 0.05) : u;
        const x0 = b.x + wx * b.c + wz * b.s, z0 = b.z - wx * b.s + wz * b.c;
        let nx = lx * b.c + lz * b.s, nz = -lx * b.s + lz * b.c;
        const y = H(x0, z0) + 0.7;
        const t = clearRay(w, x0, y, z0, nx, nz, 6);
        STATS.rays++;
        if (t === Infinity) continue;
        STATS.hits++;
        if (t < 2.2 || t > 6) continue;
        STATS.fit++;
        const x = x0 + nx * t * 0.5, z = z0 + nz * t * 0.5;
        if (g.sim.surfaceAt(x, z) === 1) continue;
        STATS.offRoad++;
        const ax = -nz, az = nx;
        if (clearRay(w, x, H(x, z) + 0.7, z, ax, az, 3.5) < 2.6 || clearRay(w, x, H(x, z) + 0.7, z, -ax, -az, 3.5) < 2.6) continue;
        if (out.some((o) => Math.hypot(o.x - x, o.z - z) < 40)) continue;
        out.push({ x, z, h: Math.atan2(ax, az), width: +t.toFixed(1) });
      }
    }
  }
  out.sort((m, n) => m.width - n.width);
  return out.slice(0, want);
}

function parked(g, spot, seconds) {
  const p = g.player;
  p.repair();
  p.teleport({ x: spot.x, y: g.sim.heightAt(spot.x, spot.z) + 0.8, z: spot.z }, spot.h);
  p.setVelocity({ x: 0, y: 0, z: 0 });
  p._readState();
  const ctl = { throttle: 0, brake: 1, steer: 0, handbrake: 1 };
  const heat = g.heat;
  heat.value = 5; heat.bustTimer = 0; heat.boxTime = 0; heat.boxArrest = false; heat._boxAt = null; heat.ledgeTime = 0;
  const started = g.dispatcher.units.length;
  g.outcome = null;
  let bustAt = null, warnAt = null, how = null, near = Infinity, meanNear = 0, n = 0;
  g.onBusted = () => { if (bustAt === null) { bustAt = n / 60; how = heat.wedgeArrest ? 'on foot' : 'normal'; } };
  g.onEscaped = () => {};
  for (let i = 0; i < seconds * 60 && bustAt === null; i++) {
    heat.value = 5;
    g.stepHeadless(1 / 60, ctl);
    n++;
    let c = Infinity;
    for (const u of g.dispatcher.units) {
      if (u.vehicle.disabled) continue;
      c = Math.min(c, u.distanceTo(p.position) - p.spec.dims.l * 0.5 - u.vehicle.spec.dims.l * 0.5);
    }
    near = Math.min(near, c);
    meanNear += Math.min(c, 500);
    if (warnAt === null && heat.wedgeRemaining !== null && heat.wedgeRemaining !== undefined) warnAt = n / 60;
  }
  return { bustAt, how, warnAt, near: +near.toFixed(1), mean: Math.round(meanNear / Math.max(1, n)), started };
}

function prep(g) {
  g.paused = true;
  for (const u of g.dispatcher.units.slice()) if (!u.human) g.despawnPolice(u);
  const k = g.dispatcher.knowledge;
  k.timeSinceSeen = 0;
}

window.__wedgeRun = async function (spots = 6, seconds = 60) {
  window.__res = null;
  try {
    const g = window.__game;
    const list = findGaps(g, spots);
    const rows = [`${g.mapDef.id}: ${list.length} gaps found`];
    for (const s of list) {
      prep(g);
      const r = parked(g, s, seconds);
      rows.push(`${s.width} m gap at ${Math.round(s.x)},${Math.round(s.z)}: ${r.bustAt === null ? `NOT arrested in ${seconds} s` : `arrested ${r.how} at ${r.bustAt.toFixed(0)} s`}, warned ${r.warnAt === null ? 'never' : `${r.warnAt.toFixed(0)} s`}, closest unit ${r.near} m, mean ${r.mean} m`);
      await new Promise((res) => setTimeout(res, 0));
    }
    window.__res = rows.join('\n');
  } catch (e) { window.__res = 'EX: ' + e.message + ' | ' + (e.stack || '').slice(0, 300); }
  return window.__res;
};

window.__wedgeOpen = async function (spots = 10, seconds = 45) {
  window.__res = null;
  try {
    const g = window.__game, gr = g.graph;
    const rows = [`${g.mapDef.id}: parked on the road`];
    let onFoot = 0, normal = 0, none = 0, warned = 0;
    const edges = gr.edges.filter((e) => !e.cut && e.points && e.points.length > 3);
    for (let i = 0; i < spots; i++) {
      const e = edges[Math.floor((i * edges.length) / spots)];
      const m = e.points[Math.floor(e.points.length / 2)];
      prep(g);
      const r = parked(g, { x: m.x, z: m.z, h: 0.5 }, seconds);
      if (r.warnAt !== null) warned++;
      if (r.bustAt === null) none++;
      else if (r.how === 'on foot') onFoot++;
      else normal++;
      await new Promise((res) => setTimeout(res, 0));
    }
    rows.push(`${spots} places: arrested the normal way ${normal}, on foot ${onFoot}, not in ${seconds} s ${none}; warned at all ${warned}`);
    window.__res = rows.join('\n');
  } catch (e) { window.__res = 'EX: ' + e.message + ' | ' + (e.stack || '').slice(0, 300); }
  return window.__res;
};

window.__wedgeGarage = async function (seconds = 45) {
  window.__res = null;
  try {
    const g = window.__game;
    const c = g.garage;
    if (!c) { window.__res = 'no garage'; return window.__res; }
    const at = { x: c.site.cx, z: c.site.cz };
    // Between whatever solid things stand on the forecourt: the pumps' islands are 6.6 m apart.
    const w = g.world, list = [];
    const near = new Set();
    for (const l of obstacleIndex(g).buckets.values()) for (const b of l) if (Math.hypot(b.x - at.x, b.z - at.z) < 35 && b.hx < 3 && b.hz < 3) near.add(b);
    for (const b of near) {
      for (const [nx, nz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const x0 = b.x + nx * (b.hx + b.hz), z0 = b.z + nz * (b.hx + b.hz);
        const y = g.sim.heightAt(x0, z0) + 0.7;
        const t = clearRay(w, x0, y, z0, nx, nz, 8);
        if (t < 2.4 || t > 8) continue;
        const x = x0 + nx * t * 0.5, z = z0 + nz * t * 0.5;
        if (list.some((o) => Math.hypot(o.x - x, o.z - z) < 8)) continue;
        list.push({ x, z, h: Math.atan2(-nz, nx), width: +t.toFixed(1) });
      }
    }
    list.sort((m, n) => m.width - n.width);
    list.length = Math.min(list.length, 4);
    window.__siteKeys = Object.keys(c.site);
    const rows = [`${g.mapDef.id} garage at ${Math.round(at.x)},${Math.round(at.z)}: ${list.length} tight spots`];
    for (const s of list) {
      prep(g);
      const r = parked(g, s, seconds);
      rows.push(`${s.width} m at ${Math.round(s.x)},${Math.round(s.z)}: ${r.bustAt === null ? `NOT arrested in ${seconds} s` : `arrested ${r.how} at ${r.bustAt.toFixed(0)} s`}, warned ${r.warnAt === null ? 'never' : `${r.warnAt.toFixed(0)} s`}, closest ${r.near} m`);
      await new Promise((res) => setTimeout(res, 0));
    }
    window.__res = rows.join('\n');
  } catch (e) { window.__res = 'EX: ' + e.message + ' | ' + (e.stack || '').slice(0, 300); }
  return window.__res;
};
