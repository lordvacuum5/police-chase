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

import { SIGNAL } from './trafficlights.js';

/** How a unit describes the car it is chasing. */
const DESCRIBE = {
  runner: 'an orange saloon',
  supercar: 'a red sports car',
};

/** Minimum seconds between any two lines of commentary. */
const GAP = 4.5;

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
    this.redNodes = new Set();
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
   * `cooldown` is per kind; `force` ignores the gap (not the cooldown), for
   * the lines that must not be lost -- an arrest, an escalation.
   */
  _say(kind, text, { hot = false, cooldown = 10, force = false, low = !hot } = {}) {
    if (!force && this.gap > 0) return false;
    if ((this.cool[kind] || 0) > 0) return false;
    this.game.radio(text, hot, { low });
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
   * Returns { node, name, dist } or null.
   */
  _junctionAhead(v) {
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
      this._running(dt, p, k);
      this._redLights(p);
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
        2: 'Control, all units, pursuit is authorised. Primary unit, keep the commentary coming.',
        3: 'Control, tactical contact is authorised. Roadblocks going in ahead of them.',
        4: 'Control, all units, you are authorised to box. Interceptors are joining.',
        5: 'Control, all available units. This is now a critical incident.',
      };
      if (lines[tier]) this._say(`tier${tier}`, lines[tier], { hot: true, force: true, cooldown: 60 });
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
      const road = this._road(p.position);
      const text = opening
        ? `${first.callsign}, I'm primary, in pursuit of ${this._describe()}, `
          + `${this._heading(p.linvel, p.forward)}${road ? ' ' + road : ''}.`
        : `${first.callsign}, I've got them, taking over as primary.`;
      if (this._say('primary', text, { hot: opening, force: opening, cooldown: 14 })) {
        this.calledPrimary = first;
        this.announced = true;
        this.runTimer = 11;
      }
    }
    if (second && second !== this.secondary && this.calledPrimary === first) {
      if (this._say('secondary', `${second.callsign}, I'm secondary, right behind ${first.callsign}.`,
        { cooldown: 20 })) {
        this.secondary = second;
      }
    }
  }

  /** The primary's running commentary: which way, where, how fast. */
  _running(dt, p, k) {
    this.runTimer -= dt;
    if (this.runTimer > 0) return;
    // Only once somebody has actually called primary: the commentary is theirs
    // to give, and a unit narrating before anyone has said they are chasing
    // reads as the net talking to itself.
    if (!this.primary || this.primary.vehicle.disabled || this.calledPrimary !== this.primary) return;
    const who = this.primary.callsign;

    const kph = Math.abs(p.forwardSpeed) * 3.6;
    const dir = this._heading(p.linvel, p.forward);
    const road = this._road(p.position);
    const snap = this.game.graph.nearestEdge(p.position.x, p.position.z, 20);
    const onMotorway = snap && snap.edge.kind === 'motorway';
    const ahead = this._junctionAhead(p);

    let text;
    if (kph < 12) {
      text = `${who}, they've slowed right down${road ? ' ' + road : ''}. Stand by.`;
    } else if (onMotorway) {
      text = `${who}, on the motorway now, ${dir}, speeds ${this._speed(p)}.`;
    } else if (ahead && ahead.dist < 90 && kph > 20) {
      text = `${who}, ${dir}, approaching ${ahead.name}, speeds ${this._speed(p)}.`;
    } else if (kph > 150) {
      text = `${who}, speeds ${this._speed(p)}, ${dir}${road ? ' ' + road : ''}. I'm struggling to keep up.`;
    } else {
      text = `${who}, still with them, ${dir}${road ? ' ' + road : ''}, speeds ${this._speed(p)}.`;
    }
    if (this._say('running', text, { cooldown: 9 })) {
      this.runTimer = 11 + Math.random() * 4;
    }
  }

  /** Through a red light at a signalised junction. */
  _redLights(p) {
    const signals = this.game.signals;
    if (!signals || Math.abs(p.forwardSpeed) < 8) return;
    const ahead = this._junctionAhead(p);
    if (!ahead || ahead.dist > 9 || this.redNodes.has(ahead.node.id)) return;
    if (signals.stateFor(ahead.edge, ahead.node) !== SIGNAL.RED) return;
    this.redNodes.add(ahead.node.id);
    // Somebody has to have seen it. Control is at a desk.
    const k = this.game.dispatcher.knowledge;
    const who = this.primary ? this.primary.callsign
      : (k.spotter && k.spotter.callsign) || null;
    if (!who) return;
    this._say('red', `${who}, they've gone straight through a red at ${ahead.name}.`,
      { cooldown: 18, force: true });
  }

  /** Off the carriageway, across whatever is there. */
  _offRoad(dt, p) {
    const sim = this.game.sim;
    const off = sim && sim.surfaceAt && sim.surfaceAt(p.position.x, p.position.z) === 0
      && Math.abs(p.forwardSpeed) > 6;
    this.offRoadFor = off ? this.offRoadFor + dt : 0;
    if (this.offRoadFor > 1.2 && this.primary) {
      this._say('offroad', `${this.primary.callsign}, they've left the road, going across open ground.`,
        { cooldown: 25 });
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
      const text = rammed.vehicle.damage > 0.5
        ? `${rammed.callsign}, they've rammed us. Vehicle's badly damaged.`
        : `${rammed.callsign}, they've rammed us! Still in pursuit.`;
      this._say('rammed', text, { hot: true, cooldown: 12 });
      return;
    }
    if (!this.primary) return;
    const text = p.damage > 0.6
      ? `${this.primary.callsign}, they've crashed again, car's in a bad way, they're slowing.`
      : `${this.primary.callsign}, they've hit something, still mobile.`;
    this._say('crash', text, { cooldown: 15 });
  }

  /** A police car taken out of the chase. */
  _unitsDown(d) {
    for (const u of d.units) {
      if (!u.vehicle.disabled || this.disabled.has(u)) continue;
      this.disabled.add(u);
      this._say(`down-${u.callsign}`, `${u.callsign}, we're out of it, vehicle's disabled.`,
        { hot: true, cooldown: 60 });
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
      const who = this.lastPrimary ? this.lastPrimary.callsign : 'Control';
      const road = this._road(k.position);
      const dir = this._heading(k.velocity);
      if (this._say('lost', `${who}, lost visual. Last seen ${dir}${road ? ' ' + road : ''}.`,
        { hot: true, force: true, cooldown: 10 })) {
        this.lostCalled = true;
      }
    }
    if (this.lostFor > 8 && !this.controlLostCalled) {
      const road = this._road(k.position);
      if (this._say('search', `Control, all units, suspect last seen${road ? ' ' + road : ' in your area'}. Search the area and report.`,
        { hot: true, cooldown: 15 })) {
        this.controlLostCalled = true;
        this.searchTimer = 0;
      }
    }
    if (this.controlLostCalled) {
      this.searchTimer += dt;
      if (this.searchTimer > 20) {
        this.searchTimer = 0;
        const lines = [
          'Control, any units, anything on that vehicle?',
          'Control, still no further sighting. Keep looking.',
          'Control, units widen the search. They cannot have gone far.',
        ];
        this._say('searching', lines[(Math.random() * lines.length) | 0], { cooldown: 18 });
      }
    }
    this.primary = null;
    this.secondary = null;
  }

  /** Seeing them again after losing them. */
  _regained(k, p) {
    if (this.seenBefore && this.lostFor > 5) {
      const who = k.spotter && k.spotter.callsign ? k.spotter.callsign
        : (k.spotter === this.game.helicopter ? 'India 99' : 'Control');
      const road = this._road(p.position);
      this._say('regained', `${who}, eyes on! They're ${this._heading(p.linvel, p.forward)}${road ? ' ' + road : ''}.`,
        { hot: true, force: true, cooldown: 10 });
    }
    this.seenBefore = true;
  }

  /** Air support commentary, once the aircraft has them in the light. */
  _helicopter(dt, p) {
    const h = this.game.helicopter;
    if (!h || !h.active) { this.heliLocked = false; return; }
    const road = this._road(p.position);
    const dir = this._heading(p.linvel, p.forward);
    if (h.beamLocked && !this.heliLocked) {
      this.heliLocked = true;
      this._say('heli-lock', `India 99, we have them. ${dir}${road ? ' ' + road : ''}. I'll commentate.`,
        { hot: true, cooldown: 30 });
      this.heliTimer = 0;
      return;
    }
    if (!h.beamLocked) { this.heliLocked = false; return; }
    this.heliTimer += dt;
    if (this.heliTimer > 14) {
      this.heliTimer = 0;
      this._say('heli-run', `India 99, still with them, ${dir}${road ? ' ' + road : ''}, speeds ${this._speed(p)}.`,
        { cooldown: 12 });
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
      const who = near ? near.callsign : 'Control';
      if (this.pinStage === 0 && this.pinnedFor > 0.8) {
        this.pinStage = 1;
        this._say('pin1', `${who}, suspect vehicle's stopped! Moving in.`, { hot: true, force: true, cooldown: 8 });
      } else if (this.pinStage === 1 && heat.bustProgress > 0.55) {
        this.pinStage = 2;
        this._say('pin2', `${who}, we've got them blocked in. Going to the driver.`, { hot: true, force: true, cooldown: 8 });
      }
    } else {
      if (this.pinStage > 0 && heat.bustTimer <= 0.05) {
        // The unit that had them pinned is the one that saw them get away.
        const who = this.pinUnit ? this.pinUnit.callsign : 'Control';
        this._say('pushed', `${who}, they've pushed free! Still going.`,
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
    g.radio(`${near ? near.callsign : 'Unit 1'}, one detained. Driver's out of the vehicle.`, true, { final: true });
  }
}
