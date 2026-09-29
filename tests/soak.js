// Drive for ten minutes and see what breaks.
//
// Every other test here asks one question about one situation. This one asks
// nothing in particular: it drives the player round the road graph at chase
// speed with the force after it, and once a second checks the things that
// should never be true --
//
//   a NaN anywhere in a car's position or speed
//   a car under the world (world/common.js, Game._catchFallen)
//   damage outside 0..1
//   two units sharing a callsign
//   heat outside 0..5
//   rigid bodies piling up, which is a spawn that never gets cleaned away
//   anything thrown out of a frame at all
//
// -- and reports the first time each one happens. It is the cheapest way to
// find the class of bug this game keeps producing: not a wrong number that
// someone can see, but a quiet mismatch that only shows up after the world has
// been running for a while. The AI id collision, the officer left on the
// roster with no car, the car that fell off the map and was still counted as
// chasing you: all of them would have shown here.
//
// The driving is deliberately crude -- pure pursuit from one road node to a
// random neighbour, throttle to 80 km/h, brake over 100 -- because a good
// driver stays out of trouble and trouble is the point. It clips kerbs, cuts
// across verges and rams the occasional building, which is roughly what the
// game gets played like anyway.
//
// It runs headless, so ten minutes of game takes about forty seconds of real
// time. Arrests are ignored: being busted every minute would test one minute
// ten times instead of ten minutes once.
window.__runSoak = async function (seconds = 600) {
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.player); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const g = window.__game;
    const graph = g.graph;

    // ---- the driver ----
    let node = graph.nodes[0], from = null;
    let bd = Infinity;
    for (const n of graph.nodes) {
      const d = (n.x - g.player.position.x) ** 2 + (n.z - g.player.position.z) ** 2;
      if (d < bd) { bd = d; node = n; }
    }
    const step = () => {
      const p = g.player.position;
      if ((node.x - p.x) ** 2 + (node.z - p.z) ** 2 < 18 * 18) {
        const next = [];
        for (const id of node.edges) {
          const e = graph.edges[id];
          const other = graph.nodes[e.a === node.id ? e.b : e.a];
          if (other && (!from || other.id !== from.id)) next.push(other);
        }
        from = node;
        if (next.length) node = next[Math.floor(Math.random() * next.length)];
      }
      const f = g.player.forward;
      let err = Math.atan2(node.x - p.x, node.z - p.z) - Math.atan2(f.x, f.z);
      while (err > Math.PI) err -= Math.PI * 2;
      while (err < -Math.PI) err += Math.PI * 2;
      const kph = g.player.speed * 3.6;
      return {
        throttle: kph < 80 ? 1 : 0,
        brake: kph > 100 ? 0.35 : 0,
        steer: -Math.max(-1, Math.min(1, err * 1.6)),
        handbrake: 0,
      };
    };

    // ---- the watch ----
    const seen = new Set();
    const problems = [];
    const note = (s) => { if (!seen.has(s)) { seen.add(s); problems.push(`${Math.round(t)}s  ${s}`); } };

    g.onBusted = () => { g.outcome = null; g.heat.bustTimer = 0; };
    g.onEscaped = () => { g.outcome = null; };
    g.paused = true;
    let bodies0 = null, worstBodies = 0, maxVehicles = 0, maxUnits = 0, t = 0;

    for (let i = 0; i < seconds * 60; i++) {
      t = i / 60;
      try {
        g.forceControls = step();
        g.stepHeadless(1 / 60);
      } catch (e) {
        note(`threw: ${e.message}`);
        break;
      }
      if (i % 60) continue;

      // Held at three stars with eyes on: enough of the force to be
      // interesting, and it will not shake itself off while nobody is at the
      // wheel of the thing being chased.
      g.heat.value = Math.max(g.heat.value, 3);
      g.dispatcher.knowledge.seen = true;
      g.dispatcher.knowledge.position.copy(g.player.position);

      let bodies = 0;
      g.world.forEachRigidBody(() => bodies++);
      if (bodies0 === null) bodies0 = bodies;
      worstBodies = Math.max(worstBodies, bodies);
      maxVehicles = Math.max(maxVehicles, g.vehicles.length);
      maxUnits = Math.max(maxUnits, g.dispatcher.units.length);
      if (bodies - bodies0 > 400) note(`rigid bodies ${bodies0} -> ${bodies}`);

      for (const v of g.vehicles) {
        if (!Number.isFinite(v.position.x) || !Number.isFinite(v.position.y)
          || !Number.isFinite(v.speed)) note(`NaN on the ${v.specKey}`);
        if (v.position.y < -14) note(`${v.specKey} under the world at y ${v.position.y.toFixed(0)}`);
        if (v.damage > 1.001 || v.damage < 0) note(`damage ${v.damage.toFixed(2)} on the ${v.specKey}`);
      }
      const signs = g.dispatcher.units.map((u) => u.callsign);
      if (new Set(signs).size !== signs.length) note('two units with one callsign');
      if (g.heat.value < 0 || g.heat.value > 5) note(`heat ${g.heat.value.toFixed(2)}`);
      for (const u of g.dispatcher.units) {
        if (!g.vehicles.includes(u.vehicle)) note(`${u.callsign} is on the roster with no car`);
      }
    }

    g.forceControls = null;
    g.paused = false;
    let bodies = 0;
    g.world.forEachRigidBody(() => bodies++);
    window.__res = `${Math.round(t)}s driven  `
      + `cars up to ${maxVehicles}  units up to ${maxUnits}  `
      + `bodies ${bodies0} -> ${bodies} (peak ${worstBodies})\n`
      + (problems.length ? problems.join('\n') : 'nothing to report');
  } catch (e) {
    window.__res = 'EX: ' + e.message + ' | ' + (e.stack || '').slice(0, 300);
  }
};
