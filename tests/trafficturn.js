// Does the traffic turn round, and go off the road doing it?
//
// "The traffic cars still seem to go off-road a bit. Maybe it's mainly when
// they turn around. I don't know why they're turning around. They should just
// be going in loops and around the map and stuff. They should really never be
// turning around."
//
// The whole game stepped headless for `seconds` with nobody chasing, the
// player's car left where it starts (the traffic is made round it). Every
// traffic car is watched:
//
//   turns     times one ended up pointing back the way it had been going --
//             heading 150 degrees or more from where it was 8 s before, having
//             moved under 40 m net, at a standstill or a crawl at some point
//   offRoad   share of moving car-frames with its middle off the tarmac
//   carS      car-seconds watched
window.__runTrafficTurn = async function (seconds = 180, label = '') {
  window.__res = null;
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.player && window.__game.traffic); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const g = window.__game;
    g.heat.value = 0;
    const hist = new Map();
    let turns = 0, off = 0, moving = 0, carS = 0;
    const dt = 1 / 30;
    for (let i = 0; i < seconds * 30; i++) {
      g.heat.value = 0;
      g._update(dt);
      if (i % 15 !== 0) continue;           // twice a second
      const now = i * dt;
      for (const c of g.traffic.cars) {
        const v = c.v;
        if (v.removed || v.dormant) continue;
        carS += 0.5;
        let h = hist.get(c);
        if (!h) { h = []; hist.set(c, h); c._seen = now; }
        h.push({ t: now, x: v.position.x, z: v.position.z, hx: v.forward.x, hz: v.forward.z, slow: v.speed < 2 });
        while (h.length && now - h[0].t > 8) h.shift();
        if (v.speed > 2) {
          moving++;
          const e = g.graph.nearestEdge(v.position.x, v.position.z, 30);
          if (!e || e.dist > e.edge.width * 0.5 + 0.5) off++;
        }
        const a = h[0];
        if (now - a.t >= 7.5 && !c._turnedAt) {
          const dot = a.hx * v.forward.x + a.hz * v.forward.z;
          if (dot < -0.87 && Math.hypot(v.position.x - a.x, v.position.z - a.z) < 40 && h.some((p) => p.slow)) {
            turns++;
            c._turnedAt = now;
            // What it was doing, into window.__turnLog.
            const n = g.graph.nearestNode(v.position.x, v.position.z);
            (window.__turnLog = window.__turnLog || []).push({ t: Math.round(now), x: Math.round(v.position.x), z: Math.round(v.position.z),
              deg: n ? g.graph.roadDegree(n) : null, nodeD: n ? Math.round(Math.hypot(n.x - v.position.x, n.z - v.position.z)) : null,
              age: Math.round(now - (c._seen || now)), turnRound: !!c.driver.turnRoundState, rev: c.driver.reverseTimer > 0, stuck: +c.stuckFor.toFixed(1) });
          }
        }
        if (c._turnedAt && now - c._turnedAt > 10) c._turnedAt = 0;
      }
      if (i % 300 === 0) await new Promise((r) => setTimeout(r, 0));
    }
    window.__res = `${label}: turns ${turns} in ${Math.round(carS)} car-s (${(turns / (carS / 60)).toFixed(2)} a car-minute), offRoad ${(100 * off / (moving || 1)).toFixed(1)}%`;
  } catch (e) {
    window.__res = 'EX: ' + e.message + ' | ' + (e.stack || '').slice(0, 300);
  }
};
