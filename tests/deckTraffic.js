// Traffic on Ashfield City's raised roads: does it use them, and does it keep moving?
//
// "The civilian car routing system, it doesn't work on highways." The game runs (stepHeadless) with the
// player parked on the ring, and every second each traffic car up on a raised road is sampled: its speed,
// its height over the deck, and how long it has been nearly stopped.
//
//   await import('/tests/deckTraffic.js');  __runDeckTraffic(120)   // then window.__dt
//
//   onDeck     car-seconds spent up on a raised road
//   moving     of those, the share above 5 m/s
//   stuck      cars that sat under 1 m/s on a deck for 10 s or more
//   offDeck    samples of a car within a deck's width of a raised road but more than 3 m under it (fallen)
export async function runDeckTraffic(secs = 120) {
  const g = window.__game, G = g.graph, v = g.player;
  const raised = G.edges.filter((e) => e.elevated);
  const ring = raised.find((e) => e.kind === 'motorway' && e.length > 150);
  // On the hard shoulder, not in a lane: parked in the middle, every car behind it queued, and read as stuck.
  const q0 = ring.points[Math.floor(ring.points.length / 2)], q1 = ring.points[Math.floor(ring.points.length / 2) + 1] || ring.points[0];
  const l = Math.hypot(q1.x - q0.x, q1.z - q0.z) || 1, off = ring.width * 0.5 - 1.3;
  const p = { x: q0.x - (q1.z - q0.z) / l * off, z: q0.z + (q1.x - q0.x) / l * off };
  v.teleport({ x: p.x, y: G.levelOn(ring, p.x, p.z) + 0.9, z: p.z }, Math.atan2(q1.x - q0.x, q1.z - q0.z));
  v.setVelocity({ x: 0, y: 0, z: 0 });
  v._readState();
  g.onBusted = () => { g.outcome = null; };
  const slow = new Map();
  let onDeck = 0, moving = 0, offDeck = 0;
  const stuck = new Set();
  const near = (x, z) => {
    for (const e of raised) {
      for (const s of e.segs) {
        const dx = s.b.x - s.a.x, dz = s.b.z - s.a.z, l2 = dx * dx + dz * dz;
        let u = l2 ? ((x - s.a.x) * dx + (z - s.a.z) * dz) / l2 : 0;
        u = Math.max(0, Math.min(1, u));
        if (Math.hypot(s.a.x + dx * u - x, s.a.z + dz * u - z) < e.width * 0.5) return e;
      }
    }
    return null;
  };
  for (let t = 0; t < secs; t++) {
    g.stepHeadless(1, { throttle: 0, brake: 1, steer: 0, handbrake: 1 });
    for (const c of g.traffic.cars) {
      const q = c.v.position, e = near(q.x, q.z);
      if (!e) continue;
      const ly = G.levelOn(e, q.x, q.z);
      if (ly - g.sim.terrainAt(q.x, q.z) < 2) continue;
      if (q.y < ly - 3) { offDeck++; continue; }
      onDeck++;
      if (c.v.speed > 5) moving++;
      const k = (slow.get(c) || 0) + (c.v.speed < 1 ? 1 : -slow.get(c) || 0);
      slow.set(c, Math.max(0, k));
      if (slow.get(c) >= 10) stuck.add(c);
    }
    await new Promise((r) => setTimeout(r, 0));
  }
  const states = g.traffic.cars.map((c) => (c.v.dormant ? 'glide' : 'drive') + ':' + c.v.speed.toFixed(0));
  window.__dt = { secs, states, onDeck, moving: onDeck ? +(moving / onDeck).toFixed(2) : null, stuck: stuck.size, offDeck, cars: g.traffic.cars.length };
  return window.__dt;
}
window.__runDeckTraffic = runDeckTraffic;
