// Are the map's working vehicles on the ground? Haldon Vale.
//
// "The quarry vehicles seem to drive up an invisible ramp inside the quarry."
//
// Each mover's whole cycle is posed (Mover.pose, no physics) and a ray dropped
// onto the static world under it. Per mover, the worst height above what is
// under it (`float`) and below (`sink`), in metres, with where and in which
// part of the cycle (L0/L1 a leg, T0/T1 a turn). The hills' collider is sunk
// HILL_SINK under the drawn ground, so a hit on it counts the drawn ground.
window.__runMovers = async function () {
  window.__res = null;
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.world && window.__game.world.__map); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const g = window.__game;
    g.stepHeadless(0.1);
    const { RAPIER } = await import('/src/physics/world.js');
    const ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
    // Not any of the movers themselves: two trucks crossing would read as
    // one sunk in the other's roof.
    const movers = new Set((g.world.__map.movers || []).map((m) => m.body.handle));
    const notMover = (c) => !(c.parent() && movers.has(c.parent().handle));
    const map = g.world.__map;
    const mask = (0xFFFF0000 | 0x1 | 0x2 | 0x20 | 0x40 | 0x200) >>> 0;
    const out = [];
    for (const m of map.movers || []) {
      let float = [0, null], sink = [0, null];
      const N = 1500;
      for (let i = 0; i < N; i++) {
        const t = (i / N) * m.cycle;
        const a = m.pose(t);
        let gy = null;
        // Three rays a little apart: one alone now and then slips between two
        // of the heightfield's triangles.
        for (const [ox, oz] of [[0, 0], [0.3, 0.2], [-0.2, 0.3]]) {
          ray.origin.x = a.x + ox; ray.origin.y = a.y + 40; ray.origin.z = a.z + oz;
          const h = g.world.castRay(ray, 120, true, undefined, mask, undefined, undefined, notMover);
          if (!h) continue;
          let y = ray.origin.y - (h.timeOfImpact !== undefined ? h.timeOfImpact : h.toi);
          if (((h.collider.collisionGroups() >>> 16) & 0xFFFF) & 0x41) y = g.sim.heightAt(a.x, a.z);
          gy = gy === null ? y : Math.max(gy, y);
        }
        if (gy === null) continue;
        const gap = a.y - gy;
        const p = (((t + m.offset) % m.cycle) + m.cycle) % m.cycle;
        const ph = p < m.leg ? 'L0' : p < m.leg + m.turnTime ? 'T0' : p < 2 * m.leg + m.turnTime ? 'L1' : 'T1';
        if (gap > float[0]) float = [gap, { ph, x: Math.round(a.x), z: Math.round(a.z) }];
        if (gap < sink[0]) sink = [gap, { ph, x: Math.round(a.x), z: Math.round(a.z) }];
      }
      out.push({ name: m.name, float: +float[0].toFixed(2), at: float[1], sink: +sink[0].toFixed(2), sinkAt: sink[1] });
    }
    window.__res = JSON.stringify(out);
  } catch (e) {
    window.__res = 'EX: ' + e.message + ' | ' + (e.stack || '').slice(0, 300);
  }
};
