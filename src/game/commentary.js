// Pursuit commentary: the police saying what is actually going on.
//
// The dispatcher only ever spoke when it made a decision -- a unit responding,
// a PIT authorised, a roadblock going in -- so for most of a chase the net was
// silent, and nothing on it ever told you what they could see. A real pursuit
// is the opposite: the primary unit keeps up a running commentary (direction,
// road, speed, what the vehicle is doing), Control acknowledges and escalates,
// and everyone else says what is happening to them.
//
// This watches the game and says those things. It never decides anything; it
// only reports. Everything is rate-limited twice over -- a gap between any two
// lines, and a cooldown per kind of line -- and routine commentary is marked
// low priority: it only goes out into a real pause on the net, waits for the
// next one if there is none, and is cut off by anything urgent. A line about
// where the car is, read out five seconds later, is a line about where it was.
//
// Every kind of line has several wordings, drawn through the game's phrasebook
// so the same one does not come round again until the others have had a turn
// (see game/phrases.js). A search used to produce "Control, still no further
// sighting, keep looking" three times in a row.

/** How a unit describes the car it is chasing. */
const DESCRIBE = {
  runner: 'an orange saloon',
  supercar: 'a red sports car',
  offroad: 'a green four-by-four',
};

/** Minimum seconds between any two lines of commentary. */
const GAP = 9;

/** " on Eighth Street", or nothing. */
const on = (road) => (road ? ' ' + road : '');

export class Commentary {
  constructor(game) {
    this.game = game;
    this.reset();
  }

  reset() {
    this.gap = 0;
    this.cool = {};
    this.primary = null;
    this.secondary = null;
    this.lastTier = 0;
    this.seenBefore = false;
    this.lostFor = 0;
    this.lostCalled = false;
    this.controlLostCalled = false;
    this.seenFor = 0;
    this.searchTimer = 0;
    this.runTimer = 6;
    this.pinnedFor = 0;
    this.pinStage = 0;
    this.offRoadFor = 0;
    this.disabled = new Set();
    this.heliLocked = false;
    this.heliTimer = 0;
    this.lastImpactAt = 0;
    // Whether anyone has called primary yet this chase. The first call is the
    // one that describes the car; a unit taking over later just says so.
    this.announced = false;
    this.calledPrimary = null;
    this.lastPrimary = null;
    this.pinUnit = null;
  }

  // ---------------------------------------------------------------- speaking

  /**
   * Put a line on the net, if the net is free enough for it.
   *
   * `variants` are wordings for this kind of line (strings, or functions of
   * `vars`); one is only chosen once the line is actually going out, so a line
   * the gap blocked does not use up a wording. `cooldown` is per kind; `force`
   * ignores the gap (not the cooldown), for the lines that must not be lost --
   * an arrest, an escalation.
   */
  _say(kind, variants, vars = {}, { hot = false, cooldown = 10, force = false, low = !hot } = {}) {
    if (!force && this.gap > 0) return false;
    if ((this.cool[kind] || 0) > 0) return false;
    // A routine line only goes out into real quiet on the net (see
    // Game.say). When there is none it is not said *and not spent*: the gap
    // and cooldown stay open, so it goes out at the next pause instead.
    if (!this.game.say(kind.replace(/-U\d+$/, ''), variants, vars, hot, { low })) return false;
    this.gap = GAP;
    this.cool[kind] = cooldown;
    return true;
  }

  // ------------------------------------------------------------- describing

  /** "northbound", from which way the car is actually moving. */
  _heading(vel, fallback) {
    let x = vel.x, z = vel.z;
    if (Math.hypot(x, z) < 2 && fallback) { x = fallback.x; z = fallback.z; }
    if (Math.abs(x) > Math.abs(z)) return x > 0 ? 'eastbound' : 'westbound';
    return z > 0 ? 'northbound' : 'southbound';
  }

  /** "on Eighth Street", or nothing for a road with no name. */
  _road(pos) {
    const r = this.game.roadName(pos);
    return r && !/in the city/.test(r) ? r : '';
  }

  /** Speed as a unit would call it: rounded to the nearest ten. */
  _speed(v) {
    const kph = Math.abs(v.forwardSpeed) * 3.6;
    return Math.max(10, Math.round(kph / 10) * 10);
  }

  /**
   * The junction the car is heading into, if it is close and has a name.
   * Returns { node, name, dist, edge } or null.
   */
  junctionAhead(v) {
    const g = this.game.graph;
    const snap = g.nearestEdge(v.position.x, v.position.z, 30);
    if (!snap) return null;
    const dir = g.edgeDirection(snap.edge, snap.along, { x: 0, z: 1 });
    const along = dir.x * v.linvel.x + dir.z * v.linvel.z;
    const id = along >= 0 ? snap.edge.b : snap.edge.a;
    const n = g.nodes[id];
    if (!n || !n.name || !n.name.includes('/')) return null;
    const dist = Math.hypot(n.x - v.position.x, n.z - v.position.z);
    return { node: n, name: n.name, dist, edge: snap.edge };
  }

  _describe() {
    return DESCRIBE[this.game.player.specKey] || 'the suspect vehicle';
  }

  // ------------------------------------------------------------------ update

  update(dt) {
    const g = this.game;
    const heat = g.heat, d = g.dispatcher, p = g.player;
    if (!p || g.outcome) return;

    this.gap -= dt;
    for (const k of Object.keys(this.cool)) this.cool[k] -= dt;

    if (heat.value <= 0) {
      // Nothing to talk about. Keep the per-chase state clean for the next one.
      if (this.lastTier > 0) {
        const cool = this.cool;
        this.reset();
        this.cool = cool;
      }
      return;
    }

    const k = d.knowledge;
    this._escalation(heat);
    this._roles(d, p, k);
    this._unitsDown(d);

    if (k.seen) {
      this.seenFor += dt;
      this._regained(k, p);
      this.lostFor = 0;
      this.lostCalled = false;
      this.controlLostCalled = false;
      this.searchTimer = 0;
      this._running(dt, p);
      this._offRoad(dt, p);
      this._crashes(p);
      this._helicopter(dt, p);
    } else {
      this.seenFor = 0;
      this.lostFor += dt;
      this._lost(dt, k);
    }

    this._arrest(dt, heat, d, p);
  }

  // --------------------------------------------------------------- the lines

  /** Control raising the response as the heat climbs. */
  _escalation(heat) {
    const tier = heat.tier;
    if (tier > this.lastTier) {
      const lines = {
        2: [
          'Control, pursuit authorised. Commentary please.',
          'Control, all units, pursuit authorised.',
        ],
        3: [
          'Control, tactical contact authorised.',
          'Control, contact authorised. Roadblocks going in.',
        ],
        4: [
          'Control, you may box. Interceptors joining.',
          'Control, interceptors deploying. Box if you can.',
        ],
        5: [
          'Control, all units, critical incident.',
          'Control, critical incident. Every car to assist.',
        ],
      };
      if (lines[tier]) this._say(`tier${tier}`, lines[tier], {}, { hot: true, force: true, cooldown: 60 });
    }
    this.lastTier = tier;
  }

  /** Who is primary and secondary: the two nearest units actually chasing. */
  _roles(d, p, k) {
    if (!k.seen) return;
    const chasing = d.units
      .filter((u) => !u.vehicle.disabled
        && (u.role === 'pursue' || u.role === 'pit' || u.role === 'box'))
      .map((u) => ({ u, dist: u.distanceTo(p.position) }))
      .filter((x) => x.dist < 260)
      .sort((a, b) => a.dist - b.dist);
    let first = chasing[0] ? chasing[0].u : null;
    let second = chasing[1] ? chasing[1].u : null;
    // Hysteresis. Two cars trading places a length apart would otherwise hand
    // primary back and forth -- "taking over as primary" every fourteen
    // seconds. The current primary keeps it until somebody is well ahead of it.
    const held = chasing.find((x) => x.u === this.calledPrimary);
    if (held && chasing[0] && held.dist < chasing[0].dist + 25) {
      second = first === held.u ? second : first;
      first = held.u;
    }

    // Who is primary is tracked every frame; who has *said* so is tracked
    // separately, so a change the net was too busy for is announced when there
    // is room rather than silently skipped.
    this.primary = first;
    if (first) this.lastPrimary = first;
    if (first && first !== this.calledPrimary && (this.cool.primary || 0) <= 0) {
      const opening = !this.announced;
      const vars = {
        cs: first.callsign, car: this._describe(),
        dir: this._heading(p.linvel, p.forward), road: this._road(p.position),
      };
      const said = opening
        ? this._say('primary-open', [
          (v) => `${v.cs}, I'm primary, following ${v.car}.`,
          (v) => `${v.cs}, show me primary, ${v.dir}${on(v.road)}.`,
          (v) => `${v.cs}, primary, behind ${v.car}, ${v.dir}.`,
        ], vars, { hot: true, force: true, cooldown: 14 })
        : this._say('primary', [
          (v) => `${v.cs}, I'm primary now.`,
          (v) => `${v.cs}, taking primary.`,
          (v) => `${v.cs}, I've got the lead.`,
        ], vars, { cooldown: 30 });
      if (said) {
        this.cool.primary = 30;
        this.calledPrimary = first;
        this.announced = true;
        this.runTimer = 16;
      }
    }
    if (second && second !== this.secondary && this.calledPrimary === first) {
      if (this._say('secondary', [
        (v) => `${v.cs}, secondary.`,
        (v) => `${v.cs}, show me secondary.`,
        (v) => `${v.cs}, backing up ${v.p}.`,
      ], { cs: second.callsign, p: first.callsign }, { cooldown: 60 })) {
        this.secondary = second;
      }
    }
  }

  /** The primary's running commentary: which way, where, how fast. */
  _running(dt, p) {
    this.runTimer -= dt;
    if (this.runTimer > 0) return;
    // Only once somebody has actually called primary: the commentary is theirs
    // to give, and a unit narrating before anyone has said they are chasing
    // reads as the net talking to itself.
    if (!this.primary || this.primary.vehicle.disabled || this.calledPrimary !== this.primary) return;

    const kph = Math.abs(p.forwardSpeed) * 3.6;
    const snap = this.game.graph.nearestEdge(p.position.x, p.position.z, 20);
    const ahead = this.junctionAhead(p);
    const v = {
      cs: this.primary.callsign, dir: this._heading(p.linvel, p.forward),
      road: this._road(p.position), speed: this._speed(p), junction: ahead && ahead.name,
    };

    let kind, lines;
    if (kph < 12) {
      kind = 'run-slow';
      lines = [
        (x) => `${x.cs}, they're slowing${on(x.road)}.`,
        (x) => `${x.cs}, almost stopped, stand by.`,
        (x) => `${x.cs}, crawling now. Could bail.`,
      ];
    } else if (snap && snap.edge.kind === 'motorway') {
      kind = 'run-motorway';
      lines = [
        (x) => `${x.cs}, motorway, ${x.dir}, ${x.speed}.`,
        (x) => `${x.cs}, still on the motorway, ${x.speed}.`,
        (x) => `${x.cs}, ${x.dir} on the motorway.`,
      ];
    } else if (ahead && ahead.dist < 90 && kph > 20) {
      kind = 'run-junction';
      lines = [
        (x) => `${x.cs}, approaching ${x.junction}.`,
        (x) => `${x.cs}, coming up to ${x.junction}, ${x.speed}.`,
        (x) => `${x.cs}, heading for ${x.junction}.`,
      ];
    } else if (kph > 150) {
      kind = 'run-fast';
      lines = [
        (x) => `${x.cs}, speeds ${x.speed}. Losing ground.`,
        (x) => `${x.cs}, ${x.speed} plus, ${x.dir}.`,
        (x) => `${x.cs}, ${x.speed}, very dangerous driving.`,
      ];
    } else {
      kind = 'run';
      lines = [
        (x) => `${x.cs}, ${x.dir}${on(x.road)}, ${x.speed}.`,
        (x) => `${x.cs}, still with them, ${x.dir}.`,
        (x) => `${x.cs}, speed ${x.speed}, ${x.dir}.`,
        (x) => `${x.cs}, no change${on(x.road)}.`,
      ];
    }
    if (this._say(kind, lines, v, { cooldown: 20 })) {
      this.runTimer = 22 + Math.random() * 8;
    }
  }

  /**
   * Through a red light. Called by the game, which does the detecting --
   * running a red in front of a patrol car is also what can start a chase.
   * `witness` is the unit that saw it, or null.
   */
  onRanRed(junction, witness, startsChase) {
    const k = this.game.dispatcher.knowledge;
    const who = witness || this.primary || (k.spotter && k.spotter.callsign ? k.spotter : null);
    if (!who) return;
    const v = { cs: who.callsign, junction, car: this._describe() };
    if (startsChase) {
      // Not rate-limited against anything: this is how the chase begins.
      this.game.say('red-start', [
        (x) => `${x.cs}, ${x.car} just ran the red at ${x.junction}. Going after it.`,
        (x) => `${x.cs}, red light at ${x.junction}, right in front of me. Lights on.`,
        (x) => `${x.cs}, ${x.car} through a red at ${x.junction}. Stopping it.`,
      ], v, true);
      this.gap = GAP;
      return;
    }
    this._say('red', [
      (x) => `${x.cs}, through a red at ${x.junction}.`,
      (x) => `${x.cs}, they've run the red at ${x.junction}.`,
      (x) => `${x.cs}, red light, ${x.junction}. Didn't even brake.`,
    // An event, not routine commentary: it is not held back behind "on my
    // way" from a unit that happened to speak first.
    ], v, { cooldown: 18, force: true, low: false });
  }

  /** Off the carriageway, across whatever is there. */
  _offRoad(dt, p) {
    const sim = this.game.sim;
    const off = sim && sim.surfaceAt && sim.surfaceAt(p.position.x, p.position.z) === 0
      && Math.abs(p.forwardSpeed) > 6;
    this.offRoadFor = off ? this.offRoadFor + dt : 0;
    if (this.offRoadFor > 1.2 && this.primary) {
      this._say('offroad', [
        (x) => `${x.cs}, they've left the road.`,
        (x) => `${x.cs}, off-road, across the grass.`,
        (x) => `${x.cs}, gone off the road, following.`,
      ], { cs: this.primary.callsign }, { cooldown: 45 });
    }
  }

  /** The suspect hitting things -- scenery, or the police. */
  _crashes(p) {
    if (!p.lastImpactAt || p.lastImpactAt === this.lastImpactAt) return;
    if (performance.now() - p.lastImpactAt > 200) return;
    this.lastImpactAt = p.lastImpactAt;
    if (p.lastImpact < 5.5) return;

    const d = this.game.dispatcher;
    const rammed = d.units.find((u) => u.distanceTo(p.position) < 6.5);
    if (rammed) {
      if (rammed.vehicle.damage > 0.5) {
        this._say('rammed-bad', [
          (x) => `${x.cs}, rammed, car's badly damaged.`,
          (x) => `${x.cs}, big hit, car's in a bad way.`,
        ], { cs: rammed.callsign }, { hot: true, cooldown: 20 });
      } else {
        this._say('rammed', [
          (x) => `${x.cs}, they've rammed us!`,
          (x) => `${x.cs}, contact, they've hit me!`,
          (x) => `${x.cs}, deliberate ram, still with them.`,
        ], { cs: rammed.callsign }, { hot: true, cooldown: 20 });
      }
      return;
    }
    if (!this.primary) return;
    if (p.damage > 0.6) {
      this._say('crash-bad', [
        (x) => `${x.cs}, crashed again, they're slowing.`,
        (x) => `${x.cs}, car's badly damaged. Won't be long.`,
      ], { cs: this.primary.callsign }, { cooldown: 25 });
    } else {
      this._say('crash', [
        (x) => `${x.cs}, they've hit something, still mobile.`,
        (x) => `${x.cs}, collision, still going.`,
        (x) => `${x.cs}, clipped something, carrying on.`,
      ], { cs: this.primary.callsign }, { cooldown: 25 });
    }
  }

  /** A police car taken out of the chase. */
  _unitsDown(d) {
    for (const u of d.units) {
      if (!u.vehicle.disabled || this.disabled.has(u)) continue;
      this.disabled.add(u);
      this._say(`down-${u.callsign}`, [
        (x) => `${x.cs}, we're out, car's disabled.`,
        (x) => `${x.cs}, car's done, we're out.`,
        (x) => `${x.cs}, immobile, someone take over.`,
      ], { cs: u.callsign }, { hot: true, cooldown: 60 });
      if (this.primary === u) this.primary = null;
      if (this.secondary === u) this.secondary = null;
    }
  }

  /** Losing them, and Control organising the search. */
  _lost(dt, k) {
    if (!this.seenBefore) return;
    if (this.lostFor > 2.5 && !this.lostCalled) {
      // Whoever was primary when they got away -- this.primary is cleared the
      // moment contact goes, so it cannot be used here.
      const v = {
        cs: this.lastPrimary ? this.lastPrimary.callsign : 'Control',
        dir: this._heading(k.velocity), road: this._road(k.position),
      };
      if (this._say('lost', [
        (x) => `${x.cs}, lost visual, last seen ${x.dir}${on(x.road)}.`,
        (x) => `${x.cs}, I've lost them, ${x.dir}.`,
        (x) => `${x.cs}, no longer in sight, ${x.dir}.`,
      ], v, { hot: true, force: true, cooldown: 10 })) {
        this.lostCalled = true;
      }
    }
    if (this.lostFor > 8 && !this.controlLostCalled) {
      const road = this._road(k.position);
      if (this._say('search', [
        (x) => `Control, all units, last seen${x.road ? ' ' + x.road : ' in your area'}. Search the area.`,
        (x) => `Control, all units, search around${x.road ? ' ' + x.road.replace(/^on /, '') : ' the last location'}.`,
        () => 'Control, all units, set up a search.',
      ], { road }, { hot: true, cooldown: 15 })) {
        this.controlLostCalled = true;
        this.searchTimer = 0;
      }
    }
    if (this.controlLostCalled) {
      this.searchTimer += dt;
      if (this.searchTimer > 35) {
        this.searchTimer = 0;
        this._say('searching', [
          'Control, any units, anything on that vehicle?',
          'Control, nothing further. Keep looking.',
          'Control, widen the search.',
          'Control, check car parks and alleys.',
          'Control, update on the search please.',
          'Control, nothing on cameras either.',
        ], {}, { cooldown: 30 });
      }
    }
    this.primary = null;
    this.secondary = null;
  }

  /** Seeing them again after losing them. */
  _regained(k, p) {
    if (this.seenBefore && this.lostFor > 5) {
      const cs = k.spotter && k.spotter.callsign ? k.spotter.callsign
        : (k.spotter === this.game.helicopter ? 'India 99' : 'Control');
      this._say('regained', [
        (x) => `${x.cs}, eyes on! ${x.dir}${on(x.road)}.`,
        (x) => `${x.cs}, got them again, ${x.dir}!`,
        (x) => `${x.cs}, found them! ${x.dir}${on(x.road)}.`,
      ], { cs, dir: this._heading(p.linvel, p.forward), road: this._road(p.position) },
      { hot: true, force: true, cooldown: 10 });
    }
    this.seenBefore = true;
  }

  /** Air support commentary, once the aircraft has them in the light. */
  _helicopter(dt, p) {
    const h = this.game.helicopter;
    if (!h || !h.active) { this.heliLocked = false; return; }
    const v = { dir: this._heading(p.linvel, p.forward), road: this._road(p.position), speed: this._speed(p) };
    if (h.beamLocked && !this.heliLocked) {
      this.heliLocked = true;
      this._say('heli-lock', [
        (x) => `India 99, we have them, ${x.dir}. I'll commentate.`,
        (x) => `India 99, eyes on from above.`,
        (x) => `India 99, vehicle in the light, ${x.dir}.`,
      ], v, { hot: true, cooldown: 30 });
      this.heliTimer = 0;
      return;
    }
    if (!h.beamLocked) { this.heliLocked = false; return; }
    this.heliTimer += dt;
    if (this.heliTimer > 30) {
      this.heliTimer = 0;
      this._say('heli-run', [
        (x) => `India 99, still with them, ${x.dir}, ${x.speed}.`,
        (x) => `India 99, ${x.dir}${on(x.road)}, ground units behind.`,
        (x) => `India 99, ${x.speed}, ${x.dir}. Staying with it.`,
      ], v, { cooldown: 25 });
    }
  }

  /** Pinning the car and moving in, and the car pushing free again. */
  _arrest(dt, heat, d, p) {
    if (heat.bustPinned) {
      this.pinnedFor += dt;
      const near = d.units
        .filter((u) => !u.vehicle.disabled)
        .sort((a, b) => a.distanceTo(p.position) - b.distanceTo(p.position))[0];
      if (near) this.pinUnit = near;
      const cs = near ? near.callsign : 'Control';
      if (this.pinStage === 0 && this.pinnedFor > 0.8) {
        this.pinStage = 1;
        this._say('pin1', [
          (x) => `${x.cs}, they're stopped! Moving in.`,
          (x) => `${x.cs}, stopped, going in!`,
          (x) => `${x.cs}, vehicle pinned, out and on them!`,
        ], { cs }, { hot: true, force: true, cooldown: 20 });
      } else if (this.pinStage === 1 && heat.bustProgress > 0.55) {
        this.pinStage = 2;
        this._say('pin2', [
          (x) => `${x.cs}, blocked in, going to the driver.`,
          (x) => `${x.cs}, going nowhere. At the door.`,
          (x) => `${x.cs}, boxed in, getting the driver out.`,
        ], { cs }, { hot: true, force: true, cooldown: 20 });
      }
    } else {
      if (this.pinStage > 0 && heat.bustTimer <= 0.05) {
        // The unit that had them pinned is the one that saw them get away.
        this._say('pushed', [
          (x) => `${x.cs}, they've pushed free!`,
          (x) => `${x.cs}, they've forced their way out!`,
          (x) => `${x.cs}, they've shoved past us!`,
        ], { cs: this.pinUnit ? this.pinUnit.callsign : 'Control' },
        { hot: true, force: true, cooldown: 20 });
        this.pinStage = 0;
      }
      if (heat.bustTimer <= 0.05) this.pinnedFor = 0;
    }
  }

  /** Called on the arrest itself, before Control stands everybody down. */
  onBusted() {
    const g = this.game, p = g.player;
    const near = g.dispatcher.units
      .filter((u) => !u.vehicle.disabled)
      .sort((a, b) => a.distanceTo(p.position) - b.distanceTo(p.position))[0];
    const text = g.phrases.pick('detained', [
      (x) => `${x.cs}, one detained.`,
      (x) => `${x.cs}, driver's in custody.`,
      (x) => `${x.cs}, got them. One in cuffs.`,
    ], { cs: near ? near.callsign : 'Unit 1' });
    g.radio(text, true, { final: true });
  }
}
