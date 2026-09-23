// The signal sequence itself, and then running a red in front of a patrol car.
//
// __runSignalSequence checks the order of the lamps rather than anything in
// the world: a phase must read green, amber, red, red-and-amber, green, the
// two phases must never both be told to go, and there must be a spell with
// everything red between them. Red-and-amber once sat straight after a
// phase's own amber -- so a driver saw "yours is next" and then nineteen more
// seconds of red, and the speed planner, which reads red-and-amber as carry
// on, took cars through the clearance gap.
window.__runSignalSequence = async function () {
  const { TrafficLights, SIGNAL } = await import('/src/game/trafficlights.js');
  const name = { [SIGNAL.RED]: 'RED', [SIGNAL.RED_AMBER]: 'RED_AMBER', [SIGNAL.GREEN]: 'GREEN', [SIGNAL.AMBER]: 'AMBER' };
  const STEP = 0.05;
  // One full cycle: green plus amber plus the gap, twice over.
  let cycle = 0;
  const first = TrafficLights.phaseState(0, 0);
  for (let t = STEP; t < 600; t += STEP) {
    if (TrafficLights.phaseState(t, 0) === first && TrafficLights.phaseState(t - STEP, 0) !== first) { cycle = t; break; }
  }

  const order = (phase) => {
    const seq = [];
    let last = null;
    for (let t = 0; t < cycle * 2; t += STEP) {
      const s = name[TrafficLights.phaseState(t, phase)];
      if (s !== last) { seq.push(s); last = s; }
    }
    return seq;
  };

  let bothGo = 0, allRed = 0, brokenPromise = 0;
  for (let t = 0; t < cycle; t += STEP) {
    const a = TrafficLights.phaseState(t, 0), b = TrafficLights.phaseState(t, 1);
    const moving = (s) => s === SIGNAL.GREEN || s === SIGNAL.RED_AMBER;
    if (moving(a) && moving(b)) bothGo++;
    if (a === SIGNAL.RED && b === SIGNAL.RED) allRed++;
    for (const s of [a, b]) void s;
  }
  for (const phase of [0, 1]) {
    for (let t = 0; t < cycle; t += STEP) {
      // Whatever follows red-and-amber must be green: that is what it means.
      if (TrafficLights.phaseState(t, phase) === SIGNAL.RED_AMBER
        && TrafficLights.phaseState(t + STEP * 2, phase) !== SIGNAL.RED_AMBER
        && TrafficLights.phaseState(t + STEP * 2, phase) !== SIGNAL.GREEN) brokenPromise++;
    }
  }

  const wanted = ['GREEN', 'AMBER', 'RED', 'RED_AMBER', 'GREEN'];
  const seq0 = order(0).join(' ');
  return {
    cycleSeconds: +cycle.toFixed(1),
    phase0: seq0,
    phase1: order(1).join(' '),
    sequenceRight: seq0.includes(wanted.join(' ')),
    bothPhasesToldToGo: bothGo,
    secondsAllRed: +(allRed * STEP).toFixed(1),
    redAmberNotFollowedByGreen: brokenPromise,
  };
};

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
