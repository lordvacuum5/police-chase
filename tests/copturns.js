// How the police drive in a chase: stopping, reversing, and turning round when there was no need to. "Can you try and make the police
// cars a little bit better at like turning and kind of not getting stuck, and just generally ... making good decisions without
// turning around and stuff."
//   const m = await import('/tests/copturns.js');  await m.copTurns({ secs: 180 })      // window.__ct
// Your car driven by the game's own driver down long random routes (as tests/citychase.js), three stars. Every quarter second, each
// chasing unit more than 25 m from you (a roadblock or a hold excepted):
//   stopped    under 1 m/s
//   reversing  going backwards faster than 0.5 m/s
//   uturns     its heading swung over 150 degrees within 4 s, moving, while yours did not
//   stuckEpisodes  times a unit stood stopped 8 s or more on end (one stuck unit swamps the shares above), with where
// As shares of unit-samples, and U-turns a unit-minute; with the modes they were in.
export async function copTurns(opts = {}) {
  for (let i = 0; i < 600 && !(window.__game && window.__game.player); i++) await new Promise((r) => setTimeout(r, 100));
  const g = window.__game, p = g.player, gr = g.graph;
  const { Driver, SKILL } = window.__modules;
  p.body.setEnabled(true);
  g.paused = true;
  g.onBusted = () => { g.outcome = null; g.heat.bustTimer = 0; };
  g.onEscaped = () => { g.outcome = null; };
  if (g.heat._checkBust) g.heat._checkBust = () => {};
  g.heat.bump(1, 'a probe');
  let seed = opts.seed || 777;
  const rng = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return ((seed >>> 0) % 1e6) / 1e6; };
  let drv = null;
  const newRoute = () => {
    for (let k = 0; k < 30; k++) {
      const a = gr.nearestNode(p.position.x, p.position.z, p.position.y), b = gr.randomNode(rng);
      const path = a && b && gr.route(a.id, b.id);
      if (path && path.length > 4) { drv = new Driver(p, SKILL.pursuit); drv.setPath(gr.pathToPoints(path, 2.5, true)); return; }
    }
  };
  newRoute();
  const out = window.__ct = { map: g.mapDef.id, samples: 0, stopped: 0, reversing: 0, uturns: 0, unitMinutes: 0, stopModes: {}, revModes: {}, turnModes: {}, stuckEpisodes: 0, stuckAt: [] };
  const heads = new Map(), stuck = new Map();
  let pHeads = [];
  const DT = 1 / 60;
  for (let t = 0; t < (opts.secs || 180) * 60; t++) {
    g.heat.value = (opts.star || 3) + 0.05;
    if (!drv || drv.remaining(30) < 15) newRoute();
    p.setControls(drv.followPath(DT, 40));
    g.stepHeadless(DT);
    if (t % 15) continue;
    const now = t * DT, ph = Math.atan2(p.forward.x, p.forward.z);
    pHeads.push([now, ph]);
    while (pHeads.length && pHeads[0][0] < now - 4) pHeads.shift();
    const swung = (list) => { let mx = 0; for (const [, h] of list) { const d = Math.abs(Math.atan2(Math.sin(h - list[list.length - 1][1]), Math.cos(h - list[list.length - 1][1]))); mx = Math.max(mx, d); } return mx; };
    const youTurned = swung(pHeads) > 2.0;
    for (const u of g.dispatcher.units) {
      const v = u.vehicle;
      if (u.human || v.disabled || u.role === 'hold' || u.role === 'patrol' || u.role === 'block') continue;
      if (Math.hypot(v.position.x - p.position.x, v.position.z - p.position.z) < 25) continue;
      out.samples++;
      const mode = u._mode || u.role;
      if (v.speed < 1) { out.stopped++; out.stopModes[mode] = (out.stopModes[mode] || 0) + 1; }
      // Stuck: stopped this long without a break, once an episode.
      const st = stuck.get(u) || { since: null, counted: false };
      stuck.set(u, st);
      if (v.speed < 1) {
        if (st.since === null) { st.since = now; st.counted = false; }
        if (!st.counted && now - st.since >= 8) { st.counted = true; out.stuckEpisodes++; out.stuckAt.push([Math.round(v.position.x), Math.round(v.position.z), mode]); }
      } else st.since = null;
      if (v.forwardSpeed < -0.5) { out.reversing++; out.revModes[mode] = (out.revModes[mode] || 0) + 1; }
      let h = heads.get(u);
      if (!h) heads.set(u, (h = { list: [], cool: 0 }));
      h.list.push([now, Math.atan2(v.forward.x, v.forward.z)]);
      while (h.list.length && h.list[0][0] < now - 4) h.list.shift();
      if (h.cool > now) continue;
      if (v.speed > 3 && !youTurned && swung(h.list) > 2.6) { out.uturns++; out.turnModes[mode] = (out.turnModes[mode] || 0) + 1; h.cool = now + 6; }
    }
    out.unitMinutes = +(out.samples * 0.25 / 60).toFixed(1);
    if (t % 600 === 0) await new Promise((r) => setTimeout(r));
  }
  out.stoppedShare = +(out.stopped / (out.samples || 1)).toFixed(3);
  out.reversingShare = +(out.reversing / (out.samples || 1)).toFixed(3);
  out.uturnsPerUnitMin = +(out.uturns / (out.unitMinutes || 1)).toFixed(2);
  out.done = true;
  return out;
}
