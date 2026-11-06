// Meeting the ground in the helicopter, every way.
//
// "I can like smash into the ground at like 300 miles an hour, almost at a nosedive, and
// I'll be fine. So make sure you have to be relatively flat ... if you're going too fast,
// aircraft down ... if you're going still a bit fast, I want it almost to slide along the
// ground, and if it hits a building it kills itself ... the two rail landers and the main
// rotor blade almost fall off, lying flat." `?air=1`. Each case set up 0.8 m off open ground,
// held at its attitude until it touches.
window.__runHeliCrash = async function () {
  window.__res = null;
  try {
    for (let i = 0; i < 300 && !(window.__game && window.__game.player && window.__game.player.isAircraft); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const g = window.__game, a = g.player;
    g.paused = true;
    const orig = g.input.sampleAir.bind(g.input);
    g.input.sampleAir = () => ({ collective: 0, pitch: 0, roll: 0, yaw: 0 });
    const rows = [];
    // Somewhere open: clear of everything for 150 m along +z.
    const { blockedAt } = await import('/src/ai/localplan.js');
    let site = null;
    for (let t = 0; t < 6000 && !site; t++) {
      const x = (Math.random() - 0.5) * 1500, z = (Math.random() - 0.5) * 1500;
      let ok = g.sim.surfaceAt(x, z) === 0;
      for (let k = -40; k < 240 && ok; k += 8) {
        for (const o of [-12, 0, 12]) if (blockedAt(g, x + o, z + k, 4)) ok = false;
      }
      if (ok) site = { x, z };
    }
    if (!site) throw new Error('nowhere open');
    const run = async (name, { pitch = 0, roll = 0, across = 0, down = 2 }, secs = 8) => {
      const y = g.sim.heightAt(site.x, site.z) + 0.8;
      a.disabled = false; a.damage = 0; a.fuel = 200; a.downFor = 0; a.wreckFor = 0;
      a.teleport({ x: site.x, y, z: site.z }, 0);
      a.engineOff = false; a.spin = 1; a.starting = 1; a.startFrac = 1; a.collective = 0.4; a.onGround = false;
      a.pitch = pitch; a.roll = roll; a._applyAttitude();
      a.linvel.set(0, -down, across);
      let touched = null, wreckAt = null;
      for (let i = 0; i < secs * 60; i++) {
        if (touched === null && !a.disabled) { a.pitch = pitch; a.roll = roll; }
        g._update(1 / 60);
        if (touched === null && a.onGround) touched = i / 60;
        if (wreckAt === null && a.disabled) wreckAt = i / 60;
        if (i % 60 === 0) await new Promise((r) => setTimeout(r, 0));
      }
      const went = Math.hypot(a.position.x - site.x, a.position.z - site.z);
      rows.push(`${name.padEnd(34)} ${a.disabled ? `DOWN at ${wreckAt.toFixed(1)} s` : 'landed'}, went ${went.toFixed(0)} m, now ${a.speed.toFixed(1)} m/s, ${a.onGround ? 'on ground' : 'in air'}, pitch ${(a.pitch * 57.3).toFixed(0)} roll ${(a.roll * 57.3).toFixed(0)}, rotor ${a.partsOff ? 'off' : 'on'}, engine ${a.engineOff ? 'off' : 'on'}`);
    };
    await run('straight down, gently', { down: 2 });
    await run('flat, 3 m/s across', { across: 3 });
    await run('flat, 15 m/s (54 km/h)', { across: 15 });
    await run('flat, 30 m/s (108 km/h)', { across: 30 });
    await run('flat, 45 m/s (162 km/h)', { across: 45 });
    await run('flat, straight down 20 m/s', { down: 20 });
    await run('nose down 70, 134 m/s (300 mph)', { pitch: 1.2, across: 134, down: 20 });
    await run('nose down 40, 70 m/s, shallow', { pitch: 0.7, across: 70, down: 5 });
    await run('tilted 40, 10 m/s across', { roll: 0.7, across: 10 });
    await run('tilted 40, barely moving', { roll: 0.7, across: 1, down: 1 });
    await run('tilted 20, 15 m/s: flat enough', { pitch: 0.35, across: 15 });

    // Sliding into something: a site with a building 40 m along +z.
    let wall = null;
    for (let t = 0; t < 20000 && !wall; t++) {
      const x = (Math.random() - 0.5) * 1500, z = (Math.random() - 0.5) * 1500;
      if (g.sim.surfaceAt(x, z) !== 0) continue;
      let ok = true;
      for (let k = -20; k < 30 && ok; k += 4) if (blockedAt(g, x, z + k, 5)) ok = false;
      if (ok && blockedAt(g, x, z + 45, 3)) wall = { x, z };
    }
    if (wall) {
      const keep = site;
      site = wall;
      await run('slide 32 m/s at a building 40 m off', { across: 32 }, 5);
      site = keep;
    } else rows.push('no site for the building case');

    // What came off, from the last crash staged here.
    await run('crash for the parts', { pitch: 1.2, across: 60, down: 20 }, 6);
    const parts = a.parts || [];
    const lie = parts.map((p) => {
      const o = p.obj, up = o.getWorldDirection ? 0 : 0;
      const q = o.quaternion;
      const tilt = 2 * Math.acos(Math.min(1, Math.hypot(q.w, q.y)));
      return `${p.isRotor ? 'rotor' : 'skid'} ${(o.position.y - g.sim.heightAt(o.position.x, o.position.z)).toFixed(2)} m up, ${Math.round(Math.hypot(o.position.x - a.position.x, o.position.z - a.position.z))} m off, tilt ${(tilt * 57.3).toFixed(0)}, ${p.vel.length().toFixed(1)} m/s`;
    });
    rows.push(`parts ${parts.length}: ${lie.join(' | ')}`);
    const body = a.view.getObjectByName('body');
    const tris = () => (body.geometry.index ? body.geometry.index.count : body.geometry.attributes.position.count) / 3;
    const hullTris = tris();
    rows.push(`hull ${hullTris} tris, sitting ${(a.position.y - g.sim.heightAt(a.position.x, a.position.z)).toFixed(2)} m from the ground`);
    // And back: wind the wait on.
    a.downFor = 40;
    g._update(1 / 60);
    rows.push(`recovered: disabled ${a.disabled}, rotor ${a.partsOff ? 'off' : 'on'}, parts ${a.parts.length}, body ${tris()} tris, rotor on the aircraft ${a.view.userData.main.parent !== g.scene}`);
    g.input.sampleAir = orig;
    window.__res = rows;
  } catch (e) {
    window.__res = ['EX: ' + e.message, (e.stack || '').slice(0, 400)];
  }
};
