// Haldon Vale's railway: the crossings and the train.
//
// "A railway with a level crossing. The barriers come down and a train goes
// through." Two checks, every crossing:
//
//   stop     with the lights going, how far short an AI car on each approach
//            is told to stop (TrafficLights.stopDistanceAt), m -- and that a
//            car going away from the line is not stopped at all
//   hit      the player parked on the crossing, handbrake on, the train due:
//            how far it ends up from the crossing, how fast it is going, the
//            damage, and whether it is the right way up
//
// window.__runRailway() -> window.__res

window.__runRailway = async function () {
  for (let i = 0; i < 200 && !(window.__game && window.__game.player); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const g = window.__game, p = g.player, R = g.world.__map.railway;
  g.heat.value = 0;
  g.onBusted = () => { g.outcome = null; };
  // When is the front of the train `ahead` metres short of `s`?
  const due = (s, ahead) => {
    for (let t = 0; t < R.period; t += 0.05) {
      const f = R.frontAt(t);
      if (f && Math.abs(f.s - (s - f.dir * ahead)) < 1) return t;
    }
    return null;
  };
  const out = [];
  for (const [ci, c] of R.crossings.entries()) {
    R.clock = due(c.s, 250);
    R.update();
    const stop = [1, -1].map((sg) => g.signals.stopDistanceAt(c.x + sg * c.rdx * 40, c.z + sg * c.rdz * 40, -sg * c.rdx, -sg * c.rdz, 10));
    const away = g.signals.stopDistanceAt(c.x + c.rdx * 40, c.z + c.rdz * 40, c.rdx, c.rdz, 10);
    R.clock = due(c.s, 80);
    p.repair();
    p.teleport({ x: c.x, y: g.sim.heightAt(c.x, c.z) + 0.7, z: c.z }, Math.atan2(c.rdx, c.rdz));
    p.setVelocity({ x: 0, y: 0, z: 0 });
    for (let i = 0; i < 60 * 6; i++) {
      g.forceControls = { throttle: 0, brake: 0, steer: 0, handbrake: 1 };
      g._update(1 / 60);
    }
    g.forceControls = null;
    out.push(`crossing ${ci}: stop ${stop.map((d) => d.toFixed(0)).join('/')} m, away ${away}; `
      + `hit: ends ${Math.hypot(p.position.x - c.x, p.position.z - c.z).toFixed(0)} m off, `
      + `${(p.speed * 3.6).toFixed(0)} km/h, damage ${p.damage.toFixed(2)}, up ${p.up.y.toFixed(2)}`);
  }
  window.__res = out.join('\n');
  return window.__res;
};
