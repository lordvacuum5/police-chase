// Does the obstacle check give the same answer whichever way the car faces?
//
// "It was trying to turn into a gap between two buildings, but it thought it
// couldn't make it, so it stopped -- and it had loads of room. And they'd
// still crash into trees at that high speed. It's like they have a bubble
// around all these objects that is too big."
//
// Both halves of that are one bug. Every obstacle check sweeps a box along the
// direction of travel, and the box was left at the world's own rotation: a
// car-width plate heading north or south, and the same plate turned sideways
// heading east or west -- narrow enough to thread past a trunk the car would
// have hit, and deep enough to report a wall a metre and a half before the car
// reached it.
//
// So this asks the same two questions from four headings, twenty metres back:
//
//   wall     a wall straight across the path. The sweep should say 20 m.
//   narrow   a 1.6 m hole in that wall, which a 1.94 m car does not fit
//            through. The sweep should still say 20 m -- that is not a way
//            through.
//
// A correct check reads the same from every heading. With the plate left
// unrotated, north and south are right while east and west are more than a
// metre short on the wall and thread straight through the narrow gap.
window.__runBubble = async function () {
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.player); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const g = window.__game;
    const world = await import('/src/physics/world.js');
    const THREE = window.__modules.THREE;

    const headings = [
      { name: 'north (+Z)', dx: 0, dz: 1 },
      { name: 'south (-Z)', dx: 0, dz: -1 },
      { name: 'east (+X)', dx: 1, dz: 0 },
      { name: 'west (-X)', dx: -1, dz: 0 },
    ];
    const STAND_OFF = 20;
    const hw = g.player.spec.dims.w * 0.5 + 0.10;

    // A wall across the path with a hole of `gap` metres in it (0 for solid),
    // and the swept distance to it from STAND_OFF metres back.
    const measure = (cx, cz, h, gap) => {
      const nx = -h.dz, nz = h.dx;                       // across the path
      const bodies = [];
      const out = gap * 0.5 + 5;
      for (const side of [-1, 1]) {
        bodies.push(world.addStaticBox(
          g.world,
          cx + nx * out * side, 3, cz + nz * out * side,
          Math.abs(nx) * 5 + Math.abs(h.dx) * 1.0, 3,
          Math.abs(nz) * 5 + Math.abs(h.dz) * 1.0,
          world.GROUP.BUILDING, 0,
        ));
      }
      // Queries read the broad phase, which is only rebuilt by a step: without
      // this the walls are not there yet and everything reads clear.
      g.world.step();
      const from = new THREE.Vector3(cx - h.dx * STAND_OFF, 1.1, cz - h.dz * STAND_OFF);
      const dir = new THREE.Vector3(h.dx, 0, h.dz);
      const clear = world.sweepBox(g.world, from, dir, 60, world.RAY_GROUNDS, null, hw);
      for (const b of bodies) g.world.removeRigidBody(b);
      return +clear.toFixed(2);
    };

    const rows = headings.map((h, i) => ({
      heading: h.name,
      wall: measure(1040 + i * 150, -300, h, 0),
      narrow: measure(1040 + i * 150, 60, h, 1.6),
    }));

    // What the sweep should say: the stand-off, less the wall's own half-depth
    // and the plate's. Anything else is the check being wrong.
    const TRUTH = STAND_OFF - 1 - 0.25;
    const errs = [];
    for (const r of rows) {
      errs.push(Math.abs(r.wall - TRUTH), Math.abs(r.narrow - TRUTH));
    }
    window.__res = `car ${g.player.spec.dims.w.toFixed(2)} m wide, plate `
      + `${(hw * 2).toFixed(2)} m, the wall ${STAND_OFF} m away\n`
      + rows.map((r) => `${r.heading.padEnd(11)} wall ${String(r.wall).padStart(5)} m`
        + `  1.6 m gap ${String(r.narrow).padStart(5)} m`).join('\n')
      + `\nworst error ${Math.max(...errs).toFixed(2)} m`;
  } catch (e) {
    window.__res = 'EX: ' + e.message + ' | ' + (e.stack || '').slice(0, 300);
  }
};
