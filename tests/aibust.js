// Can the computer's police make an arrest with the player nowhere near?
//
// "A police cars can't bust normal cars. Like I have to be there for them to
// bust it." Needs the solo police side. The player is parked as far from the
// suspect as the map allows and stays there. Each run forces one suspect and
// reports when it was caught, or how close they got in `seconds`: the nearest
// bodywork gap, the most of the five seconds they filled, the units on it, its
// level, and whether it ever went below the ground.
window.__runAiBust = async function (runs = 3, seconds = 120) {
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
    for (let run = 0; run < runs; run++) {
      for (let i = 0; i < 900 && g.traffic.cars.length < 2; i++) { p.setControls(ctl); g._update(1 / 30); }
      // The traffic car furthest from the player.
      let c = null, far = -1;
      for (const t of g.traffic.cars) {
        const r = Math.hypot(t.v.position.x - p.position.x, t.v.position.z - p.position.z);
        if (r > far) { far = r; c = t; }
      }
      if (!c) { rows.push('no traffic'); continue; }
      if (c.v.dormant) { c.v.body.setEnabled(true); c.v.dormant = false; }
      const s = g.suspects.offence(c, 'bolt', null);
      if (!s) { rows.push('refused'); continue; }
      let near = Infinity, maxPin = 0, caught = 0, maxUnits = 0, below = 0;
      for (let i = 0; i < seconds * 30; i++) {
        p.setControls(ctl);
        g._update(1 / 30);
        if (s.state !== 'run') { if (s.state === 'pull' || s.state === 'parked') caught = i / 30; break; }
        for (const u of s.units) {
          if (!u.vehicle || u.vehicle.removed) continue;
          const r = Math.hypot(u.vehicle.position.x - s.v.position.x, u.vehicle.position.z - s.v.position.z);
          near = Math.min(near, r - (u.vehicle.spec.dims.l + s.v.spec.dims.l) * 0.5);
        }
        maxPin = Math.max(maxPin, s.pinFor);
        maxUnits = Math.max(maxUnits, s.units.length);
        if (s.v.position.y < g.sim.heightAt(s.v.position.x, s.v.position.z) - 1) below++;
        if (i % 150 === 0) await new Promise((r) => setTimeout(r, 0));
      }
      rows.push(`run ${run}: ${caught ? `CAUGHT at ${caught.toFixed(0)} s` : `not caught (${s.state})`}, from ${Math.round(far)} m off, nearest gap ${near.toFixed(1)} m, most pin ${maxPin.toFixed(1)} s, units up to ${maxUnits}, level ${(+s.heat).toFixed(1)}, damage ${(+s.v.damage).toFixed(2)}, below ground ${below} frames`);
      for (const o of g.suspects.list) if (o.state === 'run') { o.state = 'free'; g.suspects._release(o); }
      await new Promise((r) => setTimeout(r, 0));
    }
    window.__res = rows;
  } catch (e) {
    window.__res = ['EX: ' + e.message, (e.stack || '').slice(0, 300)];
  }
};
