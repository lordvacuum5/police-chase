// How fast a police car goes through a gap.
//
// "The police cars can fit through really tight gaps now. That's really cool.
// But they're really slow going through these tiny gaps." tests/gaps.js asks
// whether a car gets through a hole in a wall at all; this asks how fast. Two
// blocks with a gap between them on open ground (a strip checked clear of
// everything), a whole pursuing unit -- Officer, not a bare Driver -- set off
// at 60 km/h from 60 m back, and the target parked 120 m beyond the gap, so
// the unit is not slowing to arrive. Straight on, and with the gap 8 m off to
// one side so it has to line up.
//
//   at        speed passing through the gap, km/h
//   slowest   the lowest it fell to on the way in
//   time      seconds from the start to clearing the gap
//   crawling  seconds under 15 km/h in the 30 m before it
//   touched   whether it hit the sides
//
// The first case of a session has come out as a failure for reasons of its
// own (the unit set off sideways); read it with that in mind.
//
//   await import('/tests/gapspeed.js');
//   await __runGapSpeed();             // -> window.__res
window.__runGapSpeed = async function (widths = [3.0, 3.6, 4.4, 6.0], offsets = [0, 8], tweak = null) {
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.player); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const g = window.__game, M = window.__modules, gr = g.graph;
    const world = await import('/src/physics/world.js');
    g.onBusted = () => { g.outcome = null; };
    g.onEscaped = () => { g.outcome = null; };
    g.heat.value = 0;

    // Open ground for every case: a strip 30 m wide and 200 m long with nothing
    // standing in it and grass or road all the way. Reusing one spot, or
    // stepping along from a road node, put some of the cases through houses.
    let seed = 99;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    const used = [];
    const findSite = () => {
      for (let tries = 0; tries < 4000; tries++) {
        const n = gr.nodes[Math.floor(rnd() * gr.nodes.length)];
        const x = n.x + (rnd() - 0.5) * 400, z = n.z + (rnd() - 0.5) * 400;
        if (used.some((u) => Math.hypot(u.x - x, u.z - z) < 200)) continue;
        let ok = true;
        for (const lx of [-15, -8, 0, 8, 15]) {
          const o = { x: x + lx, y: 1.0, z };
          if (world.sweepBox(g.world, o, { x: 0, y: 0, z: 1 }, 200, world.RAY_SIGHT, null, 0.5) < 199) { ok = false; break; }
        }
        if (!ok) continue;
        for (let dz = 0; dz <= 200 && ok; dz += 10) {
          for (const lx of [-12, 0, 12]) {
            if (g.sim.surfaceAt(x + lx, z + dz) === undefined) { ok = false; break; }
          }
        }
        if (!ok) continue;
        used.push({ x, z });
        return { x, z };
      }
      return null;
    };
    const rows = [];
    for (const gapW of widths) {
      for (const off of offsets) {
        const site = findSite();
        if (!site) { rows.push(`gap ${gapW} m: no open ground found`); continue; }
        const baseZ = site.z;
        const cx = site.x, cz = baseZ + 60;
        const half = gapW * 0.5;
        const bodies = [];
        for (const s of [-1, 1]) {
          bodies.push(world.addStaticBox(
            g.world, cx + off + s * (half + 6), 3, cz, 6, 3, 4, world.GROUP.BUILDING, 0,
          ));
        }
        const v = g.createVehicle('patrol', 'patrol', { x: cx, y: 0.95, z: baseZ }, 0, { police: true });
        // The whole unit, not a bare Driver: the local planner, the gap picker
        // and the assists are all Officer's, and a bare Driver lined up 8 m off
        // a gap simply stops in front of the wall.
        const o = new M.Officer(g, v, { skill: M.SKILL.advanced, kind: 'patrol' });
        o.setRole(M.ROLE.PURSUE);
        // The target parked beyond the gap.
        const p = g.player;
        const aim = { x: cx + off, y: 0, z: cz + 120 };
        p.teleport({ x: aim.x, y: 0.9, z: aim.z }, 0);
        p.setVelocity({ x: 0, y: 0, z: 0 });
        p._readState();
        v.setVelocity({ x: 0, y: 0, z: 60 / 3.6 });
        v._readState();
        let touched = false, prev = v.speed, slowest = Infinity, at = null, t = 0, crawl = 0;
        for (let i = 0; i < 900; i++) {
          g.heat.value = 3;
          const kn = g.dispatcher.knowledge;
          kn.seen = true; kn.position.copy(p.position); kn.velocity.set(0, 0, 0); kn.confidence = 1;
          o.update(1 / 60, p);
          if (tweak) tweak(o.driver, v, o);
          g.stepHeadless(1 / 60);
          t += 1 / 60;
          if (prev - v.speed > 3) touched = true;
          prev = v.speed;
          if (v.position.z < cz - 2) slowest = Math.min(slowest, v.speed);
          if (v.position.z > cz - 30 && v.position.z < cz && v.speed < 15 / 3.6) crawl += 1 / 60;
          if (at === null && v.position.z > cz) at = v.speed;
          if (v.position.z > cz + 5) break;
        }
        rows.push(`gap ${gapW.toFixed(1)} m, ${off ? off + ' m off' : 'straight'}: `
          + (at === null ? `did not get through (${Math.round(v.position.z - cz)} m short, `
            + `${Math.round(v.speed * 3.6)} kph, ${Math.round(v.position.x - cx - off)} m across)`
            : `at ${Math.round(at * 3.6)} kph, slowest ${Math.round(slowest * 3.6)}, `
              + `time ${t.toFixed(1)} s, crawling ${crawl.toFixed(1)} s`)
          + (touched ? ', touched' : ''));
        g.despawnPolice(o);
        for (const b of bodies) g.world.removeRigidBody(b);
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    window.__res = rows.join('\n');
    return window.__res;
  } catch (e) {
    window.__res = 'EX: ' + e.message + ' | ' + (e.stack || '').slice(0, 250);
    return window.__res;
  }
};
