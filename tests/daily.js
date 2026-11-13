// How long the daily challenge's route takes, driven by the game's own driver with nobody about.
//
// The clock (game/daily.js, DAILY_PACE) is the route's length over an average speed for the day's car;
// this is where those speeds come from. With a daily challenge loaded (sessionStorage pc.daily and pc.map
// set to today's), for each car:
//
//   await import('/tests/daily.js');  __runDaily(['runner', 'supercar', 'offroad']);
//   // then window.__dailyDone, window.__res
//
//   time      seconds from the start to within the finish ring, or null if it never got there
//   pace      route length over that, m/s
//   touches   times it touched something the challenge would have failed it for
window.__runDaily = async function (cars = ['runner', 'supercar', 'offroad'], skillName = 'pursuit') {
  window.__dailyDone = false;
  window.__res = null;
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.player && window.__game.hud); i++) await new Promise((r) => setTimeout(r, 100));
    const g = window.__game;
    const d = g.daily;
    if (!d) throw new Error('no daily challenge loaded');
    const { Driver, SKILL } = window.__modules;
    // Nobody about: no police, no traffic, no rules.
    g.daily = null;
    g.onBusted = () => { g.outcome = null; };
    g.onEscaped = () => { g.outcome = null; };
    g.heat.reset();
    g.dispatcher.standDown();
    for (const u of g.dispatcher.units.slice()) if (!u.human) g.despawnPolice(u);
    g.traffic.clear();
    g.traffic.update = () => {};
    const out = {};
    const end = d.route.pts[d.route.pts.length - 1];
    for (const car of cars) {
      const v = g.createVehicle(car, car, d.route.start.position, d.route.start.heading, {});
      const drv = new Driver(v, SKILL[skillName] || SKILL.pursuit);
      drv.setPath(d.route.pts);
      g.player.teleport({ x: 1100, y: 1, z: 1100 }, 0);
      let t = 0, touches = 0, was = false, done = null;
      while (t < 240) {
        v.setControls(drv.followPath(1 / 60));
        g.stepHeadless(1 / 60);
        t += 1 / 60;
        // The same test the challenge makes, with the car being driven standing in for the player.
        const real = g.player;
        g.player = v;
        const hit = d._hitWhat(v);
        g.player = real;
        if (hit && !was) touches++;
        was = !!hit;
        if (Math.hypot(v.position.x - end.x, v.position.z - end.z) < 14) { done = t; break; }
        if (Math.floor(t * 60) % 300 === 0) await new Promise((r) => setTimeout(r, 0));
      }
      out[car] = { time: done && +done.toFixed(1), pace: done && +(d.route.length / done).toFixed(1), touches };
      g.removeVehicle(v);
    }
    g.daily = d;
    window.__res = { day: d.day, map: d.plan.mapId, length: Math.round(d.route.length), cars: out };
  } catch (e) {
    window.__res = 'ERR ' + (e.stack || e);
  }
  window.__dailyDone = true;
  return window.__res;
};
