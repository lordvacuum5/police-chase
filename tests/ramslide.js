// A police car hit from the side, by the player, with the tyres at each setting.
//
// "It's kind of weird when I hit them. They basically just seem to stick to the ground ... maybe
// if they're in contact with another vehicle, that gives them normal levels of grip ... so they
// can slide around the ground if you hit them hard." Same place, same hit, nobody steering:
//
//   await import('/tests/ramslide.js');
//   await __runRamSlide({ bumpGrip: 1 });   // and __runRamSlide() as it ships
//
//   pushed    how far off its line the car ended up after 1.5 s, m
//   slide     the most sideways speed it reached, m/s, and how long over 2 m/s it stayed
//   turned    how far round the hit swung it, degrees
window.__runRamSlide = async function (patch = null, kph = 100, copKph = 70) {
  window.__res = null;
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.player); i++) await new Promise((r) => setTimeout(r, 100));
    const g = window.__game, p = g.player;
    g.onBusted = () => { g.outcome = null; };
    g.onEscaped = () => { g.outcome = null; };
    for (const u of g.dispatcher.units.slice()) if (!u.human) g.despawnPolice(u);
    const e = g.graph.edges.filter((x) => !x.cut && x.points && x.points.length > 3)
      .map((x) => {
        const a = x.points[0], b = x.points[x.points.length - 1];
        return { a, b, len: Math.hypot(b.x - a.x, b.z - a.z) };
      }).filter((x) => g.sim.surfaceAt(x.a.x, x.a.z) !== 0).sort((m, n) => n.len - m.len)[0];
    const h = Math.atan2(e.b.x - e.a.x, e.b.z - e.a.z);
    const fx = Math.sin(h), fz = Math.cos(h);
    const u = g.spawnPoliceNear({ x: e.a.x, y: 0, z: e.a.z }, 5);
    const v = u.vehicle;
    const spec = v.spec;
    if (patch) v.spec = Object.assign({}, spec, patch);
    const idle = { throttle: 0, brake: 0, steer: 0, handbrake: 0 };
    const rows = [];
    let pushed = 0, slide = 0, slideFor = 0, turned = 0, spd = 0, hit = 0, n = 0, dmg = 0;
    for (const [side, along] of [[1, 12], [-1, 12], [1, 16], [-1, 16], [1, 8], [-1, 8]]) {
      v.repair();
      v.assist.shielded = false;
      const cs = copKph / 3.6, ps = kph / 3.6;
      const y0 = g.sim.heightAt(e.a.x, e.a.z) + 0.9;
      v.teleport({ x: e.a.x, y: y0, z: e.a.z }, h);
      v.setVelocity({ x: fx * cs, y: 0, z: fz * cs });
      v._readState();
      // From the side and a little ahead, timed to meet it.
      const lx = fz * side, lz = -fx * side;
      const meet = along / cs;
      const px = e.a.x + fx * along + lx * ps * meet * 0.7, pz = e.a.z + fz * along + lz * ps * meet * 0.7;
      const ph = Math.atan2(-lx, -lz);
      p.repair();
      p.teleport({ x: px, y: g.sim.heightAt(px, pz) + 0.9, z: pz }, ph);
      p.setVelocity({ x: -lx * ps * 0.7, y: 0, z: -lz * ps * 0.7 });
      p._readState();
      let touched = -1, mostSide = 0, over = 0, h0 = h;
      for (let i = 0; i < 60 * 3; i++) {
        v.setControls({ throttle: 0.4, brake: 0, steer: 0, handbrake: 0 });
        p.setControls({ throttle: 1, brake: 0, steer: 0, handbrake: 0 });
        g.heat.value = 0;
        g.stepHeadless(1 / 60, { throttle: 1, brake: 0, steer: 0, handbrake: 0 });
        if (touched < 0 && v.lastImpactAt && v.lastImpact > 4) { touched = i; h0 = Math.atan2(v.forward.x, v.forward.z); }
        if (touched >= 0) {
          const lat = Math.abs(v.lateralSpeed || 0);
          mostSide = Math.max(mostSide, lat);
          if (lat > 2) over += 1 / 60;
          if (i - touched >= 90) break;
        }
      }
      if (touched < 0) continue;
      const ox = v.position.x - e.a.x, oz = v.position.z - e.a.z;
      pushed += Math.abs(ox * fz - oz * fx);
      slide += mostSide; slideFor += over;
      let dy = Math.atan2(v.forward.x, v.forward.z) - h0;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      turned += Math.abs(dy) * 57.3;
      spd += v.speed; dmg += v.damage; hit++; n++;
    }
    v.spec = spec;
    g.despawnPolice && g.despawnPolice(u);
    rows.push(n ? `${n} hits: pushed ${(pushed / n).toFixed(1)} m, sideways at most ${(slide / n).toFixed(1)} m/s, over 2 m/s for ${(slideFor / n).toFixed(2)} s, turned ${(turned / n).toFixed(0)} deg, speed after ${Math.round((spd / n) * 3.6)} km/h, damage ${(dmg / n).toFixed(2)}` : 'no hits landed');
    window.__res = rows.join('\n');
  } catch (err) {
    window.__res = 'EX: ' + err.message + ' | ' + (err.stack || '').slice(0, 300);
  }
  return window.__res;
};
