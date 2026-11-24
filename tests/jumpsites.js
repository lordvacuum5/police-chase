// Where the raised motorway's barrier could be left out for cars to jump off: "you could add some more sections with no
// crash barrier ... that could be kind of fun".
//   const m = await import('/tests/jumpsites.js');  m.jumpSites()      // best first: { x, z, side, kind, drop, clear }
// Every 20 m of the ring and the expressway, each side: leaving it both ways at 24, 36 and 48 m/s and 12, 20 and 28 degrees
// off the road, the fall and 45 m of run-out swept for anything solid, water, another raised road, or a step in the ground.
// `clear` is how many of the 18 have nothing in the way. The sites in world/citygen.js (JUMPS) were picked from it.
export async function jumpSites(opts = {}) {
  const g = window.__game, G = g.graph, sim = g.sim, map = g.world.__map;
  const { RAPIER, GROUP, groups } = await import('/src/physics/world.js');
  g.stepHeadless(1 / 30, { throttle: 0, brake: 1, steer: 0, handbrake: 1 });
  const MASK = groups(0xFFFF, GROUP.BUILDING | GROUP.PROP | GROUP.CANOPY | GROUP.RAMP);
  const shape = new RAPIER.Cuboid(1.6, 0.6, 2.6), out = [];
  const raised = G.edges.filter((e) => e.elevated && (e.kind === 'motorway' || e.kind === 'dual'));
  for (const e of raised) {
    for (let s = 30; s < e.length - 30; s += 20) {
      const p = G.pointAt(e, s), y = G.levelOn(e, p.x, p.z), drop = y - sim.terrainAt(p.x, p.z);
      if (drop < 3.5 || drop > 13) continue;
      for (const side of [1, -1]) {
        const nx = -p.tz * side, nz = p.tx * side, hw = e.width * 0.5;
        const ex = p.x + nx * hw, ez = p.z + nz * hw;
        // Nothing else raised alongside.
        if (G.edgesNear(p.x + nx * (hw + 14), p.z + nz * (hw + 14), 34).some((o) => o !== e && o.elevated && !raised.includes(o))) continue;
        if (G.edgesNear(p.x + nx * 30, p.z + nz * 30, 22).some((o) => o !== e && o.elevated && !sameLine(G, e, o))) continue;
        let clear = 0;
        for (const dir of [1, -1]) for (const v of [24, 36, 48]) for (const deg of [12, 20, 28]) {
          const a = deg * Math.PI / 180, dx = p.tx * dir * Math.cos(a) + nx * Math.sin(a), dz = p.tz * dir * Math.cos(a) + nz * Math.sin(a);
          let x = ex, z = ez, h = y + 0.8, vy = 0, ground = false, run = 0, ok = true, last = null;
          const rot = { x: 0, y: Math.sin(Math.atan2(dx, dz) / 2), z: 0, w: Math.cos(Math.atan2(dx, dz) / 2) };
          for (let t = 0; t < 200 && ok && run < 45; t++) {
            const st = 1.5 / v;
            x += dx * 1.5; z += dz * 1.5;
            const gy = sim.terrainAt(x, z);
            if (!ground) { vy -= 9.81 * st; h += vy * st; if (h <= gy + 0.8) ground = true; } else { run += 1.5; if (last !== null && Math.abs(gy - last) > 0.6) ok = false; h = gy + 0.8; }
            last = gy;
            if (Math.abs(x) > 1440 || Math.abs(z) > 1440 || (map.clearAt && map.clearAt(x, z))) { ok = false; break; }
            // Not this road itself, as it leaves it.
            if ((x - ex) * nx + (z - ez) * nz < 3.6) continue;
            W: {
              let hit = false;
              g.world.intersectionsWithShape({ x, y: h + 0.5, z }, rot, shape, (c) => {
                const gr = c.collisionGroups() >>> 16, b = c.parent();
                if (gr === GROUP.HILL || (b && b.bodyType() === 0)) return true;
                const hx = c.halfExtents ? c.halfExtents() : null;
                if (hx && hx.x > 300) return true;
                hit = true;
                return false;
              }, undefined, MASK);
              if (hit) ok = false;
            }
          }
          if (ok) clear++;
        }
        if (clear >= (opts.least || 14)) out.push({ x: Math.round(p.x), z: Math.round(p.z), side, kind: e.kind, id: e.id, s, drop: +drop.toFixed(1), clear });
      }
    }
  }
  out.sort((a, b) => b.clear - a.clear);
  return out;
}

function sameLine(G, e, o) {
  return e.kind === o.kind && [o.a, o.b].some((n) => n === e.a || n === e.b);
}
