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
// low priority, so the audio side drops it rather than reading it out late
// behind a call that matters.
//
// Every kind of line has several wordings, drawn through the game's phrasebook
// so the same one does not come round again until the others have had a turn
// (see game/phrases.js). A search used to produce "Control, still no further
// sighting, keep looking" three times in a row.

/** How a unit describes the car it is chasing. */
const DESCRIBE = {
  runner: 'an orange saloon',
  supercar: 'a red sports car',
};

/** Minimum seconds between any two lines of commentary. */
const GAP = 4.5;

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
    this.game.say(kind.replace(/-U\d+$/, ''), variants, vars, hot, { low });
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
          'Control, all units, pursuit is authorised. Primary unit, keep the commentary coming.',
          'Control, pursuit authorised. Keep me updated on direction and speed.',
        ],
        3: [
          'Control, tactical contact is authorised. Roadblocks going in ahead of them.',
          'Control, all units, you may use tactical contact. Setting up roadblocks.',
        ],
        4: [
          'Control, all units, you are authorised to box. Interceptors are joining.',
          'Control, interceptors deploying. Box them in if you get the chance.',
        ],
        5: [
          'Control, all available units. This is now a critical incident.',
          'Control, all units, this is now a critical incident. Every available car to assist.',
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
          (v) => `${v.cs}, I'm primary, in pursuit of ${v.car}, ${v.dir}${on(v.road)}.`,
          (v) => `${v.cs}, show me primary. Following ${v.car}, ${v.dir}${on(v.road)}.`,
          (v) => `${v.cs}, primary unit, behind ${v.car} ${v.dir}${on(v.road)}.`,
        ], vars, { hot: true, force: true, cooldown: 14 })
        : this._say('primary', [
          (v) => `${v.cs}, I've got them, taking over as primary.`,
          (v) => `${v.cs}, I'm primary now.`,
          (v) => `${v.cs}, taking the lead on this one.`,
          (v) => `${v.cs}, I'm closest, I'll take primary.`,
        ], vars, { cooldown: 14 });
      if (said) {
        this.cool.primary = 14;
        this.calledPrimary = first;
        this.announced = true;
        this.runTimer = 11;
      }
    }
    if (second && second !== this.secondary && this.calledPrimary === first) {
      if (this._say('secondary', [
        (v) => `${v.cs}, I'm secondary, right behind ${v.p}.`,
        (v) => `${v.cs}, show me secondary.`,
        (v) => `${v.cs}, backing up ${v.p}, I'm secondary.`,
      ], { cs: second.callsign, p: first.callsign }, { cooldown: 20 })) {
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
        (x) => `${x.cs}, they've slowed right down${on(x.road)}. Stand by.`,
        (x) => `${x.cs}, vehicle's almost stopped${on(x.road)}, stand by.`,
        (x) => `${x.cs}, they're crawling now${on(x.road)}. Could be about to bail.`,
      ];
    } else if (snap && snap.edge.kind === 'motorway') {
      kind = 'run-motorway';
      lines = [
        (x) => `${x.cs}, on the motorway now, ${x.dir}, speeds ${x.speed}.`,
        (x) => `${x.cs}, motorway, ${x.dir}, doing ${x.speed}.`,
        (x) => `${x.cs}, still on the motorway, ${x.speed}, all lanes.`,
      ];
    } else if (ahead && ahead.dist < 90 && kph > 20) {
      kind = 'run-junction';
      lines = [
        (x) => `${x.cs}, ${x.dir}, approaching ${x.junction}, speeds ${x.speed}.`,
        (x) => `${x.cs}, coming up to ${x.junction}, ${x.speed}.`,
        (x) => `${x.cs}, heading for ${x.junction}, ${x.dir}.`,
      ];
    } else if (kph > 150) {
      kind = 'run-fast';
      lines = [
        (x) => `${x.cs}, speeds ${x.speed}, ${x.dir}${on(x.road)}. I'm struggling to keep up.`,
        (x) => `${x.cs}, they're really moving, ${x.speed} plus, ${x.dir}.`,
        (x) => `${x.cs}, speed ${x.speed}${on(x.road)}, extremely dangerous driving.`,
      ];
    } else {
      kind = 'run';
      lines = [
        (x) => `${x.cs}, still with them, ${x.dir}${on(x.road)}, speeds ${x.speed}.`,
        (x) => `${x.cs}, ${x.dir}${on(x.road)}, ${x.speed}.`,
        (x) => `${x.cs}, vehicle continuing ${x.dir}${on(x.road)}.`,
        (x) => `${x.cs}, speed ${x.speed}, direction ${x.dir}.`,
        (x) => `${x.cs}, no change, still ${x.dir}${on(x.road)}.`,
      ];
    }
    if (this._say(kind, lines, v, { cooldown: 9 })) {
      this.runTimer = 11 + Math.random() * 4;
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
        (x) => `${x.cs}, ${x.car} just went straight through a red at ${x.junction}. I'm going after it.`,
        (x) => `${x.cs}, vehicle's run the red at ${x.junction}, right in front of me. Lights on, following.`,
        (x) => `${x.cs}, did you see that? Red light at ${x.junction}. I'm stopping that car.`,
      ], v, true);
      this.gap = GAP;
      return;
    }
    this._say('red', [
      (x) => `${x.cs}, they've gone straight through a red at ${x.junction}.`,
      (x) => `${x.cs}, through the red at ${x.junction}, nearly took someone out.`,
      (x) => `${x.cs}, red light at ${x.junction}, they didn't even brake.`,
    ], v, { cooldown: 18, force: true });
  }

  /** Off the carriageway, across whatever is there. */
  _offRoad(dt, p) {
    const sim = this.game.sim;
    const off = sim && sim.surfaceAt && sim.surfaceAt(p.position.x, p.position.z) === 0
      && Math.abs(p.forwardSpeed) > 6;
    this.offRoadFor = off ? this.offRoadFor + dt : 0;
    if (this.offRoadFor > 1.2 && this.primary) {
      this._say('offroad', [
        (x) => `${x.cs}, they've left the road, going across open ground.`,
        (x) => `${x.cs}, off-road now, across the grass.`,
        (x) => `${x.cs}, they've gone off the road. I'll follow if I can.`,
      ], { cs: this.primary.callsign }, { cooldown: 25 });
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
          (x) => `${x.cs}, they've rammed us. Vehicle's badly damaged.`,
          (x) => `${x.cs}, taken a big hit, car's in a bad way.`,
        ], { cs: rammed.callsign }, { hot: true, cooldown: 12 });
      } else {
        this._say('rammed', [
          (x) => `${x.cs}, they've rammed us! Still in pursuit.`,
          (x) => `${x.cs}, contact! They've gone into the side of me.`,
          (x) => `${x.cs}, they've hit my car, deliberate, still with them.`,
        ], { cs: rammed.callsign }, { hot: true, cooldown: 12 });
      }
      return;
    }
    if (!this.primary) return;
    if (p.damage > 0.6) {
      this._say('crash-bad', [
        (x) => `${x.cs}, they've crashed again, car's in a bad way, they're slowing.`,
        (x) => `${x.cs}, vehicle is heavily damaged now. Won't be long.`,
      ], { cs: this.primary.callsign }, { cooldown: 15 });
    } else {
      this._say('crash', [
        (x) => `${x.cs}, they've hit something, still mobile.`,
        (x) => `${x.cs}, collision, but they're carrying on.`,
        (x) => `${x.cs}, they've clipped something, still going.`,
      ], { cs: this.primary.callsign }, { cooldown: 15 });
    }
  }

  /** A police car taken out of the chase. */
  _unitsDown(d) {
    for (const u of d.units) {
      if (!u.vehicle.disabled || this.disabled.has(u)) continue;
      this.disabled.add(u);
      this._say(`down-${u.callsign}`, [
        (x) => `${x.cs}, we're out of it, vehicle's disabled.`,
        (x) => `${x.cs}, car's done, we're out.`,
        (x) => `${x.cs}, I'm immobile, someone else take over.`,
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
        (x) => `${x.cs}, lost visual. Last seen ${x.dir}${on(x.road)}.`,
        (x) => `${x.cs}, I've lost them. They were ${x.dir}${on(x.road)}.`,
        (x) => `${x.cs}, no longer in sight, last direction ${x.dir}.`,
      ], v, { hot: true, force: true, cooldown: 10 })) {
        this.lostCalled = true;
      }
    }
    if (this.lostFor > 8 && !this.controlLostCalled) {
      const road = this._road(k.position);
      if (this._say('search', [
        (x) => `Control, all units, suspect last seen${x.road ? ' ' + x.road : ' in your area'}. Search the area and report.`,
        (x) => `Control, all units, make your way to${x.road ? ' ' + x.road.replace(/^on /, '') : ' the last location'} and start searching.`,
        () => 'Control, all units, set up a search. Check the side streets.',
      ], { road }, { hot: true, cooldown: 15 })) {
        this.controlLostCalled = true;
        this.searchTimer = 0;
      }
    }
    if (this.controlLostCalled) {
      this.searchTimer += dt;
      if (this.searchTimer > 20) {
        this.searchTimer = 0;
        this._say('searching', [
          'Control, any units, anything on that vehicle?',
          'Control, still no further sighting. Keep looking.',
          'Control, units widen the search. They cannot have gone far.',
          'Control, check car parks and alleys, they may have gone to ground.',
          'Control, all units, update on the search please.',
          'Control, nothing on cameras either. Keep at it.',
        ], {}, { cooldown: 18 });
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
        (x) => `${x.cs}, eyes on! They're ${x.dir}${on(x.road)}.`,
        (x) => `${x.cs}, got them again, ${x.dir}${on(x.road)}!`,
        (x) => `${x.cs}, found them! They are ${x.dir}${on(x.road)}.`,
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
        (x) => `India 99, we have them. ${x.dir}${on(x.road)}. I'll commentate.`,
        (x) => `India 99, eyes on from above, ${x.dir}${on(x.road)}.`,
        (x) => `India 99, got the vehicle in the light, ${x.dir}.`,
      ], v, { hot: true, cooldown: 30 });
      this.heliTimer = 0;
      return;
    }
    if (!h.beamLocked) { this.heliLocked = false; return; }
    this.heliTimer += dt;
    if (this.heliTimer > 14) {
      this.heliTimer = 0;
      this._say('heli-run', [
        (x) => `India 99, still with them, ${x.dir}${on(x.road)}, speeds ${x.speed}.`,
        (x) => `India 99, vehicle continuing ${x.dir}, ground units are behind.`,
        (x) => `India 99, ${x.speed}, ${x.dir}${on(x.road)}. We'll stay with it.`,
      ], v, { cooldown: 12 });
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
          (x) => `${x.cs}, suspect vehicle's stopped! Moving in.`,
          (x) => `${x.cs}, they're stopped, going in now!`,
          (x) => `${x.cs}, vehicle's pinned, out and on them!`,
        ], { cs }, { hot: true, force: true, cooldown: 8 });
      } else if (this.pinStage === 1 && heat.bustProgress > 0.55) {
        this.pinStage = 2;
        this._say('pin2', [
          (x) => `${x.cs}, we've got them blocked in. Going to the driver.`,
          (x) => `${x.cs}, they're not going anywhere. At the driver's door.`,
          (x) => `${x.cs}, boxed in, getting the driver out.`,
        ], { cs }, { hot: true, force: true, cooldown: 8 });
      }
    } else {
      if (this.pinStage > 0 && heat.bustTimer <= 0.05) {
        // The unit that had them pinned is the one that saw them get away.
        this._say('pushed', [
          (x) => `${x.cs}, they've pushed free! Still going.`,
          (x) => `${x.cs}, they've forced their way out!`,
          (x) => `${x.cs}, lost them, they've shoved past us!`,
        ], { cs: this.pinUnit ? this.pinUnit.callsign : 'Control' },
        { hot: true, force: true, cooldown: 10 });
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
      (x) => `${x.cs}, one detained. Driver's out of the vehicle.`,
      (x) => `${x.cs}, driver's in custody, one detained.`,
      (x) => `${x.cs}, got them. One in cuffs.`,
    ], { cs: near ? near.callsign : 'Unit 1' });
    g.radio(text, true, { final: true });
  }
}
