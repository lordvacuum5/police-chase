// A fleeing civilian that goes backwards and keeps going backwards.
//
// "Sometimes when we're in pursuit of a civilian car, they just start going backwards, and they just stay
// going backwards." Needs the police side. Forces runs on traffic cars and logs every stretch of more than
// two seconds going backwards: how long, how far, and what the driver was doing at the start of it.
//
//   await import('/tests/backwards.js');
//   await __runBackwards(6, 90);
window.__runBackwards = async function (runs = 6, seconds = 90) {
  window.__res = null;
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.player && window.__game.traffic); i++) await new Promise((r) => setTimeout(r, 100));
    const g = window.__game, p = g.player;
    g.paused = true;
    g.onBusted = () => { g.outcome = null; };
    g.onEscaped = () => { g.outcome = null; };
    const ctl = { throttle: 0, brake: 1, steer: 0, handbrake: 1 };
    const rows = [];
    let total = 0, long = 0, worst = 0;
    for (let run = 0; run < runs; run++) {
      for (let i = 0; i < 900 && g.traffic.cars.length < 2; i++) { p.setControls(ctl); g._update(1 / 30); }
      let c = null, far = -1;
      for (const t of g.traffic.cars) {
        const r = Math.hypot(t.v.position.x - p.position.x, t.v.position.z - p.position.z);
        if (r > far && r < 600) { far = r; c = t; }
      }
      if (!c) { rows.push('no traffic'); continue; }
      if (c.v.dormant) { c.v.body.setEnabled(true); c.v.dormant = false; }
      const s = g.suspects.offence(c, 'bolt', null);
      if (!s) { rows.push('refused'); continue; }
      const v = s.v;
      let back = 0, from = null, why = null;
      for (let i = 0; i < seconds * 30; i++) {
        p.setControls(ctl);
        g._update(1 / 30);
        if (s.state !== 'run') break;
        if (v.forwardSpeed < -1) {
          if (back === 0) {
            from = { x: v.position.x, z: v.position.z };
            const r = s.runner || s.driver || null;
            const d = (r && r.driver) || null;
            why = {
              t: +(i / 30).toFixed(1),
              rev: d ? +(d.reverseTimer || 0).toFixed(1) : null,
              turn: d ? !!d.turnRoundState : null,
              local: r ? !!r._lp : null,
              line: r ? !!r._line : null,
              gear: v.gear, thr: v.controls && +(v.controls.throttle || 0).toFixed(2), brk: v.controls && +(v.controls.brake || 0).toFixed(2),
              speed: +v.forwardSpeed.toFixed(1),
              state: s.state, pulled: !!s.pullFor,
            };
          }
          back += 1 / 30;
        } else if (back > 0) {
          if (back > 2) {
            long++;
            worst = Math.max(worst, back);
            rows.push(`run ${run}: ${back.toFixed(1)} s backwards, ${Math.round(Math.hypot(v.position.x - from.x, v.position.z - from.z))} m, ${JSON.stringify(why)}`);
          }
          total += back;
          back = 0;
        }
        if (i % 150 === 0) await new Promise((r) => setTimeout(r, 0));
      }
      if (back > 2) { long++; worst = Math.max(worst, back); rows.push(`run ${run}: still backwards at the end after ${back.toFixed(1)} s, ${JSON.stringify(why)}`); }
      for (const o of g.suspects.list) if (o.state === 'run') { o.state = 'free'; g.suspects._release(o); }
      await new Promise((r) => setTimeout(r, 0));
    }
    rows.unshift(`${runs} runs of ${seconds} s: backwards over 2 s ${long} times, the longest ${worst.toFixed(1)} s, all backwards ${total.toFixed(0)} s`);
    window.__res = rows.join('\n');
  } catch (e) {
    window.__res = 'EX: ' + e.message + ' | ' + (e.stack || '').slice(0, 300);
  }
  return window.__res;
};
