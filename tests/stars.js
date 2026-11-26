// What each wanted level is like. "I want them to, like, intentionally not hit you until wanted level 3 ... quite a lot slower ... the
// wanted levels higher up feel more really hard and feel more intentional instead of ... just chuck more units at them."
//   const m = await import('/tests/stars.js');  await m.stars({ secs: 60 })      // window.__st
// The player driven along random routes by the game's own driver, at the speed `kmh` asks (on `road`, if given: 'motorway'), the wanted level held at 1 to 5 in turn:
//   hits     police cars newly touching the player, a minute; hard: of them, those that changed its speed 2.5 m/s in a tenth of a second
//   kmh      the chasing units' mean speed, and near: the share of the time one is within 40 m; behind: how far back the nearest is, m
//   level    alongside: the share of the time one is level with it (within 2.5 m along, 4.5 m across)
//   topMph   the fastest any went, mph; overFrames: unit-frames over `over` mph
//   hurt     damage a minute; units: how many are out; orders: pit and swipe ordered, and what came of them
const breathe = () => new Promise((r) => { const c = new MessageChannel(); c.port1.onmessage = () => { c.port1.close(); r(); }; c.port2.postMessage(0); });

export async function stars(opts = {}) {
  const g = window.__game, gr = g.graph, p = g.player, { Driver, SKILL } = window.__modules;
  g.paused = true;
  g.onBusted = () => { g.outcome = null; g.heat.bustTimer = 0; };
  g.onEscaped = () => { g.outcome = null; };
  g.heat._checkBust = () => {};
  const out = window.__st = { rows: [] };
  for (const star of opts.stars || [1, 2, 3, 4, 5]) {
    let seed = opts.seed || 31337;
    const rng = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return ((seed >>> 0) % 1e6) / 1e6; };
    let drv = null, still = 0;
    const route = () => {
      for (let k = 0; k < 40; k++) {
        const a = gr.nearestNode(p.position.x, p.position.z, p.position.y), b = gr.randomNode(rng, opts.road || 'street'), path = a && b && gr.route(a.id, b.id);
        if (path && path.length > 6) { drv = new Driver(p, SKILL.pursuit); drv.limitScale = 3; drv.setPath(gr.pathToPoints(path, 2.5, true)); return; }
      }
    };
    g.dispatcher.reset();
    g.heat.reset();
    g.outcome = null;
    p.repair();
    if (opts.road) { for (let k = 0; k < 60; k++) { const node = gr.randomNode(rng, opts.road), pl = node && g._placeOnRoad(node, (e) => e.kind === opts.road); if (pl) { p.teleport(pl.position, pl.heading); p._readState(); break; } } }
    g.heat.bump(1, 'a probe');
    const r = { star, hits: 0, hard: 0, kmh: 0, near: 0, behind: 0, level: 0, hurt: 0, units: 0, mine: 0, pit: 0, ended: {}, carried: 0, put: 0 };
    const trail = [];
    let put = 0;
    const fin = g.dispatcher.onPitFinished, touching = new Set(), speeds = [];
    g.dispatcher.onPitFinished = function (u, res) { const k = `${u.pitState && u.pitState.kind || res.kind || 'pit'} ${res.reason}`; r.ended[k] = (r.ended[k] || 0) + 1; return fin.call(this, u, res); };
    let n = 0, un = 0, bn = 0, was = null, top = 0, over = 0;
    const warm = 15 * 60, total = warm + (opts.secs || 60) * 60;
    for (let t = 0; t < total; t++) {
      if (!drv || !drv.hasPath || drv.remaining(20) < 20) route();
      g.heat.value = star + 0.05;
      const c = g.camera, f = p.forward;
      c.position.set(p.position.x - f.x * 8, p.position.y + 3, p.position.z - f.z * 8);
      c.lookAt(p.position.x + f.x * 10, p.position.y + 1, p.position.z + f.z * 10);
      c.updateMatrixWorld(true);
      gr.queryY = p.position.y - 0.9;
      const ctl = drv.followPath(1 / 60, (opts.kmh || 100) / 3.6);
      gr.queryY = null;
      const dm = p.damage;
      g.stepHeadless(1 / 60, ctl);
      if (t > warm) r.hurt += Math.max(0, p.damage - dm);
      if (p.damage > 0.3) p.repair();
      still = p.speed < 2 ? still + 1 : 0;
      if (still > 200 || p.up.y < 0.3) {
        const node = gr.randomNode(rng, opts.road || 'street'), pl = node && g._placeOnRoad(node, opts.road ? (e) => e.kind === opts.road : null);
        if (pl) { p.teleport(pl.position, pl.heading); p._readState(); drv = null; still = 0; r.carried++; }
      }
      speeds.push({ x: p.linvel.x, z: p.linvel.z });
      if (speeds.length > 7) speeds.shift();
      // Never left behind for long: up to three put back on your trail when none is within 120 m, every eight seconds at most.
      trail.push({ x: p.position.x, y: p.position.y, z: p.position.z, h: Math.atan2(f.x, f.z) });
      if (trail.length > 400) trail.shift();
      put++;
      const chase = g.dispatcher.units.filter((u) => !u.vehicle.disabled && u.role !== 'patrol' && u.role !== 'hold');
      if (put > 480 && p.speed > 8 && chase.length && !chase.some((u) => Math.hypot(u.position.x - p.position.x, u.position.z - p.position.z) < 120)) {
        put = 0;
        let at = trail.length - 1, along = 0, next = 35;
        for (const u of chase.slice(0, 3)) {
          while (at > 0 && along < next) { along += Math.hypot(trail[at].x - trail[at - 1].x, trail[at].z - trail[at - 1].z); at--; }
          if (at <= 0) break;
          const q = trail[at];
          u.vehicle.teleport({ x: q.x, y: q.y + 0.1, z: q.z }, q.h);
          u.vehicle._readState();
          u.vehicle.setVelocity({ x: Math.sin(q.h) * p.speed, y: 0, z: Math.cos(q.h) * p.speed });
          next += 20;
          r.put++;
        }
      }
      if (t < warm) { if (t % 60 === 0) await breathe(); continue; }
      n++;
      r.mine += p.speed * 3.6;
      let best = Infinity, level = false;
      const jolt = Math.hypot(p.linvel.x - speeds[0].x, p.linvel.z - speeds[0].z);
      for (const u of g.dispatcher.units) {
        const v = u.vehicle;
        if (v.disabled || u.role === 'patrol' || u.role === 'hold') continue;
        const dx = v.position.x - p.position.x, dz = v.position.z - p.position.z, d = Math.hypot(dx, dz);
        un++;
        if (d < 150) { r.kmh += v.speed * 3.6; bn++; }
        // Not while it is still going at the speed it was put down at.
        if (put > 240) { top = Math.max(top, v.speed * 2.237); if (v.speed * 2.237 > (opts.over || 1e9)) over++; }
        best = Math.min(best, d);
        const along = dx * p.forward.x + dz * p.forward.z, lat = dx * p.left.x + dz * p.left.z;
        if (Math.abs(along) < 2.5 && Math.abs(lat) < 4.5 && p.speed > 8) level = true;
        if (d < 8) {
          let hit = false;
          g.world.contactPair(p.collider, v.collider, (m) => { if (m.numContacts() > 0) hit = true; });
          if (hit && !touching.has(v)) { touching.add(v); r.hits++; if (jolt > 2.5) r.hard++; } else if (!hit) touching.delete(v);
        }
      }
      if (best < 40) r.near++;
      if (best < 600) { r.behind += best; }
      if (level) r.level++;
      if (t % 30 === 0) await breathe();
    }
    g.dispatcher.onPitFinished = fin;
    const mins = n / 3600;
    out.rows.push({ star, mine: Math.round(r.mine / n), hits: +(r.hits / mins).toFixed(1), hard: +(r.hard / mins).toFixed(1), kmh: Math.round(r.kmh / Math.max(1, bn)), near: +(r.near / n).toFixed(2), behind: Math.round(r.behind / n), level: +(r.level / n).toFixed(3), hurt: +(r.hurt / mins).toFixed(2), units: +(un / n).toFixed(1), ended: r.ended, carried: r.carried, put: r.put, topMph: Math.round(top), overFrames: over });
  }
  out.done = true;
  return out;
}
