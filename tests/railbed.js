// Haldon Vale's railway bed: how far it stands off the ground round it, and
// what driving along it is like.
//
// "Train track is really messed up. It's like lots of different levels and I
// keep on going through the floor ... the train tracks need to be less raised
// up on the ground because there's like a different level almost."
//
//   bank     every 6 m along the line inside the map, the most the ground 12 m
//            to either side stands above or below the bed, m: mean, the worst
//            tenth, and the worst
//   drive    the player driven down the line at 60 km/h with the train away:
//            how far it got, the lowest its middle came to the ground (m; a
//            car sitting level is about 0.5), frames under 0.3, and damage
//
// window.__runRailBed() -> window.__res

window.__runRailBed = async function () {
  for (let i = 0; i < 200 && !(window.__game && window.__game.player); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const g = window.__game, p = g.player, map = g.world.__map, R = map.rail, H = g.sim.heightAt;
  g.heat.value = 0;
  g.onBusted = () => { g.outcome = null; };
  const inside = (q) => Math.abs(q.x) < 990 && Math.abs(q.z) < 990;
  const banks = [];
  for (let i = 0; i < R.points.length - 1; i++) {
    const a = R.points[i], b = R.points[i + 1];
    if (!inside(a)) continue;
    const l = Math.hypot(b.x - a.x, b.z - a.z) || 1, nx = -(b.z - a.z) / l, nz = (b.x - a.x) / l;
    const h0 = H(a.x, a.z);
    banks.push(Math.max(Math.abs(H(a.x + nx * 12, a.z + nz * 12) - h0), Math.abs(H(a.x - nx * 12, a.z - nz * 12) - h0)));
  }
  banks.sort((x, y) => x - y);
  const mean = banks.reduce((s, x) => s + x, 0) / banks.length;

  // The drive: steer for a point 15 m on down the line from the nearest one.
  map.railway.clock = map.railway.runTime + 5;
  const pts = R.points;
  let k = pts.findIndex(inside) + 2;
  const a = pts[k], b = pts[k + 1];
  const h = Math.atan2(b.x - a.x, b.z - a.z), v = 60 / 3.6;
  p.repair();
  p.teleport({ x: a.x, y: H(a.x, a.z) + 0.7, z: a.z }, h);
  p.setVelocity({ x: Math.sin(h) * v, y: 0, z: Math.cos(h) * v });
  let low = 9, under = 0, dist = 0, last = { x: a.x, z: a.z };
  for (let i = 0; i < 60 * 150; i++) {
    let near = k, nd = Infinity;
    for (let j = Math.max(0, k - 5); j < Math.min(pts.length, k + 15); j++) {
      const d = Math.hypot(pts[j].x - p.position.x, pts[j].z - p.position.z);
      if (d < nd) { nd = d; near = j; }
    }
    k = near;
    const t = pts[Math.min(pts.length - 1, k + 3)];
    let err = Math.atan2(p.forward.x, p.forward.z) - Math.atan2(t.x - p.position.x, t.z - p.position.z);
    err = Math.atan2(Math.sin(err), Math.cos(err));
    g.forceControls = { throttle: p.speed < v ? 1 : 0, brake: 0, steer: Math.max(-1, Math.min(1, -err * 3)), handbrake: 0 };
    g._update(1 / 60);
    map.railway.clock = map.railway.runTime + 5;
    dist += Math.hypot(p.position.x - last.x, p.position.z - last.z);
    last = { x: p.position.x, z: p.position.z };
    if (i > 60) {
      const up = p.position.y - H(p.position.x, p.position.z);
      low = Math.min(low, up);
      if (up < 0.3) { under++; if (!window.__railLow || window.__railLow.length < 6) (window.__railLow = window.__railLow || []).push([p.position.x | 0, p.position.z | 0, up.toFixed(2), p.up.y.toFixed(2), (p.speed * 3.6) | 0].join(' ')); }
    }
    if (!inside(p.position) || k >= pts.length - 4) break;
  }
  g.forceControls = null;
  window.__res = `bank: mean ${mean.toFixed(2)} m, worst tenth ${banks[Math.floor(banks.length * 0.9)].toFixed(2)} m, worst ${banks[banks.length - 1].toFixed(2)} m\n`
    + `drive: ${(dist / 1000).toFixed(2)} km of ${((pts.filter(inside).length * 6) / 1000).toFixed(2)}, lowest ${low.toFixed(2)} m, frames under 0.3 m ${under}, damage ${p.damage.toFixed(2)}`;
  return window.__res;
};
