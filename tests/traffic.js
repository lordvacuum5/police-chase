// Civilian traffic: does it behave, and does it break the chase?
//
// The second question matters more than the first. Traffic that looks right
// but gridlocks the police, or that the pursuit simply drives through, is
// worse than no traffic at all -- so the last section runs the same pursuit
// with it on and off and compares.
window.__runTraffic = async function () {
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.player); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const g = window.__game, p = g.player, t = g.traffic;
    if (!p) { window.__res = 'NO PLAYER'; return; }
    g.onBusted = () => { g.outcome = null; };
    g.onEscaped = () => { g.outcome = null; };
    g.heat.value = 0;

    const rows = [];
    const settle = (secs) => {
      for (let i = 0; i < 60 * secs; i++) {
        g.stepHeadless(1 / 60, { throttle: 0, brake: 1, steer: 0, handbrake: 1 });
      }
    };

    // --------------------------------------------- 1. are they on the road
    settle(30);
    let offRoad = 0, stoppedAtRed = 0, queued = 0;
    for (const c of t.cars) {
      const tr = c.body.translation();
      if (!g.graph.overlapsRoad(tr.x, tr.z, 1.6, 3.6, c.heading, 0)) offRoad++;
      const node = g.graph.nodes[c.dir > 0 ? c.edge.b : c.edge.a];
      const sd = g.signals ? g.signals.stopDistance(c.edge, node, tr.x, tr.z, c.speed) : Infinity;
      if (c.speed < 0.5 && isFinite(sd) && sd < 4) stoppedAtRed++;
      if (c.speed < 0.5 && isFinite(t._gapAhead(c))) queued++;
    }
    const sp = t.cars.map((c) => c.speed).sort((a, b) => a - b);
    rows.push(['cars', String(t.cars.length)]);
    rows.push(['off the carriageway', `${offRoad}`]);
    rows.push(['moving', `${sp.filter((s) => s > 1).length} of ${sp.length}`]);
    rows.push(['fastest / median', `${sp[sp.length - 1].toFixed(1)} / ${sp[sp.length >> 1].toFixed(1)} m/s`]);
    rows.push(['held at a red light', String(stoppedAtRed)]);
    rows.push(['queued behind someone', String(queued)]);

    // Nobody should be sitting on top of anybody else.
    let overlaps = 0;
    for (let i = 0; i < t.cars.length; i++) {
      for (let j = i + 1; j < t.cars.length; j++) {
        const a = t.cars[i].body.translation(), b = t.cars[j].body.translation();
        if ((a.x - b.x) ** 2 + (a.z - b.z) ** 2 < 6.25) overlaps++;
      }
    }
    rows.push(['pairs inside 2.5 m', String(overlaps)]);

    // -------------------------------------- 1b. do they turn or teleport
    //
    // The heading is written straight onto the body, so nothing in the physics
    // stops a civilian spinning through ninety degrees in one frame. Watch
    // every car for a while and record the worst single-frame turn anybody
    // makes: a real car at 12 m/s pulling 5.5 m/s^2 yaws at about 0.46 rad/s,
    // which is 0.008 rad in a frame.
    let worstYaw = 0, worstDeg = 0;
    const prevH = new Map(t.cars.map((c) => [c, c.heading]));
    for (let i = 0; i < 60 * 25; i++) {
      g.stepHeadless(1 / 60, { throttle: 0, brake: 1, steer: 0, handbrake: 1 });
      for (const c of t.cars) {
        const was = prevH.get(c);
        if (was === undefined || c.crashedFor > 0) { prevH.set(c, c.heading); continue; }
        let d = c.heading - was;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        const rate = Math.abs(d) * 60;
        if (rate > worstYaw) { worstYaw = rate; worstDeg = Math.abs(d) * 180 / Math.PI; }
        prevH.set(c, c.heading);
      }
    }
    rows.push(['worst yaw rate', `${worstYaw.toFixed(2)} rad/s`]);
    rows.push(['worst turn in one frame', `${worstDeg.toFixed(2)} deg`]);

    // ------------------------------------------------- 2. what hitting one does
    //
    // Line the run up along the *civilian's* own road rather than along +Z,
    // so the approach is on tarmac and what gets measured is the collision
    // rather than whatever the player hit on the way to it.
    let hit = null;
    for (let n = 0; n < 20 && !hit; n++) {
      const c = t.cars[Math.floor((n / 20) * t.cars.length)];
      if (!c || c.crashedFor > 0) continue;
      const tr = c.body.translation();
      const fx = Math.sin(c.heading), fz = Math.cos(c.heading);
      p.repair();
      p.teleport({ x: tr.x - fx * 32, y: 0.95, z: tr.z - fz * 32 }, c.heading);
      p.setVelocity({ x: fx * 27, y: 0, z: fz * 27 });
      // Damage lands on the frame contact is detected; the velocity bleeds off
      // over the frames after it. So the contact frame anchors the reading and
      // the speed is compared a fifth of a second either side of it. Which
      // car actually gets hit is not assumed either -- on a busy street it may
      // well be the one queued in front of the one aimed at.
      const wasDown = new Set(t.cars.filter((x) => x.crashedFor > 0));
      let prevSpeed = p.speed, prevDamage = p.damage;
      for (let i = 0; i < 60 * 3; i++) {
        g.stepHeadless(1 / 60, { throttle: 0, brake: 0, steer: 0, handbrake: 0 });
        if (p.damage > prevDamage + 0.005) {
          const dmg = p.damage - prevDamage;
          for (let k = 0; k < 12; k++) {
            g.stepHeadless(1 / 60, { throttle: 0, brake: 0, steer: 0, handbrake: 0 });
          }
          hit = {
            before: prevSpeed,
            after: p.speed,
            dmg,
            knocked: t.cars.some((x) => x.crashedFor > 0 && !wasDown.has(x)),
          };
          break;
        }
        prevSpeed = p.speed; prevDamage = p.damage;
      }
      // A wall or a lamp post is not a civilian; try again somewhere else.
      if (hit && !hit.knocked) hit = null;
    }
    rows.push(['ram one at 27 m/s', hit
      ? `${hit.before.toFixed(1)} -> ${hit.after.toFixed(1)} m/s `
        + `(-${(hit.before - hit.after).toFixed(1)}), damage +${(hit.dmg * 100).toFixed(1)}%`
      : 'no clear run at one']);
    rows.push(['it stopped driving itself', hit ? (hit.knocked ? 'yes' : 'NO') : 'n/a']);

    // ------------------------------ 3. jams, and the police ploughing in
    //
    // Run a real pursuit and watch two things: whether the traffic seizes up,
    // and how often a police car actually hits a civilian rather than getting
    // round it.
    p.repair();
    const pl = g._placeOnRoad(g.graph.nearestNode(0, -240));
    p.teleport(pl.position, pl.heading);
    p.setVelocity({ x: 0, y: 0, z: 0 });
    g.heat.value = 0;
    g.heat.bump(3, 'traffic test');

    let policeHits = 0, worstJam = 0, jamSamples = 0, stoppedSum = 0;
    const wasDown = new WeakSet();
    for (let i = 0; i < 60 * 90; i++) {
      g.stepHeadless(1 / 60, {
        throttle: 1, brake: 0, steer: 0.09 * Math.sin(i / 170), handbrake: 0,
      });
      if (p.damage > 0.6) p.repair();
      // A civilian that has just been knocked out of its lane, with a police
      // car close enough to have been the one that did it.
      for (const c of t.cars) {
        if (c.crashedFor <= 0 || wasDown.has(c)) continue;
        wasDown.add(c);
        for (const u of g.dispatcher.units) {
          if (u.distanceTo(c.position) < 7) { policeHits++; break; }
        }
      }
      if (i % 30 === 0) {
        const stopped = t.cars.filter((c) => c.speed < 0.5 && !c.atRed).length;
        stoppedSum += stopped;
        worstJam = Math.max(worstJam, stopped);
        jamSamples++;
      }
    }
    rows.push(['', '']);
    rows.push(['over 90 s of pursuit', '']);
    rows.push(['police hit a civilian', `${policeHits} times`]);
    rows.push(['stopped, not at a red', `${(stoppedSum / jamSamples).toFixed(1)} on average, `
      + `worst ${worstJam} of ${t.cars.length}`]);
    rows.push(['still on the carriageway', `${t.cars.filter((c) => {
      const tr = c.body.translation();
      return g.graph.overlapsRoad(tr.x, tr.z, 1.6, 3.6, c.heading, 0);
    }).length} of ${t.cars.length}`]);

    window.__res = rows.map((r) => `${r[0].padEnd(26)} ${r[1]}`).join('\n');
  } catch (e) {
    window.__res = 'EX ' + e.message + '\n' + String(e.stack).slice(0, 500);
  }
};
