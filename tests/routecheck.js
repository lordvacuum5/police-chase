// Is every route the police are handed a sensible one?
//
// "Look for any more bugs ... and imperfections in the routing system." The
// road checks (tests/data/_check.js) ask about the network; this asks about
// the paths cut from it. From hundreds of places on the roads, pointing either
// way, it asks RoadGraph.pathFromPosition for a route to a random junction --
// exactly as Officer._routeTo does, corner cutting and all -- and counts the
// paths that are wrong in a way a player would see:
//
//   none      no path at all to a junction the network says is reachable
//   far       no point of the path within 25 m of the car (the path starts
//             LEAD_BACK behind it on purpose, so this is the nearest point)
//   jump      two consecutive points more than 25 m apart (a teleport)
//   hairpin   the path doubles back on itself mid-route (a U-turn > 150 deg)
//   short     the path stops more than 8 m short of the junction it was for
//   offroad   a point more than half a road width plus 6 m off every road
//   detour    the path is over 1.5x the graph's own shortest route (plus 80 m)
//
// window.__runRouteCheck(samples) -> window.__res. Same seed every time.

window.__runRouteCheck = function (samples = 600, corner = 30) {
  const g = window.__game, gr = g.graph;
  let seed = 4242;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const edges = gr.edges.filter((e) => !e.cut && e.length > 12);
  const nodes = gr.nodes.filter((n) => n.edges.length);
  const count = { none: 0, far: 0, jump: 0, hairpin: 0, short: 0, offroad: 0, detour: 0 };
  const eg = {};
  const note = (k, s) => { count[k]++; if (!eg[k]) eg[k] = []; if (eg[k].length < 4) eg[k].push(s); };
  const len = (pts) => { let L = 0; for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z); return L; };
  for (let k = 0; k < samples; k++) {
    const e = edges[Math.floor(rnd() * edges.length)];
    const s = 6 + rnd() * (e.length - 12);
    const p = gr.pointAt(e, s);
    const d = gr.edgeDirection(e, s, { x: 0, z: 1 });
    const back = rnd() < 0.5 ? -1 : 1;
    const goal = nodes[Math.floor(rnd() * nodes.length)];
    if (Math.hypot(goal.x - p.x, goal.z - p.z) < 40) continue;
    const at = `${p.x.toFixed(0)},${p.z.toFixed(0)} ${e.kind} ${back > 0 ? 'fwd' : 'rev'}(e${e.id}) -> n${goal.id}`;
    const pts = gr.pathFromPosition(p.x, p.z, d.x * back, d.z * back, goal.id, 0, Infinity, 15, corner, { cuts: false });
    if (!pts || pts.length < 2) { note('none', at); continue; }
    let near = Infinity, ci = 0;
    for (let i = 0; i < pts.length; i++) {
      const dd = Math.hypot(pts[i].x - p.x, pts[i].z - p.z);
      if (dd < near) { near = dd; ci = i; }
    }
    if (near > 25) note('far', `${at} nearest point ${near.toFixed(0)} m off`);
    let jumped = false, hair = false, off = false;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const sl = Math.hypot(b.x - a.x, b.z - a.z);
      if (sl > 25 && !jumped) { jumped = true; note('jump', `${at} #${i} ${sl.toFixed(0)} m`); }
      if (i >= 2 && !hair && i < pts.length - 1) {
        const c = pts[i - 2];
        const ux = a.x - c.x, uz = a.z - c.z, vx = b.x - a.x, vz = b.z - a.z;
        const lu = Math.hypot(ux, uz), lv = Math.hypot(vx, vz);
        if (lu > 1.5 && lv > 1.5 && (ux * vx + uz * vz) / (lu * lv) < Math.cos(150 / 57.3)) {
          hair = true; note('hairpin', `${at} at ${a.x.toFixed(0)},${a.z.toFixed(0)} #${i}/${pts.length} car at #${ci}`);
        }
      }
      if (!off) {
        const n = gr.nearestEdge(b.x, b.z, 80);
        if (!n || n.dist > n.edge.width * 0.5 + 6) { off = true; note('offroad', `${at} at ${b.x.toFixed(0)},${b.z.toFixed(0)} ${n ? n.dist.toFixed(0) : '?'} m`); }
      }
    }
    const end = pts[pts.length - 1];
    const gap = Math.hypot(end.x - goal.x, end.z - goal.z);
    if (gap > 8) note('short', `${at} ends ${gap.toFixed(0)} m away`);
    const r = gr.route(gr.nearestNode(p.x, p.z).id, goal.id);
    if (r && r.length > 1) {
      const ref = len(gr.pathToPoints(r, 0, false));
      const L = len(pts);
      if (L > ref * 1.5 + 80) note('detour', `${at} ${L.toFixed(0)} m vs ${ref.toFixed(0)}`);
    }
  }
  const lines = [`${g.mapDef.id}: ${samples} routes  ` + Object.entries(count).map(([k, v]) => `${k} ${v}`).join('  ')];
  for (const [k, list] of Object.entries(eg)) for (const s of list) lines.push(`  ${k}: ${s}`);
  window.__res = lines.join('\n');
  return window.__res;
};
