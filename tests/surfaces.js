// Is the carriageway actually on top, and is the network actually connected?
//
// Two things that "looks fine to me" is not good enough for.
//
// 1. Raising the footway means any pavement geometry that overlaps a road now
//    hides it. Eyeballing a few screenshots does not prove that has stopped
//    happening, so this fires rays straight down onto thousands of points on
//    the carriageway and asks which surface is nearest the sky.
//
// 2. Routing can only turn from one road onto another where the graph says
//    they meet. Two edges can cross on screen and share no node, in which case
//    the police will drive over a junction that does not exist as far as they
//    are concerned -- and will never turn onto it.
window.__runSurfaces = async function () {
  try {
    for (let i = 0; i < 300 && !(window.__game && window.__game.player); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const g = window.__game, gr = g.graph;
    if (!g.player) { window.__res = 'NO PLAYER'; return; }
    const THREE = window.__modules.THREE;
    const rows = [];

    // ------------------------------------ 1. what is on top of the tarmac
    const road = g.scene.getObjectByName('roads');
    const surfaces = [];
    for (const nm of ['roads', 'pavements', 'plates', 'ground']) {
      const m = g.scene.getObjectByName(nm);
      if (m) surfaces.push(m);
    }
    const ray = new THREE.Raycaster();
    ray.far = 200;
    const down = new THREE.Vector3(0, -1, 0);
    const from = new THREE.Vector3();

    const drivable = gr.edges.filter((e) => !e.dead && !e.turningHead);
    const tally = {};
    let samples = 0, covered = 0;
    for (let i = 0; i < 4000; i++) {
      const e = drivable[(i * 7919) % drivable.length];
      const along = ((i * 0.6180339887) % 1) * e.length;
      const p = gr.pointAt(e, along);
      // Somewhere across the carriageway, but not right on the kerb line.
      const off = (((i * 0.4142) % 1) * 2 - 1) * (e.width * 0.5 - 1.2);
      const x = p.x - p.tz * off, z = p.z + p.tx * off;
      from.set(x, 60, z);
      ray.set(from, down);
      const hits = ray.intersectObjects(surfaces, false);
      if (!hits.length) continue;
      samples++;
      const top = hits[0].object.name;
      tally[top] = (tally[top] || 0) + 1;
      if (top !== 'roads') covered++;
    }
    rows.push(['points sampled on tarmac', String(samples)]);
    rows.push(['topmost surface', Object.entries(tally)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${(100 * v / samples).toFixed(1)}%`).join(', ')]);
    rows.push(['carriageway covered over', `${(100 * covered / samples).toFixed(2)}%`]);
    void road;

    // ----------------------------- 2. crossings the graph does not know about
    //
    // Every pair of edges whose segments intersect. If they share a node the
    // graph knows they meet; if they do not, routing can never turn between
    // them even though a car plainly could.
    const segs = [];
    for (const e of gr.edges) {
      if (e.dead) continue;
      for (const s of e.segs) segs.push({ e, s });
    }
    const cross = (p, q) => {
      const d1x = p.b.x - p.a.x, d1z = p.b.z - p.a.z;
      const d2x = q.b.x - q.a.x, d2z = q.b.z - q.a.z;
      const den = d1x * d2z - d1z * d2x;
      if (Math.abs(den) < 1e-9) return null;
      const rx = q.a.x - p.a.x, rz = q.a.z - p.a.z;
      const t = (rx * d2z - rz * d2x) / den;
      const u = (rx * d1z - rz * d1x) / den;
      if (t <= 0.001 || t >= 0.999 || u <= 0.001 || u >= 0.999) return null;
      return { x: p.a.x + d1x * t, z: p.a.z + d1z * t };
    };

    // Spatial buckets so this is not forty thousand squared.
    const CELL = 60;
    const buckets = new Map();
    segs.forEach((it, i) => {
      const k = `${Math.floor(Math.min(it.s.a.x, it.s.b.x) / CELL)},`
        + `${Math.floor(Math.min(it.s.a.z, it.s.b.z) / CELL)}`;
      let b = buckets.get(k);
      if (!b) { b = []; buckets.set(k, b); }
      b.push(i);
      void it;
    });

    const seen = new Set();
    const orphans = [];
    for (let i = 0; i < segs.length; i++) {
      const A = segs[i];
      const cx = Math.floor(Math.min(A.s.a.x, A.s.b.x) / CELL);
      const cz = Math.floor(Math.min(A.s.a.z, A.s.b.z) / CELL);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          const b = buckets.get(`${cx + dx},${cz + dz}`);
          if (!b) continue;
          for (const jj of b) {
            if (jj <= i) continue;
            const B = segs[jj];
            if (A.e === B.e) continue;
            // Sharing a node means the graph already knows.
            if (A.e.a === B.e.a || A.e.a === B.e.b
              || A.e.b === B.e.a || A.e.b === B.e.b) continue;
            const hit = cross(A.s, B.s);
            if (!hit) continue;
            const key = `${Math.min(A.e.id, B.e.id)}-${Math.max(A.e.id, B.e.id)}`;
            if (seen.has(key)) continue;
            seen.add(key);
            orphans.push({ a: A.e, b: B.e, x: hit.x, z: hit.z });
          }
        }
      }
    }
    rows.push(['', '']);
    rows.push(['crossings with no junction', String(orphans.length)]);
    const byKind = {};
    for (const o of orphans) {
      const k = [o.a.kind, o.b.kind].sort().join(' x ');
      byKind[k] = (byKind[k] || 0) + 1;
    }
    for (const [k, v] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) {
      rows.push([`  ${k}`, String(v)]);
    }

    // -------------------------- 3. can the AI route onto the motorway at all?
    const mot = gr.edges.filter((e) => e.kind === 'motorway' && !e.dead);
    const motNodes = new Set();
    for (const e of mot) { motNodes.add(e.a); motNodes.add(e.b); }
    let ways = 0;
    for (const id of motNodes) {
      for (const eid of gr.nodes[id].edges) {
        if (gr.edges[eid] && gr.edges[eid].kind !== 'motorway') { ways++; break; }
      }
    }
    rows.push(['', '']);
    rows.push(['motorway nodes', String(motNodes.size)]);
    rows.push(['of those, joined to a non-motorway', String(ways)]);

    // And does routing actually use it? Route across the map and see.
    let usedMotorway = 0, tried = 0;
    for (let i = 0; i < 40; i++) {
      const a = gr.randomNode(g.rng), b = gr.randomNode(g.rng);
      const path = gr.route(a.id, b.id);
      if (!path || path.length < 2) continue;
      tried++;
      for (let k = 0; k < path.length - 1; k++) {
        const e = gr.edgeBetween(path[k], path[k + 1]);
        if (e && e.kind === 'motorway') { usedMotorway++; break; }
      }
    }
    rows.push(['routes using the motorway', `${usedMotorway} of ${tried}`]);

    window.__res = rows.map((r) => `${r[0].padEnd(34)} ${r[1]}`).join('\n');
  } catch (e) {
    window.__res = 'EX ' + e.message + '\n' + String(e.stack).slice(0, 500);
  }
};
