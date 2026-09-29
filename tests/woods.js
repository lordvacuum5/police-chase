// How many trees does a pursuit hit, in the thickest wood the map has?
//
// "When I go through trees fast, the police cars still crash. A lot. I think
// they keep misjudging how much they can turn."
//
// The site is found rather than invented: every trunk on the loaded map is
// collected and the densest neighbourhood of them is the copse this runs in --
// on Wexbury that is about twenty-two trunks inside thirty metres, roughly one
// every eleven metres, which is as thick as the game gets. The escapee is put
// down a hundred and twenty metres short of it with the throttle pinned, two
// units are put behind them at speed, and everything they hit over the next
// forty seconds is counted:
//
//   hits    impacts above a knock (dv > 4 m/s of velocity change)
//   worst   the hardest of them, and what the car was doing at the time
//
// A unit that has slowed for the *obstacle* but not for the *turn it is about
// to have to make* arrives at the gap pointing at the trunk beside it.
//
// Read it in twos, not in ones. Even with the cars fixed, two runs of the same
// build come out a hit apart -- the chase is a chaotic thing and a metre of
// difference at the first trunk is a different wood by the tenth. A change
// worth having moves this by more than that, and the way to see it is to run
// both settings inside one page session, where everything up to that point is
// identical: raising the fleet's off-road grip, measured that way, went from
// 2 hits to 6.
//
// What this said when it was written (Wexbury, two units, forty seconds):
//
//   before the planner   5 hits, worst 31.7 m/s at 95 kph
//   with it              4 hits, worst 31.3 m/s at 93 kph
//
// and what the impacts turn out to be is the useful part. A dv of 31 m/s from
// a car doing 93 km/h -- 26 m/s -- is not a car driving into a tree: the
// impact figure includes the spin the trunk stopped (see Vehicle.postStep), so
// these are cars that have already lost the back end on grass and then wrapped
// a trunk sideways. The gap-finding is not what is failing at that point; the
// car is. Off-road stability, not obstacle planning, is the next lever.
window.__runWoods = async function (seconds = 40) {
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.player); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const g = window.__game;
    const { SKILL, ROLE } = window.__modules;
    g.onBusted = () => { g.outcome = null; };
    g.onEscaped = () => { g.outcome = null; };
    g.paused = true;

    // ---- the thickest copse on this map ----
    const pts = [];
    g.world.forEachCollider((c) => {
      const h = c.halfExtents ? c.halfExtents() : null;
      if (h && Math.abs(h.x - 0.65) < 0.01 && Math.abs(h.y - 2.6) < 0.01) {
        const t = c.translation();
        pts.push([t.x, t.z]);
      }
    });
    if (pts.length < 20) { window.__res = 'no trees on this map'; return; }
    let site = null;
    for (let i = 0; i < pts.length; i += 7) {
      const [x, z] = pts[i];
      let n = 0;
      for (const [px, pz] of pts) {
        const dx = px - x, dz = pz - z;
        if (dx * dx + dz * dz < 900) n++;       // within 30 m
      }
      if (!site || n > site.n) site = { x, z, n };
    }

    // ---- the chase ----
    g.player.repair();
    g.player.teleport({ x: site.x, y: 1.0, z: site.z - 120 }, 0);
    g.player._readState();
    g.player.setVelocity({ x: 0, y: 0, z: 25 });
    g.heat.value = 3;
    g.dispatcher.knowledge.seen = true;
    g.dispatcher.knowledge.position.copy(g.player.position);

    // Both units are interceptors, made here rather than by spawnPoliceAt,
    // which picks a kind from the wanted level and the game's own rng -- so
    // the same run gave a pair of interceptors one time and an interceptor
    // and an SUV the next, and the hit count moved by two with it. The car has
    // to be fixed for the wood to be the thing being measured.
    const units = [];
    for (const off of [-8, 8]) {
      const car = g.createVehicle('interceptor', 'interceptor',
        { x: site.x + off, y: 0.95, z: site.z - 150 }, 0, { police: true });
      if (!car) continue;
      const o = new window.__modules.Officer(g, car, {
        skill: SKILL.pursuit, kind: 'interceptor',
      });
      // Not on the dispatcher's roster: it would retask them against whatever
      // it currently believes, and the point of this is the pursuit's driving.
      o.setRole(ROLE.PURSUE);
      o.vehicle._readState();
      o.vehicle.setVelocity({ x: 0, y: 0, z: 28 });
      units.push(o);
    }
    if (!units.length) { window.__res = 'no units'; return; }

    const log = [];
    const last = new Map();
    const speeds = [];
    g.forceControls = { throttle: 1, brake: 0, steer: 0, handbrake: 0 };
    for (let i = 0; i < seconds * 60; i++) {
      for (const o of units) o.update(1 / 60, g.player);
      g.stepHeadless(1 / 60);
      for (const o of units) {
        const v = o.vehicle;
        speeds.push(v.speed * 3.6);
        if (v.lastImpactAt && v.lastImpactAt !== last.get(o) && v.lastImpact > 4) {
          last.set(o, v.lastImpactAt);
          log.push({ dv: +v.lastImpact.toFixed(1), kph: Math.round(v.speed * 3.6) });
        }
      }
    }
    g.forceControls = null;

    const mean = speeds.reduce((a, b) => a + b, 0) / Math.max(1, speeds.length);
    const worst = log.reduce((w, h) => (h.dv > (w ? w.dv : 0) ? h : w), null);
    const damage = units.map((o) => +o.vehicle.damage.toFixed(2));
    for (const o of units) g.removeVehicle(o.vehicle);
    g.paused = false;

    window.__res = `copse of ${site.n} trunks within 30 m at `
      + `${Math.round(site.x)}, ${Math.round(site.z)}\n`
      + `hits ${log.length}  worst ${worst ? `${worst.dv} m/s at ${worst.kph} kph` : 'none'}  `
      + `mean ${Math.round(mean)} kph  damage ${damage.join(' / ')}`
      + (log.length ? `\n${log.map((h) => `  dv ${h.dv} at ${h.kph} kph`).join('\n')}` : '');
  } catch (e) {
    window.__res = 'EX: ' + e.message + ' | ' + (e.stack || '').slice(0, 300);
  }
};
