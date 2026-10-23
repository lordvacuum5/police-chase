// A unit in among the houses, with the target somewhere it has to turn for.
//
// "There was obvious routes out, but it seemed to just keep on choosing
// different routes, and it seemed to choose the worst routes possible. It
// could literally have just turned around ... or it could have just turned
// the wheels and gone forwards, and then just manoeuvred itself out of, like,
// kind of housing complex."
//
// The sites are points on the weave paths (tests/weave.js), which are by
// construction off the road with a building within sixteen metres -- gaps,
// courtyards, the backs of houses. A unit is parked on one pointing along the
// weave, and the target is put eighty metres away in five directions, three of
// them behind it. Twenty seconds each.
//
//   out       got within 30 m of the target, or 40 m closer than it started
//   rev       reverses started
//   switches  times the route it was following was replaced by one that sets
//             off in a different direction (more than 45 degrees apart over the
//             first 15 m) -- the "keeps choosing different routes"
//   still     share of the time under 2 km/h
//
//   await import('/tests/estate.js');
//   __runEstate();
import { weavePath } from './weave.js?v=31';
import { Driver } from '../src/ai/driver.js';

function heading(pts, from, along = 15) {
  // Direction of the first `along` metres of a path, from `from`.
  let x = from.x, z = from.z, acc = 0;
  for (const q of pts) {
    const d = Math.hypot(q.x - x, q.z - z);
    acc += d; x = q.x; z = q.z;
    if (acc >= along) break;
  }
  return Math.atan2(x - from.x, z - from.z);
}

window.__runEstate = async function (sites = 8, seconds = 20) {
  window.__estDone = false;
  window.__res = null;
  window.__estLog = [];
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.player); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const g = window.__game;
    const { SKILL, ROLE, Officer } = window.__modules;
    const ts0 = Object.assign({}, Driver.turnStats);
    let out = 0, cases = 0, revs = 0, switches = 0, still = 0, frames = 0, hits = 0;
    const rows = [];
    for (let w = 0; w < sites; w++) {
      const W = weavePath(w);
      if (!W || W.pts.length < 12) continue;
      const a = W.pts[10], b = W.pts[11];
      const h0 = Math.atan2(b.x - a.x, b.z - a.z);
      let line = `site ${w}:`;
      for (const off of [0, 90, 135, 180, -135]) {
        g.onBusted = () => { g.outcome = null; g.heat.bustTimer = 0; };
        g.onEscaped = () => { g.outcome = null; };
        g.paused = true;
        const ang = h0 + (off * Math.PI) / 180;
        const p = g.player;
        p.repair();
        const tx = a.x + Math.sin(ang) * 80, tz = a.z + Math.cos(ang) * 80;
        p.teleport({ x: tx, y: 0.9, z: tz }, 0);
        p.setVelocity({ x: 0, y: 0, z: 0 });
        p._readState();

        const car = g.createVehicle('interceptor', 'interceptor',
          { x: a.x, y: 0.95, z: a.z }, h0, { police: true });
        if (!car) continue;
        const o = new Officer(g, car, { skill: SKILL.pursuit, kind: 'interceptor' });
        o.setRole(ROLE.PURSUE);
        o.driver.allowOffRoad = true;
        car._readState();

        // Every route it is handed, and which way that route sets off.
        let sw = 0, lastHead = null;
        const d = o.driver;
        const realSet = d.setPath.bind(d);
        const log = [];
        d.setPath = (pts) => {
          if (pts && pts.length > 1) {
            const hd = heading(pts, car.position);
            if (lastHead !== null) {
              let dd = Math.abs(hd - lastHead) % (2 * Math.PI);
              if (dd > Math.PI) dd = 2 * Math.PI - dd;
              if (dd > Math.PI / 4) {
                sw++;
                log.push(`${(f / 60).toFixed(1)}s ${Math.round(lastHead * 57.3)}->${Math.round(hd * 57.3)}`);
              }
            }
            lastHead = hd;
          }
          return realSet(pts);
        };

        let rev = 0, wasRev = false, lastAt = 0, hh = 0, f = 0, best = Infinity;
        const start = Math.hypot(tx - a.x, tz - a.z);
        for (f = 0; f < seconds * 60; f++) {
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
          const r = d.reverseTimer > 0;
          if (r && !wasRev) rev++;
          wasRev = r;
          if (car.speed < 0.55) still++;
          frames++;
          if (car.lastImpactAt && car.lastImpactAt !== lastAt && car.lastImpact > 4) {
            lastAt = car.lastImpactAt;
            hh++;
          }
          best = Math.min(best, Math.hypot(car.position.x - tx, car.position.z - tz));
        }
        const got = best < 30 || best < start - 40;
        if (got) out++;
        cases++;
        revs += rev;
        switches += sw;
        hits += hh;
        line += `  ${off}:${got ? 'out' : 'STUCK'}${rev ? `/${rev}r` : ''}${sw ? `/${sw}sw` : ''}`;
        if (!got || sw > 1) window.__estLog.push(`site ${w} off ${off}: best ${Math.round(best)} m, ${log.join(', ')}`);
        g.despawnPolice(o);
        g.paused = false;
      }
      rows.push(line);
    }
    // Every car on the map counts towards these, not only the one under test --
    // the dispatcher's own units are driving about the whole time.
    const ts = Driver.turnStats;
    rows.push(`${cases} cases: out ${out}  reverses ${revs}  route switches ${switches}  hits ${hits}  `
      + `still ${Math.round((still * 100) / Math.max(1, frames))}% of the time  `
      + `| turn-rounds, all cars: started ${ts.started - ts0.started} finished ${ts.done - ts0.done} `
      + `gave up ${ts.gaveUp - ts0.gaveUp}`
      + `${window.__noTurnRound ? '  (turn-round OFF)' : ''}`);
    window.__res = rows.join('\n');
  } catch (e) {
    window.__res = 'EX: ' + e.message + ' | ' + (e.stack || '').slice(0, 400);
  }
  window.__estDone = true;
  return window.__res;
};
