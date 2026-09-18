// Do they keep up with you across a field?
//
// "When I go off-road, the police cars suddenly slow down a lot." The flat
// plate in straightline.js answers that for pace alone; this is the real map,
// with its trees and hedges and slopes. Finds the longest straight run of open
// grass on the map with nothing solid along it, puts the player at one end of
// it doing 110 km/h flat out along it, and one pursuit unit forty metres back,
// both on the grass.
//
//   runM        how long the open run is
//   policeKph   the unit's median and top speed on the grass, catching up
//   playerKph   the player's, over the same time
//   caughtUpAt  seconds until it was within 20 m (null: never)
//   gapStart/gapEnd   distance between them at the start and at the end
//   crashes     times the unit hit something with the player over 7 m away
window.__runOffRoad = async function (kind = 'interceptor', tier = 4, kph = 110) {
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.player); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const g = window.__game, M = window.__modules, gr = g.graph, sim = g.sim;
    const W = await import('/src/physics/world.js');
    if (g.audio) g.audio.muted = true;
    const wasPaused = g.paused;
    g.paused = true;
    g.restart();
    for (const u of g.dispatcher.units.slice()) g.dispatcher.retire(u);
    g.onBusted = () => { g.outcome = null; g.heat.bustTimer = 0; };
    g.onEscaped = () => { g.outcome = null; };

    // ---- the longest open straight of grass ----
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const n of gr.nodes) {
      if (!n) continue;
      x0 = Math.min(x0, n.x); x1 = Math.max(x1, n.x); z0 = Math.min(z0, n.z); z1 = Math.max(z1, n.z);
    }
    const clearTo = (x, z, dx, dz, max) => {
      const h = sim.heightAt ? sim.heightAt(x, z) : 0;
      const hit = W.raycast(g.world, { x, y: h + 0.8, z }, { x: dx, y: 0, z: dz }, max, W.RAY_GROUNDS, null);
      return hit ? hit.toi : max;
    };
    // Inside the map: past its last road the ground is an empty plate with no
    // scenery at all, which would be the flat test over again.
    const inside = (x, z) => x > x0 + 20 && x < x1 - 20 && z > z0 + 20 && z < z1 - 20;
    const grass = (x, z) => inside(x, z) && sim.surfaceAt(x, z) === 0;
    let best = null;
    for (let x = x0 + 20; x <= x1 - 20; x += 15) {
      for (let z = z0 + 20; z <= z1 - 20; z += 15) {
        if (!grass(x, z)) continue;
        for (let a = 0; a < 16; a++) {
          const h = a * Math.PI / 8, dx = Math.sin(h), dz = Math.cos(h);
          // Forty metres of grass behind for the police car, too.
          let back = 0;
          while (back < 50 && grass(x - dx * (back + 2.5), z - dz * (back + 2.5))) back += 2.5;
          if (back < 45) continue;
          let run = 0;
          while (run < 500 && grass(x + dx * (run + 2.5), z + dz * (run + 2.5))) run += 2.5;
          if (best && run <= best.run) continue;
          // Nothing solid on the line, for the player's width either side.
          const lx = -dz, lz = dx;
          if (clearTo(x, z, -dx, -dz, 45) < 45) continue;
          const open = Math.min(clearTo(x, z, dx, dz, run), clearTo(x + lx * 1.2, z + lz * 1.2, dx, dz, run),
            clearTo(x - lx * 1.2, z - lz * 1.2, dx, dz, run));
          const use = Math.min(run, open - 10);
          if (!best || use > best.run) best = { x, z, h, run: use };
        }
      }
    }
    if (!best || best.run < 120) return 'no open grass run on this map (' + (best ? best.run : 0) + ' m)';

    const at = (s) => {
      const x = best.x + Math.sin(best.h) * s, z = best.z + Math.cos(best.h) * s;
      return { x, y: (sim.heightAt ? sim.heightAt(x, z) : 0) + 0.95, z };
    };
    const vel = { x: Math.sin(best.h) * kph / 3.6, y: 0, z: Math.cos(best.h) * kph / 3.6 };
    const p = g.player;
    p.repair();
    p.teleport(at(0), best.h);
    // Read the new heading before setting the speed: setVelocity spins the
    // wheels up along the car's forward axis, and until this it is the old
    // one -- at right angles, the wheels stay stopped and the car skids to a
    // crawl in the first two seconds.
    p._readState();
    p.setVelocity(vel);
    p._readState();
    const v = g.createVehicle(kind, kind, at(-40), best.h, { police: true });
    v.setVelocity(vel);
    v._readState();
    const u = new M.Officer(g, v, { skill: M.SKILL.advanced, kind });
    g.dispatcher.units.push(u);
    u.setRole(M.ROLE.PURSUE);
    g.heat.value = 0; g.heat.bump(1, 'test'); g.heat.value = tier + 0.3;

    // Nobody else, and they always know exactly where the car is.
    const k = g.dispatcher.knowledge;
    const realDispatch = g.dispatcher.update.bind(g.dispatcher);
    const realBlocks = g.roadblocks.update.bind(g.roadblocks);
    g.roadblocks.update = () => {};
    g.dispatcher.update = (dt, target) => {
      g.dispatcher.clock += dt;
      k.seen = true; k.timeSinceSeen = 0;
      k.position.copy(target.position); k.velocity.copy(target.linvel);
      if (u.role !== M.ROLE.PURSUE) u.setRole(M.ROLE.PURSUE);
      u.update(dt, target);
    };
    const origU = g._update.bind(g);
    g._update = (dt) => {
      g.heat.value = tier + 0.3;
      g.forceControls = { throttle: 1, brake: 0, steer: 0, handbrake: 0 };
      origU(dt);
    };

    const gapStart = Math.hypot(v.position.x - p.position.x, v.position.z - p.position.z);
    const pol = [], ply = [];
    let t = 0, crashes = 0, seen = v.lastImpactAt || 0, caught = null;
    const along = () => (p.position.x - best.x) * Math.sin(best.h) + (p.position.z - best.z) * Math.cos(best.h);
    while (t < 30 && along() < best.run) {
      g.stepHeadless(1 / 30, null, 1 / 30);
      t += 1 / 30;
      // Only the catching up: once it is on the player's bumper it is ramming
      // and boxing, and both speeds are about that instead.
      const gap = Math.hypot(v.position.x - p.position.x, v.position.z - p.position.z);
      if (gap < 20 && caught === null) caught = +t.toFixed(1);
      if (caught === null && sim.surfaceAt(v.position.x, v.position.z) === 0) {
        pol.push(v.speed * 3.6);
        ply.push(p.speed * 3.6);
      }
      if (v.lastImpactAt && v.lastImpactAt !== seen) {
        seen = v.lastImpactAt;
        if (Math.hypot(v.position.x - p.position.x, v.position.z - p.position.z) > 7) crashes++;
      }
      if (Math.floor(t * 30) % 60 === 0) await new Promise((r) => setTimeout(r, 0));
    }
    const gapEnd = Math.hypot(v.position.x - p.position.x, v.position.z - p.position.z);

    g._update = origU;
    g.dispatcher.update = realDispatch;
    g.roadblocks.update = realBlocks;
    g.forceControls = null;
    g.paused = wasPaused;
    g.dispatcher.retire(u);
    const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? Math.round(s[s.length >> 1]) : null; };
    const top = (a) => (a.length ? Math.round(Math.max(...a)) : null);
    return {
      kind, tier, runM: Math.round(best.run), seconds: +t.toFixed(1),
      policeKph: { median: med(pol), top: top(pol) }, playerKph: { median: med(ply), top: top(ply) },
      gapStart: Math.round(gapStart), gapEnd: Math.round(gapEnd), caughtUpAt: caught, crashes,
    };
  } catch (err) {
    return 'EX ' + err.message + ' ' + String(err.stack).slice(0, 300);
  }
};
