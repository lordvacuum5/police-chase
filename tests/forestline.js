// How close the long-range lines (ai/fastplan.js) pass to what they go round, and
// what a unit on one was doing when it hit a tree.
//
// "The police cars still do seem to crash quite a lot when you go through dense
// forests." The tree log says the hard ones are on a line, at 95-150 km/h, nose on.
// Either the line goes through the trunk, or it goes past and the car does not
// follow it. These are different faults, and this says which.
//
//   const t = __lineLens();          // pass as the tweak to __runForce
//   await __runForce(30, 120, 4, 'forest', t, false, 'trees');
//   __lineReport();
import { boxesNear } from '../src/ai/localplan.js';

function outside(b, x, z) {
  const dx = x - b.x, dz = z - b.z;
  const lx = Math.abs(dx * b.c - dz * b.s) - b.hx, lz = Math.abs(dx * b.s + dz * b.c) - b.hz;
  return Math.hypot(Math.max(lx, 0), Math.max(lz, 0));
}

function clearanceAt(g, x, z) {
  let best = 99;
  for (const b of boxesNear(g, x, z, 14)) best = Math.min(best, outside(b, x, z));
  return best;
}

/** The least clearance of a stretch of path, sampled every metre. */
function pathClearance(g, path, from, metres) {
  let best = 99, gone = 0;
  for (let i = Math.max(1, from); i < path.length && gone < metres; i++) {
    const a = path[i - 1], b = path[i];
    const d = Math.hypot(b.x - a.x, b.z - a.z);
    const n = Math.max(1, Math.ceil(d));
    for (let k = 0; k <= n; k++) best = Math.min(best, clearanceAt(g, a.x + ((b.x - a.x) * k) / n, a.z + ((b.z - a.z) * k) / n));
    gone += d;
  }
  return best;
}

window.__lineLens = function () {
  const L = window.__lens = {
    lines: 0, under: [0, 0, 0, 0], // lines whose least clearance is under 1, 1.5, 2, 3 m
    frames: 0, track: 0, trackOver2: 0, hits: [],
    seen: new WeakMap(), last: new WeakMap(), born: new WeakMap(), speeds: [],
  };
  return (_d, g) => {
    if (g.__lensOn) return;
    g.__lensOn = true;
    const step = g.stepHeadless.bind(g);
    g.stepHeadless = (dt, c) => {
      step(dt, c);
      for (const u of g.dispatcher.units) {
        const dr = u.driver, v = u.vehicle;
        if (!v || v.removed) continue;
        if (u._fast && dr.hasPath) {
          if (L.seen.get(u) !== dr.path) {
            L.seen.set(u, dr.path);
            L.born.set(u, g.clock);
            L.lines++;
            const c0 = pathClearance(g, dr.path, 1, 60);
            [1, 1.5, 2, 3].forEach((m, i) => { if (c0 < m) L.under[i]++; });
          }
          L.frames++;
          const ct = Math.abs(dr.crossTrack || 0);
          L.track += ct;
          if (ct > 2) L.trackOver2++;
        }
        if (v.lastImpactAt && v.lastImpactAt !== L.last.get(u) && v.lastImpact > 4) {
          L.last.set(u, v.lastImpactAt);
          let car = 99;
          for (const o of g.vehicles) {
            if (o === v || o.removed) continue;
            car = Math.min(car, Math.hypot(o.position.x - v.position.x, o.position.z - v.position.z));
          }
          L.hits.push({
            mode: u._mode, fast: !!u._fast, imp: +v.lastImpact.toFixed(1), kph: Math.round(v.speed * 3.6),
            carClear: +clearanceAt(g, v.position.x, v.position.z).toFixed(1),
            otherCar: +car.toFixed(1),
            track: +(dr.crossTrack || 0).toFixed(1),
            lineClear: u._fast && dr.hasPath ? +pathClearance(g, dr.path, Math.max(1, dr.pathIndex - 1), 25).toFixed(1) : null,
            lineAge: u._fast ? +(g.clock - (L.born.get(u) || 0)).toFixed(2) : null,
          });
        }
      }
    };
  };
};

window.__lineReport = function () {
  const L = window.__lens;
  const rows = [`lines ${L.lines}, least clearance under 1/1.5/2/3 m: ${L.under.join('/')}`,
    `on a line: mean off it ${(L.track / Math.max(1, L.frames)).toFixed(2)} m, over 2 m ${Math.round((L.trackOver2 * 100) / Math.max(1, L.frames))}% of the time`];
  for (const h of L.hits) rows.push(JSON.stringify(h));
  return rows.join('\n');
};
