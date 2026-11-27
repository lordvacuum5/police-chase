// Stingers from in front: a unit behind comes past and drops one far enough ahead to react to. "Try and make it so like one police car
// quite often will try and get in front of me and then release the spike strip ... a little bit far in front of me."
//   const m = await import('/tests/stingerrun.js');  await m.stingerRun({ secs: 120 })      // window.__sr
// The player's car carried along the roads at `kmh`, never turning back, at `star` stars; every stinger thrown: how far ahead of
// the player it lies, and whether it came from a run (a car that came past) or a unit already ahead.
export async function stingerRun(opts = {}) {
  for (let i = 0; i < 600 && !(window.__game && window.__game.player); i++) await new Promise((r) => setTimeout(r, 100));
  const g = window.__game, G = g.graph, p = g.player;
  p.body.setEnabled(true);
  g.paused = true;
  g.onBusted = () => { g.outcome = null; g.heat.bustTimer = 0; };
  g.heat._checkBust = () => {};
  g.heat.bump(1, 'a probe');
  const out = window.__sr = { runs: 0, thrown: [], fromRun: 0 };
  const d = g.dispatcher, rb = g.roadblocks;
  const origThrow = rb.throwStinger.bind(rb);
  rb.throwStinger = (v) => {
    const ok = origThrow(v);
    if (ok) {
      const b = rb.blocks[rb.blocks.length - 1];
      const dx = b.x - p.position.x, dz = b.z - p.position.z;
      out.thrown.push({ ahead: Math.round(dx * p.forward.x + dz * p.forward.z), run: !!(d.stingerRun && d.stingerRun.u.vehicle === v) });
    }
    return ok;
  };
  let lastRun = null;
  // A route: from the longest edge on, at each junction the way that turns least.
  let e = G.edges.filter((x) => !x.dead && !x.cut && x.kind !== 'ramp').sort((a, b) => b.length - a.length)[0], along = 0, dir = 1;
  const speed = (opts.kmh || 100) / 3.6;
  for (let t = 0; t < (opts.secs || 120) * 60; t++) {
    g.heat.value = (opts.star || 4) + 0.05;
    along += speed / 60 * dir;
    if (along > e.length || along < 0) {
      const n = G.nodes[dir > 0 ? e.b : e.a];
      const end = G.pointAt(e, dir > 0 ? e.length : 0), back = G.pointAt(e, dir > 0 ? e.length - 3 : 3);
      const hx = end.x - back.x, hz = end.z - back.z;
      let best = null, bd = -2;
      for (const id of n.edges) {
        const o = G.edges[id];
        if (o === e || o.cut || o.dead) continue;
        const od = o.a === n.id ? 1 : -1, s0 = G.pointAt(o, od > 0 ? 0 : o.length), s1 = G.pointAt(o, od > 0 ? Math.min(o.length, 3) : Math.max(0, o.length - 3));
        const dot = ((s1.x - s0.x) * hx + (s1.z - s0.z) * hz) / (Math.hypot(s1.x - s0.x, s1.z - s0.z) * Math.hypot(hx, hz) || 1);
        if (dot > bd) { bd = dot; best = { o, od }; }
      }
      if (!best) { dir = -dir; along = Math.max(0, Math.min(e.length, along)); }
      else { e = best.o; dir = best.od; along = dir > 0 ? 0 : e.length; }
    }
    const q = G.pointAt(e, along), q2 = G.pointAt(e, Math.max(0, Math.min(e.length, along + dir * 2)));
    let hx = q2.x - q.x, hz = q2.z - q.z;
    const hl = Math.hypot(hx, hz) || 1; hx /= hl; hz /= hl;
    const y = e.deck ? G.levelOn(e, q.x, q.z) : g.sim.heightAt(q.x, q.z);
    p.body.setTranslation({ x: q.x, y: y + 0.55, z: q.z }, true);
    const h = Math.atan2(hx, hz) / 2;
    p.body.setRotation({ x: 0, y: Math.sin(h), z: 0, w: Math.cos(h) }, true);
    p._readState();
    p.setVelocity({ x: hx * speed, y: 0, z: hz * speed });
    p._readState();
    g.stepHeadless(1 / 60, { throttle: 0, brake: 0, steer: 0, handbrake: 0 });
    if (d.stingerRun && d.stingerRun !== lastRun) { out.runs++; lastRun = d.stingerRun; }
    if (t % 120 === 0) await new Promise((r) => setTimeout(r));
  }
  out.fromRun = out.thrown.filter((x) => x.run).length;
  out.done = true;
  return out;
}
