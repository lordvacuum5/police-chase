// A unit standing between two trees, asked to go somewhere.
//
// "It basically got stuck in between two trees. It could literally have just
// turned its wheels ... and it would have been out of there. But it just kept
// on going backwards and forwards." The chase rigs count trunks hit; none of
// them asks whether a car that is already among the trunks can get out again.
//
// So: every pair of trunks four and a half to seven metres apart with nothing
// else close, a unit parked at the midpoint pointing through the gap, and the
// target put sixty metres off in six directions round it. Each case runs for
// fifteen seconds.
//
//   out       how many cases got more than fifteen metres from where they
//             started, which is out of the trees by any reading
//   rev       reverses started, summed -- the backwards-and-forwards
//   still     share of the time under 2 km/h
//
//   await import('/tests/betweentrees.js');
//   __runBetweenTrees();                     // as it ships
//   window.__noTreeStrip = true; __runBetweenTrees();   // without the strip
import { GROUP } from '../src/physics/world.js';

function pairs(want = 6) {
  if (window.__treePairs) return window.__treePairs;
  const pts = [];
  window.__game.world.forEachCollider((c) => {
    const member = c.collisionGroups ? (c.collisionGroups() >>> 16) : 0;
    if (!(member & GROUP.PROP)) return;
    const h = c.halfExtents ? c.halfExtents() : null;
    // Trunks, not lamp posts or bollards.
    if (!h || Math.abs(h.x - 0.65) > 0.01 || Math.abs(h.y - 2.6) > 0.01) return;
    const t = c.translation();
    pts.push({ x: t.x, z: t.z });
  });
  const out = [];
  for (let i = 0; i < pts.length && out.length < want; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const a = pts[i], b = pts[j];
      const d = Math.hypot(a.x - b.x, a.z - b.z);
      if (d < 4.5 || d > 7) continue;
      const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
      // Nothing else within twelve metres, so it is these two and not a wood.
      let crowded = false;
      for (const c of pts) {
        if (c === a || c === b) continue;
        if (Math.hypot(c.x - mx, c.z - mz) < 12) { crowded = true; break; }
      }
      if (crowded) continue;
      // Pointing through the gap: perpendicular to the line between them.
      // A heading h points along (sin h, cos h), so (-dz, dx) -- square to the
      // line between the trunks -- is atan2(-dz, dx).
      out.push({ x: mx, z: mz, heading: Math.atan2(-(b.z - a.z), b.x - a.x), gap: d });
      break;
    }
  }
  window.__treePairs = out;
  return out;
}

window.__runBetweenTrees = async function (seconds = 15) {
  window.__btDone = false;
  window.__res = null;
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.player); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const g = window.__game;
    const { SKILL, ROLE, Officer } = window.__modules;
    const sites = pairs();
    let out = 0, cases = 0, revs = 0, still = 0, frames = 0, hits = 0;
    const rows = [];
    for (const s of sites) {
      let line = `gap ${s.gap.toFixed(1)} m:`;
      for (const off of [0, 60, -60, 120, -120, 180]) {
        g.onBusted = () => { g.outcome = null; g.heat.bustTimer = 0; };
        g.onEscaped = () => { g.outcome = null; };
        g.paused = true;
        const ang = s.heading + (off * Math.PI) / 180;
        const p = g.player;
        p.repair();
        p.teleport({ x: s.x + Math.sin(ang) * 60, y: 0.9, z: s.z + Math.cos(ang) * 60 }, 0);
        p.setVelocity({ x: 0, y: 0, z: 0 });
        p._readState();

        const car = g.createVehicle('interceptor', 'interceptor',
          { x: s.x, y: 0.95, z: s.z }, s.heading, { police: true });
        if (!car) continue;
        const o = new Officer(g, car, { skill: SKILL.pursuit, kind: 'interceptor' });
        o.setRole(ROLE.PURSUE);
        o.driver.allowOffRoad = true;
        car._readState();

        let rev = 0, wasRev = false, lastAt = 0, h = 0;
        for (let f = 0; f < seconds * 60; f++) {
          g.heat.value = 3;
          const k = g.dispatcher.knowledge;
          k.seen = true;
          k.position.copy(p.position);
          k.velocity.set(0, 0, 0);
          k.confidence = 1;
          p.teleport(p.position, 0);
          p.setVelocity({ x: 0, y: 0, z: 0 });
          p._readState();
          o.update(1 / 60, p);
          g.stepHeadless(1 / 60);
          const r = o.driver.reverseTimer > 0;
          if (r && !wasRev) rev++;
          wasRev = r;
          if (car.speed < 0.55) still++;
          frames++;
          if (car.lastImpactAt && car.lastImpactAt !== lastAt && car.lastImpact > 4) {
            lastAt = car.lastImpactAt;
            h++;
          }
        }
        const moved = Math.hypot(car.position.x - s.x, car.position.z - s.z);
        const got = moved > 15;
        if (got) out++;
        cases++;
        revs += rev;
        hits += h;
        line += `  ${off}:${got ? 'out' : 'STUCK'}${rev ? `/${rev}r` : ''}`;
        g.despawnPolice(o);
        g.paused = false;
      }
      rows.push(line);
    }
    rows.push(`${cases} cases: out ${out}  reverses ${revs}  hits ${hits}  `
      + `still ${Math.round((still * 100) / Math.max(1, frames))}% of the time`
      + `${window.__noTreeStrip ? '  (tree strip OFF)' : ''}`);
    window.__res = rows.join('\n');
  } catch (e) {
    window.__res = 'EX: ' + e.message + ' | ' + (e.stack || '').slice(0, 400);
  }
  window.__btDone = true;
  return window.__res;
};
