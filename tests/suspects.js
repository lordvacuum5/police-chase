// Traffic that gets itself chased (game/suspects.js).
//
// "If they hit a police car, or if a traffic runs a red light, or if they
// block a police car's way ... I want then ... a proper wanted level to start
// on that car." The whole game stepped headless for `seconds` at no wanted
// level, nobody forcing anything: how many suspects there were, why, and how
// each ended -- caught and parked, got away, or still running.
//
// `force`: start one straight away, the nearest traffic car to a patrol car,
// and report its chase every few seconds (`log`): its state, units, wanted
// level, speed and the nearest unit.
window.__runSuspects = async function (seconds = 180, force = false) {
  window.__res = null;
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.player && window.__game.suspects); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const g = window.__game;
    g.heat.value = 0;
    g.stepHeadless(6);
    const seen = new Set();
    const why = {};
    const log = [];
    if (force) {
      let best = null, bd = Infinity, bu = null;
      for (const c of g.traffic.cars) {
        for (const u of g.dispatcher.units) {
          if (u.human) continue;
          const d = Math.hypot(c.v.position.x - u.vehicle.position.x, c.v.position.z - u.vehicle.position.z);
          if (d < bd) { bd = d; best = c; bu = u; }
        }
      }
      if (best) g.suspects.offence(best, 'hit', bu);
    }
    for (let i = 0; i < seconds * 30; i++) {
      g.heat.value = 0;
      g._update(1 / 30);
      for (const s of g.suspects.list) {
        if (!seen.has(s)) { seen.add(s); why[s.why] = (why[s.why] || 0) + 1; }
      }
      if (force && i % 150 === 0) {
        const s = [...seen][0];
        if (s) {
          const d = s.units.length ? Math.min(...s.units.map((u) => Math.hypot(s.v.position.x - u.vehicle.position.x, s.v.position.z - u.vehicle.position.z))) : null;
          log.push([Math.round(i / 30), s.state, s.units.length, +s.heat.toFixed(2), Math.round(s.v.speed * 3.6), d === null ? null : Math.round(d)]);
        }
      }
      if (i % 300 === 0) await new Promise((r) => setTimeout(r, 0));
    }
    const ends = {};
    for (const s of seen) ends[s.state] = (ends[s.state] || 0) + 1;
    window.__res = JSON.stringify({ suspects: seen.size, why, ends, log });
  } catch (e) {
    window.__res = 'EX: ' + e.message + ' | ' + (e.stack || '').slice(0, 300);
  }
};
