// Hitting a tractor. Haldon Vale.
//
// "It doesn't just there's a solid wall, is the sense. It's more like a the
// resistance and how it acts when you hit it is more like a police van."
//
// The player's car is put `gap` metres to the side of the first tractor
// (map.movers[0]), homing in on it, and driven into its flank at
// `kph`. Then, for the second after the first touch:
//
//   stop    the car's speed change in its worst single substep, m/s -- the
//           thump; a wall is all of it at once
//   after   the car's speed half a second after the touch, km/h
//   dmg     damage the car took, %
//   shoved  how far the tractor was pushed off its line at most, m
window.__runWorkHit = async function (kph = 50, gap = 16) {
  window.__res = null;
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.world && window.__game.world.__map); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const g = window.__game;
    g.onBusted = () => { g.outcome = null; };
    g.heat.value = 0;
    const p = g.player;
    let controls = { throttle: 0, brake: 0, steer: 0, handbrake: 0 };
    const origU = g._update.bind(g);
    g._update = (dt) => { p.setControls(controls); origU(dt); p.setControls(controls); };

    const runInto = (target, aim) => {
      const v = kph / 3.6, tHit = gap / v;
      const at = aim(tHit);
      const start = { x: at.x - at.sx * gap, z: at.z - at.sz * gap };
      start.y = g.sim.heightAt(start.x, start.z) + 0.9;
      p.repair();
      p.teleport(start, Math.atan2(at.sx, at.sz));
      p.setVelocity({ x: at.sx * v, y: 0, z: at.sz * v });
      let touched = -1, stop = 0, after = null, prev = p.speed, shoved = 0, lastD = Infinity, stalled = 0;
      const dmg0 = p.damage;
      for (let i = 0; i < 300; i++) {
        controls = { throttle: 0, brake: 0, steer: 0, handbrake: 0 };
        // Homing in until close, so a tractor slower or faster than predicted
        // is still hit square.
        // (From the body: `position` is only read back when the car is stepped.)
        const bt = p.body.translation();
        const dx = target.position.x - bt.x, dz = target.position.z - bt.z, d = Math.hypot(dx, dz);
        // Something else in the way -- a hedge, a wall -- and the homing would
        // ram it every step: say so and stop.
        // (Over a run of frames: one that took no physics step goes nowhere.)
        stalled = touched < 0 && d > lastD - 0.01 ? stalled + 1 : 0;
        if (stalled > 8) return { blocked: true };
        lastD = d;
        if (touched < 0 && d > 6) {
          p.teleport({ x: bt.x, y: bt.y, z: bt.z }, Math.atan2(dx, dz));
          p.setVelocity({ x: (dx / d) * v, y: 0, z: (dz / d) * v });
        }
        // Substep by substep, to catch the thump.
        g._update(1 / 120);
        const sp = Math.hypot(p.linvel.x, p.linvel.z);
        if (touched < 0 && Math.hypot(p.position.x - target.position.x, p.position.z - target.position.z) < 4.5 && prev - sp > 0.3) touched = i;
        if (touched >= 0) {
          stop = Math.max(stop, prev - sp);
          if (i - touched === 60) after = Math.round(sp * 3.6);
          if (target.body && target.position) {
            const t = target.body.translation();
            shoved = Math.max(shoved, Math.hypot(t.x - target.position.x, t.z - target.position.z));
          }
        }
        prev = sp;
      }
      return { touched: touched >= 0, stop: +stop.toFixed(1), after, dmg: +((p.damage - dmg0) * 100).toFixed(1), shoved: +shoved.toFixed(2) };
    };

    const map = g.world.__map;
    const m = map.movers[0];
    // Placed and moving before anything is aimed at it.
    g.stepHeadless(1);
    const out = {};
    // From its right-hand side, where it is now: the homing above follows it.
    out.tractor = runInto(m, () => {
      const t = m.body.translation();
      const fx = m.forward.x, fz = m.forward.z;
      return { x: t.x, z: t.z, sx: -fz, sz: fx };
    });
    g._update = origU;
    window.__res = JSON.stringify(out);
  } catch (e) {
    window.__res = 'EX: ' + e.message + ' | ' + (e.stack || '').slice(0, 300);
  }
};
