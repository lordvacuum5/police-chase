// Can they stay with you on an open straight?
//
// Player flat out in a straight line, one police car sixty metres behind it
// driving its own pursuit. Both cars run on the flat plate beyond the map edge
// with the surface forced to tarmac, and both are shifted back up the lane
// together whenever the player reaches the end of it, so the run can go on for
// as long as it likes without either car meeting a corner. What is left is
// pace: engine, gearing, drag, and whatever the driver's own speed limits do.
//
// `surface` 0 runs the same thing on grass: "when I go off-road, the police
// cars suddenly slow down a lot".
//
//   gap_m       distance from the player to the police car, at 5/10/20/30 s
//   playerKph   what the player settles at
//   policeKph   what the police car settles at
window.__runStraight = async function (kind = 'interceptor', tier = 5, seconds = 30, surface = 1) {
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.player); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const g = window.__game, M = window.__modules;
    if (g.audio) g.audio.muted = true;
    const wasPaused = g.paused;
    g.paused = true;
    g.onBusted = () => { g.outcome = null; g.heat.bustTimer = 0; };
    g.onEscaped = () => { g.outcome = null; };

    const realSurface = g.sim.surfaceAt, realHeight = g.sim.heightAt;
    g.sim.surfaceAt = () => surface;
    g.sim.heightAt = () => 0;
    const LANE_X = 1100, Z0 = -1150, Z1 = 1150;

    // Whichever car is selected in the menu (localStorage 'pc.car').
    const p = g.player;
    p.repair();
    p.teleport({ x: LANE_X, y: 0.95, z: Z0 }, 0);
    p.setVelocity({ x: 0, y: 0, z: 30 });
    p._readState();

    // One unit, sixty metres back, already rolling.
    const v = g.createVehicle(kind, kind, { x: LANE_X, y: 0.95, z: Z0 - 60 }, 0, { police: true });
    v.setVelocity({ x: 0, y: 0, z: 30 });
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

    // Both cars back up the lane together, with everything they were doing
    // intact, so the gap between them is untouched by the teleport.
    const shift = (car2, dz) => {
      const vel = { x: car2.linvel.x, y: car2.linvel.y, z: car2.linvel.z };
      const gear = car2.gear, rpm = car2.rpm, omegas = car2.wheels.map((w) => w.omega);
      car2.teleport({ x: car2.position.x, y: car2.position.y, z: car2.position.z + dz },
        Math.atan2(car2.forward.x, car2.forward.z));
      car2.setVelocity(vel);
      car2.gear = gear; car2.rpm = rpm;
      car2.wheels.forEach((w, i) => { w.omega = omegas[i]; });
    };

    const origU = g._update.bind(g);
    g._update = (dt) => {
      g.heat.value = tier + 0.3;
      g.forceControls = { throttle: 1, brake: 0, steer: 0, handbrake: 0 };
      origU(dt);
    };

    const marks = {};
    let t = 0;
    while (t < seconds) {
      g.stepHeadless(1 / 30, null, 1 / 30);
      t += 1 / 30;
      if (p.position.z > Z1) { const dz = Z0 - p.position.z; shift(p, dz); shift(v, dz); }
      const s = Math.round(t);
      if ([5, 10, 20, 30].includes(s) && !marks[s] && Math.abs(t - s) < 1 / 50) {
        marks[s] = {
          gap_m: Math.round(Math.hypot(v.position.x - p.position.x, v.position.z - p.position.z)),
          playerKph: Math.round(p.speed * 3.6),
          policeKph: Math.round(v.speed * 3.6),
        };
      }
      if (Math.floor(t * 30) % 60 === 0) await new Promise((r) => setTimeout(r, 0));
    }

    g._update = origU;
    g.dispatcher.update = realDispatch;
    g.roadblocks.update = realBlocks;
    g.forceControls = null;
    g.sim.surfaceAt = realSurface;
    g.sim.heightAt = realHeight;
    g.paused = wasPaused;
    g.dispatcher.retire(u);
    return { car: p.spec.name, kind, tier, surface, marks, askedCap: +(u.driver.speedTarget || 0).toFixed(1) };
  } catch (e) {
    return 'EX ' + e.message + ' ' + String(e.stack).slice(0, 300);
  }
};
