// The head-on van.
//
// The player is driven along a long straight at a fixed speed by the same
// controller the police use, the van is sent, and the whole run is watched:
// where it was put, whether it could be seen appearing, how it arrived, and
// what happens to it afterwards.
//
//   aheadM       how far up the road it was put
//   forwardCos   1.0 is straight up the road in front, negative is behind
//   facingCos    -1.0 is pointing straight back down the road at the car
//   headOnDeg    angle between the two cars when they met; 180 is nose to nose
//   closingKph   how fast the two closed on each other at the meeting
//   hit          did it make contact, or did the car get past it
//   roleAfter    what the van does once its run is over
window.__runRhino = async function (kph = 130, seconds = 20, seed = 4242, dodge = true) {
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.player); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const g = window.__game, M = window.__modules, gr = g.graph, p = g.player;
    if (g.audio) g.audio.muted = true;
    const wasPaused = g.paused;
    g.paused = true;
    g.onBusted = () => { g.outcome = null; g.heat.bustTimer = 0; };
    g.onEscaped = () => { g.outcome = null; };
    g.restart();

    let s = seed >>> 0;
    const rnd = () => {
      s = (s + 0x6D2B79F5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    g.rng = rnd;

    // A long run of road, joined up, so the car is committed to a direction.
    const nodes = gr.nodes.filter((n) => n.edges.length >= 2);
    const pts = [];
    let at = nodes[Math.floor(rnd() * nodes.length)], length = 0;
    for (let guard = 0; length < (kph / 3.6) * seconds + 500 && guard < 60; guard++) {
      const to = nodes[Math.floor(rnd() * nodes.length)];
      if (to === at || Math.hypot(to.x - at.x, to.z - at.z) < 400) continue;
      const ids = gr.route(at.id, to.id);
      if (!ids || ids.length < 2) continue;
      const seg = gr.pathToPoints(ids, 2.4);
      for (const q of (pts.length ? seg.slice(1) : seg)) {
        if (pts.length) length += Math.hypot(q.x - pts[pts.length - 1].x, q.z - pts[pts.length - 1].z);
        pts.push(q);
      }
      at = to;
    }
    if (pts.length < 10) return 'no route';

    const start = pts[4], next = pts[5];
    const h = Math.atan2(next.x - start.x, next.z - start.z);
    p.repair();
    p.teleport({ x: start.x, y: 0.95, z: start.z }, h);
    p.setVelocity({ x: Math.sin(h) * kph / 3.6, y: 0, z: Math.cos(h) * kph / 3.6 });
    p._readState();
    const auto = new M.Driver(p, M.SKILL.pursuit);
    auto.limitScale = 2.4;
    auto.setPath(pts.slice(4));

    g.heat.value = 0; g.heat.bump(1, 'test'); g.heat.value = 5.3;
    const D = g.dispatcher, k = D.knowledge;
    // Only the van: no other unit, and they always know where the car is.
    const realDispatch = D.update.bind(D);
    const realBlocks = g.roadblocks.update.bind(g.roadblocks);
    g.roadblocks.update = () => {};
    let unit = null, call = null;
    D.update = (dt, target) => {
      D.clock += dt;
      k.seen = true; k.timeSinceSeen = 0;
      k.position.copy(target.position); k.velocity.copy(target.linvel);
      D._trackCourse(dt, target);
      if (unit) unit.update(dt, target);
    };

    const origU = g._update.bind(g);
    g._update = (dt) => {
      g.heat.value = 5.3;
      // dodge=false: the player holds its line, so the measurement is whether
      // the van can actually connect rather than whether a robot can dodge it.
      if (dodge) auto.avoid(g.vehicles, dt);
      g.forceControls = Object.assign({}, auto.followPath(dt, kph / 3.6));
      origU(dt);
    };

    let t = 0, sent = null, pAt = 0;
    while (t < seconds && auto.remaining() > 30) {
      // Send it once the car has been going the same way for a while, the way
      // the dispatcher does.
      if (!unit && D.straightFor > 3.2) {
        const u = g.spawnRhino(p, 5);
        if (u) {
          unit = u;
          D.units.push(u);
          u.setRole(M.ROLE.RHINO);
          D.rhinoUnit = u;
          const v = u.vehicle;
          const dx = v.position.x - p.position.x, dz = v.position.z - p.position.z;
          const d = Math.hypot(dx, dz) || 1;
          const sp = p.speed || 1;
          sent = call = {
            t: +t.toFixed(1),
            aheadM: Math.round(d),
            forwardCos: +((dx * p.linvel.x / sp + dz * p.linvel.z / sp) / d).toFixed(2),
            facingCos: +(v.forward.x * p.linvel.x / sp + v.forward.z * p.linvel.z / sp).toFixed(2),
            inView: g.inView(v.position),
            playerKph: Math.round(p.speed * 3.6),
            nearest: 9999, hit: false,
          };
        }
      }
      g.stepHeadless(1 / 30, null, 1 / 30);
      t += 1 / 30;

      if (unit && call) {
        const v = unit.vehicle;
        const d = Math.hypot(v.position.x - p.position.x, v.position.z - p.position.z);
        if (d < call.nearest) {
          call.nearest = Math.round(d);
          const dot = v.forward.x * p.forward.x + v.forward.z * p.forward.z;
          call.headOnDeg = Math.round(Math.acos(Math.max(-1, Math.min(1, dot))) * 180 / Math.PI);
          call.closingKph = Math.round((Math.abs(v.forwardSpeed) + Math.abs(p.forwardSpeed)) * 3.6);
          call.vanKph = Math.round(v.speed * 3.6);
        }
        if (p.lastImpactAt && p.lastImpactAt !== pAt) {
          pAt = p.lastImpactAt;
          if (d < 9) { call.hit = true; call.hitDv = +p.lastImpact.toFixed(1); }
        }
        call.roleAfter = unit.role;
        if (p.damage > 0.5) p.repair();
      }
      if (Math.floor(t * 30) % 60 === 0) await new Promise((r) => setTimeout(r, 0));
    }

    g._update = origU;
    D.update = realDispatch;
    g.roadblocks.update = realBlocks;
    g.forceControls = null;
    g.paused = wasPaused;
    if (unit) D.retire(unit);
    D.rhinoUnit = null;
    return sent || 'never sent (straightFor never reached the threshold)';
  } catch (e) {
    return 'EX ' + e.message + ' ' + String(e.stack).slice(0, 300);
  }
};
