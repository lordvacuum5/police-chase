// A unit on the side street, with the target going past the end of it.
//
// "If the police car is on a street to the right of me and a bit in front, so
// it can't come straight down, they try to turn around and they just hit a
// building. You'd have thought they'd be cleverer -- turn slightly the other
// way first to get a bigger turning circle."
//
// A crossroads is found on the loaded map with two roughly perpendicular
// streets off it. The target is put on one of them, driving past the junction
// and away; the unit is put on the other, up the side street, so the only way
// to the target is out of the junction and round. It is the geometry that
// produces the tightest turn a pursuit ever asks for, and the one where the
// inside of the turn is a building rather than air.
//
// What comes back, per run:
//
//   closest   how near the unit got to the target, which is the whole question
//   hits      contacts above a knock, and `wall` if any of them was hard
//   stuck     seconds spent under 10 km/h, which is what a failed turn costs
//   reverses  how many times it gave up and backed out
//
// `offset` is how far past the junction the target starts: 0 is level with the
// side street, positive is already past it, which is the case described.
window.__runSideStreet = async function (offsets = [10, 30, 60], seconds = 14, tweak = null,
  facing = 'toward') {
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.player); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const site = findCrossroads();
    if (!site) { window.__res = 'no crossroads with two long perpendicular streets'; return; }
    const rows = [];
    for (const off of offsets) rows.push(run(site, off, seconds, tweak, facing));
    window.__res = `crossroads at ${Math.round(site.n.x)}, ${Math.round(site.n.z)}\n`
      + rows.join('\n');
    return window.__res;
  } catch (e) {
    window.__res = 'EX: ' + e.message + ' | ' + (e.stack || '').slice(0, 300);
    return window.__res;
  }
};

function findCrossroads() {
  const gr = window.__game.graph;
  let best = null;
  for (const n of gr.nodes) {
    if (n.edges.length < 3) continue;
    const dirs = n.edges.map((id) => {
      const e = gr.edges[id];
      const o = gr.nodes[e.a === n.id ? e.b : e.a];
      const d = Math.hypot(o.x - n.x, o.z - n.z) || 1;
      return { e, o, len: e.length, ux: (o.x - n.x) / d, uz: (o.z - n.z) / d };
    });
    for (let i = 0; i < dirs.length; i++) {
      for (let j = 0; j < dirs.length; j++) {
        if (i === j) continue;
        if (Math.abs(dirs[i].ux * dirs[j].ux + dirs[i].uz * dirs[j].uz) > 0.25) continue;
        if (dirs[i].len < 90 || dirs[j].len < 90) continue;
        const score = Math.min(dirs[i].len, dirs[j].len);
        if (!best || score > best.score) best = { n, road: dirs[i], side: dirs[j], score };
      }
    }
  }
  return best;
}

function run(site, offset, seconds, tweak, facing) {
  const g = window.__game;
  const { SKILL, ROLE, Officer } = window.__modules;
  g.onBusted = () => { g.outcome = null; g.heat.bustTimer = 0; };
  g.onEscaped = () => { g.outcome = null; };
  g.paused = true;

  // The target drives along the main road, already past the junction.
  const r = site.road, sd = site.side, n = site.n;
  const speed = 80 / 3.6;
  const p = g.player;
  p.repair();
  p.teleport({ x: n.x + r.ux * offset, y: 0.9, z: n.z + r.uz * offset },
    Math.atan2(r.ux, r.uz));
  p._readState();

  // The unit sits up the side street, nose toward the junction.
  const back = 38;
  // 'toward' points it at the junction; 'away' points it up the side street,
  // so the only way to the target is to turn the car round first -- which is
  // the case the player described, and the one where the turning circle is
  // wider than the road.
  const sign = facing === 'away' ? 1 : -1;
  const car = g.createVehicle('interceptor', 'interceptor',
    { x: n.x + sd.ux * back, y: 0.95, z: n.z + sd.uz * back },
    Math.atan2(sign * sd.ux, sign * sd.uz), { police: true });
  if (!car) return `offset ${offset}: no car`;
  const o = new Officer(g, car, { skill: SKILL.pursuit, kind: 'interceptor' });
  o.setRole(ROLE.PURSUE);
  if (tweak) tweak(o.driver, o, car);
  car._readState();
  car.setVelocity({ x: sign * sd.ux * 14, y: 0, z: sign * sd.uz * 14 });

  let closest = Infinity, hits = 0, worst = 0, stuck = 0, reverses = 0, wasReversing = false;
  let lastAt = 0, along = offset;
  for (let i = 0; i < seconds * 60; i++) {
    along += speed / 60;
    p.teleport({ x: n.x + r.ux * along, y: 0.9, z: n.z + r.uz * along },
      Math.atan2(r.ux, r.uz));
    p._readState();
    p.setVelocity({ x: r.ux * speed, y: 0, z: r.uz * speed });
    g.heat.value = 5;
    const k = g.dispatcher.knowledge;
    k.seen = true;
    k.position.copy(p.position);
    k.velocity.set(r.ux * speed, 0, r.uz * speed);
    k.confidence = 1;

    o.update(1 / 60, p);
    if (tweak) tweak(o.driver, o, car);
    g.stepHeadless(1 / 60);

    closest = Math.min(closest, o.distanceTo(p.position));
    if (car.speed * 3.6 < 10) stuck += 1 / 60;
    const reversing = car.forwardSpeed < -0.5;
    if (reversing && !wasReversing) reverses++;
    wasReversing = reversing;
    if (car.lastImpactAt && car.lastImpactAt !== lastAt && car.lastImpact > 4) {
      lastAt = car.lastImpactAt;
      hits++;
      worst = Math.max(worst, car.lastImpact);
    }
  }
  const damage = car.damage;
  g.despawnPolice(o);
  g.paused = false;
  g.heat.reset();

  return `${facing.padEnd(6)} offset ${String(offset).padStart(3)} m   closest ${String(Math.round(closest)).padStart(3)} m   `
    + `hits ${hits} (worst ${worst.toFixed(0)} m/s)   `
    + `under 10 kph ${stuck.toFixed(1)} s   reverses ${reverses}   damage ${(damage * 100).toFixed(0)}%`;
}
