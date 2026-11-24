// "Some cars are almost floating slightly ... some cars kind of look like they're slightly in the ground ... It really
// shouldn't look like any part of the car is in the ground ever." Every car, as drawn, against the ground as drawn:
//   const m = await import('/tests/ridecheck.js');  await m.rideCheck(60)          // window.__rc
// The player is carried about (ground roads, then the motorway) with traffic and, `police` of them, patrols about, and
// twice a second, for every car within 250 m standing on its wheels: the drawn height under each wheel and under the
// body's corners, from the meshes themselves.
//   wheel   each wheel's lowest point over the drawn ground, m: mean, worst sunk (min), worst floating (max)
//   body    the body's lowest corner over the drawn ground: worst, and the share under 0
//   by      awake / dormant (gliding) / police / parked, each on ground or deck: n, sunk over 4 cm, floating over 6 cm
const DOWN = { x: 0, y: -1, z: 0 };

export async function drawnGround(g) {
  const THREE = await import('/vendor/three.module.js').catch(() => import('three'));
  const names = new Set(['roads', 'pavements', 'terrain', 'terrain-edge', 'decks', 'kerbs', 'bridges', 'carpark', 'verges', 'driveways']);
  const list = [];
  (function walk(o, on) {
    const here = on || names.has(o.name);
    if (o.isLOD) { if (here && o.levels.length) walk(o.levels[0].object, true); return; }
    if (here && o.isMesh && o.geometry && !(o.userData && o.userData.depthOnly)) { if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere(); list.push(o); }
    for (const c of o.children) walk(c, here);
  })(g.scene, false);
  g.scene.updateMatrixWorld(true);
  // Triangles in 10 m cells: raycasting whole meshes is a million triangles a ray.
  const C = 10, cells = new Map(), v = new THREE.Vector3();
  for (const o of list) {
    const p = o.geometry.attributes.position, ix = o.geometry.index, n = ix ? ix.count : p.count, P = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) { v.fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld); P[i * 3] = v.x; P[i * 3 + 1] = v.y; P[i * 3 + 2] = v.z; }
    for (let k = 0; k < n; k += 3) {
      const a = (ix ? ix.getX(k) : k) * 3, b = (ix ? ix.getX(k + 1) : k + 1) * 3, c = (ix ? ix.getX(k + 2) : k + 2) * 3;
      const t = [P[a], P[a + 1], P[a + 2], P[b], P[b + 1], P[b + 2], P[c], P[c + 1], P[c + 2], o.name || (o.parent && o.parent.name)];
      const x0 = Math.floor(Math.min(t[0], t[3], t[6]) / C), x1 = Math.floor(Math.max(t[0], t[3], t[6]) / C), z0 = Math.floor(Math.min(t[2], t[5], t[8]) / C), z1 = Math.floor(Math.max(t[2], t[5], t[8]) / C);
      for (let i = x0; i <= x1; i++) for (let j = z0; j <= z1; j++) { const key = i * 100003 + j; let l = cells.get(key); if (!l) cells.set(key, l = []); l.push(t); }
    }
  }
  /** The highest drawn surface at (x, z) below `from`: [y, name]. */
  return (x, z, from) => {
    const l = cells.get(Math.floor(x / C) * 100003 + Math.floor(z / C));
    let best = -Infinity, name = null;
    if (l) for (const t of l) {
      const d = (t[5] - t[8]) * (t[0] - t[6]) + (t[6] - t[3]) * (t[2] - t[8]);
      if (Math.abs(d) < 1e-9) continue;
      const u = ((t[5] - t[8]) * (x - t[6]) + (t[6] - t[3]) * (z - t[8])) / d, w = ((t[8] - t[2]) * (x - t[6]) + (t[0] - t[6]) * (z - t[8])) / d, q = 1 - u - w;
      if (u < -1e-4 || w < -1e-4 || q < -1e-4) continue;
      const y = u * t[1] + w * t[4] + q * t[7];
      if (y >= from) continue;
      // A pavement's sheet goes on under the road, and kerb and markings lie on it: the road, where there is one.
      const rank = (nm) => (nm === 'decks' ? 3 : nm === 'roads' ? 2 : 1);
      const r = rank(t[9]), was = rank(name);
      const near = best > -1e6 && Math.abs(y - best) < 0.3;
      if (near && name !== null && r !== was ? r > was : y > best) { best = y; name = t[9]; }
    }
    return [best, name];
  };
}

export async function rideCheck(secs = 60, opts = {}) {
  const g = window.__game, G = g.graph, p = g.player;
  const THREE = await import('/vendor/three.module.js').catch(() => import('three'));
  const ground = await drawnGround(g);
  g.onBusted = () => { g.outcome = null; g.heat.bustTimer = 0; };
  g.paused = true;
  const out = window.__rc = { by: {}, at: [], surf: {} };
  const tmp = new THREE.Vector3();
  // Each body's lowest points, in its own frame: the lowest vertex in each of 8 cells of its footprint.
  const bodies = new Map();
  const lows = (v) => {
    const key = v.specKey || v.kind || (v.spec && v.spec.name) || v.view.uuid;
    let l = bodies.get(key);
    if (l) return l;
    v.view.updateMatrixWorld(true);
    const inv = v.view.matrixWorld.clone().invert(), best = new Map();
    v.view.traverse((o) => {
      if (!o.isMesh || !o.geometry || !o.geometry.attributes.position) return;
      const q = o.geometry.attributes.position, m = inv.clone().multiply(o.matrixWorld);
      for (let i = 0; i < q.count; i += 1) {
        tmp.fromBufferAttribute(q, i).applyMatrix4(m);
        const k = `${Math.round(tmp.x / 0.6)},${Math.round(tmp.z / 0.6)}`, b = best.get(k);
        if (!b || tmp.y < b.y) best.set(k, { x: tmp.x, y: tmp.y, z: tmp.z });
      }
    });
    l = [...best.values()].sort((a, b) => a.y - b.y).slice(0, 14);
    bodies.set(key, l);
    return l;
  };
  const tally = (kind, gaps, body, v, surf) => {
    const b = out.by[kind] = out.by[kind] || { n: 0, sum: 0, min: 9, max: -9, sunk: 0, float: 0, bodyMin: 9, bodyIn: 0 };
    const lo = Math.min(...gaps), hi = Math.max(...gaps);
    b.n++; b.sum += gaps.reduce((x, y) => x + y, 0) / gaps.length;
    b.min = Math.min(b.min, lo); b.max = Math.max(b.max, hi);
    const sf = out.surf[surf] = out.surf[surf] || { n: 0, sum: 0, min: 9, max: -9 };
    sf.n++; sf.sum += (lo + hi) / 2; sf.min = Math.min(sf.min, lo); sf.max = Math.max(sf.max, hi);
    if (lo < -0.04) b.sunk++;
    if (hi > 0.06) b.float++;
    b.bodyMin = Math.min(b.bodyMin, body);
    if (body < 0) b.bodyIn++;
    if ((lo < -0.06 || hi > 0.12 || body < -0.02) && out.at.length < 400) out.at.push([kind, v.spec.name || v.kind || '', Math.round(v.view.position.x), +v.view.position.y.toFixed(2), Math.round(v.view.position.z), gaps.map((x) => +x.toFixed(2)), +body.toFixed(2), +v.speed.toFixed(1), surf]);
  };
  const ids = G.edges.filter((e) => !e.dead && !e.cut && e.length > 60 && !e.turningHead);
  let seed = 11;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  let at = null, e = null;
  for (let i = 0; i < secs * 60; i++) {
    if (i % 600 === 0) {
      // Every 10 s somewhere else; every other time up on a raised road.
      const want = (i / 600) % 2 === 1 || opts.raised, set = ids.filter((q) => !!q.elevated === !!want && q.kind !== 'alley');
      e = set[Math.floor(rnd() * set.length)];
      at = e ? { e, s: 5 } : at;
    }
    at.s += 14 / 60;
    if (at.s > at.e.length - 3) {
      const n = G.nodes[at.fwd === false ? at.e.a : at.e.b], nx = n.edges.map((k) => G.edges[k]).find((q) => q !== at.e && !q.dead && !q.cut && !!q.elevated === !!at.e.elevated);
      at = nx && nx.a === n.id ? { e: nx, s: 3 } : { e: ids[Math.floor(rnd() * ids.length)], s: 3 };
    }
    const q = G.pointAt(at.e, at.s), y = at.e.deck ? G.levelOn(at.e, q.x, q.z) : g.groundAt(q.x, q.z);
    p.teleport({ x: q.x - q.tz * 3, y: y + 0.6, z: q.z + q.tx * 3 }, Math.atan2(q.tx, q.tz));
    p.setVelocity({ x: q.tx * 14, y: 0, z: q.tz * 14 });
    p._readState();
    p.repair();
    g.heat.value = 0;
    g.stepHeadless(1 / 60, { throttle: 0.2, brake: 0, steer: 0, handbrake: 0 });
    if (i % 30 === 29) {
      for (const v of g.vehicles) {
        if (v === p || v.remote || !v.view || Math.hypot(v.position.x - q.x, v.position.z - q.z) > 250) continue;
        if (v.up.y < 0.9) continue;
        // Drawn where it is now.
        v.view.position.copy(v.position); v.view.quaternion.copy(v.quaternion);
        if (g._drawnLift) g._drawnLift(v);
        const gaps = [];
        let surf = null, hi = 0;
        for (let k = 0; k < 4; k++) {
          v.wheelCentre(k, tmp, { position: v.view.position, quaternion: v.view.quaternion, up: v.up });
          const [gy, nm] = ground(tmp.x, tmp.z, tmp.y + 0.5);
          if (gy > -1e6) { gaps.push(tmp.y - v.spec.wheelRadius - gy); surf = nm; }
          if (v.wheels[k].grounded) hi++;
        }
        if (gaps.length < 4) continue;
        // In the air: not what this is about.
        if (!v.dormant && hi < 3) continue;
        let body = 9;
        v.view.updateMatrixWorld(true);
        for (const c of lows(v)) {
          tmp.set(c.x, c.y, c.z).applyMatrix4(v.view.matrixWorld);
          const [gy] = ground(tmp.x, tmp.z, tmp.y + 1);
          if (gy > -1e6) body = Math.min(body, tmp.y - gy);
        }
        const who = v.isTraffic ? (v.dormant ? 'glide' : 'traffic') : v.isPolice ? 'police' : 'other';
        tally(`${who} ${surf === 'decks' ? 'deck' : 'ground'}`, gaps, body, v, surf);
      }
    }
    if (i % 60 === 0) await new Promise((r) => { const c = new MessageChannel(); c.port1.onmessage = () => { c.port1.close(); r(); }; c.port2.postMessage(0); });
  }
  for (const b of Object.values(out.by)) { b.mean = +(b.sum / b.n).toFixed(3); delete b.sum; for (const k of ['min', 'max', 'bodyMin']) b[k] = +b[k].toFixed(2); }
  for (const s of Object.values(out.surf)) { s.mean = +(s.sum / s.n).toFixed(3); delete s.sum; s.min = +s.min.toFixed(2); s.max = +s.max.toFixed(2); }
  out.done = true;
  return out;
}
