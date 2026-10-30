// Does the car shake on screen when the frame rate wobbles?
//
// "There is quite a bad judder on the player's car just driving along, even on
// single player, possibly when there are a lot of police cars."
//
// The player's car runs dead straight at `kph` out past the edge of the map on
// forced tarmac (like tests/highspeed.js), and the game is stepped with frame
// times drawn from `pattern` -- a steady 60 Hz, or the uneven mix a loaded
// frame loop actually produces. After each frame the car's interpolated pose
// is projected through the real camera. Driving straight at a steady speed it
// should sit still on screen, so whatever it moves is judder:
//
//   shake   mean frame-to-frame movement of the car on screen, in thousandths
//           of the screen height; p95 alongside
window.__runCamJudder = async function (kph = 130, patterns = null) {
  window.__res = null;
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.player); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const g = window.__game;
    const THREE = await import('three');
    g.onBusted = () => { g.outcome = null; };
    g.heat.value = 0;
    const realSurface = g.sim.surfaceAt, realHeight = g.sim.heightAt;
    g.sim.surfaceAt = () => 1;
    g.sim.heightAt = () => 0;
    const v = g.player;
    let controls = { throttle: 0, brake: 0, steer: 0, handbrake: 0 };
    const origU = g._update.bind(g);
    g._update = (dt) => { v.setControls(controls); origU(dt); v.setControls(controls); };

    patterns = patterns || {
      steady60: [1 / 60],
      uneven: [1 / 60, 1 / 60, 1 / 40, 1 / 60, 1 / 45, 1 / 60, 1 / 30, 1 / 55],
      slow: [1 / 40, 1 / 30, 1 / 45, 1 / 28, 1 / 35],
    };
    const out = {};
    for (const [name, dts] of Object.entries(patterns)) {
      v.teleport({ x: 1015, y: 0.9, z: -1000 }, 0);
      controls = { throttle: 0, brake: 1, steer: 0, handbrake: 1 };
      for (let i = 0; i < 60; i++) g._update(1 / 60);
      v.setVelocity({ x: 0, y: 0, z: kph / 3.6 });
      g.camera3.snapTo(v);
      const moves = [];
      let last = null;
      const p = new THREE.Vector3();
      for (let i = 0; i < 360; i++) {
        const err = kph / 3.6 - v.forwardSpeed;
        controls = { throttle: Math.max(0, Math.min(1, err * 0.6)), brake: 0, steer: 0, handbrake: 0 };
        g._update(dts[i % dts.length]);
        const a = Math.min(1, Math.max(0, g.accumulator * 120));
        p.copy(v.prevPos).lerp(v.position, a);
        g.camera.updateMatrixWorld();
        p.project(g.camera);
        if (last && i > 120) moves.push(Math.hypot(p.x - last.x, p.y - last.y) * 0.5 * 1000);
        last = { x: p.x, y: p.y };
      }
      moves.sort((x, y) => x - y);
      out[name] = { shake: +(moves.reduce((s, x) => s + x, 0) / moves.length).toFixed(2),
        p95: +moves[Math.floor(moves.length * 0.95)].toFixed(2), kph: Math.round(v.forwardSpeed * 3.6) };
      await new Promise((r) => setTimeout(r, 0));
    }
    g.sim.surfaceAt = realSurface; g.sim.heightAt = realHeight; g._update = origU;
    window.__res = JSON.stringify(out);
  } catch (e) {
    window.__res = 'EX: ' + e.message + ' | ' + (e.stack || '').slice(0, 300);
  }
};
