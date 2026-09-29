// What happens at the end of the map?
//
// Before the wall in world/common.js: you drove off it. The ground plate is
// 2400 m across, the roads reach 2000, and past the last field there was
// nothing -- the car went over the edge and fell at terminal velocity forever,
// with no way back. R rights a car that is stopped or upside down, and a
// falling one is neither, so the chase carried on around a player who was
// three hundred metres under the world. A police car that went over was worse
// again: the roster measures how far away a unit is across the ground, so it
// stayed "nearby", was never retired, and held a place on the board from
// outside the world.
//
// Two questions, and both have to answer for the fix to be worth anything:
//
//   edge    driven flat out at the boundary, does the car stop on the plate
//   caught  dropped under the world on purpose, is it put back on a road
//
// The wall is what stops it happening and the catch is what stops it
// mattering, so the second is tested by cheating past the first.
//
// The wall is invisible and it hurts: 64% damage at 150 km/h, against 60% for
// driving into a building at the same speed. That is deliberate -- it is a
// wall, it behaves like every other wall in the game, and it stands four
// metres inside an edge you can see coming, 200 m beyond the furthest road.
window.__runEdge = async function () {
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.player); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const g = window.__game;
    g.onBusted = () => { g.outcome = null; };
    g.onEscaped = () => { g.outcome = null; };
    g.heat.value = 0;
    g.paused = true;
    const p = g.player;
    const rows = [];

    // ---- 1. flat out at the boundary, from every side ----
    const runs = [
      ['north', 0, 900, { x: 0, y: 0, z: 40 }, () => p.position.z],
      ['south', 0, -900, { x: 0, y: 0, z: -40 }, () => -p.position.z],
      ['east', 900, 0, { x: 40, y: 0, z: 0 }, () => p.position.x],
      ['west', -900, 0, { x: -40, y: 0, z: 0 }, () => -p.position.x],
    ];
    for (const [name, x, z, vel, out] of runs) {
      p.repair();
      p.teleport({ x, y: 1.0, z }, Math.atan2(vel.x, vel.z));
      p._readState();
      p.setVelocity(vel);
      g.stepHeadless(14, { throttle: 1, brake: 0, steer: 0, handbrake: 0 });
      rows.push(`${name.padEnd(6)} stopped ${out().toFixed(1).padStart(7)} m out  `
        + `y ${p.position.y.toFixed(2).padStart(6)}  ${p.position.y > -1 ? 'on the plate' : 'FELL OFF'}`);
    }

    // ---- 2. under the world anyway ----
    p.repair();
    p.teleport({ x: 600, y: -60, z: -600 }, 0);
    p._readState();
    p.setVelocity({ x: 0, y: -30, z: 0 });
    g.stepHeadless(0.5);
    rows.push(`dropped to -60 m: now y ${p.position.y.toFixed(2)} at `
      + `${Math.round(p.position.x)}, ${Math.round(p.position.z)}  `
      + `${p.position.y > -1 ? 'recovered' : 'STILL FALLING'}`);

    // ---- 3. and so is a police car, which is retired rather than towed ----
    const before = g.dispatcher.units.length;
    const car = g.createVehicle('interceptor', 'interceptor',
      { x: 300, y: -80, z: 300 }, 0, { police: true });
    let unit = null;
    if (car) {
      unit = new window.__modules.Officer(g, car, {
        skill: window.__modules.SKILL.pursuit, kind: 'interceptor',
      });
      g.dispatcher.adopt(unit);
      g.stepHeadless(0.2);
    }
    rows.push(`a police car under the world: roster ${before} -> `
      + `${g.dispatcher.units.length}  ${g.vehicles.includes(car) ? 'STILL THERE' : 'retired'}`);

    g.paused = false;
    window.__res = rows.join('\n');
  } catch (e) {
    window.__res = 'EX: ' + e.message + ' | ' + (e.stack || '').slice(0, 300);
  }
};
