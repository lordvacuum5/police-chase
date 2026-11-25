// What does drawing a frame cost, and what of it is what? "It is still laggy ... on my laptop".
//   const m = await import('/tests/drawcost.js');  await m.drawCost()     // window.__dc
// At 1280x720 from places on Ashfield (downtown street, suburb, motorway over the city, 120 m up), traffic about: the
// graphics chip's own clock (EXT_disjoint_timer_query_webgl2), ms a frame, median, and the render call's on the main thread;
// triangles and calls. Then with each thing taken out or changed, the saving in both.
const breathe = (ms = 0) => new Promise((r) => setTimeout(r, ms));

async function time(g, n) {
  const R = g.renderer, gl = R.getContext(), ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  const qs = [], cpu = [];
  for (let i = 0; i < n; i++) {
    const q = ext && gl.createQuery();
    if (ext) gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
    const t0 = performance.now();
    R.render(g.scene, g.camera);
    cpu.push(performance.now() - t0);
    if (ext) { gl.endQuery(ext.TIME_ELAPSED_EXT); qs.push(q); }
    gl.flush();
    if (i % 3 === 2) await breathe();
  }
  const res = [];
  for (const q of qs) {
    for (let k = 0; k < 300 && !gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE); k++) await breathe(4);
    if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) res.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);
    gl.deleteQuery(q);
  }
  const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? +s[Math.floor(s.length / 2)].toFixed(2) : null; };
  return { gpu: med(res), cpu: med(cpu), tris: Math.round(R.info.render.triangles / 1000), calls: R.info.render.calls };
}

export function places() {
  const g = window.__game, G = g.graph, at = (x, z) => g.sim.terrainAt(x, z);
  const st = G.edges.filter((e) => e.kind === 'street' && !e.elevated && !e.bridge && e.length > 100);
  const near = (x, z) => st.map((e) => ({ e, p: G.pointAt(e, e.length / 2) })).sort((a, b) => Math.hypot(a.p.x - x, a.p.z - z) - Math.hypot(b.p.x - x, b.p.z - z))[0].p;
  const d = near(-100, 100), s = near(650, 500), m = G.edges.filter((e) => e.kind === 'motorway' && e.elevated && e.length > 60)[6], q = G.pointAt(m, 20), y = G.levelOn(m, q.x, q.z);
  return {
    downtown: [d.x, at(d.x, d.z) + 3, d.z, d.tx, d.tz],
    suburb: [s.x, at(s.x, s.z) + 3, s.z, s.tx, s.tz],
    motorway: [q.x, y + 3, q.z, q.tx, q.tz],
    heli: [-250, 120, -600, 0.5, 0.86],
  };
}

export async function drawCost(opts = {}) {
  const g = window.__game, R = g.renderer;
  g.paused = true;
  const realLoop = g._loop;
  R.setPixelRatio(1);
  R.setSize(opts.w || 1280, opts.h || 720, false);
  g.camera.aspect = (opts.w || 1280) / (opts.h || 720);
  g.camera.updateProjectionMatrix();
  const out = window.__dc = {};
  const P = places();
  for (const [name, v] of Object.entries(P)) {
    if (opts.only && !opts.only.includes(name)) continue;
    const set = () => {
      const c = g.camera;
      c.position.set(v[0], v[1], v[2]);
      c.lookAt(v[0] + v[3] * 40, v[1] - (name === 'heli' ? 12 : 1), v[2] + v[4] * 40);
      c.updateMatrixWorld(true);
      g.player.teleport({ x: v[0] + v[3] * 8, y: v[1] - 2, z: v[2] + v[4] * 8 }, Math.atan2(v[3], v[4]));
      g._fogTick = 14; g._fogCull();
      const q = R.render; R.render = () => {}; g._render(0.016); R.render = q;
      c.position.set(v[0], v[1], v[2]); c.lookAt(v[0] + v[3] * 40, v[1] - (name === 'heli' ? 12 : 1), v[2] + v[4] * 40); c.updateMatrixWorld(true);
    };
    g.traffic.preset = false;
    for (let k = 0; k < 40; k++) { set(); g.stepHeadless(0.3, { throttle: 0, brake: 1, steer: 0, handbrake: 1 }); if (k % 6 === 0) await breathe(); }
    set();
    const row = out[name] = { base: await time(g, 12) };
    row.base = await time(g, opts.n || 30);
    // With and without in turn, a frame each: the chip's clock speed wanders, and one block after another read minus 3 ms.
    const trial = async (key, on, off) => {
      const A = [], B = [], cA = [], cB = [];
      const gl = R.getContext(), ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
      let ti = null;
      for (let i = 0; i < (opts.n || 22); i++) {
        for (const w of [0, 1]) {
          if (w) on(); else off();
          const q = gl.createQuery();
          gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
          const t0 = performance.now();
          R.render(g.scene, g.camera);
          const t = performance.now() - t0;
          gl.endQuery(ext.TIME_ELAPSED_EXT);
          gl.flush();
          if (w) ti = [R.info.render.triangles, R.info.render.calls];
          (w ? B : A).push(q); (w ? cB : cA).push(t);
        }
        if (i % 2 === 1) await breathe();
      }
      off();
      const read = async (qs) => { const r = []; for (const q of qs) { for (let k = 0; k < 300 && !gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE); k++) await breathe(3); r.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6); gl.deleteQuery(q); } return r; };
      const a = await read(A), b = await read(B), med = (x) => x.slice().sort((u, v) => u - v)[Math.floor(x.length / 2)];
      const dif = (x, y) => med(x.map((v, k) => v - y[k]));
      row[key] = [+dif(a, b).toFixed(2), +dif(cA, cB).toFixed(2), row.base.tris - Math.round(ti[0] / 1000), row.base.calls - ti[1], +med(a).toFixed(1), +med(cA).toFixed(1)];
    };
    const names = {};
    for (const o of g.scene.children) { const k = o.name || o.type; (names[k] = names[k] || []).push(o); }
    for (const [k, list] of Object.entries(names)) {
      const vis = list.map((o) => o.visible);
      if (!vis.some((x) => x) || list.every((o) => o.isLight || /Object3D|Light/.test(o.type) && !o.children.length)) continue;
      let t = 0;
      list.forEach((o) => o.traverse((m) => { if (m.isMesh && m.geometry) t += (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position ? m.geometry.attributes.position.count : 0) / 3 * (m.isInstancedMesh ? m.count : 1); }));
      if (t < (opts.least || 6000)) continue;
      await trial(k, () => list.forEach((o) => { o.visible = false; }), () => list.forEach((o, i) => { o.visible = vis[i]; }));
    }
    const sh = R.shadowMap.enabled;
    await trial('*shadow pass', () => { R.shadowMap.autoUpdate = false; R.shadowMap.needsUpdate = false; }, () => { R.shadowMap.autoUpdate = true; });
    await trial('*shadows off', () => { g.sun.castShadow = false; }, () => { g.sun.castShadow = true; });
    const far = g.scene.fog.far;
    await trial('*fog 560', () => { g.scene.fog.far = 560; g.camera.far = 600; g.camera.updateProjectionMatrix(); g._fogTick = 14; g._fogCull(); }, () => { g.scene.fog.far = far; g.camera.far = 1400; g.camera.updateProjectionMatrix(); g._fogTick = 14; g._fogCull(); });
    await trial('*0.75 resolution', () => { R.setPixelRatio(0.75); }, () => { R.setPixelRatio(1); });
    await trial('*all flat', () => { g.scene.overrideMaterial = window.__flatM = window.__flatM || new (g.scene.fog.constructor === Object ? Object : g.wheelMesh.material.constructor)({ color: 0x888888 }); }, () => { g.scene.overrideMaterial = null; });
    void sh; void realLoop;
    row.sorted = Object.entries(row).filter(([k, x]) => Array.isArray(x)).sort((a, b) => b[1][0] - a[1][0]).slice(0, 14);
  }
  out.done = true;
  return out;
}
