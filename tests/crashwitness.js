// Traffic in trouble in front of a police player (game/suspects.js).
//
// "If I'm the police car, okay, in a single player world, if a normal traffic
// car hits me, the pursuit starts, right? Also, if two civilian cars hit each
// other, I would like one to stay where they are, or come off the road a bit
// ... and I want the other one to speed off, and then the police to begin
// pursuit of that vehicle. But only if the police car is in visual range of
// it, like close visual, relatively close visual range."
//
// Needs the solo police side: sessionStorage 'pc.side' = 'police'. Three
// staged cases, each on a straight bit of road with no other police near:
//
//   hit      a traffic car driven into the player's police car at 40 km/h
//   seen     two traffic cars driven into each other 25 m in front of it
//   unseen   the same, 250 m away
//
// Each reports what came of it after `after` seconds: suspects, why, their
// states (run / pull / parked), units on the one running.
window.__runCrashWitness = async function (after = 20) {
  window.__res = null;
  const rows = [];
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.player && window.__game.suspects && window.__game.traffic); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const g = window.__game;
    if (!g.soloPolice) throw new Error('not the solo police side');
    g.onBusted = () => { g.outcome = null; };
    g.onEscaped = () => { g.outcome = null; };
    g.stepHeadless(3);
    const p = g.player;
    const ctl = { throttle: 0, brake: 1, steer: 0, handbrake: 1 };
    const origU = g._update.bind(g);
    g._update = (dt) => { p.setControls(ctl); origU(dt); p.setControls(ctl); };
    // A long straight edge, for room: the nearest to where the player started,
    // where traffic is about. One out by the edge of the map had none to
    // send once the first two were used up.
    let edge = null, ed = Infinity;
    for (const e of g.graph.edges) {
      if (e.quarry || e.kind === 'track' || e.length < 140) continue;
      const a = e.points[0], b = e.points[e.points.length - 1];
      if (Math.hypot(b.x - a.x, b.z - a.z) < e.length * 0.97) continue;
      const r = Math.hypot((a.x + b.x) / 2 - p.position.x, (a.z + b.z) / 2 - p.position.z);
      if (r < ed) { ed = r; edge = e; }
    }
    if (!edge) throw new Error('no straight road');
    const a0 = edge.points[0], b0 = edge.points[edge.points.length - 1];
    const L = Math.hypot(b0.x - a0.x, b0.z - a0.z), dx = (b0.x - a0.x) / L, dz = (b0.z - a0.z) / L;
    const on = (s, side = 0) => ({ x: a0.x + dx * s - dz * side, z: a0.z + dz * s + dx * side });
    const put = (v, at, head, kph) => {
      v.teleport({ x: at.x, y: g.sim.heightAt(at.x, at.z) + 0.8, z: at.z }, head);
      v.setVelocity({ x: Math.sin(head) * kph / 3.6, y: 0, z: Math.cos(head) * kph / 3.6 });
    };
    const fwd = Math.atan2(dx, dz), back = Math.atan2(-dx, -dz);
    const clearPolice = (x, z) => {
      for (const u of g.dispatcher.units.slice()) {
        if (u.human || !u.vehicle) continue;
        if (Math.hypot(u.vehicle.position.x - x, u.vehicle.position.z - z) < 400) {
          u.vehicle.teleport({ x: x + 700, y: g.sim.heightAt(x + 700, z) + 1, z }, 0);
        }
      }
    };
    const report = (name) => {
      const s = g.suspects.list.map((q) => `${q.why}:${q.state}${q.victim ? '(other car)' : ''}${q.state === 'run' ? '/' + q.units.length + ' units' : ''}`);
      return `${name}: ${s.length ? s.join(', ') : 'nothing'}`;
    };

    const two = () => {
      // Whichever two, woken if they were asleep for being far off.
      for (let i = 0; i < 600 && g.traffic.cars.length < 2; i++) g._update(1 / 30);
      const cs = g.traffic.cars.slice(0, 2);
      if (cs.length < 2) throw new Error('fewer than two traffic cars');
      for (const c of cs) if (c.v.dormant) { c.v.body.setEnabled(true); c.v.dormant = false; }
      return cs;
    };
    const settle = async () => {
      for (let i = 0; i < after * 30; i++) {
        g._update(1 / 30);
        if (i % 300 === 0) await new Promise((r) => setTimeout(r, 0));
      }
    };
    const reset = () => { g.suspects.reset(); };

    // 1. Into the player.
    const pAt = on(L * 0.5);
    p.repair();
    put(p, pAt, fwd, 0);
    clearPolice(pAt.x, pAt.z);
    let [c1] = two();
    put(c1.v, on(L * 0.5 + 20), back, 40);
    // Its own driver brakes for the police car in the road -- traffic does --
    // so it is held on full throttle until it has hit.
    const own = c1.v.setControls.bind(c1.v);
    c1.v.setControls = (o) => own(c1.v.isTraffic ? { throttle: 1, brake: 0, steer: 0, handbrake: 0 } : o);
    for (let i = 0; i < 90; i++) g._update(1 / 30);
    c1.v.setControls = own;
    rows.push(report('hit (3 s)'));
    await settle();
    rows.push(report(`hit (${after} s)`));
    reset();

    // 1b. The player into the back of one: not its doing.
    p.repair();
    clearPolice(pAt.x, pAt.z);
    [c1] = two();
    put(c1.v, on(L * 0.5 + 12), fwd, 0);
    put(p, pAt, fwd, 45);
    for (let i = 0; i < 90; i++) g._update(1 / 30);
    rows.push(report(`rammed (3 s, player hit at ${(p.lastImpact || 0).toFixed(1)} m/s)`));
    reset();

    // 2 and 3. Two into each other, near and far.
    for (const [name, gap] of [['seen', 25], ['unseen', 250]]) {
      p.repair();
      const at = on(L * 0.5);
      put(p, on(L * 0.5 - gap), fwd, 0);
      clearPolice(at.x, at.z);
      const [ca, cb] = two();
      put(ca.v, on(L * 0.5 - 6, 1.5), fwd, 35);
      put(cb.v, on(L * 0.5 + 6, 1.5), back, 35);
      for (let i = 0; i < 60; i++) g._update(1 / 30);
      rows.push(report(`${name} (2 s)`));
      await settle();
      rows.push(report(`${name} (${after} s)`));
      reset();
    }
    g._update = origU;
    window.__res = rows.join('\n');
  } catch (e) {
    window.__res = rows.join('\n') + '\nEX: ' + e.message + ' | ' + (e.stack || '').slice(0, 300);
  }
};
