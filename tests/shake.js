// How much does the ground shake a car driving along the roads? "Just driving around, the car feels a little bit like juddery, very
// slightly." The game's own driver takes the player's car down long routes at about `kmh`; each step, the car's up-and-down
// acceleration (from its vertical speed). rms, and the share of steps over 3 m/s2, by the kind of road under it.
//   const m = await import('/tests/shake.js');  await m.shake({ secs: 60 })      // window.__sk
const breathe = () => new Promise((r) => setTimeout(r));

export async function shake(opts = {}) {
  for (let i = 0; i < 600 && !(window.__game && window.__game.player && window.__modules); i++) await new Promise((r) => setTimeout(r, 100));
  const g = window.__game, p = g.player, gr = g.graph, { Driver, SKILL } = window.__modules;
  g.paused = true;
  g.onBusted = () => { g.outcome = null; };
  for (const u of g.dispatcher.units.slice()) g.dispatcher.retire(u);
  g.dispatcher.update = () => {};
  let seed = opts.seed || 11;
  const rng = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return ((seed >>> 0) % 1e6) / 1e6; };
  let drv = null;
  const route = () => {
    for (let k = 0; k < 40; k++) {
      const a = gr.nearestNode(p.position.x, p.position.z, p.position.y), b = gr.randomNode(rng, opts.road || 'street'), path = a && b && gr.route(a.id, b.id);
      if (path && path.length > 5) { drv = new Driver(p, SKILL.regular); drv.setPath(gr.pathToPoints(path, 2.5, true)); return; }
    }
  };
  const by = {};
  let vy0 = p.linvel.y;
  for (let t = 0; t < (opts.secs || 60) * 60; t++) {
    if (!drv || drv.remaining(20) < 20) route();
    const c = drv.followPath(1 / 60, (opts.kmh || 60) / 3.6);
    g.stepHeadless(1 / 60, c);
    const a = (p.linvel.y - vy0) * 60;
    vy0 = p.linvel.y;
    if (t < 120 || p.speed < 8) continue;
    const e = gr.nearestEdge(p.position.x, p.position.z, 12), k = e ? e.edge.kind : 'off';
    const r = by[k] || (by[k] = { n: 0, ss: 0, over: 0 });
    r.n++; r.ss += a * a; if (Math.abs(a) > 3) r.over++;
    if (t % 120 === 0) await breathe();
  }
  const out = window.__sk = { map: g.mapDef.id };
  let n = 0, ss = 0, over = 0;
  for (const [k, r] of Object.entries(by)) { out[k] = { rms: +Math.sqrt(r.ss / r.n).toFixed(2), over: +(r.over / r.n).toFixed(3), n: r.n }; n += r.n; ss += r.ss; over += r.over; }
  out.all = { rms: +Math.sqrt(ss / n).toFixed(2), over: +(over / n).toFixed(3), n };
  out.done = true;
  return out;
}
