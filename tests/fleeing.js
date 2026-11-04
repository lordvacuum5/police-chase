// How well does a civilian car run from the police?
//
// "They're really bad at driving ... sometimes they don't even move, or they just
// crash into another police car, or they just crash into another car ... can't
// seem to get out of busting situations fast enough." Needs the solo police side.
// The player is parked far away; a nearby patrol is put on each suspect. `seconds`
// of each, or until caught: mean speed, share of the time under 2 m/s without having
// given up, knocks, flips, how it ended, and what it was doing when stopped.
window.__runFleeing = async function (runs = 6, seconds = 40) {
  window.__res = null;
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.player && window.__game.traffic); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const g = window.__game;
    g.paused = true;
    g.onBusted = () => { g.outcome = null; };
    g.onEscaped = () => { g.outcome = null; };
    const p = g.player;
    const ctl = { throttle: 0, brake: 1, steer: 0, handbrake: 1 };
    const rows = [];
    const tot = { mean: 0, stopped: 0, knocks: 0, n: 0 };
    for (let run = 0; run < runs; run++) {
      for (let i = 0; i < 900 && g.traffic.cars.length < 2; i++) { p.setControls(ctl); g._update(1 / 30); }
      let c = null, far = -1;
      for (const t of g.traffic.cars) {
        const r = Math.hypot(t.v.position.x - p.position.x, t.v.position.z - p.position.z);
        if (r > far) { far = r; c = t; }
      }
      if (!c) continue;
      if (c.v.dormant) { c.v.body.setEnabled(true); c.v.dormant = false; }
      const s = g.suspects.offence(c, 'bolt', null);
      if (!s) continue;
      const v = s.v;
      let sum = 0, n = 0, stopped = 0, knocks = 0, last = v.lastImpactAt, longest = 0, spell = 0, flips = 0, why = '';
      for (let i = 0; i < seconds * 30; i++) {
        p.setControls(ctl);
        g._update(1 / 30);
        if (s.state !== 'run') break;
        sum += v.speed; n++;
        if (v.lastImpactAt !== last && v.lastImpact > 2.6) { knocks++; last = v.lastImpactAt; }
        if (v.flippedFor > 1 && (i % 30 === 0)) flips++;
        if (v.speed < 2 && !s.gaveUp) {
          stopped++; spell++;
          if (spell > longest) {
            longest = spell;
            const d = s.runner.driver;
            why = `T${v.controls.throttle.toFixed(1)} B${v.controls.brake.toFixed(1)} wall ${(+d.wallNear).toFixed(0)} clear ${(+d._clear).toFixed(0)} target ${(+d.speedTarget).toFixed(1)} rev ${d.reverseTimer > 0 ? 1 : 0} path ${d.hasPath ? 1 : 0} pinned ${s.runner._pinFor ? s.runner._pinFor.toFixed(1) : '-'} units near ${s.units.filter((u) => u.vehicle && Math.hypot(u.vehicle.position.x - v.position.x, u.vehicle.position.z - v.position.z) < 8).length}`;
          }
        } else spell = 0;
        if (i % 150 === 0) await new Promise((r) => setTimeout(r, 0));
      }
      const mean = n ? (sum / n) * 3.6 : 0;
      rows.push(`run ${run} (${v.specKey}): mean ${Math.round(mean)} km/h, stopped ${Math.round((stopped / (n || 1)) * 100)}%, longest ${(longest / 30).toFixed(1)} s, knocks ${knocks}, flipped ${flips} s, ${(n / 30).toFixed(0)} s, ended ${s.state}${s.gaveUp ? ' gave up' : ''}, damage ${(+v.damage).toFixed(2)}, nerve ${s.nerve === undefined ? '-' : s.nerve.toFixed(2)}${why ? ` | worst stop: ${why}` : ''}`);
      tot.mean += mean; tot.stopped += stopped / (n || 1); tot.knocks += knocks; tot.n++;
      for (const o of g.suspects.list) if (o.state === 'run') { o.state = 'free'; g.suspects._release(o); }
      await new Promise((r) => setTimeout(r, 0));
    }
    rows.unshift(`${tot.n} runs: mean ${Math.round(tot.mean / tot.n)} km/h, stopped ${Math.round((tot.stopped / tot.n) * 100)}%, knocks ${tot.knocks}`);
    window.__res = rows;
  } catch (e) {
    window.__res = ['EX: ' + e.message, (e.stack || '').slice(0, 300)];
  }
};
