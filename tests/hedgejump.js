// Over a hedge, not through it (Vehicle._hedgeDrag).
//
// "With hedges, you know they slow me down. Well, if I even jump over the
// hedge, not even touching it, it still slows me down." The hedge's collider
// stands HEDGE_SOLID (6 m) high for the AI's sight lines; the drag now needs
// the car's underside below the top of what is drawn.
//
// The player's car sent square across one hedge at 60 km/h, three ways:
//   through   on the ground
//   jump      launched upward from 15 m out, clear over the top
//   skim      launched to be at the hedge's height as it crosses
// Each reports horizontal speed before and 2 s after, and whether the drag
// fired. `oldTop` true pretends every hedge is 99 m tall: the old behaviour.
window.__runHedgeJump = async function (oldTop = false) {
  window.__res = null;
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.player && window.__game.sim && window.__game.sim.hedges); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const g = window.__game, p = g.player, W = g.world;
    g.onBusted = () => { g.outcome = null; };
    g.stepHeadless(2);
    const hedges = g.sim.hedges;
    if (oldTop) for (const k of hedges.keys()) hedges.set(k, 99);
    // A hedge on open, fairly level ground, out of the way of everything.
    let pick = null;
    for (const [h, top] of hedges) {
      const c = W.getCollider(h);
      const t = c.translation();
      const gy = g.sim.heightAt(t.x, t.z);
      if (Math.abs(g.sim.heightAt(t.x + 20, t.z) - gy) > 1 || Math.abs(g.sim.heightAt(t.x, t.z + 20) - gy) > 1) continue;
      pick = { c, t, top: oldTop ? null : top, gy };
      break;
    }
    if (!pick) throw new Error('no level hedge');
    const r = pick.c.rotation();
    // The hedge's length runs along its local x; across it is local z.
    const ax = 1 - 2 * (r.y * r.y + r.z * r.z), az = 2 * (r.x * r.z - r.w * r.y);
    const nx = az, nz = -ax;                               // across
    const head = Math.atan2(nx, nz);
    const rows = [];
    for (const [name, vy] of [['through', 0], ['jump', 9], ['skim', 5.2]]) {
      p.repair();
      const sx = pick.t.x - nx * 15, sz = pick.t.z - nz * 15;
      p.teleport({ x: sx, y: g.sim.heightAt(sx, sz) + 0.7, z: sz }, head);
      p.setVelocity({ x: nx * 16.7, y: vy, z: nz * 16.7 });
      p._hedgeFor = 0;
      let fired = false, minUnder = Infinity;
      for (let i = 0; i < 120; i++) {
        p.setControls({ throttle: 0, brake: 0, steer: 0, handbrake: 0 });
        g._update(1 / 60);
        const along = (p.position.x - pick.t.x) * nx + (p.position.z - pick.t.z) * nz;
        if (p._hedgeFor > 0 && !fired) fired = `at ${along.toFixed(1)} m, underside ${(p.collider.translation().y - p.spec.dims.h * 0.5 - pick.gy).toFixed(1)} m up`;
        if (Math.abs(along) < 1.2) minUnder = Math.min(minUnder, p.collider.translation().y - p.spec.dims.h * 0.5 - pick.gy);
      }
      const after = Math.hypot(p.linvel.x, p.linvel.z) * 3.6;
      rows.push(`${name}: 60 -> ${after.toFixed(0)} km/h, drag ${fired || 'no'}, underside over the hedge ${Number.isFinite(minUnder) ? minUnder.toFixed(1) + ' m' : 'n/a'} (top ${pick.top === null ? '99' : (pick.top - pick.gy).toFixed(1)} m)`);
    }
    window.__res = rows.join('\n');
  } catch (e) {
    window.__res = 'EX: ' + e.message + ' | ' + (e.stack || '').slice(0, 300);
  }
};
