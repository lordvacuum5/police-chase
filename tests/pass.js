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
// and what the player then does, which is where the contacts actually happen:
//
//   none     stays put
//   creep    rolls along its lane at walking-to-jogging pace the whole time
//   pullOut  parked at the kerb, pulls out in front of the patrol car late
//   swerve   stopped in the lane, swerves out into the passing line just as
//            the patrol car comes by
//   swerveEarly / swerveLate   the same, when it is 14 m behind, or alongside
//   stopGo   drives off at 20 km/h and stands on the brakes when the patrol
//            car is 12 m behind, then goes again
//   backUp   reverses toward the patrol car when it is 10 m behind
//
//   passed     the patrol car got by
//   contacts   times it touched the player's car
//   theirFault of those, the ones where the patrol car was the one moving in
//   sideGap    closest the two came side by side, centre to centre (m)
//   waited     seconds the patrol car sat stopped behind, not getting by
//   shoved     how far the player's car was pushed (m) -- anything but ~0 is
//              the patrol car driving into it
/**
 * The same thing round a corner: the patrol car comes up to a junction and
 * turns, and the player is stopped in its lane just past the turn -- the case a
 * straight road never tests, where "in front" and "in my lane" stop meaning
 * the same thing. `after` is how far past the junction the player is parked.
 */
window.__runPassCorner = async function (after = 18, kph = 43, seconds = 16, seed = 1) {
  try {
    const g = window.__game, M = window.__modules, gr = g.graph, p = g.player;
    const { DRIVE_SIDE } = await import('/src/world/roadgraph.js');
    if (g.audio) g.audio.muted = true;
    const wasPaused = g.paused;
    g.paused = true;
    g.restart();
    for (const u of g.dispatcher.units.slice()) g.dispatcher.retire(u);
    g.heat.value = 0;

    // Corners: two long roads meeting at a node at 60-120 degrees.
    const corners = [];
    for (const n of gr.nodes) {
      if (!n || n.edges.length < 2) continue;
      const es = n.edges.map((id) => gr.edges[id]).filter((e) => e && e.length > 90 && e.width >= 9);
      for (let i = 0; i < es.length; i++) for (let j = 0; j < es.length; j++) {
        if (i === j) continue;
        const e1 = es[i], e2 = es[j];
        const out = (e) => { const q = gr.pointAt(e, e.a === n.id ? 3 : e.length - 3); const s = e.a === n.id ? 1 : -1; return { x: q.tx * s, z: q.tz * s }; };
        const d1 = out(e1), d2 = out(e2);
        const cos = d1.x * d2.x + d1.z * d2.z;
        if (cos > -0.5 && cos < 0.5) corners.push({ n, e1, e2 });
      }
    }
    if (!corners.length) return 'no corner found';
    const c = corners[(seed * 7919) % corners.length];
    const { n, e1, e2 } = c;
    // Along an edge, measured *from the node*, and the direction away from it.
    const fromNode = (e, dist, lat) => {
      const toward = e.a === n.id;
      const q = gr.pointAt(e, toward ? dist : e.length - dist);
      const s = toward ? 1 : -1;                     // +1: away from the node
      const tx = q.tx * s, tz = q.tz * s;
      return { x: q.x - tz * lat, z: q.z + tx * lat, h: Math.atan2(tx, tz) };
    };
    const lane = (e) => Math.min(3.0, e.width * 0.25) * DRIVE_SIDE;
    // Player: on e2, stopped in the lane that leads away from the junction.
    const pp = fromNode(e2, after, lane(e2));
    p.repair();
    p.teleport({ x: pp.x, y: 0.95, z: pp.z }, pp.h);
    p.setVelocity({ x: 0, y: 0, z: 0 });
    p._readState();
    // Patrol: on e1, 60 m out, driving toward the junction (so the opposite
    // direction to "away from the node", in its own lane for that direction).
    const sp0 = fromNode(e1, 60, -lane(e1));
    const sh = sp0.h + Math.PI;
    const v = g.createVehicle('patrol', 'patrol', { x: sp0.x, y: 0.95, z: sp0.z }, sh, { police: true });
    v.setVelocity({ x: Math.sin(sh) * kph / 3.6, y: 0, z: Math.cos(sh) * kph / 3.6 });
    v._readState();
    const u = new M.Officer(g, v, { skill: M.SKILL.advanced, kind: 'patrol' });
    g.dispatcher.units.push(u);
    u.setRole(M.ROLE.PATROL);
    const goal = e2.a === n.id ? e2.b : e2.a;
    u._patrol = (dt) => {
      if (!u.driver.hasPath || u.goalNode !== goal) u._routeTo(goal, 3.0);
      return u.driver.followPath(dt, kph / 3.6);
    };
    const origU = g._update.bind(g);
    g._update = (dt) => {
      g.heat.value = 0;
      g.forceControls = { throttle: 0, brake: 1, steer: 0, handbrake: 1 };
      origU(dt);
    };
    let t = 0, hits = 0, pAt = p.lastImpactAt || 0, closest = 99;
    while (t < seconds) {
      g.stepHeadless(1 / 30, null, 1 / 30);
      t += 1 / 30;
      const d = Math.hypot(v.position.x - p.position.x, v.position.z - p.position.z);
      closest = Math.min(closest, d);
      if (p.lastImpactAt && p.lastImpactAt !== pAt) { pAt = p.lastImpactAt; if (d < 7) hits++; }
      if (Math.floor(t * 30) % 90 === 0) await new Promise((r) => setTimeout(r, 0));
    }
    g._update = origU;
    g.forceControls = null;
    g.paused = wasPaused;
    const shoved = Math.hypot(p.position.x - pp.x, p.position.z - pp.z);
    const pastIt = (() => {
      const dx = v.position.x - pp.x, dz = v.position.z - pp.z;
      return dx * Math.sin(pp.h) + dz * Math.cos(pp.h) > 6;
    })();
    g.dispatcher.retire(u);
    return { corner: seed, after, contacts: hits, shoved: +shoved.toFixed(2), closest: +closest.toFixed(1), passed: pastIt };
  } catch (err) {
    return 'EX ' + err.message + ' ' + String(err.stack).slice(0, 300);
  }
};

window.__runPass = async function (where = 'inLane', width = 20, kph = 43, seconds = 18, move = 'none') {
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

    // The player's car is steered at points on the road by the same controller
    // the police use, so "pull out into the lane" is a place and a speed rather
    // than a guess at which way the wheel turns.
    const drv = new M.Driver(p, M.SKILL.regular);
    let plan = null;                     // { x, z, speed } once the player moves
    const alongOf = (x, z) => {
      const q = gr.pointAt(e, 0);
      return (x - q.x) * q.tx + (z - q.z) * q.tz;
    };
    if (move === 'creep') { const q = at(e.length - 10, laneLat); plan = { x: q.x, z: q.z, speed: 3 }; }
    if (move === 'stopGo') { const q = at(e.length - 10, laneLat); plan = { x: q.x, z: q.z, speed: 5.5 }; }
    const swerveAt = { swerveEarly: 14, swerve: 7, swerveLate: 1 }[move];
    let held = 0, stopped = false, backing = false;

    const origU = g._update.bind(g);
    g._update = (dt) => {
      g.heat.value = 0;
      const pa = alongOf(p.position.x, p.position.z), va = alongOf(v.position.x, v.position.z);
      if (!plan && move === 'pullOut' && pa - va < 26) {
        const q = at(pa + 22, laneLat); plan = { x: q.x, z: q.z, speed: 5 };
      }
      if (!plan && swerveAt !== undefined && pa - va < swerveAt) {
        const q = at(pa + 14, -laneLat); plan = { x: q.x, z: q.z, speed: 5 };
      }
      if (move === 'stopGo' && !stopped && pa - va < 12) { stopped = true; held = 2.0; }
      if (move === 'backUp' && !backing && pa - va < 10) backing = true;
      if (held > 0) {
        held -= dt;
        g.forceControls = { throttle: 0, brake: 1, steer: 0, handbrake: 0 };
      } else if (backing) {
        // Brake held at a standstill is reverse, and then drives it backwards.
        g.forceControls = { throttle: 0, brake: 0.6, steer: 0, handbrake: 0 };
      } else {
        g.forceControls = plan
          ? Object.assign({}, drv.driveTo(plan, plan.speed, dt, { ignoreSurroundings: true }))
          : { throttle: 0, brake: 1, steer: 0, handbrake: 1 };
      }
      origU(dt);
    };

    const pf = { x: Math.sin(pp.h), z: Math.cos(pp.h) }, pl = { x: -pf.z, z: pf.x };
    let t = 0, hits = 0, ours = 0, pAt = p.lastImpactAt || 0, passed = false, sideGap = null, waited = 0;
    while (t < seconds) {
      g.stepHeadless(1 / 30, null, 1 / 30);
      t += 1 / 30;
      const dx = v.position.x - pp.x, dz = v.position.z - pp.z;
      const along = dx * pf.x + dz * pf.z;
      if (Math.abs(along) < 2.5) sideGap = Math.min(sideGap ?? 99, Math.abs(dx * pl.x + dz * pl.z));
      if (along > 6) passed = true;
      if (!passed && v.speed < 0.5) waited += 1 / 30;
      const d = Math.hypot(v.position.x - p.position.x, v.position.z - p.position.z);
      if (p.lastImpactAt && p.lastImpactAt !== pAt) {
        pAt = p.lastImpactAt;
        if (d < 7) {
          hits++;
          // The patrol car's own speed toward the player's car: over half a
          // metre a second, it drove into it, rather than being driven into.
          const tx = (p.position.x - v.position.x) / d, tz = (p.position.z - v.position.z) / d;
          if (v.linvel.x * tx + v.linvel.z * tz > 0.5) ours++;
        }
      }
      if (Math.floor(t * 30) % 90 === 0) await new Promise((r) => setTimeout(r, 0));
    }

    g._update = origU;
    g.forceControls = null;
    g.paused = wasPaused;
    const shoved = Math.hypot(p.position.x - pp.x, p.position.z - pp.z);
    g.dispatcher.retire(u);
    return {
      where, move, width, kph, passed, contacts: hits, theirFault: ours,
      sideGap: sideGap === null ? null : +sideGap.toFixed(2),
      waited: +waited.toFixed(1), shoved: +shoved.toFixed(2),
    };
  } catch (err) {
    return 'EX ' + err.message + ' ' + String(err.stack).slice(0, 300);
  }
};
