// Into the edge of the map at an angle.
//
// "I also, like, went really far. I suddenly just hit a brick wall and
// basically went flying backwards. Really weird."
//
// The player's car aimed at the invisible wall at the east edge at `kph`,
// `deg` degrees off square, on whatever ground is there. Then for two seconds:
//
//   back    the fastest it came away from the wall, m/s
//   spin    the worst yaw rate, deg/s
//   upset   how far from upright it got (1 - up.y)
//   along   its speed along the wall a second after the hit, km/h
window.__runEdgeHit = async function (kph = 110, degs = [20, 45, 70]) {
  window.__res = null;
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.player); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const g = window.__game;
    const { EDGE_FACE } = await import('/src/physics/world.js');
    g.onBusted = () => { g.outcome = null; };
    g.heat.value = 0;
    const p = g.player;
    let controls = { throttle: 0, brake: 0, steer: 0, handbrake: 0 };
    const origU = g._update.bind(g);
    g._update = (dt) => { p.setControls(controls); origU(dt); p.setControls(controls); };
    const rows = [];
    for (const deg of degs) {
      const a = deg / 57.3, v = kph / 3.6;
      // Heading +x is into the east wall; `deg` off it toward +z.
      const dx = Math.cos(a), dz = Math.sin(a);
      const x = EDGE_FACE - 25, z = 300;
      p.repair();
      p.teleport({ x, y: g.sim.heightAt(x, z) + 0.9, z }, Math.atan2(dx, dz));
      p.setVelocity({ x: dx * v, y: 0, z: dz * v });
      let back = 0, spin = 0, upset = 0, hitAt = -1, along = null;
      for (let i = 0; i < 240; i++) {
        controls = { throttle: 0.3, brake: 0, steer: 0, handbrake: 0 };
        g._update(1 / 60);
        if (hitAt < 0 && p.position.x > EDGE_FACE - 4) hitAt = i;
        if (hitAt >= 0) {
          back = Math.max(back, -p.linvel.x);
          spin = Math.max(spin, Math.abs(p.body.angvel().y) * 57.3);
          upset = Math.max(upset, 1 - p.up.y);
          if (i - hitAt === 60) along = Math.round(Math.abs(p.linvel.z) * 3.6);
        }
      }
      rows.push(`${deg} deg: back ${back.toFixed(1)} m/s, spin ${Math.round(spin)} deg/s, upset ${upset.toFixed(2)}, along ${along} km/h`);
    }
    g._update = origU;
    window.__res = rows.join('\n');
  } catch (e) {
    window.__res = 'EX: ' + e.message + ' | ' + (e.stack || '').slice(0, 300);
  }
};
