// Does the garage do what it says?
//
//  1. Where it is, and that it is somewhere a car can get to: on the lot,
//     level, and clear of anything solid.
//  2. Driving in: the car is put on the road in front of the lot, pointed at
//     the bay, and driven in slowly through the game's own update. It has to
//     arrive in the bay without hitting anything on the way.
//  3. The repair: with the car damaged and stopped in the bay, nothing for
//     three seconds, then the damage coming down, and it stopping the moment
//     the car moves.
window.__runGarage = async function () {
  try {
    for (let i = 0; i < 300 && !(window.__game && window.__game.player && window.__game.garage); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const g = window.__game, gar = g.garage, p = g.player;
    const rows = [];
    if (!gar.site) { window.__res = 'NO SITE'; return; }
    if (g.audio) g.audio.muted = true;
    g.onBusted = () => { g.outcome = null; };
    g.onEscaped = () => { g.outcome = null; };
    g.heat.value = 0;
    const s = gar.site;
    rows.push(['map', g.mapDef.id]);
    rows.push(['site', `${s.cx.toFixed(0)}, ${s.cz.toFixed(0)} on ${s.roadName} (${s.edge.kind})`]);
    rows.push(['from the start', `${Math.hypot(s.cx - g.startPlace.position.x, s.cz - g.startPlace.position.z).toFixed(0)} m`]);

    // ---- 1. level ground ----
    let lo = Infinity, hi = -Infinity;
    for (let u = -16; u <= 16; u += 2) {
      for (let v = -14; v <= 11; v += 2) {
        const w = gar.toWorld(u, v);
        const h = g.sim.heightAt(w.x, w.z);
        lo = Math.min(lo, h); hi = Math.max(hi, h);
      }
    }
    rows.push(['ground height on the lot', `${lo.toFixed(3)} - ${hi.toFixed(3)} m`]);

    // ---- 2. drive in ----
    const bayU = 10, roadV = -(12 + 3 + s.edge.width * 0.25);
    const from = gar.toWorld(bayU, roadV);
    const to = gar.toWorld(bayU, 5.5);
    const heading = Math.atan2(to.x - from.x, to.z - from.z);
    p.repair();
    p.teleport({ x: from.x, y: 0.9, z: from.z }, heading);
    p.setVelocity({ x: 0, y: 0, z: 0 });
    // Handbrake, not brake: held brake at a standstill selects reverse.
    g.stepHeadless(0.5, { throttle: 0, brake: 0, steer: 0, handbrake: 1 });
    let hits = 0, lastAt = p.lastImpactAt || 0, t = 0;
    while (t < 20) {
      const loc = gar.toLocal(p.position.x, p.position.z);
      const left = 5.5 - loc.v;
      const want = Math.max(0, Math.min(4, left * 0.8));
      const err = want - p.forwardSpeed;
      // Keep it pointed up the middle of the bay.
      const side = loc.u - bayU;
      const steer = Math.max(-1, Math.min(1, side * 0.25));
      g.stepHeadless(1 / 30, {
        throttle: err > 0.2 ? 0.6 : 0,
        brake: err < -0.3 || left < 0.2 ? 1 : 0, steer, handbrake: 0,
      }, 1 / 30);
      t += 1 / 30;
      if (p.lastImpactAt && p.lastImpactAt !== lastAt) { hits++; lastAt = p.lastImpactAt; }
      if (left < 0.4 && p.speed < 0.3) break;
    }
    g.stepHeadless(0.5, { throttle: 0, brake: 1, steer: 0, handbrake: 0 });
    rows.push(['drove into the bay', `${gar.inBay(p) ? 'yes' : 'NO'} in ${t.toFixed(1)} s, ${hits} collisions`]);

    // ---- 3. repair ----
    if (!gar.inBay(p)) {
      const c = gar.toWorld(10, 5.5);
      p.teleport({ x: c.x, y: 0.9, z: c.z }, heading);
      p.setVelocity({ x: 0, y: 0, z: 0 });
      g.stepHeadless(0.5, { throttle: 0, brake: 1, steer: 0, handbrake: 0 });
    }
    p.damage = 0.6;
    const hold = { throttle: 0, brake: 1, steer: 0, handbrake: 1 };
    g.stepHeadless(2.8, hold);
    rows.push(['after 2.8 s still', `damage ${(p.damage * 100).toFixed(1)}%  (${gar.readout && gar.readout.label} ${gar.readout && gar.readout.value})`]);
    g.stepHeadless(1.2, hold);
    const at4 = p.damage;
    rows.push(['after 4 s still', `damage ${(p.damage * 100).toFixed(1)}%  (${gar.readout && gar.readout.label} ${gar.readout && gar.readout.value})`]);
    g.stepHeadless(6, hold);
    rows.push(['after 10 s still', `damage ${(p.damage * 100).toFixed(1)}%  (${((at4 - p.damage) / 6 * 100).toFixed(1)}% a second)`]);

    // Drive off: it has to stop at once.
    const before = p.damage;
    g.stepHeadless(1.5, { throttle: 0.6, brake: 0, steer: 0, handbrake: 0 });
    g.stepHeadless(2, { throttle: 0, brake: 1, steer: 0, handbrake: 0 });
    rows.push(['after driving off', `damage ${(p.damage * 100).toFixed(1)}% (was ${(before * 100).toFixed(1)}), repairing ${gar.repairing}`]);

    // And back to full, given the time.
    const c = gar.toWorld(10, 5.5);
    p.teleport({ x: c.x, y: 0.9, z: c.z }, heading);
    p.setVelocity({ x: 0, y: 0, z: 0 });
    p.damage = 0.3;
    g.stepHeadless(12, hold);
    rows.push(['30% damage, 12 s later', `damage ${(p.damage * 100).toFixed(1)}%  (${gar.readout && gar.readout.label})`]);

    window.__res = rows.map((r) => `${r[0].padEnd(26)} ${r[1]}`).join('\n');
  } catch (e) {
    window.__res = 'EX ' + e.message + '\n' + String(e.stack).slice(0, 500);
  }
};
