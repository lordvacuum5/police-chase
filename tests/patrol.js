// How well does a patrol car drive?
//
// "The police cars, when they're patrolling, they do not drive well ... they're
// really bad at driving." Every other rig is about a chase. This one leaves the
// game running with nobody wanted -- the player parked on a road, the
// dispatcher keeping its patrol cars out -- and watches every unit on
// ROLE.PATROL, once a frame:
//
//   speed      mean km/h, and the share of time stopped (under 1 m/s) away
//              from a red light
//   lane       how far the car is from the middle of its own lane, m (mean
//              and the share of time more than 1.5 m off it)
//   wrong      the share of time on the wrong side of the road
//   off        the share of time off the carriageway altogether
//   hits       knocks over 2.6 m/s -- kerbs, walls, other cars
//   weave      steering reversals per km: a car that saws at the wheel
//   reverse    seconds spent going backwards
//   tarmac     the share of time up on the footway or the verge
//   limit      the share of time more than 15% over the road's speed
//   braking    the share of time braking harder than 4 m/s/s, over half a second
//
// window.__runPatrol(seconds) -> window.__res. Same seed every run.

window.__runPatrol = async function (seconds = 90) {
  for (let i = 0; i < 200 && !(window.__game && window.__game.player); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const g = window.__game, gr = g.graph, p = g.player;
  const { ROLE } = window.__modules;
  g.heat.value = 0;
  g.onBusted = () => { g.outcome = null; };
  // The player out of the way: parked on the road, the first patrol car to
  // come up behind it queued there for the whole run (Officer._warnIfBlocked
  // is meant to), and that is not driving. Off the road beside the network,
  // so the patrols still work the part of the map round it.
  let at = null;
  for (const n of gr.nodes) {
    if (n.edges.length < 3) continue;
    at = n; break;
  }
  const park = { x: at.x + 40, z: at.z + 40 };
  for (let k = 0; k < 20 && g.sim.surfaceAt(park.x, park.z) !== 0; k++) { park.x += 15; park.z += 9; }
  const parkY = (g.groundAt ? g.groundAt(park.x, park.z) : 0) + 1;
  const s = { n: 0, speed: 0, stopped: 0, lane: 0, laneBad: 0, wrong: 0, off: 0, hits: 0, rev: 0, dist: 0, flips: 0 };
  const last = new Map();
  for (let i = 0; i < seconds * 60; i++) {
    g.heat.value = 0;
    if (i % 60 === 0) p.teleport({ x: park.x, y: parkY, z: park.z }, 0);
    p.setVelocity({ x: 0, y: 0, z: 0 });
    g._update(1 / 60);
    for (const u of g.dispatcher.units) {
      if (u.role !== ROLE.PATROL) continue;
      const v = u.vehicle;
      const snap = gr.nearestEdge(v.position.x, v.position.z, 40);
      if (!snap) continue;
      s.n++;
      s.speed += v.speed;
      const red = u._signalCap && u._signalCap() < 1;
      if (v.speed < 1 && !red) s.stopped++;
      if (v.forwardSpeed < -0.5) s.rev++;
      // Lane: which way along the edge the car is going, and its signed offset
      // from the centreline, + to the left of travel. The lane middle is at
      // +min(3, w/2 - 1.6) for the side this game drives on (DRIVE_SIDE).
      const e = snap.edge;
      const dir = gr.edgeDirection(e, snap.along, { x: 0, z: 1 });
      const fwd = dir.x * v.forward.x + dir.z * v.forward.z >= 0 ? 1 : -1;
      const tx = dir.x * fwd, tz = dir.z * fwd;
      const lat = (v.position.x - snap.x) * -tz + (v.position.z - snap.z) * tx;
      const half = e.width * 0.5;
      const laneMid = Math.min(3, half - 1.6) * (window.__driveSide || g.driveSide || 1);
      const err = Math.abs(lat - laneMid);
      s.lane += err;
      if (err > 1.5) s.laneBad++;
      if (Math.sign(lat) !== Math.sign(laneMid) && Math.abs(lat) > 1) s.wrong++;
      if (Math.abs(lat) > half + 0.5) s.off++;
      // Up on the footway or the verge rather than on the tarmac.
      if (g.sim.surfaceAt(v.position.x, v.position.z) !== 1) s.kerb = (s.kerb || 0) + 1;
      // Braking hard: more than 4 m/s/s off the speed, over half a second. A
      // frame at a time this counted the speed controller pulsing the brake,
      // which every car does and nobody can see.
      const hist = (last.get(u) || {}).hist || [];
      hist.push(v.forwardSpeed);
      if (hist.length > 30) hist.shift();
      if (hist.length === 30 && (hist[0] - hist[29]) * 2 > 4) s.brake = (s.brake || 0) + 1;
      if (v.speed > (e.speed || 15) * 1.15) s.fast = (s.fast || 0) + 1;
      // Each knock once: lastImpactAt is wall-clock, and headless a frame takes
      // a fraction of a millisecond, so testing "recent" counted one knock
      // dozens of times.
      if (v.lastImpactAt && v.lastImpactAt !== (last.get(u) || {}).hitAt && v.lastImpact > 2.6) s.hits++;
      if (v.up && v.up.y < 0.3) s.flips++;
      const prev = last.get(u);
      if (prev) s.dist += Math.hypot(v.position.x - prev.x, v.position.z - prev.z);
      last.set(u, { x: v.position.x, z: v.position.z, hitAt: v.lastImpactAt, hist });
      const st = v.controls ? v.controls.steer || 0 : 0;
      if (prev && prev.st !== undefined && Math.sign(st) !== Math.sign(prev.st) && Math.abs(st - prev.st) > 0.3) s.weave = (s.weave || 0) + 1;
      last.get(u).st = st;
    }
  }
  const n = Math.max(1, s.n);
  window.__res = `${g.mapDef.id} patrol ${seconds}s  unit-seconds ${(n / 60).toFixed(0)}  `
    + `mean ${(s.speed / n * 3.6).toFixed(0)} km/h  stopped ${(100 * s.stopped / n).toFixed(0)}%  `
    + `lane error ${(s.lane / n).toFixed(2)} m (off lane ${(100 * s.laneBad / n).toFixed(0)}%)  `
    + `wrong side ${(100 * s.wrong / n).toFixed(0)}%  off road ${(100 * s.off / n).toFixed(0)}%  `
    + `off the tarmac ${(100 * (s.kerb || 0) / n).toFixed(0)}%  over the limit ${(100 * (s.fast || 0) / n).toFixed(0)}%  `
    + `hard braking ${(100 * (s.brake || 0) / n).toFixed(0)}%  `
    + `hits ${s.hits}  weave ${((s.weave || 0) / Math.max(0.1, s.dist / 1000)).toFixed(0)}/km  `
    + `reverse ${(s.rev / 60).toFixed(0)} s  flipped frames ${s.flips}  km ${(s.dist / 1000).toFixed(1)}`;
  return window.__res;
};
