// The whole force against a weaving target, not two cars told to follow.
//
// tests/weave.js measures one thing: can a unit in ROLE.PURSUE follow a player
// through the gaps. The answer is no -- about 50 km/h where the player does
// 110, and every attempt to lift that bought speed with crashes. But following
// is not the force's only answer and it was never meant to be. The dispatcher
// has ROLE.INTERCEPT: expand the road graph forward from the target, work out
// when they could reach each junction, and send units that can beat them there.
// At five stars the rules allow five pursuers and six interceptors.
//
// So the honest question is not "can one car follow" but "does the force still
// have you when you cut through a housing estate", and that needs the real
// dispatcher, the real roster and the real roles. This rig steps the whole game
// -- Game._update by way of stepHeadless, so spawning, heat, orders and radio
// all run -- and only the player is on rails.
//
//   near        how much of the run the nearest unit was within 80 m
//   lost        seconds before the nearest was beyond 150 m and stayed there
//   closest     the closest any unit got, after the first second
//   seen        how much of the run the dispatcher knew where the target was,
//               which separates "they cannot drive it" from "they lost sight"
//   roles       unit-seconds in each role, so an intercept that never happens
//               is visible rather than assumed
import { weavePath } from './weave.js?v=31';
import { makeRng } from '../src/util/math.js';

window.__runForce = async function (seconds = 30, kph = 110, runs = 4, label = '', tweak = null, pinSight = false) {
  window.__forceDone = false;
  window.__forceAt = -1;
  window.__res = null;
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.player); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const rows = [];
    let near = 0, lost = 0, closest = 0, seen = 0, n = 0, cNear = 0, cLost = 0;
    let meanNear = 0, regained = 0, ahead = 0, picked = 0, reached = 0;
    for (let i = 0; i < runs; i++) {
      window.__forceAt = i;
      const r = run(i, seconds, kph, tweak, pinSight);
      if (!r) continue;
      rows.push(r.line);
      near += r.near; lost += r.lost; closest += r.closest; seen += r.seen; n++;
      cNear += r.cohortNear; cLost += r.cohortLost;
      meanNear += r.meanNear; regained += r.regained; ahead += r.ahead;
      picked += r.picked; reached += r.reached;
      await new Promise((res) => setTimeout(res, 0));
    }
    rows.push(`${n} runs:  near ${Math.round((near * 100) / n)}%  `
      + `held on ${(lost / n).toFixed(1)}s  closest ${Math.round(closest / n)} m  `
      + `seen ${Math.round((seen * 100) / n)}%  `
      + `| mean nearest ${Math.round(meanNear / n)} m  `
      + `someone in front ${Math.round((ahead * 100) / n)}%  got back on ${regained}x  `
      + `| predictions: car passed ${reached} of ${picked} junctions sent to `
      + `(${Math.round((reached * 100) / Math.max(1, picked))}%)  `
      + `| started-with: near ${Math.round((cNear * 100) / n)}%`);
    window.__res = (label ? label + '\n' : '') + rows.join('\n');
    window.__forceDone = true;
    return window.__res;
  } catch (e) {
    window.__forceDone = true;
    window.__res = 'EX: ' + e.message + ' | ' + (e.stack || '').slice(0, 400);
    return window.__res;
  }
};

const ROLE_NAMES = {};

function run(which, seconds, kph, tweak, pinSight) {
  const g = window.__game;
  const { ROLE } = window.__modules;
  for (const k of Object.keys(ROLE)) ROLE_NAMES[ROLE[k]] = k;

  const W = weavePath(which);
  if (!W || W.pts.length < 8) return null;
  const pts = W.pts;

  g.onBusted = () => { g.outcome = null; g.heat.bustTimer = 0; };
  g.onEscaped = () => { g.outcome = null; };

  // Clear whatever the last run left, so each one starts the same way. The
  // aircraft matters as much as the cars: it does not reset itself between
  // runs, so it begins the second run wherever the first one left it, and two
  // identical settings measured in a row came back with the same figures in
  // some places and wildly different ones in others purely from that.
  // Same random stream every run. Spawn positions, the aircraft's approach and
  // a dozen other things draw on it, and without this the same settings
  // measured twice came back with the dispatcher seeing the target 100% of one
  // batch and 49% of the next -- variance far larger than anything being
  // looked for. Reseeded per run rather than per batch, so run 3 does not
  // depend on how run 2 went.
  g.rng = makeRng(0xC0FFEE + which * 7919);

  // Everything back on the road. Successive batches of this rig came back worse
  // and worse -- the second reading of one setting was always below the first,
  // whichever setting it was -- because damage, debris and bent traffic carry
  // over, and a chase through a town somebody has already been crashed through
  // is a different chase. This does not undo knocked-down scenery, so batches
  // are still best compared from a fresh page.
  for (const v of g.vehicles) if (v.repair) v.repair();

  g.helicopter.reset();
  const k0 = g.dispatcher.knowledge;
  k0.seen = false;
  k0.timeSinceSeen = 999;
  k0.confidence = 0;
  for (const u of g.dispatcher.units.slice()) if (!u.human) g.despawnPolice(u);

  const speed = kph / 3.6;
  const p = g.player;
  const h0 = Math.atan2(pts[1].x - pts[0].x, pts[1].z - pts[0].z);
  p.repair();
  p.teleport({ x: pts[0].x, y: 0.9, z: pts[0].z }, h0);
  p.setVelocity({ x: Math.sin(h0) * speed, y: 0, z: Math.cos(h0) * speed });
  p._readState();

  // Five stars, and the roster filled before the clock starts: the dispatcher
  // tops up one car every 1.6 s, so a thirty-second run measured from cold
  // spends most of itself waiting for the force to turn up.
  g.heat.value = 5;

  for (let i = 0; i < 40 && g.dispatcher.units.length < g.dispatcher.rules.units; i++) {
    const u = g.spawnPoliceNear(p.position, 5);
    if (!u) break;
    g.dispatcher.units.push(u);
  }
  const started = g.dispatcher.units.length;

  // Air support already on station. Reset alone is not enough: it launches from
  // 420 m out and takes most of a thirty-second run to arrive, so a rig that
  // only resets it never measures the air search at all -- and a rig that does
  // not reset it starts each run wherever the last one finished, which is worse.
  // On station with the light on the car is the state a player is actually in
  // when they start cutting through gardens at five stars.
  const h = g.helicopter;
  h.launch(p);
  h.pos.set(p.position.x, h.pos.y, p.position.z);
  h.vel.set(0, 0, 0);
  h.beam.x = p.position.x;
  h.beam.z = p.position.z;
  h.spotlight = 1;
  h.beamLocked = true;

  const st = g.dispatcher.interceptStats;
  st.solved = 0; st.late = 0; st.noShortlist = 0; st.noMargin = 0; st.overLimit = 0;
  const bs = g.dispatcher.blockStats;
  for (const key of Object.keys(bs)) bs[key] = 0;

  // Sight held, when asked, by standing in for the perception pass itself --
  // pinning the knowledge before the step is useless, because _updateKnowledge
  // runs inside it and overwrites whatever was put there.
  //
  // Whether the force can see the car and what it does once it can are
  // different questions, and the detection half is much the noisier: the same
  // settings measured twice came back seeing the target 100% of one batch and
  // 76% of the next, a bigger swing than any change to the orders is going to
  // make. Held, the rig measures the driving and the roles and nothing else.
  const realPerceive = g.dispatcher._updateKnowledge;
  if (pinSight) {
    g.dispatcher._updateKnowledge = function (dt, t) {
      const kk = this.knowledge;
      kk.seen = true;
      kk.spotter = this.units[0] || null;
      kk.position.copy(t.position);
      kk.velocity.copy(t.linvel);
      kk.timeSinceSeen = 0;
      kk.confidence = 1;
      this.sightRange = 70 + this.tier * 32;
      this.inContact = true;
    };
  }

  if (tweak) tweak(g.dispatcher, g);
  // Who was actually chasing at the start. The dispatcher tops the roster up
  // near the target throughout, so "the nearest unit is 23 m back" can be true
  // of a force that lost every car it started with and simply had new ones
  // appear. Those are different games to play against, and only one of them
  // matches "they lose you instantly", so the cohort is tracked apart.
  const cohort = new Set(g.dispatcher.units);

  // The player is on rails; everything else is the game's own. forceControls
  // keeps the real input out of it.
  const idle = { throttle: 0, brake: 0, steer: 0, handbrake: 0 };

  let leg = 1, along = 0;
  let heliFrames = 0, heliSee = 0;
  // Mean distance of the nearest unit, and how often they get back on you after
  // dropping away. Both because 'within 80 m' and 'lost at' are decided in the
  // first ten seconds of a run and then never move -- two identical settings
  // gave the same figure for each of them to the decimal while the rest of the
  // run differed completely.
  let nearSum = 0, regained = 0, wasLost = false;
  // Somebody in front of you, which is the whole point of an intercept and the
  // thing mean distance cannot see: a unit 60 m behind and a unit 60 m ahead
  // read the same, and only one of them is a problem for the player.
  let aheadFrames = 0, aheadSum = 0;
  // Whether the junctions the solver sends units to are places the car actually
  // goes. Everything in the intercept solver is downstream of RoadGraph.predict,
  // which walks the road network -- and a player cutting through gardens is not
  // on it. If the predictions are wrong then no amount of placing units better
  // can help, because they are being placed correctly at the wrong junctions.
  const picked = new Map();
  let nearFrames = 0, seenFrames = 0, frames = 0, lostAt = null;
  let cohortNear = 0, cohortLostAt = null;
  let closest = Infinity;
  let joined = 0;
  const roleTime = {};
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
    // Velocity first, then read the state off it. The other way round -- which
    // every rig in here did -- leaves forwardSpeed derived from the velocity
    // teleport had just cleared, so the car reads as stationary to everything
    // that asks how fast it is going. In tests/force.js that silently turned
    // off the rolling block and the head-on van for the whole run (the gate
    // wants more than 12 m/s and saw nearly nothing) and switched the box's
    // "slow enough to surround" test permanently on.
    p.setVelocity({ x: hx * speed, y: 0, z: hz * speed });
    p._readState();
    // Pinned, because the run is about the driving and not about the heat
    // decaying while the player is untouchable.
    g.heat.value = 5;

    g.stepHeadless(1 / 60, idle);

    frames++;
    if (g.dispatcher.knowledge.seen) seenFrames++;
    // Air support, because at five stars it is supposed to see over the roofs --
    // and it flies in from 420 m away, so for much of a short run it is not
    // there yet.
    const h = g.helicopter;
    if (h && h.active) heliFrames++;
    if (h && h.canSee(p)) heliSee++;
    let min = Infinity, cmin = Infinity, bestAhead = -Infinity;
    for (const u of g.dispatcher.units) {
      const du = u.distanceTo(p.position);
      min = Math.min(min, du);
      // How far up the road the unit is, measured along the way the player is
      // going. Positive is in front.
      const along = (u.position.x - p.position.x) * hx + (u.position.z - p.position.z) * hz;
      if (du < 150 && along > 0) bestAhead = Math.max(bestAhead, along);
      if (cohort.has(u)) cmin = Math.min(cmin, du);
      const name = ROLE_NAMES[u.role] || String(u.role);
      roleTime[name] = (roleTime[name] || 0) + 1;
      if (name === 'INTERCEPT' && u.orders && u.orders.node !== undefined
        && u.orders.node !== null && !picked.has(u.orders.node)) {
        const nd = g.graph.nodes[u.orders.node];
        if (nd) picked.set(u.orders.node, { x: nd.x, z: nd.z, reached: false });
      }
    }
    if (cmin < 80) { cohortNear++; cohortLostAt = null; }
    else if (cohortLostAt === null) cohortLostAt = i / 60;
    nearSum += Math.min(min, 600);
    for (const j of picked.values()) {
      if (!j.reached && Math.hypot(j.x - p.position.x, j.z - p.position.z) < 40) j.reached = true;
    }
    if (bestAhead > -Infinity) { aheadFrames++; aheadSum += bestAhead; }
    if (min > 150) wasLost = true;
    else if (wasLost && min < 80) { regained++; wasLost = false; }
    if (min < 80) { nearFrames++; lostAt = null; } else if (lostAt === null) lostAt = i / 60;
    if (i > 60) closest = Math.min(closest, min);
  }

  if (pinSight) g.dispatcher._updateKnowledge = realPerceive;
  let reached = 0;
  for (const j of picked.values()) if (j.reached) reached++;
  const ended = Math.round(Math.min(...g.dispatcher.units.map((u) => u.distanceTo(p.position))));
  for (const u of g.dispatcher.units) if (!cohort.has(u)) joined++;
  const cohortEnd = Math.round(Math.min(...[...cohort]
    .filter((u) => g.dispatcher.units.includes(u))
    .map((u) => u.distanceTo(p.position)), 9999));
  const total = Object.values(roleTime).reduce((s, x) => s + x, 0) || 1;
  const roles = Object.keys(roleTime).sort((x, y) => roleTime[y] - roleTime[x])
    .slice(0, 5)
    .map((k) => `${k} ${Math.round((roleTime[k] * 100) / total)}%`).join(' ');

  return {
    line: `run ${which}  units ${String(started).padStart(2)}  `
      + `near ${String(Math.round((nearFrames * 100) / frames)).padStart(3)}%  `
      + `lost at ${lostAt === null ? 'never' : `${lostAt.toFixed(1)}s`}  `
      + `closest ${String(Math.round(closest)).padStart(3)} m  `
      + `ended ${String(ended).padStart(4)} m  `
      + `seen ${String(Math.round((seenFrames * 100) / frames)).padStart(3)}%  `
      + `| the ones that started: near ${String(Math.round((cohortNear * 100) / frames)).padStart(3)}%  `
      + `lost at ${cohortLostAt === null ? 'never' : `${cohortLostAt.toFixed(1)}s`}  `
      + `ended ${String(cohortEnd).padStart(4)} m  joined ${joined}  `
      + `| heli up ${String(Math.round((heliFrames * 100) / frames)).padStart(3)}% `
      + `sees ${String(Math.round((heliSee * 100) / frames)).padStart(3)}%  `
      + `| mean nearest ${String(Math.round(nearSum / frames)).padStart(3)} m  `
      + `someone in front ${String(Math.round((aheadFrames * 100) / frames)).padStart(3)}% `
      + `at ${String(Math.round(aheadSum / Math.max(1, aheadFrames))).padStart(3)} m  `
      + `got back on ${regained}x  | ${roles}  `
      + `| intercepts solved ${st.solved} no-junction ${st.noShortlist} `
      + `no-margin ${st.noMargin} late-but-sent ${st.late} `
      + `over-limit ${st.overLimit} cands ${st.candidates}  `
      + `| ahead: tried ${bs.tried} placed ${bs.placed} `
      + `blocked-by ${Object.keys(bs).filter((x) => x !== 'tried' && x !== 'placed' && bs[x])
        .map((x) => `${x} ${bs[x]}`).join(' ') || 'nothing'}`,
    meanNear: nearSum / frames,
    ahead: aheadFrames / frames,
    picked: picked.size,
    reached,
    regained,
    cohortNear: cohortNear / frames,
    cohortLost: cohortLostAt === null ? seconds : cohortLostAt,
    near: nearFrames / frames,
    lost: lostAt === null ? seconds : lostAt,
    closest: Math.min(closest, 999),
    seen: seenFrames / frames,
  };
}

/**
 * How long air support takes to find you again after you have broken away.
 *
 * The force rig above puts the aircraft on station with the light already on
 * the car, which is the common case and says nothing about the search -- with
 * the beam locked it simply never loses the target, and `seen` comes back 100%
 * whatever the search pattern does. This sets up the case the search is for:
 * the car is gone, the crew know roughly where it was and which way it was
 * going, and the aircraft is behind it.
 *
 * What comes back is the seconds until the searchlight is on the car again, and
 * 'never' for a run where it is still hunting when time runs out.
 */
window.__runReacquire = async function (seconds = 25, kph = 110, runs = 6, label = '', tweak = null) {
  window.__forceDone = false;
  window.__res = null;
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.player); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const rows = [];
    let found = 0, sum = 0, lit = 0;
    for (let i = 0; i < runs; i++) {
      const r = reacquire(i, seconds, kph, tweak);
      if (!r) continue;
      rows.push(r.line);
      if (r.at !== null) { found++; sum += r.at; }
      lit += r.lit;
    }
    rows.push(`${runs} runs:  found again ${found}/${runs}  `
      + `${found ? `after ${(sum / found).toFixed(1)}s on average  ` : ''}`
      + `light on the car ${Math.round((lit * 100) / runs)}% of the time`);
    window.__res = (label ? label + '\n' : '') + rows.join('\n');
    window.__forceDone = true;
    return window.__res;
  } catch (e) {
    window.__forceDone = true;
    window.__res = 'EX: ' + e.message + ' | ' + (e.stack || '').slice(0, 400);
    return window.__res;
  }
};

function reacquire(which, seconds, kph, tweak) {
  const g = window.__game;
  const W = weavePath(which);
  if (!W || W.pts.length < 8) return null;
  const pts = W.pts;

  g.onBusted = () => { g.outcome = null; g.heat.bustTimer = 0; };
  g.onEscaped = () => { g.outcome = null; };
  // No cars: this is about the aircraft. A ground unit that happens to get a
  // line on the car would hand the fix back and the search would never run.
  for (const u of g.dispatcher.units.slice()) if (!u.human) g.despawnPolice(u);

  const speed = kph / 3.6;
  const p = g.player;
  const h0 = Math.atan2(pts[1].x - pts[0].x, pts[1].z - pts[0].z);
  p.repair();
  p.teleport({ x: pts[0].x, y: 0.9, z: pts[0].z }, h0);
  p.setVelocity({ x: Math.sin(h0) * speed, y: 0, z: Math.cos(h0) * speed });
  p._readState();
  g.heat.value = 5;

  const h = g.helicopter;
  h.reset();
  h.launch(p);
  // Behind the car and off to one side, as it would be having just lost it.
  h.pos.set(pts[0].x - Math.sin(h0) * 200, h.pos.y, pts[0].z - Math.cos(h0) * 200);
  h.vel.set(0, 0, 0);
  h.beam.x = h.pos.x;
  h.beam.z = h.pos.z;
  h.spotlight = 1;
  h.beamLocked = false;

  // Last seen where it is now, going the way it is going -- and five seconds
  // ago, so the search is already running rather than still in its grace.
  const k = g.dispatcher.knowledge;
  k.seen = false;
  k.spotter = null;
  k.position.copy(p.position);
  k.velocity.set(Math.sin(h0) * speed, 0, Math.cos(h0) * speed);
  k.timeSinceSeen = 5;
  k.confidence = 0.9;

  if (tweak) tweak(g.dispatcher, g);

  const idle = { throttle: 0, brake: 0, steer: 0, handbrake: 0 };
  let leg = 1, along = 0, frames = 0, litFrames = 0, at = null;
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
    // Pinned lost, so the measurement is of the search and not of a lucky
    // glimpse feeding the fix straight back.
    if (!h.canSee(p)) {
      k.seen = false;
      k.spotter = null;
    }

    g.stepHeadless(1 / 60, idle);
    frames++;
    if (h.canSee(p)) {
      litFrames++;
      if (at === null) at = i / 60;
    }
  }

  const gap = Math.round(h.distanceTo(p.position));
  return {
    line: `run ${which}  found again ${at === null ? 'never' : `after ${at.toFixed(1)}s`}  `
      + `light on the car ${String(Math.round((litFrames * 100) / frames)).padStart(3)}%  `
      + `aircraft ended ${String(gap).padStart(4)} m away`,
    at,
    lit: litFrames / frames,
  };
}
