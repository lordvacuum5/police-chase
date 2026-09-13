// Running a red light in front of a patrol car.
//
// Finds a signalised approach that is showing red, parks a police car at the
// junction with a view of it, and drives the player through at 55 km/h with no
// heat. Then the same again with nobody watching, and once more mid-chase.
// Reports what the heat did and what went out on the radio each time.
window.__runRedLight = async function () {
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.player); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const g = window.__game, gr = g.graph, p = g.player, sig = g.signals;
    const { SIGNAL } = await import('/src/game/trafficlights.js');
    if (g.audio) g.audio.muted = true;

    const lines = [];
    const realRadio = g.radio.bind(g);
    g.radio = (text, hot, opts) => { lines.push(text); return realRadio(text, hot, opts); };

    // A red approach whose junction has a name, with a decent run-up on it.
    const findRed = () => {
      for (const [key, head] of sig.byApproach) {
        if (head.down || head.state !== SIGNAL.RED) continue;
        const edge = gr.edges[key >> 1];
        if (!edge || edge.dead || edge.length < 60) continue;
        const node = gr.nodes[(key & 1) ? edge.b : edge.a];
        if (!node || !node.name || !node.name.includes('/')) continue;
        // Hold the light on red for the test.
        return { head, edge, node, toB: !!(key & 1) };
      }
      return null;
    };

    const run = async (label, { witness, heat }) => {
      g.outcome = null;
      g.heat.reset();
      g.dispatcher.reset();
      g.commentary.reset();
      g._lastRed = null;
      if (heat) { g.heat.bump(1, 'a test'); g.heat.value = heat; }
      const r = findRed();
      if (!r) return `${label}: no red approach found`;
      const state0 = r.head.state;
      // Pin the light: signals cycle, and a test that passes because the light
      // happened to change is not a test.
      const realUpdate = sig.update.bind(sig);
      sig.update = () => { r.head.state = SIGNAL.RED; };

      // Player 40 m up the approach, heading for the junction.
      const along = r.toB ? r.edge.length - 40 : 40;
      const s = gr.pointAt(r.edge, along);
      const dir = r.toB ? 1 : -1;
      const h = Math.atan2(s.tx * dir, s.tz * dir);
      p.repair();
      p.teleport({ x: s.x, y: 0.9, z: s.z }, h);
      p.setVelocity({ x: Math.sin(h) * 15, y: 0, z: Math.cos(h) * 15 });

      let unit = null;
      if (witness) {
        // A patrol car sitting in the junction, a car's width to one side.
        unit = g.spawnPoliceNear({ x: r.node.x, y: 0, z: r.node.z }, 0);
        if (unit) {
          g.dispatcher.units.push(unit);
          unit.vehicle.teleport({ x: r.node.x - s.tz * dir * 9, y: 0.9, z: r.node.z + s.tx * dir * 9 }, h + Math.PI / 2);
        }
      }
      lines.length = 0;
      const heat0 = g.heat.value;
      for (let i = 0; i < 150; i++) {
        g.stepHeadless(1 / 30, { throttle: 0.5, brake: 0, steer: 0, handbrake: 0 });
      }
      sig.update = realUpdate;
      r.head.state = state0;
      return `${label}\n  junction ${r.node.name}, witness ${unit ? unit.callsign : 'none'}`
        + `\n  heat ${heat0.toFixed(2)} -> ${g.heat.value.toFixed(2)}`
        + `\n  radio: ${lines.length ? lines.map((l) => '"' + l + '"').join('\n         ') : '(nothing)'}`;
    };

    const out = [];
    out.push(await run('no chase, patrol car watching', { witness: true, heat: 0 }));
    out.push(await run('no chase, nobody watching', { witness: false, heat: 0 }));
    out.push(await run('during a chase', { witness: true, heat: 2.2 }));

    g.radio = realRadio;
    g.heat.reset(); g.dispatcher.reset(); g.commentary.reset();
    if (g.audio) g.audio.muted = false;
    window.__res = out.join('\n\n');
  } catch (e) {
    window.__res = 'EX: ' + e.message + ' | ' + (e.stack || '').slice(0, 400);
  }
};
