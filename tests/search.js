// Do the police look anywhere but the road?
//
// The player is parked off the road -- a field, a car park, the back of an
// estate -- and the force has just lost contact at the nearest bit of road.
// Spotting is switched off, so the search runs the whole time and what gets
// measured is where it goes:
//
//   offRoad    share of the searching units' time spent well away from any road
//              (more than a carriageway's half width plus 6 m)
//   deepest    furthest any searching unit got from a road, metres
//   foundAt    seconds until a unit would have seen the car -- inside the
//              stopped-target sight range with a clear line to it -- or null
//   nearest    closest any unit got to the hidden car, metres
//   crashes    impacts on searching units away from other cars
//   stuck      share of the time units spent below 1 m/s
window.__runSearch = async function (seconds = 60, seed = 7, tier = 3, minOff = 30, maxOff = 90) {
  try {
    const g = window.__game, gr = g.graph, p = g.player;
    const W = await import('/src/physics/world.js');
    if (g.audio) g.audio.muted = true;
    const wasPaused = g.paused;
    g.paused = true;
    g.onBusted = () => { g.outcome = null; g.heat.bustTimer = 0; };
    g.onEscaped = () => { g.outcome = null; };
    g.restart();

    let s = seed >>> 0;
    const rnd = () => {
      s = (s + 0x6D2B79F5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    g.rng = rnd;

    // Somewhere to hide: off the road, minOff-maxOff m from it, not inside anything.
    const solid = W.groups(0xFFFF, W.GROUP.BUILDING | W.GROUP.PROP);
    const blocked = (x, z) => {
      for (const [ox, oz] of [[0, 0], [2.5, 0], [-2.5, 0], [0, 2.5], [0, -2.5]]) {
        if (W.raycast(g.world, { x: x + ox, y: 40, z: z + oz }, { x: 0, y: -1, z: 0 }, 39.5, solid)) return true;
      }
      return false;
    };
    let hide = null, snap = null;
    for (let i = 0; i < 4000 && !hide; i++) {
      const x = (rnd() - 0.5) * 1300, z = (rnd() - 0.5) * 1300;
      if (g.sim.surfaceAt(x, z) === 1) continue;
      const e = gr.nearestEdge(x, z);
      if (!e || e.dist - e.edge.width * 0.5 < minOff || e.dist - e.edge.width * 0.5 > maxOff) continue;
      if (blocked(x, z)) continue;
      hide = { x, z }; snap = e;
    }
    if (!hide) return 'no hiding place found';

    p.repair();
    p.teleport({ x: hide.x, y: 0.95 + (g.sim.heightAt ? g.sim.heightAt(hide.x, hide.z) : 0), z: hide.z }, rnd() * 6.28);
    p._readState();

    // Contact lost where the car left the road.
    const lost = new (window.__modules.THREE.Vector3)(snap.x, 0, snap.z);
    g.heat.value = 0; g.heat.bump(1, 'test'); g.heat.value = tier + 0.3;
    const d = g.dispatcher, k = d.knowledge;
    k.seen = false; k.position.copy(lost); k.timeSinceSeen = 8;
    const realKnow = d._updateKnowledge;
    d._updateKnowledge = function (dt) {
      k.seen = false; k.spotter = null;
      k.timeSinceSeen = Math.min(k.timeSinceSeen + dt, 30);
      k.position.copy(lost);
      this.sightRange = (55 + this.tier * 10) * 1.2 * 0.6;
      this.inContact = false;
    };
    const realHeli = g.helicopter.update;
    g.helicopter.update = () => {};

    const origU = g._update.bind(g);
    g._update = (dt) => {
      g.heat.value = tier + 0.3;
      g.forceControls = { throttle: 0, brake: 1, steer: 0, handbrake: 1 };
      origU(dt);
    };

    const range = (55 + tier * 10) * 1.2 * 0.6;
    const seen = new WeakMap();
    const crashLog = [];
    let t = 0, samples = 0, off = 0, slow = 0, deepest = 0, foundAt = null, nearest = Infinity, crashes = 0;
    const eye = { x: 0, y: 0, z: 0 }, tgt = { x: hide.x, y: 0.8, z: hide.z };
    while (t < seconds) {
      g.stepHeadless(1 / 30, null, 1 / 30);
      t += 1 / 30;
      for (const u of d.units) {
        const v = u.vehicle;
        const last = seen.get(v);
        if (last === undefined) seen.set(v, v.lastImpactAt || 0);
        else if (v.lastImpactAt && v.lastImpactAt !== last) {
          seen.set(v, v.lastImpactAt);
          const other = g.vehicles.some((o) => o !== v && Math.hypot(o.position.x - v.position.x, o.position.z - v.position.z) < 6.5);
          if (!other && u.role === 'search') {
            crashes++;
            // What was right there, by kind, within four metres.
            const near = {};
            for (const [name, bit] of Object.entries(W.GROUP)) {
              if (name === 'VEHICLE' || name === 'TERRAIN') continue;
              let best = Infinity;
              for (let a = 0; a < 16; a++) {
                const h = W.raycast(g.world, { x: v.position.x, y: v.position.y + 0.1, z: v.position.z },
                  { x: Math.sin(a * Math.PI / 8), y: 0, z: Math.cos(a * Math.PI / 8) }, 4, W.groups(0xFFFF, bit), v.body);
                if (h) best = Math.min(best, h.toi);
              }
              if (best < 4) near[name.toLowerCase()] = +best.toFixed(1);
            }
            const e = gr.nearestEdge(v.position.x, v.position.z);
            crashLog.push({ t: +t.toFixed(1), kph: +(v.speed * 3.6).toFixed(0), dv: +v.lastImpact.toFixed(1),
              offRoad: e ? +(e.dist - e.edge.width * 0.5).toFixed(0) : null, near,
              mode: u._mode, way: u._wayIn ? u._wayIn.length : 0, surface: g.sim.surfaceAt(v.position.x, v.position.z),
              ground: g.sim.heightAt ? +g.sim.heightAt(v.position.x, v.position.z).toFixed(2) : null });
          }
        }
        if (u.role !== 'search' || v.disabled) continue;
        samples++;
        const e = gr.nearestEdge(v.position.x, v.position.z);
        const out = e ? e.dist - e.edge.width * 0.5 : 0;
        if (out > 6) off++;
        deepest = Math.max(deepest, out);
        if (v.speed < 1) slow++;
        const dh = Math.hypot(v.position.x - hide.x, v.position.z - hide.z);
        nearest = Math.min(nearest, dh);
        if (foundAt === null && dh < range) {
          eye.x = v.position.x; eye.y = v.position.y + 1.1; eye.z = v.position.z;
          if (W.hasLineOfSight(g.world, eye, tgt, 1.5)) foundAt = +t.toFixed(1);
        }
      }
      if (Math.floor(t * 30) % 90 === 0) await new Promise((r) => setTimeout(r, 0));
    }

    g._update = origU;
    d._updateKnowledge = realKnow;
    g.helicopter.update = realHeli;
    g.forceControls = null;
    g.paused = wasPaused;
    return {
      seed, tier, hideFromRoad: +(snap.dist - snap.edge.width * 0.5).toFixed(0),
      searchers: d.units.filter((u) => u.role === 'search').length,
      offRoad: samples ? +(100 * off / samples).toFixed(0) : 0,
      deepest: +deepest.toFixed(0), foundAt, nearest: +nearest.toFixed(0),
      crashes, crashLog, stuck: samples ? +(100 * slow / samples).toFixed(0) : 0,
    };
  } catch (e) {
    return 'EX ' + e.message + ' ' + String(e.stack).slice(0, 300);
  }
};
