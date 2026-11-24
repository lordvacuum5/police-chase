// Civilians making way for a siren up on the raised roads: do any go off the edge?
//
// "The civilian car ... it basically just kind of drove off the edge and then couldn't get back on." Each raised
// road in turn has a traffic car put on it at speed, either side, and told a siren is coming (pullFor held) for
// 8 s.   const m = await import('/tests/pullover.js');  await m.pullOver()
//   off     ended more than 1.5 m under the deck, or past its edge
//   stopped came to rest
export async function pullOver(only = null) {
  const g = window.__game, G = g.graph, T = g.traffic;
  g.onBusted = () => { g.outcome = null; };
  g.paused = true;
  g.vehicleLimit = 1;
  for (const u of g.dispatcher.units.slice()) g.dispatcher.retire(u);
  g.stepHeadless(1);
  const out = { tried: 0, off: 0, stopped: 0, at: [] };
  const edges = G.edges.filter((e) => e.elevated && e.length > 60 && (!only || e.kind === only));
  T.preset = true;
  T.clear();
  const real = T._sirenNear;
  T._sirenNear = () => true;
  for (const e of edges) {
    for (const f of e.kind === 'ramp' ? [0.3, 0.45, 0.6, 0.75] : [0.5]) {
      for (const dir of [1, -1]) {
        const s = e.length * f, p = G.pointAt(e, s), tx = p.tx * dir, tz = p.tz * dir, lane = Math.min(3, e.width * 0.25);
        const x = p.x - -tz * -lane * 1, z = p.z - tx * lane * 1;
        const y = G.levelOn(e, p.x, p.z);
        const v = g.createVehicle('hatchback', 'hatchback', { x, y: y + 0.95, z }, Math.atan2(tx, tz), { spawn: true });
        if (!v) continue;
        if (!T.adopt(v, `pull${out.tried}`, null)) { g.removeVehicle(v); continue; }
        v.setVelocity({ x: tx * 11, y: 0, z: tz * 11 });
        // The player near, or it is put to glide.
        g.player.teleport({ x: p.x - tx * 45, y: y + 1, z: p.z - tz * 45 }, Math.atan2(tx, tz));
        g.player.setVelocity({ x: 0, y: 0, z: 0 });
        out.tried++;
        for (let i = 0; i < 480; i++) g.stepHeadless(1 / 60, { throttle: 0, brake: 0, steer: 0, handbrake: 1 });
        const q = v.position;
        let near = Infinity, half = 0, lv = 0;
        for (const o of G.edges) {
          if (!o.elevated) continue;
          for (const sg of o.segs) {
            const dx = sg.b.x - sg.a.x, dz = sg.b.z - sg.a.z, l2 = dx * dx + dz * dz;
            let u = l2 ? ((q.x - sg.a.x) * dx + (q.z - sg.a.z) * dz) / l2 : 0; u = Math.max(0, Math.min(1, u));
            const d = Math.hypot(sg.a.x + dx * u - q.x, sg.a.z + dz * u - q.z) - o.width * 0.5;
            if (d < near) { near = d; half = o.width * 0.5; lv = G.levelOn(o, q.x, q.z); }
          }
        }
        void half;
        if (v.removed || near > 0.3 || q.y < lv - 1.5) { out.off++; if (out.at.length < 8) out.at.push([e.kind, e.id, f, dir, Math.round(q.x), +q.y.toFixed(1), Math.round(q.z), +near.toFixed(1), +(G.levelOn(e, p.x, p.z) - g.sim.terrainAt(p.x, p.z)).toFixed(1)]); }
        if (v.speed < 0.6) out.stopped++;
        T.clear();
      }
    }
  }
  T._sirenNear = real;
  return out;
}
