// A unit pinned near one wall of a gap, with the way out straight ahead.
//
// "It's in between these two [houses], and it can literally just turn its
// wheels, and go forwards, and it could just get out of the gap, that's quite
// big. It just doesn't seem able to see it."
//
// Narrow passages are found from the colliders themselves: a lattice across the
// map, keeping points with 3.2-5.5 m between walls on either side, twelve clear
// metres ahead and four behind. The car is put 0.3 m off the nearer wall,
// pointing along the passage, with the target sixty metres straight on. That is
// the case where the planner used to find no plan at all, because the car
// already stood inside its safety margin and every move from there failed.
//
//   plan      planLocal found one from the start pose (no driving)
//   out       driven for 15 s, the car got 25 m along toward the target
//
//   await import('/tests/pinned.js');
//   __runPinned();                 // then window.__res when window.__pinDone
import { sweepBox, groups, GROUP } from '../src/physics/world.js';
import { planLocal } from '../src/ai/localplan.js';

const SOLID = groups(0xFFFF, GROUP.BUILDING | GROUP.PROP);

function passages(spec, want) {
  const g = window.__game;
  const hw = spec.dims.w / 2;
  const b = g.graph.bounds;
  const found = [];
  for (let x = b.minX; x < b.maxX && found.length < want; x += 7) {
    for (let z = b.minZ; z < b.maxZ && found.length < want; z += 7) {
      const o = { x, y: 1, z };
      for (const h of [0, Math.PI / 4, Math.PI / 2, (3 * Math.PI) / 4]) {
        const fx = Math.sin(h), fz = Math.cos(h), lx = Math.cos(h), lz = -Math.sin(h);
        const dl = sweepBox(g.world, o, { x: lx, y: 0, z: lz }, 6, SOLID, null, 0.1);
        const dr = sweepBox(g.world, o, { x: -lx, y: 0, z: -lz }, 6, SOLID, null, 0.1);
        const w = dl + dr;
        if (w < 3.2 || w > 5.5) continue;
        if (sweepBox(g.world, o, { x: fx, y: 0, z: fz }, 12, SOLID, null, hw) < 12) continue;
        if (sweepBox(g.world, o, { x: -fx, y: 0, z: -fz }, 6, SOLID, null, hw) < 4) continue;
        const side = dl < dr ? 1 : -1;
        const shift = Math.min(dl, dr) - (hw + 0.3);
        found.push({ x: x + lx * side * shift, z: z + lz * side * shift, h, w, fx, fz });
        break;
      }
    }
  }
  return found;
}

window.__runPinned = async function (want = 15, secs = 15) {
  window.__pinDone = false;
  window.__res = null;
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.player); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    // Rapier only answers shape casts once the world has been stepped, and right
    // after load it may not have been: every sweep then reads clear, no
    // passage measures narrow enough, and the rig finds nothing to test.
    await new Promise((r) => setTimeout(r, 1500));
    const g = window.__game;
    // A hidden page barely runs its frame loop, so make sure of it.
    g.world.step();
    const { SKILL, ROLE, Officer } = window.__modules;
    g.onBusted = () => { g.outcome = null; g.heat.bustTimer = 0; };
    g.onEscaped = () => { g.outcome = null; };
    const spec = g.player.spec;
    const sites = passages(spec, want);
    let planned = 0, out = 0, hits = 0;
    const rows = [];
    for (const s of sites) {
      const tx = s.x + s.fx * 60, tz = s.z + s.fz * 60;
      const p = planLocal(g, {
        position: { x: s.x, y: 0.95, z: s.z }, forward: { x: s.fx, z: s.fz }, forwardSpeed: 0, spec,
      }, { x: tx, z: tz });
      if (p) planned++;

      const pl = g.player;
      pl.repair();
      pl.teleport({ x: tx, y: 0.9, z: tz }, 0);
      pl.setVelocity({ x: 0, y: 0, z: 0 });
      pl._readState();
      g.paused = true;
      const car = g.createVehicle('interceptor', 'interceptor', { x: s.x, y: 0.95, z: s.z }, s.h, { police: true });
      if (!car) continue;
      const o = new Officer(g, car, { skill: SKILL.pursuit, kind: 'interceptor' });
      o.setRole(ROLE.PURSUE);
      o.driver.allowOffRoad = true;
      car._readState();
      let lastAt = 0, h = 0;
      for (let f = 0; f < secs * 60; f++) {
        g.heat.value = 3;
        const k = g.dispatcher.knowledge;
        k.seen = true; k.position.copy(pl.position); k.velocity.set(0, 0, 0); k.confidence = 1;
        pl.teleport(pl.position, 0); pl.setVelocity({ x: 0, y: 0, z: 0 }); pl._readState();
        o.update(1 / 60, pl);
        g.stepHeadless(1 / 60);
        if (car.lastImpactAt && car.lastImpactAt !== lastAt && car.lastImpact > 4) { lastAt = car.lastImpactAt; h++; }
      }
      const along = (car.position.x - s.x) * s.fx + (car.position.z - s.z) * s.fz;
      const got = along > 25;
      if (got) out++;
      hits += h;
      rows.push(`gap ${s.w.toFixed(1)} m: plan ${p ? 'yes' : 'NO'}  ${got ? 'out' : 'STUCK'} (${Math.round(along)} m along)${h ? `  hits ${h}` : ''}`);
      g.despawnPolice(o);
      g.paused = false;
    }
    rows.push(`${sites.length} pinned starts: planned from ${planned}, got out of ${out}, hits ${hits}`
      + `${window.__noLocalPlan ? '  (planner OFF)' : ''}`);
    window.__res = rows.join('\n');
  } catch (e) {
    window.__res = 'EX: ' + e.message + ' | ' + (e.stack || '').slice(0, 400);
  }
  window.__pinDone = true;
  return window.__res;
};
