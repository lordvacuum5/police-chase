// Can they actually get to awkward places?
//
// Builds a courtyard out of building boxes with a single narrow entrance,
// drops the target inside it, puts a police car outside, and asks whether the
// unit reaches it. This is the case the road network cannot help with: there
// is no road to a courtyard, so anything that falls back to routing stops
// short at the wall.
window.__runReach = async function () {
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.player); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const g = window.__game, M = window.__modules, gr = g.graph, p = g.player;
    if (!p) { window.__res = 'NO PLAYER'; return; }
    const world = await import('/src/physics/world.js');
    g.onBusted = () => { g.outcome = null; };
    g.onEscaped = () => { g.outcome = null; };

    let site = null;
    for (let i = 0; i < 200 && !site; i++) {
      const n = gr.randomNode(g.rng);
      const pl = g._placeOnRoad(n);
      if (pl) site = { x: pl.position.x, z: pl.position.z };
    }

    const rows = [];
    const cases = [
      { name: 'courtyard, 3.0 m entrance', gap: 3.0 },
      { name: 'courtyard, 4.5 m entrance', gap: 4.5 },
      { name: 'courtyard, 7 m entrance', gap: 7.0 },
    ];

    for (let ci = 0; ci < cases.length; ci++) {
      const { name, gap } = cases[ci];
      const cx = site.x + ci * 400, cz = site.z + 260;
      const R = 26;                       // courtyard half-size
      const bodies = [];
      const wall = (x, z, hx, hz) => bodies.push(
        world.addStaticBox(g.world, x, 4, z, hx, 4, hz, world.GROUP.BUILDING, 0),
      );
      // Four walls; the north one has the entrance in it.
      wall(cx, cz - R, R, 2);
      wall(cx - R, cz, 2, R);
      wall(cx + R, cz, 2, R);
      const halfGap = gap * 0.5;
      const seg = (R - halfGap) * 0.5;
      wall(cx - halfGap - seg, cz + R, seg, 2);
      wall(cx + halfGap + seg, cz + R, seg, 2);

      // Target in the middle of the courtyard; unit outside, north of it.
      p.teleport({ x: cx, y: 0.95, z: cz }, 0);
      p.repair();
      p.setVelocity({ x: 0, y: 0, z: 0 });

      const v = g.createVehicle('patrol', 'patrol',
        { x: cx + 12, y: 0.95, z: cz + 70 }, Math.PI, { police: true });
      const off = new M.Officer(g, v, { skill: M.SKILL.advanced, kind: 'patrol' });
      off.setRole(M.ROLE.PURSUE);
      g.dispatcher.units.push(off);
      g.heat.value = 4.2;

      const k = g.dispatcher.knowledge;
      const oK = g.dispatcher._updateKnowledge.bind(g.dispatcher);
      g.dispatcher._updateKnowledge = (dtt, tg) => {
        oK(dtt, tg);
        k.seen = true; k.timeSinceSeen = 0;
        k.position.copy(tg.position); k.velocity.copy(tg.linvel);
      };

      let best = 1e9, reachedAt = null;
      for (let i = 0; i < 500; i++) {
        g.forceControls = { throttle: 0, brake: 1, steer: 0, handbrake: 1 };
        g.stepHeadless(0.1);
        const dd = Math.hypot(v.position.x - cx, v.position.z - cz);
        if (dd < best) best = dd;
        if (dd < 12 && reachedAt === null) { reachedAt = +(i * 0.1).toFixed(1); break; }
      }
      rows.push({
        gap_m: gap, name,
        closestApproach_m: Math.round(best),
        reached: reachedAt !== null,
        reachedAfter_s: reachedAt,
        endedInsideCourtyard: Math.abs(v.position.x - cx) < R && Math.abs(v.position.z - cz) < R,
      });

      g.dispatcher._updateKnowledge = oK;
      g.dispatcher.retire(off);
      for (const b of bodies) g.world.removeRigidBody(b);
      await new Promise((r) => setTimeout(r, 0));
    }
    window.__res = JSON.stringify({ rows }, null, 1);
  } catch (e) {
    window.__res = 'EX: ' + e.message + ' | ' + (e.stack || '').slice(0, 250);
  }
};
