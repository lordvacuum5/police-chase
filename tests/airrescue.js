// Air Rescue (game/airrescue.js): is every day's set of places one a helicopter can land in?
//   const m = await import('/tests/airrescue.js');  m.places(60)      on the map that is loaded, for that many days
//   bad   places with a solid within 13 m of the middle, water within 12, a road within 10, or ground that rises
//         over 0.9 m; fewer  days with under three places
//   await m.fly()     today's, flown by a crude pilot: up, across, down into each box; then landed hard; then wrecked
import { pickSites } from '/src/game/airrescue.js';
import { makeRng } from '/src/util/math.js';

export function places(days = 60) {
  const g = window.__game, G = g.graph, pad = g.garage.helipad, map = g.world.__map;
  const out = { map: g.mapDef.id, days, fewer: 0, bad: 0, why: {}, len: [], legs: [] };
  const note = (w) => { out.bad++; out.why[w] = (out.why[w] || 0) + 1; };
  for (let d = 0; d < days; d++) {
    const s = pickSites(g, makeRng(1000 + d * 7919), pad);
    if (s.length < 3) { out.fewer++; continue; }
    let at = pad, len = 0;
    for (const p of s) {
      const l = Math.hypot(p.x - at.x, p.z - at.z);
      len += l; out.legs.push(l); at = p;
      let lo = Infinity, hi = -Infinity;
      for (let a = 0; a < 24; a++) for (const r of [3, 9, 12]) {
        const x = p.x + Math.cos(a * 0.2618) * r, z = p.z + Math.sin(a * 0.2618) * r, y = g.sim.heightAt ? g.sim.heightAt(x, z) || 0 : 0;
        lo = Math.min(lo, y); hi = Math.max(hi, y);
        if (map.clearAt && map.clearAt(x, z)) { note('water'); a = 99; break; }
      }
      if (hi - lo > 1) note('slope');
      for (const e of G.edgesNear(p.x, p.z, 40)) for (const sg of e.segs) {
        const dx = sg.b.x - sg.a.x, dz = sg.b.z - sg.a.z, l2 = dx * dx + dz * dz; let u = l2 ? ((p.x - sg.a.x) * dx + (p.z - sg.a.z) * dz) / l2 : 0; u = Math.max(0, Math.min(1, u));
        if (Math.hypot(sg.a.x + dx * u - p.x, sg.a.z + dz * u - p.z) < e.width * 0.5 + 10) { note('road'); }
      }
      const shape = { hx: 9, hy: 8, hz: 9 };
      void shape;
      g.world.forEachCollider((c) => {
        const m = c.collisionGroups() >>> 16;
        if (!(m & (2 | 4 | 256)) || !c.halfExtents) return;
        const h = c.halfExtents(); if (!h) return;
        const t = c.translation();
        const r = Math.hypot(h.x, h.z);
        if (Math.hypot(t.x - p.x, t.z - p.z) < Math.min(h.x, h.z) + 9 && t.y + h.y > p.y + 0.3 && r < 60) note('solid');
      });
    }
    out.len.push(len);
  }
  const avg = (a) => Math.round(a.reduce((x, y) => x + y, 0) / a.length);
  return { ...out, len: [Math.round(Math.min(...out.len)), avg(out.len), Math.round(Math.max(...out.len))], legs: [Math.round(Math.min(...out.legs)), avg(out.legs), Math.round(Math.max(...out.legs))] };
}

/** One frame of the game's own update with the stick where the pilot puts it. */
function frame(g, stick, dt = 1 / 60) {
  const keep = g.input.sampleAir;
  g.input.sampleAir = () => stick;
  g.daily.state !== 'x' && g._update(dt);
  g.input.sampleAir = keep;
}

/** Straight up to `alt`, over to (x, z) nose first, and down at `sink` m/s, by putting the aircraft there (not a flying test: a rules test). */
export function carry(g, x, y, z, sink) {
  const p = g.player;
  p.engineOff = false; p.startFrac = 1; p.spin = 1;
  p.position.set(x, y + 3, z); p.linvel.set(0, -sink, 0); p.pitch = p.roll = 0; p._restAt = null; p.onGround = false;
  for (let i = 0; i < 240 && !p.onGround && !p.disabled; i++) { p.linvel.y = -sink; frame(g, { collective: 0, pitch: 0, roll: 0, yaw: 0 }); }
}

export async function fly() {
  const g = window.__game, d = g.daily, r = d.rescue, out = [];
  g.paused = true;
  const say = () => [d.state, r.leg, +r.held.toFixed(1), r.hard, d._last && d._last.replace(/<[^>]+>/g, ' ').trim()];
  const run = (s, stick = { collective: 0, pitch: 0, roll: 0, yaw: 0 }) => { for (let i = 0; i < s * 60; i++) frame(g, stick); };
  run(4); out.push(['go', say(), [g.player.engineOff, +d.limit]]);
  let s = r.target;
  carry(g, s.x, s.y, s.z, 4.5); run(4); out.push(['hard landing (4.5 m/s)', say(), +r.touch.toFixed(1)]);
  carry(g, s.x, s.y, s.z, 1.5); run(1.5); out.push(['gentle, part held', say()]);
  g.player.position.y += 6; run(0.2); out.push(['lifted off early', say()]);
  carry(g, s.x + 14, s.y, s.z, 1.5); run(4); out.push(['beside the box', say()]);
  carry(g, s.x, s.y, s.z, 1.5); run(3.5); out.push(['landing 1', say()]);
  s = r.target; carry(g, s.x + 5, s.y, s.z - 5, 2.5); run(3.5); out.push(['landing 2', say()]);
  g.player.wreck(); run(1); out.push(['wrecked, 1 s on', say()]); run(1.5); out.push(['2.5 s on', say(), [Math.round(g.player.position.x - r.pad.x), +(g.player.position.y - r.pad.y).toFixed(2), g.player.disabled, g.player.damage]]);
  run(4);
  for (let k = 0; k < 3; k++) { s = r.target; carry(g, s.x, s.y, s.z, 1); run(3.4); }
  out.push(['all three', say(), g.outcome]);
  return out;
}
