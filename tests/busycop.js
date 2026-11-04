// Can a police car already chasing a civilian still take an interest in you?
//
// "If the police cars are in pursuit of a traffic vehicle, they cannot get in a
// pursuit with you, with the actual player." Runner side. A suspect with a patrol
// on it, every other unit retired and no spawns; the player driven past
// that unit at 110 km/h (`ram` false) or into it (`ram` true). Reports the wanted
// level, and how many cars are after the suspect and after the player, over time.
window.__runBusyCop = async function (ram = false, seconds = 20) {
  window.__res = null;
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.player && window.__game.traffic); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const g = window.__game, p = g.player;
    g.paused = true;
    g.onBusted = () => { g.outcome = null; g.heat.bustTimer = 0; };
    g.onEscaped = () => { g.outcome = null; };
    const hold = { throttle: 0, brake: 1, steer: 0, handbrake: 1 };
    for (let i = 0; i < 900 && !(g.traffic.cars.length && g.dispatcher.units.length); i++) { p.setControls(hold); g._update(1 / 30); }
    g.heat.value = 0;
    const c = g.traffic.cars[0];
    if (c.v.dormant) { c.v.body.setEnabled(true); c.v.dormant = false; }
    const u = g.dispatcher.units[0];
    const s = g.suspects.offence(c, 'bolt', u);
    // Nobody else about, and nobody new until the player is wanted: the one on the
    // civilian is the only one who can see anything.
    for (const o of g.dispatcher.units.slice()) if (!o.human) g.dispatcher.retire(o);
    const quiet = () => { if (g.heat.value <= 0) { g.dispatcher.spawnTimer = 99; g.suspects.list[0].acquireFor = 99; } };
    for (let i = 0; i < 30; i++) { quiet(); p.setControls(hold); g._update(1 / 30); }
    g.heat.value = 0;
    const uv = u.vehicle, f = uv.forward;
    const dist = ram ? 12 : 40;
    const at = { x: uv.position.x - f.x * dist, z: uv.position.z - f.z * dist };
    p.teleport({ x: at.x, y: g.sim.heightAt(at.x, at.z) + 0.8, z: at.z }, Math.atan2(f.x, f.z));
    p.setVelocity({ x: f.x * 30, y: 0, z: f.z * 30 });
    const rows = [];
    let starAt = null;
    for (let i = 0; i < seconds * 30; i++) {
      quiet();
      p.setControls({ throttle: 1, brake: 0, steer: 0, handbrake: 0 });
      g._update(1 / 30);
      g.outcome = null;
      if (starAt === null && g.heat.value > 0) starAt = i / 30;
      if (i % 150 === 149) {
        rows.push(`${Math.round((i + 1) / 30)} s: level ${g.heat.value.toFixed(1)}, on the civilian ${s.units.length}, on you ${g.dispatcher.units.filter((x) => !x.human && x.role !== 'patrol').length}, that unit ${s.units.includes(u) ? 'on the civilian' : 'on you'}`);
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    rows.unshift(`${ram ? 'rammed it' : 'past it at 110 km/h'}: ${starAt === null ? 'NEVER wanted' : `wanted at ${starAt.toFixed(1)} s`}`);
    window.__res = rows;
  } catch (e) {
    window.__res = ['EX: ' + e.message, (e.stack || '').slice(0, 300)];
  }
};
