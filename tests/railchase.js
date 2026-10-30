// Police following you down the railway. Haldon Vale.
//
// "When the police cars go near trees or an obstacle, they just slow down so
// much ... the train track ... runs through a bunch of trees. And they sort of
// keep up most of the time ... following me on the train track. And for some
// reason, they decide to go inside the trees ... They should just stay on the
// train track, because it's the fastest route to me."
//
// A ghost runs along the railway at `kph` (like tests/weave.js: teleported
// along the line, the force told exactly where it is), the train kept away,
// two pursuit interceptors starting behind it on the bed. Per run, from
// `from` metres along the line, `seconds` long, over every unit-frame:
//
//   gap     mean distance to the ghost, m; `lost` frames over 150 m
//   offBed  share of frames more than 6 m off the line while within 150 m
//   trees   share of frames with a tree or building within 4 m of the car
//   slow    share under 40 km/h
//   hits    contacts over 4 m/s
window.__runRailChase = async function (kph = 100, seconds = 25, froms = [300, 900, 1500], label = '') {
  window.__res = null;
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.world && window.__game.world.__map); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const g = window.__game;
    const { SKILL, ROLE, Officer } = window.__modules;
    const rw = g.world.__map.railway;
    const { GROUP, groups, RAPIER } = await import('/src/physics/world.js');
    const ball = new RAPIER.Ball(4);
    // The train well away for the whole of each run (set again for each: three
    // runs outlasted it once, and the third met the train).
    const noTrain = () => {
      for (let t = rw.clock; t < rw.clock + rw.period; t += 1) {
        let clear = true;
        for (let k = 0; k < seconds + 10 && clear; k += 2) if (rw.frontAt(t + k)) clear = false;
        if (clear) { rw.clock = t; return; }
      }
    };
    const line = [];
    for (let s = 0; s <= rw.len; s += 4) line.push(rw._pose(s));
    const offLine = (x, z) => {
      let best = Infinity;
      for (const p of line) best = Math.min(best, (p.x - x) ** 2 + (p.z - z) ** 2);
      return Math.sqrt(best);
    };
    const SOLID = groups(0xFFFF, GROUP.BUILDING | GROUP.PROP);
    const out = [];
    for (const from of froms) {
      noTrain();
      g.onBusted = () => { g.outcome = null; g.heat.bustTimer = 0; };
      g.onEscaped = () => { g.outcome = null; };
      g.paused = true;
      const speed = kph / 3.6, p = g.player;
      let s = from;
      const at = (s0) => rw._pose(s0);
      const a0 = at(s), a1 = at(s + 4);
      const h0 = Math.atan2(a1.x - a0.x, a1.z - a0.z);
      p.repair();
      p.teleport({ x: a0.x, y: g.sim.heightAt(a0.x, a0.z) + 0.9, z: a0.z }, h0);
      const units = [];
      for (const back of [25, 40]) {
        const b = at(s - back), b1 = at(s - back + 4);
        const hb = Math.atan2(b1.x - b.x, b1.z - b.z);
        const car = g.createVehicle('interceptor', 'interceptor', { x: b.x, y: g.sim.heightAt(b.x, b.z) + 0.95, z: b.z }, hb, { police: true });
        if (!car) continue;
        const o = new Officer(g, car, { skill: SKILL.pursuit, kind: 'interceptor' });
        o.setRole(ROLE.PURSUE);
        o.driver.allowOffRoad = true;
        car._readState();
        car.setVelocity({ x: Math.sin(hb) * speed, y: 0, z: Math.cos(hb) * speed });
        units.push(o);
      }
      const d = { frames: 0, gap: 0, lost: 0, offBed: 0, near: 0, trees: 0, slow: 0, hits: 0 };
      const lastAt = new Map();
      for (let i = 0; i < seconds * 60; i++) {
        s += speed / 60;
        if (s > rw.len - 10) break;
        const a = at(s), b = at(s + 3);
        const hx = (b.x - a.x) / 3, hz = (b.z - a.z) / 3, hl = Math.hypot(hx, hz) || 1;
        p.teleport({ x: a.x, y: g.sim.heightAt(a.x, a.z) + 0.9, z: a.z }, Math.atan2(hx, hz));
        p.setVelocity({ x: (hx / hl) * speed, y: 0, z: (hz / hl) * speed });
        p._readState();
        g.heat.value = 3;
        const k = g.dispatcher.knowledge;
        k.seen = true;
        k.position.copy(p.position);
        k.velocity.set((hx / hl) * speed, 0, (hz / hl) * speed);
        k.confidence = 1;
        for (const o of units) o.update(1 / 60, p);
        g.stepHeadless(1 / 60);
        for (const o of units) {
          const v = o.vehicle, gap = o.distanceTo(p.position);
          d.frames++;
          d.gap += gap;
          if (gap > 150) { d.lost++; continue; }
          d.near++;
          if (i % 6 === 0) {
            if (offLine(v.position.x, v.position.z) > 6) d.offBed += 6;
            let close = false;
            g.world.intersectionsWithShape(v.position, v.body.rotation(), ball, () => { close = true; return false; }, undefined, SOLID, v.collider);
            if (close) d.trees += 6;
          }
          if (v.speed * 3.6 < 40) d.slow++;
          // A line every half second of each unit, into window.__railTrace.
          if (window.__railTrace && i % 30 === 0) {
            window.__railTrace.push([from, Math.round(i / 6) / 10, units.indexOf(o), o._mode, Math.round(offLine(v.position.x, v.position.z)), Math.round(v.speed * 3.6), Math.round(gap), o._rail ? Math.round(o._rail.me) + '>' + Math.round(o._rail.them) : '-']);
          }
          if (v.lastImpactAt && v.lastImpactAt !== lastAt.get(o) && v.lastImpact > 4) { lastAt.set(o, v.lastImpactAt); d.hits++; }
        }
      }
      for (const o of units) g.despawnPolice(o);
      g.paused = false;
      g.heat.reset();
      const n = d.frames || 1, m = d.near || 1;
      out.push(`${label} from ${from}: gap ${Math.round(d.gap / n)} m, lost ${Math.round((100 * d.lost) / n)}%, offBed ${Math.round((100 * d.offBed) / m)}%, trees ${Math.round((100 * d.trees) / m)}%, slow ${Math.round((100 * d.slow) / m)}%, hits ${d.hits}`);
      await new Promise((r) => setTimeout(r, 0));
    }
    window.__res = out.join('\n');
  } catch (e) {
    window.__res = 'EX: ' + e.message + ' | ' + (e.stack || '').slice(0, 300);
  }
};
