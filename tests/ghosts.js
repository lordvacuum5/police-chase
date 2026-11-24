// Invisible walls, and things you drive through: what is solid against what is drawn, over the whole map.
//
// "There's invisible walls, or there's like inconsistencies." Every collider and every triangle drawn is marked into a
// 0.5 m grid where it stands in a car's way -- 0.35 to 1.1 m over the ground (`layer` 'ground') or over a raised road's
// deck ('deck') -- and the two grids compared, a metre either way.
//   const m = await import('/tests/ghosts.js');  await m.ghosts()      // and m.ghosts({ layer: 'deck' })
//   invisible   solid with nothing drawn within REACH m: places { x, z, n (cells), what }
//   phantom     drawn with nothing solid, by the mesh's name
const CELL = 0.5, LO = 0.35, HI = 1.1;

/** Drawn, and not meant to stop a car (or the ground itself). */
const SOFT = /^(sky|river|terrain|terrain-edge|roads|markings|kerbs|road-wear|pavements|verges|water|hedge-|grass|deck-markings|deck-edges|air-rescue|skids|shadow|blob|props-|rain|windows|lit|driveways|fields?|clouds?|stars|sun)/i;

export async function ghosts(opts = {}) {
  const g = window.__game, G = g.graph, W = g.world, sim = g.sim, map = W.__map;
  const layer = opts.layer || 'ground', REACH = opts.reach || 1.0;
  const { RAPIER, GROUP } = await import('/src/physics/world.js');
  const THREE = await import('three').catch(() => null) || window.THREE;
  g.stepHeadless(1 / 30, { throttle: 0, brake: 1, steer: 0, handbrake: 1 });
  const half = (g.mapDef && g.mapDef.half) || 1000, N = Math.round(half * 2 / CELL);
  const solid = new Uint8Array(N * N), drawn = new Uint8Array(N * N);
  const why = new Map();             // cell -> what is solid there (group)
  const nameOf = new Map();
  const names = [];
  const inA = (x, z) => !opts.at || Math.hypot(x - opts.at.x, z - opts.at.z) < opts.at.r;

  // The height the car's road is at, on this layer; NaN where there is none.
  const base = new Float32Array(N * N).fill(NaN);
  if (layer === 'deck') {
    for (const e of G.edges) {
      if (!e.elevated) continue;
      for (let s = 0; s <= e.length; s += 0.4) {
        const p = G.pointAt(e, s), y = G.levelOn(e, p.x, p.z), h = e.width * 0.5 + 1.5;
        for (let o = -h; o <= h; o += 0.4) {
          const x = p.x - p.tz * o, z = p.z + p.tx * o, i = Math.floor((x + half) / CELL), j = Math.floor((z + half) / CELL);
          if (i >= 0 && j >= 0 && i < N && j < N) base[j * N + i] = y;
        }
      }
    }
  }
  const at = (x, z) => {
    if (layer !== 'deck') return sim.terrainAt ? sim.terrainAt(x, z) : 0;
    const i = Math.floor((x + half) / CELL), j = Math.floor((z + half) / CELL);
    return i >= 0 && j >= 0 && i < N && j < N ? base[j * N + i] : NaN;
  };

  const mark = (grid, x, y, z, tag) => {
    const i = Math.floor((x + half) / CELL), j = Math.floor((z + half) / CELL);
    if (i < 0 || j < 0 || i >= N || j >= N) return;
    const k = j * N + i;
    if (grid[k] && !tag) return;
    const b = at(x, z);
    if (!(y >= b + LO && y <= b + HI)) return;
    grid[k] = 1;
    if (tag !== undefined) (grid === solid ? why : nameOf).set(k, tag);
  };
  // A triangle, cut to the slab it could matter in, and marked every quarter metre.
  const poly = [], poly2 = [];
  const tri = (grid, A, B, C, tag) => {
    if (!inA(A[0], A[2])) return;
    // Faces that could stop a car: a floor or a roof inside a building is not one (unless it is a road's sheet).
    const e1 = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], e2 = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
    const nx = e1[1] * e2[2] - e1[2] * e2[1], ny = e1[2] * e2[0] - e1[0] * e2[2], nz = e1[0] * e2[1] - e1[1] * e2[0];
    if (Math.abs(ny) > 0.97 * Math.hypot(nx, ny, nz)) return;
    const cx = (A[0] + B[0] + C[0]) / 3, cz = (A[2] + B[2] + C[2]) / 3;
    const big = Math.max(Math.abs(A[0] - B[0]), Math.abs(A[0] - C[0]), Math.abs(A[2] - B[2]), Math.abs(A[2] - C[2])) > 60;
    const b = big ? null : at(cx, cz);
    let lo = -1e9, hi = 1e9;
    if (!big) {
      if (Number.isNaN(b)) {
        if ([A, B, C].every((q) => Number.isNaN(at(q[0], q[2])))) return;
      } else { lo = b + LO - 4; hi = b + HI + 4; }
    }
    if (Math.max(A[1], B[1], C[1]) < lo || Math.min(A[1], B[1], C[1]) > hi) return;
    let P = [A, B, C];
    for (const [lim, sg] of [[lo, 1], [hi, -1]]) {
      const Q = [];
      for (let k = 0; k < P.length; k++) {
        const p = P[k], q = P[(k + 1) % P.length], dp = (p[1] - lim) * sg, dq = (q[1] - lim) * sg;
        if (dp >= 0) Q.push(p);
        if ((dp >= 0) !== (dq >= 0)) { const u = dp / (dp - dq); Q.push([p[0] + (q[0] - p[0]) * u, p[1] + (q[1] - p[1]) * u, p[2] + (q[2] - p[2]) * u]); }
      }
      P = Q;
      if (P.length < 3) return;
    }
    for (let k = 1; k < P.length - 1; k++) {
      const p = P[0], q = P[k], r = P[k + 1];
      const l1 = Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]), l2 = Math.hypot(r[0] - p[0], r[1] - p[1], r[2] - p[2]);
      const n = Math.min(400, Math.max(1, Math.ceil(l1 / 0.25))), m = Math.min(400, Math.max(1, Math.ceil(l2 / 0.25)));
      for (let a = 0; a <= n; a++) {
        const u = a / n;
        for (let c = 0; c <= m * (1 - u) + 1e-6; c++) {
          const v = Math.min(1 - u, c / m);
          mark(grid, p[0] + (q[0] - p[0]) * u + (r[0] - p[0]) * v, p[1] + (q[1] - p[1]) * u + (r[1] - p[1]) * v, p[2] + (q[2] - p[2]) * u + (r[2] - p[2]) * v, tag);
        }
      }
    }
  };
  void poly; void poly2;
  const prog = window.__ghp = { step: 'solid', n: 0, of: 0 };
  const breathe = () => new Promise((r) => { const ch = new MessageChannel(); ch.port1.onmessage = () => { ch.port1.close(); r(); }; ch.port2.postMessage(0); });

  // ---- solid
  const BOX = [[0, 1, 3], [0, 3, 2], [4, 6, 7], [4, 7, 5], [0, 4, 5], [0, 5, 1], [2, 3, 7], [2, 7, 6], [0, 2, 6], [0, 6, 4], [1, 5, 7], [1, 7, 3]];
  const kinds = {};
  const list = [];
  W.forEachCollider((c) => list.push(c));
  let nc = 0;
  for (const c of list) {
    if (!c.isEnabled()) continue;
    const gr = c.collisionGroups() >>> 16, body = c.parent();
    if (body && body.bodyType() === 0 && !opts.dynamic) { if ((gr & GROUP.VEHICLE)) continue; }
    if (gr & (GROUP.HILL | GROUP.STREET)) continue;                // street furniture is drawn near the car only
    // What a car meets: the wheels' and the body's.
    if (!((c.collisionGroups() & 0xFFFF) & GROUP.VEHICLE)) continue;
    const dynamic = body && body.bodyType() === 0;
    const t = c.translation(), q = c.rotation();
    if (!inA(t.x, t.z) && c.shape.type !== 6) continue;
    const rot = (x, y, z) => {
      const ix = q.w * x + q.y * z - q.z * y, iy = q.w * y + q.z * x - q.x * z, iz = q.w * z + q.x * y - q.y * x, iw = -q.x * x - q.y * y - q.z * z;
      return [t.x + ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y, t.y + iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z, t.z + iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x];
    };
    const ty = c.shape.type;
    kinds[`${gr}:${ty}`] = (kinds[`${gr}:${ty}`] || 0) + 1;
    const tag = gr + (dynamic ? 100000 : 0);
    if (ty === 1) {
      const h = c.halfExtents();
      if (h.x > 400 || h.z > 400) continue;                        // the plate, the edge
      const V = [];
      for (const x of [-h.x, h.x]) for (const y of [-h.y, h.y]) for (const z of [-h.z, h.z]) V.push(rot(x, y, z));
      for (const f of BOX) tri(solid, V[f[0]], V[f[1]], V[f[2]], tag);
    } else if (ty === 9 || ty === 6) {
      const v = c.vertices(), ix = c.indices();
      if (!v) continue;
      const P = (i) => rot(v[i * 3], v[i * 3 + 1], v[i * 3 + 2]);
      if (ix) for (let k = 0; k < ix.length; k += 3) tri(solid, P(ix[k]), P(ix[k + 1]), P(ix[k + 2]), tag);
      else {
        // A hull without faces: its points' box is near enough.
        const n = v.length / 3;
        for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) tri(solid, P(a), P(b), P((b + 1) % n), tag);
      }
    } else {
      const r = c.shape.radius || 0.3, hh = c.shape.halfHeight || r;
      for (let a = 0; a < 10; a++) {
        const p = (ang, y) => rot(Math.cos(ang) * r, y, Math.sin(ang) * r), a0 = a * Math.PI / 5, a1 = (a + 1) * Math.PI / 5;
        tri(solid, p(a0, -hh), p(a1, -hh), p(a1, hh), tag); tri(solid, p(a0, -hh), p(a1, hh), p(a0, hh), tag);
      }
    }
    prog.of = list.length; prog.n = nc;
    if (++nc % 400 === 0) await breathe();
  }

  // ---- drawn
  const perName = {};
  const meshes = [];
  g.scene.updateMatrixWorld(true);
  const vehicles = new Set(g.vehicles.map((v) => v.view).filter(Boolean));
  (function walk(o, soft) {
    if (vehicles.has(o)) return;
    if (o.isLOD) { if (o.levels.length) walk(o.levels[0].object, soft || SOFT.test(o.name)); return; }
    const s = soft || SOFT.test(o.name || '');
    if ((o.isMesh || o.isInstancedMesh) && o.geometry && o.geometry.attributes.position) meshes.push({ o, soft: s, name: o.name || (o.parent && o.parent.name) || '?' });
    for (const k of o.children) walk(k, s);
  })(g.scene, false);
  let nm = 0;
  for (const { o, soft, name } of meshes) {
    const mat = Array.isArray(o.material) ? o.material[0] : o.material;
    if (!mat || mat.visible === false) continue;
    if (soft) continue;
    prog.step = 'drawn ' + name; prog.n++; prog.of = meshes.length;
    const t0 = performance.now();
    const p = o.geometry.attributes.position, ix = o.geometry.index;
    const n = ix ? ix.count : p.count;
    const inst = o.isInstancedMesh ? o.count : 1;
    let id = names.indexOf(name);
    if (id < 0) { id = names.length; names.push(name); }
    const M = o.matrixWorld.clone(), tmp = o.matrixWorld.clone();
    for (let q = 0; q < inst; q++) {
      if (o.isInstancedMesh) { o.getMatrixAt(q, tmp); tmp.premultiply(M); } else tmp.copy(M);
      const e = tmp.elements;
      const V = (i) => { const x = p.getX(i), y = p.getY(i), z = p.getZ(i); return [e[0] * x + e[4] * y + e[8] * z + e[12], e[1] * x + e[5] * y + e[9] * z + e[13], e[2] * x + e[6] * y + e[10] * z + e[14]]; };
      for (let k = 0; k < n; k += 3) {
        const a = ix ? ix.getX(k) : k, b = ix ? ix.getX(k + 1) : k + 1, c = ix ? ix.getX(k + 2) : k + 2;
        tri(drawn, V(a), V(b), V(c), id);
      }
      perName[name] = (perName[name] || 0) + 1;
      if ((nm += n) > 60000) { nm = 0; await breathe(); }
    }
    (prog.ms = prog.ms || {})[name] = ((prog.ms || {})[name] || 0) + performance.now() - t0 | 0;
  }

  // ---- compared
  const R = Math.ceil(REACH / CELL);
  const near = (grid, i, j) => {
    for (let b = Math.max(0, j - R); b <= Math.min(N - 1, j + R); b++) for (let a = Math.max(0, i - R); a <= Math.min(N - 1, i + R); a++) if (grid[b * N + a]) return true;
    return false;
  };
  const gather = (grid, other, tagOf, phys) => {
    const left = new Map();
    for (let k = 0; k < grid.length; k++) if (grid[k]) { const i = k % N, j = (k - i) / N; if (!near(other, i, j) && !(phys && phys(i, j))) left.set(k, tagOf.get(k)); }
    const places = [];
    const seen = new Set();
    for (const [k0, tag] of left) {
      if (seen.has(k0)) continue;
      const st = [k0]; seen.add(k0);
      const pl = { n: 0, x: 0, z: 0, tag };
      while (st.length) {
        const k = st.pop(), i = k % N, j = (k - i) / N;
        pl.n++; pl.x += i; pl.z += j;
        for (let b = -3; b <= 3; b++) for (let a = -3; a <= 3; a++) { const q = (j + b) * N + i + a; if (left.has(q) && !seen.has(q)) { seen.add(q); st.push(q); } }
      }
      pl.x = Math.round((pl.x / pl.n + 0.5) * CELL - half); pl.z = Math.round((pl.z / pl.n + 0.5) * CELL - half);
      places.push(pl);
    }
    places.sort((a, b) => b.n - a.n);
    return { cells: left.size, places };
  };
  // Inside something solid, by the physics.
  const ball = new RAPIER.Ball(0.5);
  const inside = (i, j) => {
    const x = (i + 0.5) * CELL - half, z = (j + 0.5) * CELL - half;
    let hit = false;
    W.intersectionsWithShape({ x, y: at(x, z) + 0.9, z }, { x: 0, y: 0, z: 0, w: 1 }, ball, (c) => {
      if ((c.collisionGroups() >>> 16) & (GROUP.HILL | GROUP.VEHICLE)) return true;
      hit = true;
      return false;
    });
    return hit;
  };
  const inv = gather(solid, drawn, why), pha = gather(drawn, solid, nameOf, inside);
  const byTag = {}, byName = {};
  for (const p of inv.places) { const b = byTag[p.tag] = byTag[p.tag] || { places: 0, cells: 0 }; b.places++; b.cells += p.n; }
  for (const p of pha.places) { const nme = names[p.tag]; p.name = nme; const b = byName[nme] = byName[nme] || { places: 0, cells: 0 }; b.places++; b.cells += p.n; }
  let sc = 0, dc = 0;
  for (let k = 0; k < solid.length; k++) { sc += solid[k]; dc += drawn[k]; }
  void RAPIER; void THREE; void map;
  return { layer, solidCells: sc, drawnCells: dc, kinds, invisible: { cells: inv.cells, n: inv.places.length, byTag, places: inv.places.slice(0, opts.keep || 60) }, phantom: { cells: pha.cells, n: pha.places.length, byName, places: pha.places.slice(0, opts.keep || 60) }, names: perName };
}
