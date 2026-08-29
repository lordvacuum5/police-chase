// The narrowest gap a unit will commit to.
//
// Builds a wall across open ground with a hole of a given width, puts a police
// car on one side and the target on the other, and asks two questions: does the
// obstacle sweep call the gap clear, and does the unit actually drive through
// without touching the sides.
window.__runGaps = async function () {
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.player); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const g = window.__game, M = window.__modules, gr = g.graph, p = g.player;
    if (!p) { window.__res = 'NO PLAYER'; return; }
    const world = await import('/src/physics/world.js');
    g.onBusted = () => { g.outcome = null; };
    g.onEscaped = () => { g.outcome = null; };
    g.heat.value = 0;

    // Somewhere flat and empty.
    let site = null;
    for (let i = 0; i < 200 && !site; i++) {
      const n = gr.randomNode(g.rng);
      const pl = g._placeOnRoad(n);
      if (pl) site = pl.position;
    }
    const carW = M.SPECS.patrol.dims.w;

    const rows = [];
    // 0.0 is the control: a solid wall must read as blocked, or the test is
    // measuring nothing.
    const widths = [0.0, 1.6, 2.2, 2.6, 3.2, 4.4];
    for (let gi = 0; gi < widths.length; gi++) {
      const gapW = widths[gi];
      // Each case gets its own patch of ground. Reusing one spot means a
      // leftover wall from the previous iteration blocks the next, which is
      // exactly how this test first reported every gap as impassable.
      const baseZ = site.z + gi * 300;
      const cx = site.x, cz = baseZ + 40;
      const half = gapW * 0.5;
      const bodies = [];
      for (const s of [-1, 1]) {
        bodies.push(world.addStaticBox(
          g.world, cx + s * (half + 6), 3, cz, 6, 3, 1.2, world.GROUP.BUILDING, 0,
        ));
      }

      const v = g.createVehicle('patrol', 'patrol', { x: cx, y: 0.95, z: baseZ }, 0, { police: true });
      const d = new M.Driver(v, M.SKILL.advanced);

      // Does the sweep think the gap is passable?
      const origin = { x: cx, y: 1.0, z: baseZ + 2 };
      const clear = world.sweepBox(g.world, origin, { x: 0, y: 0, z: 1 }, 80,
        world.RAY_GROUNDS, v.body, d.halfWidth);
      const sweepSaysClear = clear > 60;

      // Now actually drive at a point beyond the wall.
      const aim = { x: cx, y: 0, z: cz + 25 };
      let touched = false, through = false;
      let prev = v.speed;
      v.setVelocity({ x: 0, y: 0, z: 14 });
      for (let i = 0; i < 420; i++) {
        v.setControls(d.driveTo(aim, 16, 1 / 60, { allowHandbrake: false }));
        g.stepHeadless(1 / 60);
        if (prev - v.speed > 3) touched = true;
        prev = v.speed;
        if (v.position.z > cz + 5) { through = true; break; }
      }

      rows.push({
        gap_m: gapW,
        carWidth_m: carW,
        probeWidth_m: +(d.halfWidth * 2).toFixed(2),
        sweepSaysClear,
        drovethrough: through,
        touchedSides: touched,
      });
      g.removeVehicle(v);
      for (const b of bodies) g.world.removeRigidBody(b);
      await new Promise((r) => setTimeout(r, 0));
    }
    window.__res = JSON.stringify({ rows }, null, 1);
  } catch (e) {
    window.__res = 'EX: ' + e.message + ' | ' + (e.stack || '').slice(0, 250);
  }
};
