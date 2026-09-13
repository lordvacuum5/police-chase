// What does the radio actually say during a chase?
//
// Runs a scripted pursuit through each phase the commentary is meant to cover
// -- the start, escalation, the running commentary, losing them and searching,
// seeing them again, and pinning the car to an arrest -- and records every line
// that goes out, with the time it went out. The audio is muted for the run:
// this is about what is said and how often, not the voice.
window.__runCommentary = async function () {
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.player); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const g = window.__game, M = window.__modules, p = g.player, gr = g.graph;
    const wasMuted = g.audio ? g.audio.muted : false;
    if (g.audio) g.audio.muted = true;

    let simT = 0;
    const lines = [];
    const realRadio = g.radio.bind(g);
    g.radio = (text, hot, opts) => {
      // Only what the game would actually put out: after an arrest everything
      // but the closing lines is suppressed.
      if (!(g.outcome && !(opts && opts.final))) {
        lines.push({ t: +simT.toFixed(1), text, hot: !!hot, low: !!(opts && opts.low) });
      }
      return realRadio(text, hot, opts);
    };

    // A quarry that drives itself, as in tests/harness.js.
    const auto = new M.Driver(p, M.SKILL.pursuit);
    auto.limitScale = 1.5;
    let stop = false;
    const route = () => {
      const to = gr.randomNode(g.rng);
      const pts = gr.pathFromPosition(p.position.x, p.position.z, p.forward.x, p.forward.z, to.id, 2.5);
      if (pts.length > 1) auto.setPath(pts);
    };
    const origU = g._update.bind(g);
    g.onEscaped = () => {};
    g._update = (dt) => {
      if (p.damage > 0.5 && !stop) p.repair();
      if (!auto.hasPath || auto.remaining() < 120) route();
      auto.avoid(g.vehicles, dt);
      g.forceControls = stop
        ? { throttle: 0, brake: 1, steer: 0, handbrake: 1 }
        : Object.assign({}, auto.followPath(dt, 40));
      origU(dt);
    };
    const run = async (seconds) => {
      const n = Math.round(seconds / 0.1);
      for (let i = 0; i < n; i++) {
        g.stepHeadless(0.1);
        simT += 0.1;
        if (i % 100 === 0) await new Promise((r) => setTimeout(r, 0));
      }
    };
    const phase = (name) => lines.push({ t: +simT.toFixed(1), text: `----- ${name} -----`, phase: true });

    route();
    phase('chase starts');
    g.heat.bump(1, 'driving dangerously');
    // Force contact so there is something to commentate on, like the harness.
    const k = g.dispatcher.knowledge;
    const realK = g.dispatcher._updateKnowledge.bind(g.dispatcher);
    let blind = false;
    g.dispatcher._updateKnowledge = (dt, tg) => {
      realK(dt, tg);
      if (blind) {
        k.seen = false; k.spotter = null;
      } else {
        k.seen = true; k.timeSinceSeen = 0;
        k.position.copy(tg.position); k.velocity.copy(tg.linvel);
        if (!k.spotter) k.spotter = g.dispatcher.units[0] || null;
      }
    };
    for (let tier = 1; tier <= 4; tier++) {
      g.heat.value = tier + 0.2;
      await run(18);
    }

    phase('they lose sight');
    blind = true;
    await run(34);

    phase('seen again');
    blind = false;
    await run(12);

    phase('car stops, police pin it');
    stop = true;
    let busted = false;
    g.onBusted = () => { if (!busted) { busted = true; g.outcome = 'busted'; g.commentary.onBusted(); realRadio('Control, received. Suspect in custody. All units, stand down.', true); } };
    for (let i = 0; i < 40 && !busted; i++) await run(1);

    g._update = origU;
    g.radio = realRadio;
    g.dispatcher._updateKnowledge = realK;
    if (g.audio) g.audio.muted = wasMuted;

    const spoken = lines.filter((l) => !l.phase);
    const byMinute = spoken.length / (simT / 60);
    window.__res = [
      `simulated ${simT.toFixed(0)} s, ${spoken.length} lines, ${byMinute.toFixed(1)} a minute, `
        + `${spoken.filter((l) => l.low).length} low priority, arrested: ${busted}`,
      '',
      ...lines.map((l) => (l.phase ? l.text : `${String(l.t).padStart(6)}s ${l.hot ? '!' : l.low ? '.' : ' '} ${l.text}`)),
    ].join('\n');
  } catch (e) {
    window.__res = 'EX: ' + e.message + ' | ' + (e.stack || '').slice(0, 400);
  }
};
