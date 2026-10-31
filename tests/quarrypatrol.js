// Patrols round the quarry, nobody wanted. Haldon Vale.
//
// "The police routing system, however, in the quarry is awful. Like, even
// when I patrolled it, I literally left it running for like 30 minutes ...
// when it was just trying to patrol, literally one is just stuck against the
// wall and it just cannot move."
//
// The player's car parked at `where` ('floor', 'rim' or 'track'), wanted level
// held at zero, and the whole game stepped headless for `minutes`. A unit is
// stuck when it has moved under 3 m in 10 s while it has a path to follow.
// Per run:
//
//   stuck    stuck spells, and the longest, s
//   spells   where each began: metres from the quarry's middle, height, and
//            the edge it was on
// `__runDeadEndHold()`: the case it found, set up on purpose. A traffic car
// held still at the turning place of the dead-end farm track west of the
// quarry (edge ending at the node nearest 203,-168), a patrol sent down the
// track toward it. How long until the patrol is 25 m back up the track, or
// null if not in 60 s.
window.__runDeadEndHold = async function () {
  window.__res = null;
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.player && window.__game.heat && window.__game.traffic); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const g = window.__game, gr = g.graph;
    g.onBusted = () => { g.outcome = null; };
    g.stepHeadless(3);
    const end = gr.nearestNode(203, -168);
    const e = gr.edges[end.edges[0]];
    const other = gr.nodes[e.a === end.id ? e.b : e.a];
    // Along the track from the far junction: the patrol 40 m short of the
    // end, the traffic car at it.
    const at = (back) => {
      const along = e.a === end.id ? back : e.length - back;
      const p = gr.edgePoint ? gr.edgePoint(e, along) : null;
      if (p) return p;
      const f = back / e.length;
      return { x: end.x + (other.x - end.x) * f, z: end.z + (other.z - end.z) * f };
    };
    const tp = at(4), pp = at(40);
    const c = g.traffic.cars[0];
    if (!c) throw new Error('no traffic');
    const head = (from, to) => Math.atan2(to.x - from.x, to.z - from.z);
    c.v.teleport({ x: tp.x, y: g.sim.heightAt(tp.x, tp.z) + 0.6, z: tp.z }, head(other, end));
    const u = g.dispatcher.units.find((x) => !x.human && x.vehicle);
    u.vehicle.teleport({ x: pp.x, y: g.sim.heightAt(pp.x, pp.z) + 0.6, z: pp.z }, head(other, end));
    u.setRole && u.setRole('patrol');
    // The patrol going down the track at 40 km/h, bound for somewhere far off
    // the other way, as the one found was: too quick to turn round where it
    // is, so the route runs on to the end of the track and turns there --
    // where the traffic car is held.
    const h = head(other, end);
    u.vehicle.setVelocity({ x: Math.sin(h) * 11, y: 0, z: Math.cos(h) * 11 });
    u._routeTo(gr.nearestNode(-159, -390).id, 3.0);
    // The one found was dormant (traffic.js _sleep): far from the player, no
    // body, moved along its route without physics -- and at the end of the
    // track with no route on, standing still while still reading its cruising
    // speed, 10.5 m/s. So: the car asleep, no route, and the player 170 m
    // off, as then -- far enough that it stays asleep (it wakes inside 150 m),
    // near enough that the patrol is never retired as stranded (200 m,
    // Dispatcher._manageRoster), which is why it was there for good.
    // Back along the track's line behind the patrol, so the car is beyond
    // waking range and the patrol is inside 200 m.
    const ax = other.x - end.x, az = other.z - end.z, al = Math.hypot(ax, az);
    const px = end.x + ax / al * 175, pz = end.z + az / al * 175;
    g.player.teleport({ x: px, y: g.sim.heightAt(px, pz) + 1, z: pz }, 0);
    c.v.setVelocity({ x: 0, y: 0, z: 0 });
    // One step first, so the player's position is where it was put before
    // traffic measures how far off it is.
    g._update(1 / 30);
    g.traffic._sleep(c);
    c.cruise = 10.5;
    // Not made a suspect for blocking the patrol (game/suspects.js): that is
    // another way out, and not the one being measured.
    const realSuspects = g.suspects && g.suspects.update;
    if (g.suspects) g.suspects.update = () => {};
    const realRoute = g.traffic._route.bind(g.traffic);
    g.traffic._route = (car) => { if (car !== c) realRoute(car); };
    let away = null;
    const trace = [];
    for (let i = 0; i < 60 * 30; i++) {
      g.heat.value = 0;
      c.driver.setPath([]);
      g._update(1 / 30);
      const p = u.vehicle.position;
      if (i % 150 === 0) {
        trace.push([i / 30, Math.round(Math.hypot(p.x - end.x, p.z - end.z)), +u.vehicle.speed.toFixed(1),
          u._obstacle === c.v ? 'held' : u._obstacle ? 'other' : '-', u._behindAt ? +u._behindAt.t.toFixed(1) : null, u.role,
          g.traffic.cars.includes(c), !!c.v.dormant, c.stuckFor, +(u.driver.remaining() | 0), u.goalNode]);
      }
      if (Math.hypot(p.x - end.x, p.z - end.z) > 65) { away = +(i / 30).toFixed(1); break; }
      if (i % 300 === 0) await new Promise((r) => setTimeout(r, 0));
    }
    g.traffic._route = realRoute;
    if (g.suspects) g.suspects.update = realSuspects;
    window.__res = JSON.stringify({
      away,
      carToPlayer: Math.round(Math.hypot(tp.x - px, tp.z - pz)), patrolToPlayer: Math.round(Math.hypot(pp.x - px, pp.z - pz)),
      carMoved: +Math.hypot(c.v.position.x - tp.x, c.v.position.z - tp.z).toFixed(1), trace });
  } catch (err) {
    window.__res = 'EX: ' + err.message + ' | ' + (err.stack || '').slice(0, 300);
  }
};

window.__runQuarryPatrol = async function (minutes = 10, where = 'floor') {
  window.__res = null;
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.player && window.__game.heat && window.__game.world.__map); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const g = window.__game;
    g.onBusted = () => { g.outcome = null; };
    const q = g.world.__map.quarry;
    const ox = Math.cos(q.open), oz = Math.sin(q.open);
    const at = where === 'floor' ? { x: q.x, z: q.z }
      : where === 'rim' ? { x: q.x - ox * (q.r + 12), z: q.z - oz * (q.r + 12) }
        : { x: q.x + ox * (q.r + 15), z: q.z + oz * (q.r + 15) };
    const p = g.player;
    p.teleport({ x: at.x, y: g.sim.heightAt(at.x, at.z) + 0.9, z: at.z }, 0);
    p.setControls({ throttle: 0, brake: 1, steer: 0, handbrake: 1 });
    const track = new Map();
    const spells = [];
    let total = 0, longest = 0;
    const steps = minutes * 60 * 30;
    for (let i = 0; i < steps; i++) {
      g.heat.value = 0;
      p.setControls({ throttle: 0, brake: 1, steer: 0, handbrake: 1 });
      g._update(1 / 30);
      if (i % 30 === 0) {
        for (const u of g.dispatcher.units) {
          if (u.human || !u.vehicle) continue;
          let s = track.get(u);
          if (!s) { s = { hist: [], stuck: null }; track.set(u, s); }
          const pos = u.vehicle.position;
          s.hist.push({ x: pos.x, z: pos.z });
          if (s.hist.length > 10) s.hist.shift();
          const h0 = s.hist[0];
          const moved = Math.hypot(pos.x - h0.x, pos.z - h0.z);
          const want = u.driver && u.driver.hasPath;
          if (s.hist.length === 10 && moved < 3 && want) {
            if (!s.stuck) {
              const e = g.graph.nearestEdge ? g.graph.nearestEdge(pos.x, pos.z) : null;
              s.stuck = {
                t: Math.round(i / 30), cs: u.callsign, role: u.role,
                d: Math.round(Math.hypot(pos.x - q.x, pos.z - q.z)), y: +pos.y.toFixed(1),
                x: Math.round(pos.x), z: Math.round(pos.z),
                edge: e && e.edge ? (e.edge.name || e.edge.kind) : null,
                len: 0,
              };
              spells.push(s.stuck);
            }
            s.stuck.len += 1;
          } else if (s.stuck && moved > 3) {
            total++; longest = Math.max(longest, s.stuck.len + 10);
            s.stuck = null;
          }
        }
      }
      if (i % 600 === 0) await new Promise((r) => setTimeout(r, 0));
    }
    for (const s of spells) longest = Math.max(longest, s.len + 10);
    window.__res = JSON.stringify({ where, spells: spells.length, longest, list: spells.slice(0, 12) });
  } catch (e) {
    window.__res = 'EX: ' + e.message + ' | ' + (e.stack || '').slice(0, 300);
  }
};
