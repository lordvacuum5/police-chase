// How many trees does a unit hit crossing a wood at speed?
//
// "When I go through trees fast, the police cars still crash. A lot. It feels
// like they don't stop now -- like they know how to get through -- I think
// they keep misjudging how much they can turn. When they're going through
// tight trees very close to each other, they seem to just hit the trees."
//
// A field of trunks out past the edge of the map, a unit put down at one end
// and sent to the other, and a count of what it hit on the way:
//
//   hits     impacts above a knock (dv > 4), which is a trunk, not a kerb
//   worst    the hardest one, in metres per second of velocity change
//   kph      mean speed across the run, and what it arrived at
//   arrived  whether it got there at all inside the time
//
// The trunks are the map's own: 1.3 m square, on a jittered grid whose spacing
// is the argument, so `gap` is how much room there is between one trunk and
// the next -- a 1.94 m car needs rather more than its own width to thread.
//
// What it says as it stands (2026-09, an interceptor sent 300 m at 105 km/h):
//
//   12 m apart   1 hit, dv 5.2, mean 13 kph, did not arrive
//    9 m apart   no hits,       mean 22 kph, did not arrive
//    7 m apart   no hits,       mean 15 kph, did not arrive
//
// So in a wood this dense a unit does not crash -- it crawls, and the thing
// holding it there is the stopping distance to the next trunk: with trunks
// nine metres apart there is never more than nine metres of it, which is about
// 30 km/h. Two changes were tried against this and both measured worse and
// were taken out again: letting the speed rule assume the car could go *round*
// a trunk rather than stop for it (hits went from dv 5 to dv 18, damage 0.04
// to 0.27 -- the steering cannot execute the swerve the speed assumed), and
// making the avoidance steer start earlier by taking its urgency linearly
// rather than squared (no measurable difference at all).
//
// Which means the crashing seen in the game -- "when I go through trees fast,
// the police cars still crash, a lot" -- is not this code path. Something in a
// real pursuit is letting a unit into a wood faster than this limiter allows:
// the gap-seeker (_driveDirect/_findGap) and the chase speed target are where
// to look, with an in-game reproduction rather than this synthetic one.
window.__runWoods = async function (gaps = [12, 9, 7], seconds = 26, kph = 105) {
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.player); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const g = window.__game;
    const { SKILL } = window.__modules;
    const world = await import('/src/physics/world.js');
    g.onBusted = () => { g.outcome = null; };
    g.onEscaped = () => { g.outcome = null; };
    g.heat.value = 0;
    g.paused = true;

    // Flat, empty, and grass all the way: the wood is the only thing in it.
    const realSurface = g.sim.surfaceAt, realHeight = g.sim.heightAt;
    g.sim.surfaceAt = () => 0;
    g.sim.heightAt = () => 0;

    const rows = [];
    for (let gi = 0; gi < gaps.length; gi++) {
      const gap = gaps[gi];
      // All three on the same lane of the ground plate, which runs to 1200:
      // spread sideways they fell off the edge of it, and a car falling
      // through the floor reports a lovely clear run.
      const X0 = 1040, Z0 = -820 + gi * 340;
      const LEN = 300, WIDE = 120;

      // A jittered grid of trunks, with a clear strip at each end to get up to
      // speed in and to stop in.
      const bodies = [];
      let seed = 1234 + gi * 77;
      const rnd = () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed / 0x7fffffff;
      };
      let row = 0;
      for (let z = 40; z < LEN - 40; z += gap) {
        // Every other row offset by half a gap, so there is no straight lane
        // through the wood: the car has to steer, which is the whole question.
        const stagger = (row++ % 2) * gap * 0.5;
        // Measured from the car's own line, so every other row has a trunk
        // squarely in front of it. Laid out from the edge instead, the grid
        // left a clear lane down the middle and the car drove through the wood
        // without steering at all -- which measured nothing.
        const n = Math.ceil(WIDE / (2 * gap));
        for (let k = -n; k <= n; k++) {
          const x = k * gap + stagger;
          const jx = (rnd() - 0.5) * gap * 0.55;
          const jz = (rnd() - 0.5) * gap * 0.55;
          bodies.push(world.addStaticBox(
            g.world, X0 + x + jx, 2.6, Z0 + z + jz, 0.65, 2.6, 0.65, world.GROUP.PROP, 0,
          ));
        }
      }
      g.world.step();

      const officer = g.spawnPoliceAt({ x: X0, y: 0.95, z: Z0 }, 0, 2);
      if (!officer) { window.__res = 'no unit'; return; }
      officer.skill = SKILL.pursuit;
      officer.driver.allowOffRoad = true;
      officer.driver.limitScale = 3;
      const v = officer.vehicle;
      v.assist.boost = 1; v.assist.grip = 1;
      v._readState();
      v.setVelocity({ x: 0, y: 0, z: kph / 3.6 });

      const goal = { x: X0, y: 0.95, z: Z0 + LEN };
      const speeds = [];
      let hits = 0, worst = 0, lastAt = 0, t = 0, arrived = false;
      while (t < seconds) {
        v.setControls(officer.driver.driveTo(goal, kph / 3.6, 1 / 60));
        g.stepHeadless(1 / 60);
        t += 1 / 60;
        speeds.push(Math.abs(v.forwardSpeed) * 3.6);
        if (v.lastImpactAt && v.lastImpactAt !== lastAt) {
          lastAt = v.lastImpactAt;
          if (v.lastImpact > 4) { hits++; worst = Math.max(worst, v.lastImpact); }
        }
        if (Math.hypot(v.position.x - goal.x, v.position.z - goal.z) < 25) { arrived = true; break; }
      }

      const mean = speeds.reduce((a, b) => a + b, 0) / Math.max(1, speeds.length);
      rows.push({
        gap,
        hits,
        worst: +worst.toFixed(1),
        meanKph: Math.round(mean),
        endKph: Math.round(Math.abs(v.forwardSpeed) * 3.6),
        arrived,
        secs: +t.toFixed(1),
        damage: +v.damage.toFixed(2),
      });

      g.dispatcher.retire(officer);
      for (const b of bodies) g.world.removeRigidBody(b);
      await new Promise((r) => setTimeout(r, 0));
    }

    g.sim.surfaceAt = realSurface;
    g.sim.heightAt = realHeight;
    g.paused = false;
    window.__res = rows.map((r) => `${String(r.gap).padStart(2)} m apart  `
      + `hits ${String(r.hits).padStart(2)} (worst ${String(r.worst).padStart(4)})  `
      + `mean ${String(r.meanKph).padStart(3)} kph  end ${String(r.endKph).padStart(3)}  `
      + `damage ${r.damage}  ${r.arrived ? `arrived ${r.secs}s` : 'did not arrive'}`).join('\n');
  } catch (e) {
    window.__res = 'EX: ' + e.message + ' | ' + (e.stack || '').slice(0, 300);
  }
};
