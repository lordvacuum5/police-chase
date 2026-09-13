// What does the radio actually say during a chase?
//
// Runs a scripted pursuit through each phase the commentary is meant to cover
// -- the start, escalation, the running commentary, losing them and searching,
// seeing them again, and pinning the car to an arrest -- and records what goes
// out on the net.
//
// The real speech engine cannot run in a stepped simulation, so the channel is
// modelled: the game's own queueing (GameAudio.radio, _pumpRadio, busy,
// quietFor) runs for real on a simulated clock, and only _transmit is replaced
// -- each line is held on the air for about as long as the voice would take to
// say it. That makes the numbers mean what the player hears: lines a minute on
// the air, how long each waited, which were dropped for being late, and which
// routine lines were cut off by something more urgent.
window.__runCommentary = async function (mode = 'scripted', seconds = 180) {
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.player); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const g = window.__game, M = window.__modules, p = g.player, gr = g.graph;
    // Relative to the page, so the same test can be pointed at an older copy
    // of the game served from another folder.
    const { GameAudio, speakable } = await import(new URL('src/game/audio.js', document.baseURI).href);

    let simT = 0;
    const events = [];
    // Timed on this machine's voices at the game's rates, onstart to onend:
    // Hazel (Control) 2.8 s for 32 characters and 5.0 s for 68, George (units)
    // 2.0 s for 30 and 4.5 s for 76 -- about half a second plus 16.5 to 19
    // characters a second. Plus about a second of clicks, chirps and key-up.
    const airtime = (text) => 1.6 + speakable(text).length / 16.5;

    // ------------------------------------------------------ the channel model
    const chan = Object.create(GameAudio.prototype);
    Object.assign(chan, {
      ready: true, muted: false, failed: false, ctx: { currentTime: 0 },
      radioQueue: [], radioFreeAt: 0, currentMsg: null, _endCurrent: null,
    });
    const transmitted = new Set();
    const queuedAt = new Map();
    chan._transmit = function (msg) {
      const now = this.ctx.currentTime;
      transmitted.add(msg);
      const rec = { t: +simT.toFixed(1), text: msg.text, hot: msg.hot, low: msg.low, wait: now - (queuedAt.get(msg) ?? now), cut: false };
      events.push(rec);
      this.currentMsg = msg;
      this.radioFreeAt = now + airtime(msg.text);
      this._endCurrent = () => {
        rec.cut = true;
        this.currentMsg = null;
        this._endCurrent = null;
        this.radioFreeAt = Math.min(this.radioFreeAt, this.ctx.currentTime + 0.45);
      };
    };
    chan.update = function (dt) {
      this.ctx.currentTime += dt;
      if (this.currentMsg && this.ctx.currentTime >= this.radioFreeAt) {
        this.currentMsg = null; this._endCurrent = null;
      }
      const before = this.radioQueue.slice();
      this._pumpRadio();
      // Anything that left the queue without going out waited too long.
      for (const m of before) {
        if (!this.radioQueue.includes(m) && !transmitted.has(m)) {
          events.push({ t: +simT.toFixed(1), text: m.text, dropped: true });
        }
      }
    };
    chan.impact = () => {};
    chan.resume = () => {};
    // Lines pushed out of the queue by a newer one of the same kind.
    const realChanRadio = GameAudio.prototype.radio;
    chan.radio = function (text, hot, opts = {}) {
      const before = this.radioQueue.slice();
      realChanRadio.call(this, text, hot, opts);
      for (const m of this.radioQueue) if (!queuedAt.has(m)) queuedAt.set(m, this.ctx.currentTime);
      for (const m of before) {
        if (!this.radioQueue.includes(m)) events.push({ t: +simT.toFixed(1), text: m.text, dropped: true, replaced: true });
      }
    };
    const realAudio = g.audio;
    g.audio = chan;

    // Everything the game *tried* to put out, for comparison.
    let attempted = 0;
    const realGameRadio = g.radio.bind(g);
    g.radio = (text, hot, opts) => {
      if (!text.startsWith('[') && !(g.outcome && !(opts && opts.final))) attempted++;
      return realGameRadio(text, hot, opts);
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
    // The scripted run manages the heat itself; a natural one escapes for real.
    if (mode !== 'natural') g.onEscaped = () => {};
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
    const phase = (name) => events.push({ t: +simT.toFixed(1), text: `----- ${name} -----`, phase: true });

    // No arrest before the phase that is meant to end in one: an early bust
    // silences the net and leaves the search phases with nothing to say.
    g.onBusted = () => { g.heat.bustTimer = 0; };

    route();
    phase('chase starts');
    g.heat.bump(1, 'driving dangerously');
    const k = g.dispatcher.knowledge;
    const realK = g.dispatcher._updateKnowledge.bind(g.dispatcher);
    let busted = false;

    if (mode === 'natural') {
      // Nothing forced: the police have to see the car to know where it is,
      // and the heat climbs at its own rate. Closer to an ordinary chase than
      // the scripted run, which packs four escalations into seventy seconds.
      // Driven at an ordinary pace rather than the harness's flat-out one,
      // which loses a first-star response within seconds. A chase starts with
      // a sighting, as a real one does; if the car gets clean away, a little
      // later somebody sees it again.
      auto.limitScale = 1.0;
      const sighting = () => {
        k.seen = true; k.timeSinceSeen = 0;
        k.position.copy(p.position); k.velocity.copy(p.linvel);
      };
      sighting();
      let clearFor = 0;
      for (let s = 0; s < seconds; s += 1) {
        clearFor = g.heat.value <= 0 ? clearFor + 1 : 0;
        if (clearFor >= 12) {
          phase('got away; seen again later');
          g.heat.reset();
          g.heat.bump(1, 'driving dangerously');
          sighting();
          clearFor = 0;
        }
        await run(1);
      }
    } else {
      // Force contact so there is something to commentate on, like the harness.
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
      g.onBusted = () => {
        if (!busted) {
          busted = true; g.outcome = 'busted'; g.commentary.onBusted();
          realGameRadio('Control, received. All units, stand down.', true, { final: true });
        }
      };
      for (let i = 0; i < 40 && !busted; i++) await run(1);
      await run(8);   // let the closing lines go out
    }

    g._update = origU;
    g.radio = realGameRadio;
    g.dispatcher._updateKnowledge = realK;
    g.audio = realAudio;
    // Both were set on the instance, over the class's own methods.
    delete g.onEscaped;
    delete g.onBusted;

    const aired = events.filter((e) => !e.phase && !e.dropped);
    const dropped = events.filter((e) => e.dropped);
    const waits = aired.map((e) => e.wait).sort((a, b) => a - b);
    const onAir = aired.reduce((s, e) => s + airtime(e.text), 0);
    window.__res = [
      `${mode}: simulated ${simT.toFixed(0)} s, arrested: ${busted}, peak heat ${g.heat.peak.toFixed(1)}`,
      `tried to say ${attempted}, aired ${aired.length} (${(aired.length / (simT / 60)).toFixed(1)} a minute), `
        + `channel busy ${(100 * onAir / simT).toFixed(0)}% of the time`,
      `waited for the channel: median ${(waits[waits.length >> 1] || 0).toFixed(1)} s, `
        + `worst ${(waits[waits.length - 1] || 0).toFixed(1)} s`,
      `dropped as late ${dropped.filter((e) => !e.replaced).length}, replaced by a newer call `
        + `${dropped.filter((e) => e.replaced).length}, routine lines cut off ${aired.filter((e) => e.cut).length}`,
      '',
      ...events.map((e) => (e.phase ? e.text
        : e.dropped ? `${String(e.t).padStart(6)}s x (${e.replaced ? 'replaced' : 'late'}) ${e.text}`
          : `${String(e.t).padStart(6)}s ${e.hot ? '!' : e.low ? '.' : ' '} ${e.text}`
            + `${e.wait > 0.3 ? `  [waited ${e.wait.toFixed(1)} s]` : ''}${e.cut ? '  [cut off]' : ''}`)),
    ].join('\n');
  } catch (e) {
    window.__res = 'EX: ' + e.message + ' | ' + (e.stack || '').slice(0, 400);
  }
};
