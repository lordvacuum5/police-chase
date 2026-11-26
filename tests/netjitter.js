// Remote cars over a bumpy connection. "Lots of civilian cars are really, really laggy" in multiplayer.
//   const m = await import('/tests/netjitter.js');  m.netJitter()      // window.__nj
// A car going round a 60 m circle at 20 m/s on the sending machine, whose frames take 14 to 30 ms and which sends at most 30 times a
// second (Session.dueToSend); each packet `delay` ms on the way, give or take `jitter` (and a few held up 120 ms more); drawn here at
// 60 frames a second by Track.sample, 30 m off (the delay in full) and 4 m off (carried on). How far the drawn car moves from frame to
// frame against the frame before (jerk, m), and how far it is from where it was 90 ms before (error, m): by when packets arrived, as
// it was, and by the sender's clock (SenderClock).
import { Track, SenderClock } from '/src/net/session.js';

export function netJitter(opts = {}) {
  const out = window.__nj = {};
  for (const [name, delayMs, jitter] of [['steady', 40, 4], ['bumpy', 60, 35], ['awful', 90, 70]]) {
    let seed = 7;
    const rng = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return ((seed >>> 0) % 1e6) / 1e6; };
    // The sender's packets: [sent at, car].
    const sent = [];
    const R = 60, W = 20 / R;
    const at = (t) => ({ x: Math.cos(W * t / 1000) * R, z: Math.sin(W * t / 1000) * R, vx: -Math.sin(W * t / 1000) * 20, vz: Math.cos(W * t / 1000) * 20 });
    let t = 0, last = -1e9;
    while (t < 20000) {
      t += 14 + rng() * 16;
      if (t - last < 1000 / 30) continue;
      last = t;
      const p = at(t);
      sent.push([t, { id: 'c', kind: 'hatchback', x: p.x, y: 0, z: p.z, qx: 0, qy: 0, qz: 0, qw: 1, vx: p.vx, vy: 0, vz: p.vz, steer: 0, speed: 20, damage: 0, flags: 0 }]);
    }
    // Arriving: in order, as a socket delivers them.
    const arrive = [];
    let prev = 0;
    for (const [ts, car] of sent) {
      const lag = delayMs + (rng() * 2 - 1) * jitter + (rng() < 0.03 ? 120 : 0);
      prev = Math.max(prev, ts + Math.max(5, lag) + 5000);
      arrive.push([prev, ts, car]);
    }
    const res = {};
    for (const way of ['arrival', 'sender']) {
      for (const [near, delay] of [['far', 90], ['near', 0]]) {
        const track = new Track('c'), clock = new SenderClock();
        let k = 0, a = null, b = null;
        const jerk = [], err = [];
        for (let now = 6000; now < 24000; now += 1000 / 60) {
          while (k < arrive.length && arrive[k][0] <= now) {
            const [got, ts, car] = arrive[k++];
            track.push(car, way === 'arrival' ? got : clock.local(ts, got));
          }
          const c = track.sample(now, delay);
          if (!c) continue;
          if (a && b) jerk.push(Math.hypot(c.x - 2 * b.x + a.x, c.z - 2 * b.z + a.z));
          a = b; b = { x: c.x, z: c.z };
          const truth = at(now - 5000 - delay - (way === 'arrival' ? delayMs : delayMs));
          err.push(Math.hypot(c.x - truth.x, c.z - truth.z));
        }
        jerk.sort((x, y) => x - y);
        const q = (arr, f) => +arr[Math.floor(f * (arr.length - 1))].toFixed(3);
        res[`${way} ${near}`] = { jerk50: q(jerk, 0.5), jerk95: q(jerk, 0.95), jerk99: q(jerk, 0.99), over5cm: jerk.filter((j) => j > 0.05).length };
      }
    }
    out[name] = res;
  }
  return out;
}
