// How fast does a unit get through a junction, and does it survive it?
//
// "When they're turning they slow down loads and then they turn. They need to
// keep a relative good speed and cut the corner, like a human would."
//
// A route is rounded off at each junction before the speed planner ever sees
// it (RoadGraph.pathToPoints), and the radius of that rounding is what the
// planner reads the corner speed off. This drives a unit along a fixed route
// across the map with different roundings and reports what it cost:
//
//   kph        mean speed over the run, and the slowest it went
//   corners    the minimum speed at each junction it turned at
//   secs       how long the route took -- the figure that actually matters
//   hits       impacts above a knock, which is how a "faster" line that puts
//              the car into a shop window shows up as the failure it is
//
// The unit drives with the pursuit's own settings (allowOffRoad, no posted
// limit) but with nothing to chase, so the only thing under test is the line.
// Each setting is [corner, arcFloor]: how far back from a junction the turn
// starts, and the tightest turn the speed limiter will believe in. See
// RoadGraph.pathToPoints and Driver.arcFloor.
window.__runCorners = async function (settings = [[9, 6], [16, 13]], legs = 3) {
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.player); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const g = window.__game;
    const { SKILL } = window.__modules;
    g.onBusted = () => { g.outcome = null; };
    g.onEscaped = () => { g.outcome = null; };
    g.heat.value = 0;
    g.paused = true;

    const gr = g.graph;

    // One route, reused for every setting: a fair comparison needs the same
    // corners in the same order. Picked as a run of junctions each a few
    // hundred metres from the last, so there is room to get going between them.
    const rng = g.rng;
    let start = null, goals = [];
    for (let i = 0; i < 400 && !start; i++) {
      const n = gr.randomNode(rng, 'street');
      if (g._placeOnRoad(n)) start = n;          // somewhere a car can actually stand
    }
    if (!start) { window.__res = 'nowhere to start'; return; }
    let from = start;
    for (let leg = 0; leg < legs; leg++) {
      let best = null;
      for (let i = 0; i < 300; i++) {
        const n = gr.randomNode(rng, 'street');
        const d = Math.hypot(n.x - from.x, n.z - from.z);
        if (d < 240 || d > 420) continue;
        if (!gr.route(from.id, n.id, Infinity)) continue;
        best = n; break;
      }
      if (!best) break;
      goals.push(best.id);
      from = best;
    }
    if (!goals.length) { window.__res = 'no route'; return; }

    const rows = [];
    for (const [corner, arcFloor] of settings) {
      const place = g._placeOnRoad(start);
      if (!place) { window.__res = 'nowhere to start'; return; }
      const officer = g.spawnPoliceAt(place.position, place.heading, 2);
      if (!officer) { window.__res = 'no unit'; return; }
      officer.skill = SKILL.pursuit;
      officer.driver.allowOffRoad = true;
      officer.driver.limitScale = 3;
      officer.driver.arcFloor = arcFloor;

      const v = officer.vehicle;
      v.assist.boost = 1; v.assist.grip = 1;

      const speeds = [];
      const dips = [];
      const cross = [];
      let hits = 0, t = 0, goalIndex = 0, lastImpact = 0;
      let dip = Infinity, sinceDip = 0;

      while (t < 140 && goalIndex < goals.length) {
        // Route with this rounding, re-planned only when it runs out.
        if (!officer.driver.hasPath || officer.goalNode !== goals[goalIndex]) {
          const pts = gr.pathFromPosition(v.position.x, v.position.z,
            v.forward.x, v.forward.z, goals[goalIndex], 2.4, Infinity, v.speed, corner);
          if (pts.length < 2) break;
          officer.driver.setPath(pts);
          officer.goalNode = goals[goalIndex];
        }
        officer.driver.arcFloor = arcFloor;
        v.setControls(officer.driver.followPath(1 / 60, 60));
        g.stepHeadless(1 / 60);
        t += 1 / 60;

        const kph = Math.abs(v.forwardSpeed) * 3.6;
        speeds.push(kph);
        cross.push(Math.abs(officer.driver.crossTrack || 0));
        // A dip is a local minimum that lasts: the slowest it got between two
        // stretches of getting on with it. That is the junction.
        if (kph < 55) { dip = Math.min(dip, kph); sinceDip = 0; } else {
          sinceDip += 1 / 60;
          if (dip < Infinity && sinceDip > 1.2) { dips.push(Math.round(dip)); dip = Infinity; }
        }
        if (v.lastImpactAt && v.lastImpactAt !== lastImpact) {
          lastImpact = v.lastImpactAt;
          if (v.lastImpact > 4) hits++;
        }
        // Arrived means near the junction it was sent to. Asking the driver how
        // much path is left answers a different question -- a car that has just
        // been put down, or one that has run wide, both report nearly none.
        const gn = gr.nodes[goals[goalIndex]];
        if (Math.hypot(v.position.x - gn.x, v.position.z - gn.z) < 25) goalIndex++;
      }
      if (dip < Infinity) dips.push(Math.round(dip));

      const mean = speeds.reduce((a, b) => a + b, 0) / Math.max(1, speeds.length);
      rows.push({
        corner, arcFloor,
        secs: +t.toFixed(1),
        arrived: goalIndex,
        meanKph: Math.round(mean),
        offLine: +(cross.reduce((a, b) => a + b, 0) / Math.max(1, cross.length)).toFixed(1),
        worstOff: +Math.max(...cross).toFixed(1),
        slowest: Math.round(Math.min(...speeds)),
        corners: dips,
        hits,
      });
      g.dispatcher.retire(officer);
      await new Promise((r) => setTimeout(r, 0));
    }

    g.paused = false;
    window.__res = rows.map((r) => `corner ${String(r.corner).padStart(2)} arc ${String(r.arcFloor).padStart(2)}  `
      + `${String(r.secs).padStart(5)} s  arrived ${r.arrived}/${goals.length}  `
      + `mean ${String(r.meanKph).padStart(3)}  slowest ${String(r.slowest).padStart(3)}  `
      + `hits ${r.hits}  off ${r.offLine}/${r.worstOff}  junctions [${r.corners.join(', ')}]`).join('\n');
  } catch (e) {
    window.__res = 'EX: ' + e.message + ' | ' + (e.stack || '').slice(0, 300);
  }
};
