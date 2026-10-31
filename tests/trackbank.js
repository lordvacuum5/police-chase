// Driving along the steep bank beside the quarry's dirt track. Haldon Vale.
//
// "The dirt track. Where if I go on the edge of that ... a really steep edge,
// so you start having weird stuff in my car ... I start like flying in weird
// directions."
//
// The player's car is put on the bank either side of the track where it cuts
// through the rim, `side` metres off its middle, pointing down the track, and
// driven at `kph` for three seconds, from several places along it. Per run:
//
//   spin   the worst pitch/roll rate, deg/s
//   jump   the worst upward speed, m/s
//   upset  how far from upright it got at worst (1 - up.y)
window.__runTrackBank = async function (kph = 40, sides = [-13, -10, 10, 13]) {
  window.__res = null;
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.world && window.__game.world.__map); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const g = window.__game;
    g.onBusted = () => { g.outcome = null; };
    g.heat.value = 0;
    const q = g.world.__map.quarry, p = g.player;
    const ox = Math.cos(q.open), oz = Math.sin(q.open), tx = -oz, tz = ox;
    let controls = { throttle: 0, brake: 0, steer: 0, handbrake: 0 };
    const origU = g._update.bind(g);
    g._update = (dt) => { p.setControls(controls); origU(dt); p.setControls(controls); };
    const rows = [];
    let worstSpin = 0, worstJump = 0, worstUpset = 0;
    for (const along of [q.r + 20, q.r + 4, q.r - 2]) {
      for (const side of sides) {
        const x = q.x + ox * along + tx * side, z = q.z + oz * along + tz * side;
        p.repair();
        // Pointing down the track, into the quarry.
        const h = Math.atan2(-ox, -oz);
        p.teleport({ x, y: g.sim.heightAt(x, z) + 0.9, z }, h);
        p.setVelocity({ x: -ox * kph / 3.6, y: 0, z: -oz * kph / 3.6 });
        let spin = 0, jump = 0, upset = 0;
        for (let i = 0; i < 180; i++) {
          controls = { throttle: 0.4, brake: 0, steer: 0, handbrake: 0 };
          g._update(1 / 60);
          if (i < 10) continue;
          const av = p.body.angvel();
          spin = Math.max(spin, Math.hypot(av.x, av.z) * 57.3);
          jump = Math.max(jump, p.linvel.y);
          upset = Math.max(upset, 1 - p.up.y);
        }
        worstSpin = Math.max(worstSpin, spin); worstJump = Math.max(worstJump, jump); worstUpset = Math.max(worstUpset, upset);
        rows.push(`${Math.round(along - q.r)}/${side}: spin ${Math.round(spin)} jump ${jump.toFixed(1)} upset ${upset.toFixed(2)}`);
      }
    }
    g._update = origU;
    rows.push(`worst: spin ${Math.round(worstSpin)} deg/s, jump ${worstJump.toFixed(1)} m/s, upset ${worstUpset.toFixed(2)}`);
    window.__res = rows.join('\n');
  } catch (e) {
    window.__res = 'EX: ' + e.message + ' | ' + (e.stack || '').slice(0, 300);
  }
};
