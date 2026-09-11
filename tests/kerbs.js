// Raised footways: is the step where it is drawn, and can you feel it?
//
// The height field lives on top of one flat collider rather than in geometry,
// so the two things that can go wrong are that it disagrees with what is drawn
// and that it does nothing to the car. Both are measurable.
window.__runKerbs = async function () {
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.player); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const g = window.__game, p = g.player, gr = g.graph;
    if (!p) { window.__res = 'NO PLAYER'; return; }
    g.onBusted = () => { g.outcome = null; };
    g.onEscaped = () => { g.outcome = null; };
    g.heat.value = 0;

    const H = g.sim.heightAt;
    const rows = [];
    if (!H) { window.__res = 'no height field'; return; }

    // ------------------------------------------- 1. is the step where it is drawn
    //
    // Walk out across the carriageway from a road's centre line and find where
    // the ground first rises. It should be at the kerb -- half the road's
    // width -- and nowhere else.
    // A street near the middle of town, so there is a footway on both sides
    // rather than open country on one of them.
    let edge = null, best = Infinity;
    for (const e of gr.edges) {
      if (e.kind !== 'street' || e.length < 70 || e.turningHead) continue;
      const m = gr.pointAt(e, e.length * 0.5);
      const d = Math.hypot(m.x, m.z);
      if (d < best) { best = d; edge = e; }
    }
    const mid = gr.pointAt(edge, edge.length * 0.5);
    const nx = -mid.tz, nz = mid.tx;
    let rise = null, maxOnRoad = 0;
    for (let d = 0; d < 22; d += 0.1) {
      const h = H(mid.x + nx * d, mid.z + nz * d);
      if (d < edge.width * 0.5 - 0.8) maxOnRoad = Math.max(maxOnRoad, h);
      if (rise === null && h > 0.07) rise = d;
    }
    rows.push(['road half width', `${(edge.width * 0.5).toFixed(2)} m`]);
    rows.push(['ground rises at', rise === null ? 'never' : `${rise.toFixed(2)} m out`]);
    rows.push(['highest point on the road', `${(maxOnRoad * 1000).toFixed(0)} mm`]);
    rows.push(['footway height', `${(H(mid.x + nx * 11, mid.z + nz * 11) * 1000).toFixed(0)} mm`]);

    // --------------------------------------------------- 2. can you feel it?
    // Straight at the kerb at a range of speeds, square on, and see what it
    // does to the car: how much the suspension takes, how much speed it costs,
    // and whether it throws the car off line.
    const hit = (speed) => {
      // Settle on the carriageway first. Measuring from the frame after a
      // teleport reads the drop onto the road, which dwarfs the kerb.
      p.repair();
      p.teleport({ x: mid.x - nx * 13, y: 0.95, z: mid.z - nz * 13 },
        Math.atan2(nx, nz));
      p.setVelocity({ x: 0, y: 0, z: 0 });
      for (let i = 0; i < 90; i++) {
        g.stepHeadless(1 / 60, { throttle: 0, brake: 1, steer: 0, handbrake: 1 });
      }
      const y0 = p.position.y;
      const rest = p.wheels.reduce((m, w) => Math.max(m, w.compression), 0);

      p.setVelocity({ x: nx * speed, y: 0, z: nz * speed });
      // Only the crossing itself. Run on and the car finds the building
      // behind the footway, and the wall's damage lands in the kerb's column.
      const across = () => (p.position.x - mid.x) * nx + (p.position.z - mid.z) * nz;
      let maxComp = 0, maxRise = 0, entry = speed;
      const dmg0 = p.damage;
      let crossed = false, frames = 0;
      for (let i = 0; i < 60 * 3 && frames < 8; i++) {
        if (!crossed) entry = p.speed;
        g.stepHeadless(1 / 60, { throttle: 0, brake: 0, steer: 0, handbrake: 0 });
        if (!crossed && across() > rise - 0.4) crossed = true;
        if (crossed) {
          frames++;
          for (const w of p.wheels) maxComp = Math.max(maxComp, w.compression);
          maxRise = Math.max(maxRise, p.position.y - y0);
        }
      }
      return {
        entry,
        left: p.speed,
        rise: maxRise,
        comp: maxComp, rest,
        dmg: p.damage - dmg0,
      };
    };
    for (const s of [4, 10, 18, 26]) {
      const r = hit(s);
      rows.push([`mount it at ${String(s).padStart(2)} m/s`,
        `${r.entry.toFixed(1)} -> ${r.left.toFixed(1)} m/s, body lifts `
        + `${(r.rise * 1000).toFixed(0)} mm, suspension ${(r.comp * 1000).toFixed(0)} mm `
        + `(${(r.rest * 1000).toFixed(0)} at rest), damage +${(r.dmg * 100).toFixed(1)}%`]);
    }

    // ------------------------------- 3. does it upset the car along the road?
    // Clipping a kerb at an angle is the interesting case: it should shove the
    // car, not stop it. Driving *along* the road should feel nothing at all.
    const along = (offset) => {
      p.repair();
      const start = gr.pointAt(edge, 6);
      const h = Math.atan2(start.tx, start.tz);
      p.teleport({ x: start.x + nx * offset, y: 0.95, z: start.z + nz * offset }, h);
      p.setVelocity({ x: 0, y: 0, z: 0 });
      for (let i = 0; i < 90; i++) {
        g.stepHeadless(1 / 60, { throttle: 0, brake: 1, steer: 0, handbrake: 1 });
      }
      p.setVelocity({ x: start.tx * 22, y: 0, z: start.tz * 22 });
      let swing = 0;
      const y0 = p.position.y;
      for (let i = 0; i < 60 * 2.0; i++) {
        g.stepHeadless(1 / 60, { throttle: 0.3, brake: 0, steer: 0, handbrake: 0 });
        swing = Math.max(swing, Math.abs(p.position.y - y0));
      }
      return swing * 1000;
    };
    rows.push(['down the middle, body moves', `${along(0).toFixed(0)} mm`]);
    rows.push(['in the gutter, body moves', `${along(edge.width * 0.5 - 1.6).toFixed(0)} mm`]);

    // --------------------------------------------------------- 4. what it cost
    rows.push(['', '']);
    rows.push(['surface grid', `${g.sim.surfaceAt ? 'ok' : 'missing'}, `
      + `${(2000 * 2000 / 1e6).toFixed(0)} MB at 1 m`]);

    window.__res = rows.map((r) => `${r[0].padEnd(28)} ${r[1]}`).join('\n');
  } catch (e) {
    window.__res = 'EX ' + e.message + '\n' + String(e.stack).slice(0, 500);
  }
};
