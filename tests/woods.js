// How many trees does a pursuit hit, in the thickest wood the map has?
//
// "Police cars still seem to hit trees even when they have loads of time to
// react."
//
// The site is found rather than invented: every trunk on the loaded map is
// collected and the densest neighbourhood of them is the copse this runs in --
// on Wexbury that is about twenty-two trunks inside thirty metres, roughly one
// every eleven metres, which is as thick as the game gets. An interceptor
// chases a target straight through it, and everything *it* hits is counted:
//
//   hits    impacts above a knock (dv > 4 m/s of velocity change)
//   mean    its average speed, which is the other half of the question --
//           a unit that crawls through the wood hits nothing and is useless
//   behind  how far the target has pulled away by the end, same idea
//
// ---------------------------------------------------------------------------
// What the target is, and why it is not the player's car
//
// This used to put the player down 120 m short of the copse with the throttle
// pinned and chase it with two units for forty seconds. It never measured
// that. The player drove into the first trunk at about two seconds -- 90 km/h,
// then 39, then stopped -- and the remaining thirty-seven seconds were two
// police cars parked behind a stationary car in a wood. "0 hits, mean 10 kph"
// looked like a flawless drive and was two cars that never went anywhere; the
// numbers this file used to print, and anything tuned against them, were noise.
//
// So the target is a ghost: a point carried along a straight line through the
// middle of the copse at a fixed speed, with the player's car moved onto it
// each frame. It cannot crash, so the pursuit lasts as long as the wood does,
// and every car in the count is a police car doing its own driving. The line
// is straight and the speed constant on purpose -- there is nothing clever to
// follow, and the trunks are in plain view the whole way. If a unit cannot get
// through this, it is not because it was surprised.
//
// ---------------------------------------------------------------------------
// One run is not a measurement
//
// A single approach is exactly repeatable -- run it twice in a session and
// every figure matches to the digit -- and still tells you almost nothing,
// because a metre of difference at the first trunk is a different wood by the
// tenth. Sizing offRoadLatLimit by single runs would have picked 19.5 over 17,
// where the sweep says 18.5 beats both. So __woodsSweep runs the same wood
// from five starting offsets and adds up what happens, and that is the number
// to compare. Compare inside one page session, with the setting as the only
// thing that differs.
//
//   await import('/tests/woods.js');
//   __woodsSweep();                                 // as it ships
//   __woodsSweep({ offRoadLatLimit: 0 });           // as it was before
window.__runWoods = async function (seconds = 22, targetKph = 90) {
  try {
    await ready();
    const r = approach(0, targetKph, seconds, null, true);
    const site = window.__woodsSite;
    window.__res = `copse of ${site.n} trunks within 30 m at `
      + `${Math.round(site.x)}, ${Math.round(site.z)}, ghost at ${targetKph} kph\n`
      + `hits ${r.hits}  worst ${r.worst ? `${r.worst.dv} m/s at ${r.worst.kph} kph` : 'none'}  `
      + `mean ${Math.round(r.kph)} kph  damage ${r.damage}  left ${r.behind} m behind\n`
      + `throttle ${r.thr.toFixed(2)}  brake ${r.brk.toFixed(2)}  `
      + `asking for lock it cannot have ${Math.round(r.both * 100)}% of the time`
      + (r.log.length ? `\n${r.log.map((h) => `  dv ${h.dv} at ${h.kph} kph`).join('\n')}` : '');
  } catch (e) {
    window.__res = 'EX: ' + e.message + ' | ' + (e.stack || '').slice(0, 300);
  }
};

/**
 * The same wood from five starting offsets, added up. `patch` is merged over
 * the car's spec, so a setting can be turned off without editing the game.
 */
window.__woodsSweep = async function (patch = null, targetKph = 90, seconds = 22) {
  try {
    await ready();
    const tweak = patch ? (car) => { car.spec = Object.assign({}, car.spec, patch); } : null;
    let hits = 0, kph = 0, behind = 0, thr = 0, brk = 0, both = 0;
    const offs = [-10, -5, 0, 5, 10];
    for (const off of offs) {
      const r = approach(off, targetKph, seconds, tweak, false);
      hits += r.hits; kph += r.kph; behind += r.behind;
      thr += r.thr; brk += r.brk; both += r.both;
    }
    const n = offs.length;
    window.__res = `${n} approaches at ${targetKph} kph`
      + `${patch ? `, spec patched with ${JSON.stringify(patch)}` : ''}\n`
      + `hits ${hits}  mean ${Math.round(kph / n)} kph  `
      + `behind ${Math.round(behind / n)} m  `
      + `throttle ${(thr / n).toFixed(2)}  brake ${(brk / n).toFixed(2)}  `
      + `asking for lock it cannot have ${Math.round((both / n) * 100)}%`;
    return window.__res;
  } catch (e) {
    window.__res = 'EX: ' + e.message + ' | ' + (e.stack || '').slice(0, 300);
    return window.__res;
  }
};

async function ready() {
  for (let i = 0; i < 200 && !(window.__game && window.__game.player); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!window.__woodsSite) window.__woodsSite = findCopse();
}

/** The densest neighbourhood of trunks on the loaded map. */
function findCopse() {
  const g = window.__game;
  const pts = [];
  g.world.forEachCollider((c) => {
    const h = c.halfExtents ? c.halfExtents() : null;
    if (h && Math.abs(h.x - 0.65) < 0.01 && Math.abs(h.y - 2.6) < 0.01) {
      const t = c.translation();
      pts.push([t.x, t.z]);
    }
  });
  let site = null;
  for (let i = 0; i < pts.length; i += 7) {
    const [x, z] = pts[i];
    let n = 0;
    for (const [px, pz] of pts) {
      const dx = px - x, dz = pz - z;
      if (dx * dx + dz * dz < 900) n++;            // within 30 m
    }
    if (!site || n > site.n) site = { x, z, n };
  }
  return site;
}

/** One car, one line through the wood. */
function approach(off, targetKph, seconds, tweak, keepLog) {
  const g = window.__game;
  const { SKILL, ROLE, Officer } = window.__modules;
  const site = window.__woodsSite;
  g.onBusted = () => { g.outcome = null; };
  g.onEscaped = () => { g.outcome = null; };
  g.paused = true;

  const speed = targetKph / 3.6;
  const start = site.z - 150;
  const p = g.player;
  p.repair();
  p.teleport({ x: site.x, y: 0.9, z: start }, 0);
  p._readState();
  p.setVelocity({ x: 0, y: 0, z: speed });

  // An interceptor, made here rather than by spawnPoliceAt, which picks a kind
  // from the wanted level and the game's own rng -- so the same run gave an
  // interceptor one time and an SUV the next, and the hit count moved with it.
  // The car has to be fixed for the wood to be the thing being measured.
  const car = g.createVehicle('interceptor', 'interceptor',
    { x: site.x + off, y: 0.95, z: start - 30 }, 0, { police: true });
  if (tweak) tweak(car);
  const o = new Officer(g, car, { skill: SKILL.pursuit, kind: 'interceptor' });
  // Not on the dispatcher's roster: it would retask the unit against whatever
  // it currently believes, and the point of this is the pursuit's driving.
  o.setRole(ROLE.PURSUE);
  car._readState();
  car.setVelocity({ x: 0, y: 0, z: speed });

  const log = [];
  let z = start, lastAt = 0, n = 0, sum = 0, thr = 0, brk = 0, both = 0;
  for (let i = 0; i < seconds * 60; i++) {
    // Carry the ghost along its line, and tell the force where it is. The heat
    // has to be held up too: this unit is off the roster, so nothing on it is
    // keeping contact, and a chase that quietly ends stands the car down in
    // the middle of the wood -- which is what the old "0 hits" runs were.
    z += speed / 60;
    p.teleport({ x: site.x, y: 0.9, z }, 0);
    p._readState();
    p.setVelocity({ x: 0, y: 0, z: speed });
    g.heat.value = 3;
    const k = g.dispatcher.knowledge;
    k.seen = true;
    k.position.copy(p.position);
    k.velocity.set(0, 0, speed);
    k.confidence = 1;

    o.update(1 / 60, p);
    g.stepHeadless(1 / 60);

    const c = car.controls || {};
    n++;
    sum += car.speed * 3.6;
    thr += c.throttle || 0;
    brk += c.brake || 0;
    // The driver on full lock with the limiter holding it back: the one number
    // that says "it wanted to go round that and could not turn tightly enough".
    if (car.steerLimit < car.spec.steering.maxAngle - 0.001 && Math.abs(c.steer || 0) > 0.95) both++;
    if (car.lastImpactAt && car.lastImpactAt !== lastAt && car.lastImpact > 4) {
      lastAt = car.lastImpactAt;
      log.push({ dv: +car.lastImpact.toFixed(1), kph: Math.round(car.speed * 3.6) });
    }
  }

  const out = {
    hits: log.length,
    log: keepLog ? log : [],
    worst: log.reduce((w, h) => (h.dv > (w ? w.dv : 0) ? h : w), null),
    kph: sum / n,
    behind: Math.round(o.distanceTo(p.position)),
    damage: +car.damage.toFixed(2),
    thr: thr / n,
    brk: brk / n,
    both: both / n,
  };
  g.removeVehicle(car);
  g.paused = false;
  return out;
}
