// The jolt in a turn, and the wall that is not there.
//
// "It almost just looks like they almost just jolt ... it's not like they do a whole jolt
// 90 degrees. It's just like a couple of degrees." And: "one almost hit an invisible wall when
// it was going up a hill and just bounced back." Read every frame of every unit in a real chase:
// pass __joltLens() as the tweak to __runForce, then call __joltReport().
//
//   jolt   the yaw rate moving more than JOLT rad/s in 3 frames, above 60 km/h on the ground
//   then   what happened in the frames before it: a new line, a jump in the steering command, a knock
//   wall   a knock above 8 m/s with nothing solid or another car near, and the slope it was on
import { boxesNear } from '../src/ai/localplan.js';

const JOLT = 0.35;

/** What the body box itself is touching right now, not counting the wheels' rays. */
function bodyTouch(v) {
  const out = [];
  for (const c of v.keel ? [v.collider, v.keel] : [v.collider]) {
    v.world.contactPairsWith(c, (o) => {
      if (o === v.collider || o === v.keel) return;
      let t = false;
      v.world.contactPair(c, o, (m) => { if (m.numContacts() > 0) t = true; });
      if (t) out.push(`${c === v.keel ? 'keel' : 'body'}:${(o.collisionGroups() >>> 16).toString(16)}`);
    });
  }
  return out;
}

function clearAt(g, x, z) {
  let best = 99;
  for (const b of boxesNear(g, x, z, 10)) {
    const dx = x - b.x, dz = z - b.z;
    const lx = Math.abs(dx * b.c - dz * b.s) - b.hx, lz = Math.abs(dx * b.s + dz * b.c) - b.hz;
    best = Math.min(best, Math.hypot(Math.max(lx, 0), Math.max(lz, 0)));
  }
  return best;
}

window.__joltLens = function () {
  const L = window.__jolt = { frames: 0, seconds: 0, jolts: 0, by: { line: 0, knock: 0, steer: 0, other: 0 }, acc: [], cmd: [], walls: [], st: new WeakMap(), samples: [] };
  return (_d, g) => {
    if (g.__joltOn) return;
    g.__joltOn = true;
    const step = g.stepHeadless.bind(g);
    g.stepHeadless = (dt, c) => {
      step(dt, c);
      for (const u of g.dispatcher.units) {
        const v = u.vehicle, dr = u.driver;
        if (!v || v.removed || u.human) continue;
        let s = L.st.get(u);
        if (!s) L.st.set(u, s = { yaw: [], steer: [], path: null, lineAt: -99, hitAt: 0, knockAt: -99, i: 0, jFor: 0, vel: null });
        s.i++;
        const yaw = v.angvel.y, cmd = v.controls ? v.controls.steer || 0 : 0;
        s.yaw.push(yaw); if (s.yaw.length > 4) s.yaw.shift();
        s.steer.push(cmd); if (s.steer.length > 16) s.steer.shift();
        if (dr.path !== s.path) { s.path = dr.path; s.lineAt = s.i; }
        if (v.lastImpactAt !== s.hitAt && v.lastImpact > 3) { s.hitAt = v.lastImpactAt; s.knockAt = s.i; }
        s.jFor = Math.max(0, s.jFor - 1);
        const touch = bodyTouch(v);
        const roll = Math.asin(Math.max(-1, Math.min(1, (v.up.x * v.forward.z - v.up.z * v.forward.x) * 0 + Math.hypot(v.up.x, v.up.z)))) * 57.3;
        s.buf = s.buf || [];
        s.buf.push({ h: +(Math.hypot(v.linvel.x, v.linvel.z) * 3.6).toFixed(0), g: v.grounded, yaw: +yaw.toFixed(2), ang: +v.steerAngle.toFixed(3), br: +(v.controls ? v.controls.brake || 0 : 0).toFixed(2), th: +(v.controls ? v.controls.throttle || 0 : 0).toFixed(2), t: touch.join(',') });
        if (s.buf.length > 16) s.buf.shift();
        if (v.speed > 60 / 3.6) {
          L.at = (L.at || 0) + 1;
          L.gr = L.gr || [0, 0, 0, 0, 0];
          L.gr[Math.max(0, Math.min(4, v.grounded))]++;
          if (touch.some((x) => x.startsWith('body'))) L.bodyOn = (L.bodyOn || 0) + 1;
          if (touch.some((x) => x.startsWith('keel'))) L.keelOn = (L.keelOn || 0) + 1;
          L.rollSum = (L.rollSum || 0) + Math.abs(roll);
        }
        const fast = v.speed > 60 / 3.6;
        if (fast && s.yaw.length === 4) {
          L.frames++;
          const d = Math.abs(yaw - s.yaw[0]);
          L.acc.push(d);
          let big = 0;
          for (let k = 1; k < s.steer.length; k++) big = Math.max(big, Math.abs(s.steer[k] - s.steer[k - 1]));
          L.cmd.push(big);
          if (d > JOLT && !s.jFor) {
            L.jolts++;
            s.jFor = 12;
            const by = s.i - s.knockAt < 12 ? 'knock' : s.i - s.lineAt < 12 ? 'line' : big > 0.15 ? 'steer' : 'other';
            L.by[by]++;
            L.jg = L.jg || [0, 0, 0, 0, 0];
            L.jg[Math.max(0, Math.min(4, v.grounded))]++;
            if (touch.some((x) => x.startsWith('body'))) L.jBody = (L.jBody || 0) + 1;
            if (L.traces === undefined) L.traces = [];
            if (L.traces.length < 6) L.traces.push({ by, kph: Math.round(v.speed * 3.6), frames: s.buf.slice() });
            if (L.samples.length < 16) L.samples.push({ by, d: +d.toFixed(2), kph: Math.round(v.speed * 3.6), mode: u._mode, big: +big.toFixed(2), lim: +(v.steerLimit || 0).toFixed(3), ang: +v.steerAngle.toFixed(3) });
          }
        }
        if (s.vel && v.lastImpact > 8 && s.knockAt === s.i && L.walls.length < 24) {
          const x = v.position.x, z = v.position.z;
          const clear = clearAt(g, x, z);
          let near = 99;
          for (const o of g.vehicles) if (o !== v && !o.removed) near = Math.min(near, Math.hypot(o.position.x - x, o.position.z - z));
          if (clear > 3.5 && near > 7) {
            const e = 3, h = (a, b) => g.sim.heightAt(a, b);
            const sl = Math.hypot(h(x + e, z) - h(x - e, z), h(x, z + e) - h(x, z - e)) / (2 * e);
            const f = s.vel;
            L.walls.push({ imp: +v.lastImpact.toFixed(1), was: Math.round(Math.hypot(f.x, f.z) * 3.6), now: Math.round(v.speed * 3.6), vyWas: +f.y.toFixed(1), vyNow: +v.linvel.y.toFixed(1), slope: +(sl * 100).toFixed(0), up: +v.up.y.toFixed(2), keel: !!v.keel, free: !!v._hillFree, surface: g.sim.surfaceAt(x, z), grounded: v.grounded, mode: u._mode, y: +(v.position.y - h(x, z)).toFixed(2) });
          }
        }
        s.vel = { x: v.linvel.x, y: v.linvel.y, z: v.linvel.z };
        // Thrown back: a fifth of its speed gone in a fifth of a second, on no brakes, with nothing there.
        const hs = Math.hypot(v.linvel.x, v.linvel.z);
        s.hs = s.hs || []; s.hs.push(hs); if (s.hs.length > 12) s.hs.shift();
        s.backFor = Math.max(0, (s.backFor || 0) - 1);
        const brake = v.controls ? v.controls.brake || 0 : 0;
        if (s.hs.length === 12 && s.hs[0] > 12 && hs < s.hs[0] * 0.8 && brake < 0.3 && !s.backFor && !v.disabled) {
          const x = v.position.x, z = v.position.z;
          let near = 99;
          for (const o of g.vehicles) if (o !== v && !o.removed) near = Math.min(near, Math.hypot(o.position.x - x, o.position.z - z));
          const clear = clearAt(g, x, z);
          if (near > 7 && clear > 3.5) {
            s.backFor = 60;
            const touch = [];
            for (const c of v.keel ? [v.collider, v.keel] : [v.collider]) {
              v.world.contactPairsWith(c, (o) => {
                if (o === v.collider || o === v.keel) return;
                let t = false;
                v.world.contactPair(c, o, (m) => { if (m.numContacts() > 0) t = true; });
                if (!t) return;
                const he = o.halfExtents ? o.halfExtents() : null;
                touch.push(`${c === v.keel ? 'keel' : 'body'}:${(o.collisionGroups() >>> 16).toString(16)}:${he ? [he.x, he.y, he.z].map((q) => q.toFixed(1)).join('x') : 'mesh'}`);
              });
            }
            const e = 3, h = (a, b) => g.sim.heightAt(a, b);
            const f = v.forward;
            const ahead = (h(x + f.x * 4, z + f.z * 4) - h(x, z)) / 4;
            if (L.traces2 === undefined) L.traces2 = [];
            if (L.traces2.length < 6) L.traces2.push({ was: Math.round(s.hs[0] * 3.6), frames: s.buf.slice() });
            (L.back = L.back || []).push({ was: Math.round(s.hs[0] * 3.6), now: Math.round(hs * 3.6), vy: +v.linvel.y.toFixed(1), rise: +(ahead * 100).toFixed(0), up: +v.up.y.toFixed(2), y: +(v.position.y - h(x, z)).toFixed(2), ground: v.grounded, mode: u._mode, imp: +(v.lastImpact || 0).toFixed(0), touch: touch.join(' '), at: [Math.round(x), Math.round(z)] });
          }
        }
      }
    };
  };
};

window.__joltReport = function () {
  const L = window.__jolt;
  const pc = (a, p) => { const b = a.slice().sort((x, y) => x - y); return b.length ? b[Math.floor(b.length * p)] : 0; };
  const mins = L.frames / 60 / 60;
  return [
    `unit-minutes at speed ${mins.toFixed(1)}, jolts ${L.jolts} (${(L.jolts / Math.max(0.01, mins)).toFixed(0)} a minute)  after a knock ${L.by.knock}  a new line ${L.by.line}  a jump in steering ${L.by.steer}  other ${L.by.other}`,
    `yaw rate change over 3 frames, rad/s: median ${pc(L.acc, 0.5).toFixed(3)}  p95 ${pc(L.acc, 0.95).toFixed(3)}  p99 ${pc(L.acc, 0.99).toFixed(3)}`,
    `biggest step in the steering command in the last 16 frames: median ${pc(L.cmd, 0.5).toFixed(3)}  p95 ${pc(L.cmd, 0.95).toFixed(3)}`,
    ...L.samples.map((x) => JSON.stringify(x)),
    `at speed: wheels down 0-4 ${(L.gr || []).map((x) => Math.round((x * 100) / Math.max(1, L.at))).join('/')}%, body on something ${Math.round(((L.bodyOn || 0) * 100) / Math.max(1, L.at))}%, keel ${Math.round(((L.keelOn || 0) * 100) / Math.max(1, L.at))}%, mean roll ${((L.rollSum || 0) / Math.max(1, L.at)).toFixed(1)} deg`,
    `at a jolt: wheels down 0-4 ${(L.jg || []).join('/')}, body on something ${L.jBody || 0}`,
    `thrown back: ${(L.back || []).length}`,
    ...(L.back || []).map((x) => JSON.stringify(x)),
    'walls:',
    ...L.walls.map((x) => JSON.stringify(x)),
  ].join('\n');
};
