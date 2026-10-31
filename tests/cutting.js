// Walls where the quarry's terracing meets the dirt track's banks. Haldon Vale.
//
// "The two sides of the dirt track, like right when it stops being like the
// terracing ... there's an actual slope there that you can actually just get
// up if you go fast enough ... it's still really steep ... the tyre marks are
// still in the sky ... your car starts to basically fly ... I suddenly just
// hit a brick wall and basically went flying backwards."
//
// The surface a car meets -- the highest static thing under each point, with
// the hills' collider counted at the drawn ground it is sunk under -- sampled
// round the rim either side of the cutting, from `from` to `to` degrees off
// the cutting's line, out from 14 m inside the rim to 20 m beyond it. A
// "wall" is a rise of more than 1.5 m per metre between neighbouring samples,
// round the rim or out from it, that a car coming down the track or along the
// rim would meet.
//
//   walls   how many sample points stand at the top of one
//   worst   the steepest, m/m, and where (degrees off the line, metres from the rim)
window.__runCutting = async function (to = 50) {
  window.__res = null;
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.world && window.__game.world.__map); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const g = window.__game;
    g.stepHeadless(0.1);
    const q = g.world.__map.quarry;
    const { RAPIER } = await import('/src/physics/world.js');
    const ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
    const mask = (0xFFFF0000 | 0x1 | 0x2 | 0x20 | 0x40 | 0x200) >>> 0;
    // The highest of three rays a little apart: one alone now and then slips
    // between two of the heightfield's triangles and reads the deep plate
    // under the quarry, a 23 m "wall" that is not there.
    const one = (x, z) => {
      ray.origin.x = x; ray.origin.y = 90; ray.origin.z = z;
      const h = g.world.castRay(ray, 200, true, undefined, mask);
      if (!h) return null;
      let y = 90 - (h.timeOfImpact !== undefined ? h.timeOfImpact : h.toi);
      if (((h.collider.collisionGroups() >>> 16) & 0xFFFF) & 0x40) y += 0.35;
      return y;
    };
    const top = (x, z) => {
      let best = null;
      for (const [ox, oz] of [[0, 0], [0.07, 0.05], [-0.05, 0.08]]) {
        const y = one(x + ox, z + oz);
        if (y !== null && (best === null || y > best)) best = y;
      }
      return best;
    };
    const P = (a, r) => ({ x: q.x + Math.cos(a) * r, z: q.z + Math.sin(a) * r });
    let walls = 0, worst = 0, at = null;
    const where = {};
    for (const side of [1, -1]) {
      for (let deg = 0; deg <= to; deg += 0.5) {
        const a = q.open + side * deg / 57.3;
        for (let r = q.r - 14; r <= q.r + 20; r += 0.5) {
          const p = P(a, r), y = top(p.x, p.z);
          if (y === null) continue;
          // Round the rim, half a metre further from the cutting; and out.
          const ar = 0.5 / r, pa = P(a + side * ar, r), pr = P(a, r + 0.5);
          const ya = top(pa.x, pa.z), yr = top(pr.x, pr.z);
          const s = Math.max(ya === null ? 0 : Math.abs(ya - y), yr === null ? 0 : Math.abs(yr - y)) / 0.5;
          // Only where a car can be: not the faces down into the pit.
          if (r < q.r - 7 && y < q.floor + 3) continue;
          if (s > 1.5 && Math.max(y, ya || y, yr || y) > q.floor + 3) {
            walls++;
            const k = `${side > 0 ? '+' : '-'}${Math.round(deg / 5) * 5}`;
            where[k] = (where[k] || 0) + 1;
            if (s > worst) { worst = s; at = { deg: side * deg, out: r - q.r }; }
          }
        }
      }
    }
    window.__res = JSON.stringify({ walls, worst: +worst.toFixed(1), at, where });
  } catch (e) {
    window.__res = 'EX: ' + e.message + ' | ' + (e.stack || '').slice(0, 300);
  }
};
