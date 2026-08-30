// Traffic signals and street furniture, measured rather than eyeballed.
//
// Two questions this answers:
//   1. Does a patrolling unit actually stop at a red light, and go on green?
//   2. What does hitting street furniture cost you -- is it "a bit of a push",
//      or does it stop the car dead?
window.__runStreets = async function () {
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.player); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const g = window.__game, M = window.__modules, p = g.player;
    if (!p) { window.__res = 'NO PLAYER'; return; }
    g.onBusted = () => { g.outcome = null; };
    g.onEscaped = () => { g.outcome = null; };
    g.heat.value = 0;

    const SIGNAL = { RED: 0, RED_AMBER: 1, GREEN: 2, AMBER: 3 };
    const rows = [];

    // ------------------------------------------------ 1. do reds stop a unit
    const lights = g.signals;
    const j = lights.junctions.find((x) => x.heads.length >= 3) || lights.junctions[0];
    const head = j.heads[0];

    // Hold the whole town on one colour, so the run is not a race with the
    // cycle. update() still has to write the lamp matrices.
    const realUpdate = lights.update.bind(lights);
    let forced = SIGNAL.RED;
    lights.update = (dt) => {
      realUpdate(dt);
      for (const h of lights.heads) h.state = forced;
    };

    // Park a patrol car well back on the approach, pointing at the junction.
    const back = head.setback + 60;
    const sx = j.node.x + head.dir.x * back;
    const sz = j.node.z + head.dir.z * back;
    const heading = Math.atan2(-head.dir.x, -head.dir.z);
    const v = g.createVehicle('patrol', 'patrol', { x: sx, y: 0.95, z: sz }, heading,
      { police: true });
    const officer = new M.Officer(g, v, { kind: 'patrol', skill: M.SKILL.regular });
    const toLine = () => {
      const dx = v.position.x - j.node.x, dz = v.position.z - j.node.z;
      return dx * head.dir.x + dz * head.dir.z - head.setback - 0.6;
    };

    let stoppedAt = null, worst = Infinity, moved = false;
    for (let i = 0; i < 60 * 30; i++) {
      officer.update(1 / 60, null);
      v.setControls(officer.driver.out);
      g.stepHeadless(1 / 60, null);
      const d = toLine();
      worst = Math.min(worst, d);
      // Only count a standstill once the car has actually set off: it starts
      // from rest, and "stopped where it was parked" is not an answer.
      if (v.speed > 4) moved = true;
      if (moved && v.speed < 0.4 && stoppedAt === null) stoppedAt = d;
    }
    rows.push(['red: came to a stand', stoppedAt === null ? 'never stopped'
      : `${stoppedAt.toFixed(1)} m before the line`]);
    rows.push(['red: furthest past the line', `${Math.max(0, -worst).toFixed(1)} m`]);

    forced = SIGNAL.GREEN;
    const bx = v.position.x, bz = v.position.z;
    for (let i = 0; i < 60 * 8; i++) {
      officer.update(1 / 60, null);
      v.setControls(officer.driver.out);
      g.stepHeadless(1 / 60, null);
    }
    rows.push(['green: moved on in 8 s',
      `${Math.hypot(v.position.x - bx, v.position.z - bz).toFixed(1)} m`]);

    lights.update = realUpdate;
    g.removeVehicle(v);

    // ---------------------------- 2. signal heads must not stand in the road
    let onTarmac = 0;
    for (const h of lights.heads) {
      if (g.graph.overlapsRoad(h.x, h.z, 0.5, 0.5, 0, 0.2)) onTarmac++;
    }
    rows.push(['signal heads on tarmac', `${onTarmac} of ${lights.heads.length}`]);

    // ------------------------------------------ 3. what furniture costs you
    const props = g.props;
    for (const kind of ['lamp', 'bollard', 'bin', 'sign', 'signal']) {
      const pool = props.props.filter((r) => r.kind === kind && !r.down);
      if (!pool.length) { rows.push([`hit a ${kind}`, 'none placed']); continue; }

      // Straight at it from 34 m back, coasting at 28 m/s. On the town map a
      // given prop may have a building or a hedge on that line, so try a few
      // before giving up -- otherwise the test reports "missed" for a system
      // that works perfectly well.
      let q = null, before = null, after = null, dmg0 = 0, dmg1 = 0;
      for (let n = 0; n < 12 && after === null; n++) {
        q = pool[Math.floor((n / 12) * pool.length)];
        if (!q || q.down) continue;
        p.repair();
        p.teleport({ x: q.x, y: 0.95, z: q.z - 34 }, 0);
        p.setVelocity({ x: 0, y: 0, z: 28 });
        dmg0 = p.damage; dmg1 = dmg0; before = null;
        // Stop the moment it goes over: run on and the car finds a wall to
        // hit, and the wall's damage lands in the furniture's column.
        for (let i = 0; i < 60 * 3 && after === null; i++) {
          if (!q.down) before = p.speed;
          g.stepHeadless(1 / 60, { throttle: 0, brake: 0, steer: 0, handbrake: 0 });
          if (q.down) { after = p.speed; dmg1 = p.damage; }
        }
      }
      if (after === null) { rows.push([`hit a ${kind}`, 'no clear run at one']); continue; }
      rows.push([`hit a ${kind}`,
        `${before.toFixed(1)} -> ${after.toFixed(1)} m/s `
        + `(-${(before - after).toFixed(2)}), damage +`
        + `${((dmg1 - dmg0) * 100).toFixed(1)}%`]);

      // Let it come to rest, then check it is lying on the ground rather than
      // buried in it. The mesh origin is the prop's base, so once it is flat
      // the base should be within a hand's breadth of y = 0 either way -- it
      // used to end up a whole prop-length under the road.
      for (let i = 0; i < 60 * 6; i++) g.stepHeadless(1 / 60, { throttle: 0, brake: 1, steer: 0, handbrake: 1 });
      const entry = props.byKind.get(kind);
      const mat = new (window.__modules.THREE.Matrix4)();
      entry.mesh.getMatrixAt(q.index, mat);
      const baseY = mat.elements[13];
      rows.push([`  ${kind} came to rest at`, `y = ${baseY.toFixed(2)} m`]);
    }
    rows.push(['props placed', String(props.props.length)]);
    rows.push(['signal heads', String(lights.heads.length)]);

    window.__res = rows.map((r) => `${r[0].padEnd(30)} ${r[1]}`).join('\n');
  } catch (e) {
    window.__res = 'EX ' + e.message + '\n' + String(e.stack).slice(0, 500);
  }
};
