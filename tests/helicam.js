// Where does the camera put the helicopter at strange angles?
//
// "The hiccups are still, if you do some strange angles ... the camera ends up being to
// the side, the left or the right, maybe it's one side only ... stay in a fixed position
// with the tilt ... but when it's strafing to the side, I kind of want it to follow."
// `?air=1`, high up, flown through scripted stick moves with the real controls at about
// 60 Hz. For each: how far off the middle of the screen the aircraft gets (fraction of a
// half-screen), and the biggest frame-to-frame jump in the camera relative to the aircraft.
window.__runHeliCam = async function () {
  window.__res = null;
  try {
    for (let i = 0; i < 300 && !(window.__game && window.__game.player && window.__game.player.isAircraft); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const g = window.__game, a = g.player, THREE = await import('three');
    g.paused = true;
    const orig = g.input.sampleAir.bind(g.input);
    let stick = { collective: 0, pitch: 0, roll: 0, yaw: 0 };
    g.input.sampleAir = () => stick;
    a.engineOff = false; a.spin = 1; a.starting = 1; a.startFrac = 1;
    const rows = [], v = new THREE.Vector3();
    const cam = g.camera3.camera;
    const run = async (name, c, secs) => {
      a.position.y = g.sim.heightAt(a.position.x, a.position.z) + 200;
      let maxX = 0, maxY = 0, jump = 0, px = null, py = null, pz = null, turn = 0, pq = null;
      for (let i = 0; i < secs * 60; i++) {
        stick = c;
        if (a.position.y < g.sim.heightAt(a.position.x, a.position.z) + 120) a.position.y += 80;
        const before = a.position.y;
        g._update(1 / 60 + (Math.random() * 2 - 1) * 0.0005);
        g._render(1 / 60);
        v.copy(a.position).project(cam);
        maxX = Math.max(maxX, Math.abs(v.x)); maxY = Math.max(maxY, Math.abs(v.y));
        const rx = cam.position.x - a.position.x, ry = cam.position.y - a.position.y, rz = cam.position.z - a.position.z;
        if (px !== null && Math.abs(a.position.y - before) < 5) jump = Math.max(jump, Math.hypot(rx - px, ry - py, rz - pz));
        px = rx; py = ry; pz = rz;
        if (pq) turn = Math.max(turn, cam.quaternion.angleTo(pq));
        pq = cam.quaternion.clone();
        if (i % 60 === 0) await new Promise((r) => setTimeout(r, 0));
      }
      rows.push(`${name.padEnd(22)} off centre x ${maxX.toFixed(2)} y ${maxY.toFixed(2)}, rel jump ${jump.toFixed(2)} m, view turn ${(turn * 57.3).toFixed(1)} deg a frame, speed ${Math.round(a.speed * 3.6)} km/h, pitch ${(a.pitch * 57.3).toFixed(0)} roll ${(a.roll * 57.3).toFixed(0)}`);
    };
    const neutral = { collective: 0.3, pitch: 0, roll: 0, yaw: 0 };
    await run('level', neutral, 2);
    await run('pitch forward', { ...neutral, pitch: 0.3 }, 4);
    await run('back to level', neutral, 3);
    await run('nose right down', { ...neutral, pitch: 0.6 }, 4);
    await run('back to level', neutral, 4);
    await run('pitch back', { ...neutral, pitch: -0.4 }, 4);
    await run('back to level', neutral, 3);
    await run('strafe right', { ...neutral, roll: 0.25 }, 5);
    await run('back to level', neutral, 3);
    await run('strafe left', { ...neutral, roll: -0.25 }, 5);
    await run('back to level', neutral, 3);
    await run('roll past 90 right', { ...neutral, roll: 0.75 }, 4);
    await run('back to level', neutral, 4);
    await run('roll past 90 left', { ...neutral, roll: -0.75 }, 4);
    await run('back to level', neutral, 4);
    await run('over on its back', { ...neutral, pitch: 1 }, 5);
    await run('back to level', neutral, 5);
    await run('pedal and roll', { ...neutral, roll: 0.4, yaw: 1 }, 4);
    await run('pedal other way', { ...neutral, roll: -0.4, yaw: -1, pitch: 0.2 }, 4);
    g.input.sampleAir = orig;
    window.__res = rows;
  } catch (e) {
    window.__res = ['EX: ' + e.message, (e.stack || '').slice(0, 300)];
  }
};
