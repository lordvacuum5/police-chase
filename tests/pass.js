// Does a patrol car go round you, or into you?
//
// The player's car is parked on a straight road with no chase on, and a patrol
// car comes up behind it along the same road, on its beat. Where the player is
// parked is the variable:
//
//   kerb     pulled in at the side of the patrol's lane
//   inLane   stopped square in the patrol's lane
//   headOn   in the patrol's lane, facing it
//   middle   across the centre of the road
//
//   passed     the patrol car got by
//   contacts   times it touched the player's car
//   sideGap    closest the two came side by side, centre to centre (m)
//   waited     seconds the patrol car sat stopped behind, not getting by
//   shoved     how far the player's car was pushed (m) -- anything but ~0 is
//              the patrol car driving into it
window.__runPass = async function (where = 'inLane', width = 20, kph = 43, seconds = 18) {
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.player); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const g = window.__game, M = window.__modules, gr = g.graph, p = g.player;
    const { DRIVE_SIDE } = await import('/src/world/roadgraph.js');
    if (g.audio) g.audio.muted = true;
    const wasPaused = g.paused;
    g.paused = true;
    g.restart();
    for (const u of g.dispatcher.units.slice()) g.dispatcher.retire(u);
    g.heat.value = 0;

    // The straightest long road of this width.
    let e = null;
    for (const c of gr.edges) {
      if (!c || c.width !== width || c.length < 120) continue;
      if (!e || c.segs.length < e.segs.length || (c.segs.length === e.segs.length && c.length > e.length)) e = c;
    }
    if (!e) return `no ${width} m road on this map`;
    const at = (along, lat) => {
      const q = gr.pointAt(e, along);
      return { x: q.x - q.tz * lat, z: q.z + q.tx * lat, h: Math.atan2(q.tx, q.tz) };
    };
    const laneLat = Math.min(3.0, e.width * 0.25) * DRIVE_SIDE;
    let lat = 0, face = 0;
    if (where === 'kerb') lat = (e.width * 0.5 - 1.1) * DRIVE_SIDE;
    if (where === 'inLane') lat = laneLat;
    if (where === 'headOn') { lat = laneLat; face = Math.PI; }
    const pp = at(80, lat);
    p.repair();
    p.teleport({ x: pp.x, y: 0.95, z: pp.z }, pp.h + face);
    p.setVelocity({ x: 0, y: 0, z: 0 });
    p._readState();

    const sp = at(15, laneLat);
    const v = g.createVehicle('patrol', 'patrol', { x: sp.x, y: 0.95, z: sp.z }, sp.h, { police: true });
    v.setVelocity({ x: Math.sin(sp.h) * kph / 3.6, y: 0, z: Math.cos(sp.h) * kph / 3.6 });
    v._readState();
    const u = new M.Officer(g, v, { skill: M.SKILL.advanced, kind: 'patrol' });
    g.dispatcher.units.push(u);
    u.setRole(M.ROLE.PATROL);
    // Its beat is simply this road, end to end.
    u._patrol = (dt) => {
      if (!u.driver.hasPath || u.goalNode !== e.b) u._routeTo(e.b, 3.0);
      return u.driver.followPath(dt, kph / 3.6);
    };

    const origU = g._update.bind(g);
    g._update = (dt) => {
      g.heat.value = 0;
      g.forceControls = { throttle: 0, brake: 1, steer: 0, handbrake: 1 };
      origU(dt);
    };

    const pf = { x: Math.sin(pp.h), z: Math.cos(pp.h) }, pl = { x: -pf.z, z: pf.x };
    let t = 0, hits = 0, pAt = p.lastImpactAt || 0, passed = false, sideGap = null, waited = 0;
    while (t < seconds) {
      g.stepHeadless(1 / 30, null, 1 / 30);
      t += 1 / 30;
      const dx = v.position.x - pp.x, dz = v.position.z - pp.z;
      const along = dx * pf.x + dz * pf.z;
      if (Math.abs(along) < 2.5) sideGap = Math.min(sideGap ?? 99, Math.abs(dx * pl.x + dz * pl.z));
      if (along > 6) passed = true;
      if (!passed && v.speed < 0.5) waited += 1 / 30;
      const d = Math.hypot(v.position.x - p.position.x, v.position.z - p.position.z);
      if (p.lastImpactAt && p.lastImpactAt !== pAt) { pAt = p.lastImpactAt; if (d < 7) hits++; }
      if (Math.floor(t * 30) % 90 === 0) await new Promise((r) => setTimeout(r, 0));
    }

    g._update = origU;
    g.forceControls = null;
    g.paused = wasPaused;
    const shoved = Math.hypot(p.position.x - pp.x, p.position.z - pp.z);
    g.dispatcher.retire(u);
    return {
      where, width, kph, passed, contacts: hits,
      sideGap: sideGap === null ? null : +sideGap.toFixed(2),
      waited: +waited.toFixed(1), shoved: +shoved.toFixed(2),
    };
  } catch (err) {
    return 'EX ' + err.message + ' ' + String(err.stack).slice(0, 300);
  }
};
