// Does the world shake when you fly?
//
// "Try to stop it juddering so much." Flying dead straight and level at a steady
// speed, the camera should move the same distance every frame. The rig steps the game
// at about 60 Hz with `?air=1` and measures each frame's camera movement against
// speed * dt, with `wobble` seconds either way on the frame time as a real one has: `off` is the mean and p95 of |moved / expected - 1|.
window.__runHeliJudder = async function (frames = 240, kph = 200, wobble = 0.0005) {
  window.__res = null;
  try {
    for (let i = 0; i < 300 && !(window.__game && window.__game.player && window.__game.player.isAircraft); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const g = window.__game, a = g.player;
    g.paused = true;
    g.forceAir = null;
    const speed = kph / 3.6;
    a.teleport({ x: a.position.x, y: g.sim.heightAt(a.position.x, a.position.z) + 120, z: a.position.z }, 0);
    const cam = g.camera3.camera.position;
    const off = [], moved = [];
    let px = null, pz = null;
    for (let i = 0; i < frames; i++) {
      const dt = 1 / 60 + (Math.random() * 2 - 1) * wobble;
      // Held on a straight line at a steady speed, whatever the flight model wants.
      a.setVelocity({ x: 0, y: 0, z: speed });
      a.position.y = g.sim.heightAt(a.position.x, a.position.z) + 120;
      g._update(dt);
      g._render(dt);
      if (px !== null && i > 30) {
        const d = Math.hypot(cam.x - px, cam.z - pz);
        moved.push(d);
        off.push(Math.abs(d / (speed * dt) - 1));
      }
      px = cam.x; pz = cam.z;
      if (i % 60 === 0) await new Promise((r) => setTimeout(r, 0));
    }
    off.sort((x, y) => x - y);
    moved.sort((x, y) => x - y);
    window.__res = {
      expected: +(speed / 60).toFixed(3),
      moved: { min: +moved[0].toFixed(3), max: +moved[moved.length - 1].toFixed(3) },
      offMean: +(off.reduce((s, x) => s + x, 0) / off.length).toFixed(3),
      offP95: +off[Math.floor(off.length * 0.95)].toFixed(3),
    };
  } catch (e) {
    window.__res = 'EX: ' + e.message + ' ' + (e.stack || '').slice(0, 300);
  }
};
