// Where the quarry's stone meets the fields.
//
// "You know where it joins from stone to grass ... some of it is really weird, almost points going
// in ... it doesn't nicely flow into the stone ... I think the suspension went too low, and the model
// just hit a bit, and it just went flying."
//
//   await import('/tests/quarryrim.js');
//   __rimShape();             // no driving: the two surfaces, all the way round
//   await __rimDrive(70);     // a car driven across the rim from outside, along the edge's normal
//
// shape:  kerb    how far the rock's top stands above the ground a body rests on, just outside it
//         step    the biggest change in the drawn ground over 1 m, going out from the rock
//         gap     rock top minus drawn ground at the join: + a lip, - a trench
// drive:  thrown  over 3 m/s of upward speed gained in a moment, where the ground is not asking for it
//         hit     the hardest knock, m/s, and on what

function ring(g) {
  const q = g.world.__map.quarry;
  const rOut = q.rimOut;
  return { q, rOut };
}

window.__rimShape = function (every = 0.5) {
  const g = window.__game, { q, rOut } = ring(g);
  const sim = g.sim, top = g.world.__map.solidTopAt;
  let n = 0, kerbMax = 0, kerbSum = 0, kerbs = 0, stepMax = 0, trench = 0, lip = 0, gapMax = -99, gapMin = 99;
  const bad = [];
  for (let d = 0; d < 360; d += every) {
    const a = (d * Math.PI) / 180;
    if (Math.abs(Math.atan2(Math.sin(a - q.open), Math.cos(a - q.open))) < 0.25) continue;
    const c = Math.cos(a), s = Math.sin(a);
    const P = (r) => [q.x + c * r, q.z + s * r];
    const rock = top(...P(rOut - 0.4));
    const ground = sim.heightAt(...P(rOut + 0.4));
    if (rock === null || rock === undefined || rock === -Infinity) continue;
    const gap = rock - ground;
    gapMax = Math.max(gapMax, gap); gapMin = Math.min(gapMin, gap);
    if (gap > 0.1) lip++;
    if (gap < -0.1) trench++;
    let st = 0, prev = ground;
    for (let r = rOut + 1.4; r < rOut + 16; r += 1) {
      const h = sim.heightAt(...P(r));
      st = Math.max(st, Math.abs(h - prev));
      prev = h;
    }
    stepMax = Math.max(stepMax, st);
    if (Math.abs(gap) > 0.3 || st > 0.6) bad.push({ d, gap: +gap.toFixed(2), st: +st.toFixed(2) });
    kerbSum += Math.abs(gap); kerbs++;
    n++;
  }
  // The worst, spread out.
  bad.sort((x, y) => Math.abs(y.gap) + y.st - Math.abs(x.gap) - x.st);
  const picks = [];
  for (const b of bad) { if (picks.length < 10 && !picks.some((p) => Math.abs(p.d - b.d) < 8)) picks.push(b); }
  return `${n} angles, rim radius ${rOut.toFixed(1)}: rock over ground at the join ${gapMin.toFixed(2)} to ${gapMax.toFixed(2)} m, mean size ${(kerbSum / kerbs).toFixed(2)}; a lip (>0.1) ${Math.round((lip * 100) / n)}% of the way round, a trench ${Math.round((trench * 100) / n)}%; steepest step going out ${stepMax.toFixed(2)} m per m; bad ${bad.length}\nworst ${JSON.stringify(picks)}`;
};

window.__rimDrive = async function (kph = 70, step = 6, inward = true) {
  window.__res = null;
  try {
    const g = window.__game, p = g.player, { q, rOut } = ring(g);
    g.onBusted = () => { g.outcome = null; };
    g.onEscaped = () => { g.outcome = null; };
    for (const u of g.dispatcher.units.slice()) if (!u.human) g.despawnPolice(u);
    const ctl = { throttle: 0.7, brake: 0, steer: 0, handbrake: 0 };
    const speed = kph / 3.6;
    let n = 0, thrown = 0, rolled = 0, hitSum = 0, hitMax = 0;
    const bad = [];
    for (let d = 0; d < 360; d += step) {
      const a = (d * Math.PI) / 180;
      if (Math.abs(Math.atan2(Math.sin(a - q.open), Math.cos(a - q.open))) < 0.3) continue;
      const c = Math.cos(a), s = Math.sin(a);
      // Sideways along the rim's edge a little as well, the way a car actually meets it.
      const dir = inward ? 1 : -1;
      const start = inward ? rOut + 22 : rOut - 8;
      const x = q.x + c * start, z = q.z + s * start;
      const h = Math.atan2(-c * dir, -s * dir);
      p.repair();
      p.teleport({ x, y: g.sim.heightAt(x, z) + 0.9, z }, h);
      p.setVelocity({ x: -c * dir * speed, y: 0, z: -s * dir * speed });
      p._readState();
      let vyMax = -9, hit = 0, up = 1, touched = '', at = 0, prevVy = 0, jump = 0, jumpAt = 0;
      const t0 = p.lastImpactAt;
      for (let i = 0; i < 80; i++) {
        g.heat.value = 0;
        g.stepHeadless(1 / 60, ctl);
        // Only until it reaches the drop: past that it is falling, which is the point.
        const r = Math.hypot(p.position.x - q.x, p.position.z - q.z);
        if (r < rOut - 1.5) break;
        const dv = p.linvel.y - prevVy;
        if (i > 4 && dv > jump) { jump = dv; jumpAt = r - rOut; }
        prevVy = p.linvel.y;
        vyMax = Math.max(vyMax, p.linvel.y);
        up = Math.min(up, p.up.y);
        if (p.lastImpactAt !== t0 && p.lastImpact > hit) {
          hit = p.lastImpact;
          at = r - rOut;
          p.world.contactPairsWith(p.collider, (o) => {
            p.world.contactPair(p.collider, o, (m) => { if (m.numContacts() > 0) touched = (o.collisionGroups() >>> 16).toString(16); });
          });
        }
      }
      n++;
      hitSum += hit; hitMax = Math.max(hitMax, hit);
      const isThrown = jump > 3;
      if (isThrown) thrown++;
      if (up < 0.5) rolled++;
      if (isThrown || hit > 8 || up < 0.5) bad.push({ d, jump: +jump.toFixed(1), at: +jumpAt.toFixed(1), vy: +vyMax.toFixed(1), hit: +hit.toFixed(1), on: touched, up: +up.toFixed(2) });
      await new Promise((r) => setTimeout(r, 0));
    }
    bad.sort((x, y) => y.jump + y.hit - x.jump - x.hit);
    window.__res = `${kph} km/h, ${inward ? 'going in' : 'coming out'}, ${n} places: kicked up ${thrown}, tipped ${rolled}, mean hardest knock ${(hitSum / n).toFixed(1)} m/s, worst ${hitMax.toFixed(1)}\n${bad.slice(0, 8).map((b) => JSON.stringify(b)).join('\n')}`;
  } catch (err) {
    window.__res = 'EX: ' + err.message + ' | ' + (err.stack || '').slice(0, 300);
  }
  return window.__res;
};
