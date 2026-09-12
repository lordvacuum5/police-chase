// Why a box does or does not close. Runs one at a full-tier response against a
// crawling target and records, second by second, where each unit is relative to
// the slot it was given and how fast it is going.
window.__runBoxProbe = async function () {
  try {
    for (let i = 0; i < 300 && !(window.__game && window.__game.player); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const g = window.__game, gr = g.graph;
    let wide = null;
    for (const e of gr.edges) {
      if (e.dead || e.turningHead || e.width < 14 || e.length < 90) continue;
      if (!wide || e.length > wide.length) wide = e;
    }
    const s = gr.pointAt(wide, 60);
    g.heat.reset(); g.dispatcher.reset();
    g.player.teleport({ x: s.x, y: 0.9, z: s.z }, Math.atan2(s.tx, s.tz));
    g.player.setVelocity({ x: 0, y: 0, z: 0 });
    g.player.repair();
    g.heat.bump(1, 'a probe'); g.heat.value = 4.8; g.heat.peak = 4.8;

    const rel = (v) => {
      const p = g.player;
      const dx = v.position.x - p.position.x, dz = v.position.z - p.position.z;
      return {
        long: dx * p.forward.x + dz * p.forward.z,
        lat: dx * p.left.x + dz * p.left.z,
      };
    };

    const log = [];
    for (let t = 0; t < 55; t++) {
      g.stepHeadless(1, { throttle: 0.18, brake: 0, steer: 0, handbrake: 0 });
      const a = g.dispatcher.boxAssignment;
      const line = { t, tgt: +(g.player.speed).toFixed(1), n: g.dispatcher.units.length };
      if (a) {
        line.box = [];
        for (const [u, slot] of a) {
          const r = rel(u.vehicle);
          line.box.push(`${slot.name}:${Math.hypot(r.lat - slot.x, r.long - slot.z).toFixed(1)}`
            + `@${u.vehicle.speed.toFixed(1)}/${(u.driver.speedTarget || 0).toFixed(1)}`
            + `${u.role === 'box' ? '' : '!' + u.role}`);
        }
        line.tight = +g.dispatcher.boxTightness.toFixed(2);
      } else {
        const close = g.dispatcher.units
          .filter((u) => u.distanceTo(g.player.position) < 60)
          .map((u) => `${u.role}:${u.distanceTo(g.player.position).toFixed(0)}`);
        line.near = close.join(' ');
      }
      log.push(line);
    }
    window.__res = JSON.stringify(log);
  } catch (e) {
    window.__res = 'EX ' + e.message + '\n' + String(e.stack).slice(0, 500);
  }
};
