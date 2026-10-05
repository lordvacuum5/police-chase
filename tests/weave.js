// Can they follow you between the buildings?
//
// "I can just go through loads and loads of tight gaps really fast through
// loads of buildings and then they just literally cannot do anything. They
// lose you instantly, even on wanted level five."
//
// Every other rig here chases along roads. This one does not: a ghost is sent
// in a straight line across a built-up part of the map, through whatever gaps
// happen to be in the way, which is what a player does when they stop using
// the streets. Threading those is the thing the pursuit is worst at, and it is
// a different question from cornering -- a gap needs a line that goes one way
// and then the other, and nothing that steers a single arc can describe one.
//
//   stayed    how much of the run at least one unit was within 80 m
//   lost      seconds before the last unit was further than 150 m and stayed
//             there, or 'never' if they hung on to the end
//   hits      contacts above a knock
//   gaps      how many building gaps the line actually passes through, so a
//             run that happened to cross open ground is obvious
window.__runWeave = async function (seconds = 22, kph = 110, tweak = null, runs = 4, label = '') {
  // Stamped and counted, because a run of eight takes the best part of a minute
  // and reading window.__res before it finishes hands back the *previous*
  // answer. Two settings were compared that way and came out identical, which
  // they were: it was the same string twice.
  window.__weaveDone = false;
  window.__weaveAt = -1;
  window.__res = null;
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.player); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const rows = [];
    let stayed = 0, lost = 0, back = 0, hits = 0, spd = 0, sliding = 0, spins = 0;
    for (let i = 0; i < runs; i++) {
      window.__weaveAt = i;
      const r = run(i, seconds, kph, tweak);
      rows.push(r.line);
      stayed += r.stayed; lost += r.lost; back += r.back; hits += r.hits; spd += r.spd;
      sliding += r.sliding; spins += r.spins;
      await new Promise((res) => setTimeout(res, 0));
    }
    rows.push(`${runs} runs:  stayed ${Math.round((stayed * 100) / runs)}%  `
      + `held on ${(lost / runs).toFixed(1)}s  ended ${Math.round(back / runs)} m back  `
      + `hits ${hits}  mean ${Math.round(spd / runs)} kph  `
      + `sliding ${Math.round((sliding * 100) / runs)}%  lost it ${spins}x`);
    window.__res = (label ? label + '\n' : '') + rows.join('\n');
    window.__weaveDone = true;
    return window.__res;
  } catch (e) {
    window.__weaveDone = true;
    window.__res = 'EX: ' + e.message + ' | ' + (e.stack || '').slice(0, 300);
    return window.__res;
  }
};

/**
 * One setting after another in a single page session, which is the only way
 * these differences come out of the noise -- and in one call, because a sweep
 * driven from the console loses its place every time a poll times out.
 *
 *   __weaveSweep([1, 2, 3], (d, o, v, x) => { o.bandGrip = x; })
 *
 * Results land in window.__sweep as they finish, so a long sweep can be read
 * while it is still going.
 */
window.__weaveSweep = async function (values, tweak, seconds = 22, kph = 110, runs = 6) {
  window.__sweep = [];
  window.__sweepDone = false;
  for (const x of values) {
    await window.__runWeave(seconds, kph, (d, o, v) => tweak(d, o, v, x), runs, String(x));
    const rows = window.__res.split('\n');
    window.__sweep.push(`${String(x).padStart(6)}  ${rows[rows.length - 1].replace(/^\d+ runs:\s*/, '')}`);
  }
  window.__sweepDone = true;
  window.__res = window.__sweep.join('\n');
  return window.__res;
};

/**
 * A weaving path through the gaps of a built-up area, found once per run.
 *
 * Not a straight line. The first version of this drew one across the town and
 * scored it on how many buildings it passed close to -- and every line it
 * chose went clean through one to three of them, so the ghost teleported
 * through walls the pursuit had to drive round, and it lost the target at
 * seven seconds no matter what the driving did. Demanding a clear straight
 * line instead finds nothing at all, which is the answer to why: there is no
 * such line across a town. The player is not driving one either. They are
 * weaving.
 *
 * So this weaves: from a start in the built-up part, step forward eight metres
 * at a time, and at each step take the heading nearest the general bearing
 * that is actually clear ahead. That is a line through the gaps, which is the
 * thing being complained about and the thing the pursuit has to follow.
 */
export function weavePath(which) {
  const g = window.__game;
  if (!window.__weavePaths) window.__weavePaths = {};
  if (window.__weavePaths[which]) return window.__weavePaths[which];

  if (!window.__weaveWalls) {
    const walls = [];
    g.world.forEachCollider((c) => {
      const h = c.halfExtents ? c.halfExtents() : null;
      if (h && h.y > 3 && h.x > 3 && h.z > 3) {
        const t = c.translation();
        walls.push({ x: t.x, z: t.z, r: Math.max(h.x, h.z) });
      }
    });
    window.__weaveWalls = walls;
  }
  const walls = window.__weaveWalls;

  let seed = 7310041 + which * 2267;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

  // Clear of every building by the width of a car and a bit.
  const clear = (x, z, pad) => {
    for (const b of walls) {
      const dx = b.x - x, dz = b.z - z;
      if (dx * dx + dz * dz < (b.r + pad) * (b.r + pad)) return false;
    }
    return true;
  };

  // Beside a building, which is what makes a step part of a gap.
  const hemmed = (x, z) => {
    for (const b of walls) {
      if (Math.hypot(b.x - x, b.z - z) - b.r < 16) return true;
    }
    return false;
  };

  let best = null;
  // Many attempts, scored on how much of the path was hemmed in rather than how
  // long it is. Greedily walking clear ground finds a seventy-step path easily
  // -- by leaving town, which is the opposite of the thing being measured, and
  // the first version of this picked exactly that for half its runs.
  for (let attempt = 0; attempt < 500; attempt++) {
    const seedWall = walls[Math.floor(rnd() * walls.length)];
    let bearing = rnd() * Math.PI * 2;
    let x = seedWall.x + Math.sin(bearing) * (seedWall.r + 14);
    let z = seedWall.z + Math.cos(bearing) * (seedWall.r + 14);
    if (!clear(x, z, 4)) continue;

    const pts = [{ x, z }];
    let near = 0;
    for (let i = 0; i < 70; i++) {
      // Straight on first, then progressively wider, so it only turns when it
      // has to -- which is what makes it a weave rather than a wander. Twice
      // over: once insisting the next point still has a building beside it, and
      // only then settling for any clear step at all.
      let took = null;
      for (let pass = 0; pass < 2 && !took; pass++) {
        for (const off of [0, 0.22, -0.22, 0.45, -0.45, 0.7, -0.7, 1.0, -1.0]) {
          const h = bearing + off;
          const nx = x + Math.sin(h) * 8, nz = z + Math.cos(h) * 8;
          if (!clear(nx, nz, 4)) continue;
          // And the step between has to be clear too, not just its end.
          if (!clear((x + nx) * 0.5, (z + nz) * 0.5, 4)) continue;
          if (pass === 0 && !hemmed(nx, nz)) continue;
          // Not back over ground it has already covered: hugging walls will
          // otherwise send it round and round one block, which reads as a
          // seventy-step weave and is really a roundabout.
          let doubled = false;
          for (let j = 0; j < pts.length - 8; j++) {
            if (Math.hypot(pts[j].x - nx, pts[j].z - nz) < 20) { doubled = true; break; }
          }
          if (doubled) continue;
          took = { h, nx, nz };
          break;
        }
      }
      if (!took) break;
      if (hemmed(took.nx, took.nz)) near++;
      x = took.nx; z = took.nz; bearing = took.h;
      pts.push({ x, z });
    }
    if (pts.length < 30) continue;
    if (!best || near > best.near) best = { pts, near };
    // Nothing to improve on: seventy steps, every one of them in a gap. Without
    // this the search is the slowest thing in the file by a wide margin -- five
    // hundred attempts against six hundred-odd buildings, per route -- and a
    // batch of eight takes longer than the eight chases it is setting up.
    if (best.pts.length > 70 && best.near >= 70) break;
  }

  window.__weavePaths[which] = best;
  return best;
}

function run(which, seconds, kph, tweak) {
  const g = window.__game;
  const { SKILL, ROLE, Officer } = window.__modules;
  const W = weavePath(which);
  if (!W || W.pts.length < 8) return { line: `run ${which}: no weave`, stayed: 0, lost: 0, back: 0, hits: 0, spd: 0 };
  const pts = W.pts;
  g.onBusted = () => { g.outcome = null; g.heat.bustTimer = 0; };
  g.onEscaped = () => { g.outcome = null; };
  g.paused = true;

  const speed = kph / 3.6;
  const p = g.player;
  const h0 = Math.atan2(pts[1].x - pts[0].x, pts[1].z - pts[0].z);
  p.repair();
  p.teleport({ x: pts[0].x, y: 0.9, z: pts[0].z }, h0);
  p.setVelocity({ x: Math.sin(h0) * speed, y: 0, z: Math.cos(h0) * speed });
  p._readState();

  const units = [];
  for (const off of [-5, 5]) {
    const car = g.createVehicle('interceptor', 'interceptor',
      { x: pts[0].x + off - Math.sin(h0) * 14, y: 0.95, z: pts[0].z - Math.cos(h0) * 14 },
      h0, { police: true });
    if (!car) continue;
    const o = new Officer(g, car, { skill: SKILL.pursuit, kind: 'interceptor' });
    o.setRole(ROLE.PURSUE);
    o.driver.allowOffRoad = true;
    car._readState();
    car.setVelocity({ x: Math.sin(h0) * speed, y: 0, z: Math.cos(h0) * speed });
    if (tweak) tweak(o.driver, o, car);
    units.push(o);
  }
  if (!units.length) return { line: `run ${which}: no units`, stayed: 0, lost: 0, back: 0, hits: 0, spd: 0 };

  let leg = 1, along = 0, stayed = 0, n = 0, hits = 0, lostAt = null;
  // What they are doing while they lose it, because 'lost at five seconds' does
  // not say whether they crawled, reversed, went the wrong way or hit a wall.
  // Sideways and spun, because "they slide out more and lose control" is not
  // something contacts measure: a unit can spin, gather it up and carry on
  // without touching anything, and that is still the thing being complained
  // about. Twenty degrees of body slip is sliding; sixty is gone.
  const d = { sliding: 0, spun: 0, spins: 0,
    spd: 0, slow: 0, offRoad: 0, reversing: 0, stuck: 0, onRoadWanted: 0, wall: 0, frames: 0,
    // Which limit was the binding one, counted.
    bind: { asked: 0, safe: 0, wall: 0, way: 0, slide: 0 },
    sub: { sClear: 0, sTravel: 0, sRunout: 0, sArc: 0, sBack: 0 } };
  const lastAt = new Map();
  const spinning = new Map();
  for (let i = 0; i < seconds * 60; i++) {
    const a = pts[leg - 1], b = pts[leg];
    const segLen = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    along += speed / 60;
    while (along > segLen && leg < pts.length - 1) { along -= segLen; leg++; }
    if (leg >= pts.length - 1) break;
    const t = Math.min(1, along / segLen);
    const hx = (b.x - a.x) / segLen, hz = (b.z - a.z) / segLen;
    p.teleport({ x: a.x + (b.x - a.x) * t, y: 0.9, z: a.z + (b.z - a.z) * t },
      Math.atan2(hx, hz));
    p.setVelocity({ x: hx * speed, y: 0, z: hz * speed });
    p._readState();
    g.heat.value = 5;
    const k = g.dispatcher.knowledge;
    k.seen = true;
    k.position.copy(p.position);
    k.velocity.set(hx * speed, 0, hz * speed);
    k.confidence = 1;

    for (const o of units) {
      o.update(1 / 60, p);
      if (tweak) tweak(o.driver, o, o.vehicle);
    }
    g.stepHeadless(1 / 60);

    let near = Infinity;
    for (const o of units) {
      near = Math.min(near, o.distanceTo(p.position));
      const v = o.vehicle;
      d.frames++;
      d.spd += v.speed * 3.6;
      if (v.speed * 3.6 < 20) d.slow++;
      if (v.surface !== 1) d.offRoad++;
      if (o.driver && o.driver.reverseTimer > 0) d.reversing++;
      if (o.driver && o.driver.stuckTimer > 0.3) d.stuck++;
      if (o.driver) d.wall += Math.min(30, o.driver.wallNear);
      if (o.driver && o.driver.caps) {
        const c = o.driver.caps;
        let who = 'asked', low = c.asked;
        for (const k of ['safe', 'wall', 'way', 'slide']) {
          if (c[k] < low - 0.01) { low = c[k]; who = k; }
        }
        d.bind[who]++;
        if (who === 'safe') {
          let w2 = 'sClear', l2 = c.sClear;
          for (const k of ['sTravel', 'sRunout', 'sArc', 'sBack']) {
            if (c[k] < l2 - 0.01) { l2 = c[k]; w2 = k; }
          }
          d.sub[w2]++;
        }
      }
      if (o.driver && !o.driver.allowOffRoad) d.onRoadWanted++;
      const slip = Math.abs(v.slipAngleBody);
      if (slip > 0.35 && v.speed > 5) d.sliding++;
      if (slip > 1.0 && v.speed > 5) {
        d.spun++;
        if (!spinning.get(o)) { d.spins++; spinning.set(o, true); }
      } else if (slip < 0.5) spinning.set(o, false);
      if (v.lastImpactAt && v.lastImpactAt !== lastAt.get(o) && v.lastImpact > 4) {
        lastAt.set(o, v.lastImpactAt);
        hits++;
      }
    }
    n++;
    if (near < 80) { stayed++; lostAt = null; } else if (lostAt === null) lostAt = i / 60;
  }

  const behind = Math.round(Math.min(...units.map((o) => o.distanceTo(p.position))));
  for (const o of units) g.despawnPolice(o);
  g.paused = false;
  g.heat.reset();

  const pc = (v) => String(Math.round((v * 100) / Math.max(1, d.frames))).padStart(3) + '%';
  const line = `run ${which}  gaps ${String(W.near).padStart(3)}  `
    + `stayed ${String(Math.round((stayed * 100) / n)).padStart(3)}%  `
    + `lost at ${lostAt === null ? 'never' : `${lostAt.toFixed(1)}s`}  `
    + `ended ${String(behind).padStart(4)} m back  hits ${hits}  `
    + `| sliding ${pc(d.sliding)}  spun ${pc(d.spun)}  lost it ${d.spins}x  `
    + `| ${String(Math.round(d.spd / Math.max(1, d.frames))).padStart(3)} kph  `
    + `slow ${pc(d.slow)}  off-road ${pc(d.offRoad)}  `
    + `rev ${pc(d.reversing)}  stuck ${pc(d.stuck)}  roadOnly ${pc(d.onRoadWanted)}  `
    + `wall ${(d.wall / Math.max(1, d.frames)).toFixed(1)} m  `
    + `| capped by ` + ['asked', 'safe', 'wall', 'way', 'slide']
      .map((k) => `${k} ${pc(d.bind[k])}`).join('  ')
    + `  | of which ` + ['sClear', 'sTravel', 'sRunout', 'sArc', 'sBack']
      .map((k) => `${k.slice(1)} ${pc(d.sub[k])}`).join(' ');
  return {
    line,
    stayed: stayed / n,
    // How long they held on, which is what 'they lose you instantly' means.
    // Never losing it counts as the whole run.
    lost: lostAt === null ? seconds : lostAt,
    back: behind,
    hits,
    sliding: d.sliding / Math.max(1, d.frames),
    spins: d.spins,
    spd: d.spd / Math.max(1, d.frames),
  };
}
