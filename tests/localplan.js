// The local planner, one car at a time, in the places it was built for.
//
// tests/estate.js measures escapes across forty cases; this traces single ones
// so that what a car actually did can be read: how soon it was within 30 m of
// the target, how many plans it made and what they were, and the worst frame
// time the officer's update cost -- the planner runs inside the game loop, and a
// slow plan is a visible stutter.
//
//   await import('/tests/localplan.js');
//   __runLocalTrace([[0, 90], [1, 0]], 35);     // [site, offset] pairs
//   ... then window.__res when window.__lpDone
import { weavePath } from './weave.js?v=31';

function trace(w, off, secs, every) {
  const g = window.__game;
  const { SKILL, ROLE, Officer } = window.__modules;
  g.onBusted = () => { g.outcome = null; g.heat.bustTimer = 0; };
  g.onEscaped = () => { g.outcome = null; };
  const W = weavePath(w);
  const a = W.pts[10], b = W.pts[11];
  const h0 = Math.atan2(b.x - a.x, b.z - a.z);
  const ang = h0 + (off * Math.PI) / 180;
  const p = g.player;
  const tx = a.x + Math.sin(ang) * 80, tz = a.z + Math.cos(ang) * 80;
  p.repair();
  p.teleport({ x: tx, y: 0.9, z: tz }, 0);
  p.setVelocity({ x: 0, y: 0, z: 0 });
  p._readState();
  g.paused = true;
  const car = g.createVehicle('interceptor', 'interceptor', { x: a.x, y: 0.95, z: a.z }, h0, { police: true });
  const o = new Officer(g, car, { skill: SKILL.pursuit, kind: 'interceptor' });
  o.setRole(ROLE.PURSUE);
  o.driver.allowOffRoad = true;
  car._readState();
  const s0 = Object.assign({}, Officer.localStats);
  const L = [];
  let best = 1e9, at30 = null, worst = 0, err = null, hits = 0, lastAt = 0;
  for (let f = 0; f < secs * 60; f++) {
    g.heat.value = 3;
    const k = g.dispatcher.knowledge;
    k.seen = true;
    k.position.copy(p.position);
    k.velocity.set(0, 0, 0);
    k.confidence = 1;
    p.teleport(p.position, 0);
    p.setVelocity({ x: 0, y: 0, z: 0 });
    p._readState();
    // The officer's update and the game step together: planning happens in the
    // step now (Game._update pumps the planner queue), so timing the update
    // alone would miss it.
    const t0 = performance.now();
    try { o.update(1 / 60, p); } catch (e) { if (!err) err = e.message + ' ' + (e.stack || '').slice(0, 300); }
    g.stepHeadless(1 / 60);
    const took = performance.now() - t0;
    worst = Math.max(worst, took);
    if (window.__frames) window.__frames.push(took);
    const dd = Math.hypot(car.position.x - tx, car.position.z - tz);
    best = Math.min(best, dd);
    if (at30 === null && dd < 30) at30 = f / 60;
    if (car.lastImpactAt && car.lastImpactAt !== lastAt && car.lastImpact > 4) {
      lastAt = car.lastImpactAt;
      hits++;
      const lp = o._lp;
      L.push(`  HIT ${car.lastImpact.toFixed(1)} at t${(f / 60).toFixed(1)} ${Math.round(car.forwardSpeed * 3.6)}kph `
        + `mode ${o._mode} lp ${lp ? `${lp.i || 0}/${lp.pts.length} dir ${lp.pts[lp.i || 0].dir}` : '-'} `
        + `rev ${o.driver.reverseTimer > 0} near ${o.driver.wallNear.toFixed(1)}`);
    }
    if (every && f % every === 0) {
      const lp = o._lp;
      L.push(`t${(f / 60).toFixed(1)} ${Math.round(car.forwardSpeed * 3.6)}kph mode ${o._mode} `
        + `lp ${lp ? `${lp.i || 0}/${lp.pts.length} dir ${lp.pts[lp.i || 0].dir}` : '-'} dist ${Math.round(dd)}`);
    }
  }
  const st = Officer.localStats;
  g.despawnPolice(o);
  g.paused = false;
  return `site ${w} off ${off}: best ${Math.round(best)} m  within 30 m ${at30 === null ? 'never' : at30.toFixed(1) + 's'}  `
    + `hits ${hits}  plans ${st.plans - s0.plans} (reverse ${st.withReverse - s0.withReverse}, to road ${st.toRoad - s0.toRoad})  `
    + `worst frame ${worst.toFixed(0)} ms${err ? '  EX ' + err : ''}`
    + (L.length ? '\n' + L.join('\n') : '');
}

window.__runLocalTrace = async function (cases, secs = 35, every = 0) {
  window.__lpDone = false;
  window.__res = null;
  for (let i = 0; i < 200 && !(window.__game && window.__game.player); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const dbg = (await import('../src/ai/localplan.js'))._debug;
  dbg.pumpMax = 0; dbg.pumpTotal = 0; dbg.pumpFrames = 0; dbg.pumpOver8 = 0; dbg.pumpOver16 = 0;
  for (const k of Object.keys(dbg.stageMax)) delete dbg.stageMax[k];
  window.__frames = [];
  const rows = [];
  for (const [w, off] of cases) {
    rows.push(trace(w, off, secs, every));
    await new Promise((r) => setTimeout(r, 0));
  }
  rows.push(`planner queue: worst frame ${dbg.pumpMax.toFixed(1)} ms, `
    + `${dbg.pumpFrames} frames planned, ${(dbg.pumpTotal / Math.max(1, dbg.pumpFrames)).toFixed(1)} ms each on average, `
    + `over 8 ms ${dbg.pumpOver8}, over 16 ms ${dbg.pumpOver16}  | longest single stage: `
    + Object.entries(dbg.stageMax).map(([k, x]) => `${k} ${x.toFixed(1)}`).join(', '));
  // Whole frames: the officer's update plus the game step, every frame of every
  // case, so the planner's share can be told apart from everything else's.
  const f = window.__frames.slice().sort((a, b) => a - b);
  const pct = (q) => f[Math.min(f.length - 1, Math.floor(q * f.length))] || 0;
  rows.push(`whole frames: median ${pct(0.5).toFixed(1)} ms, 99th ${pct(0.99).toFixed(1)}, `
    + `over 16 ms ${f.filter((x) => x > 16).length} of ${f.length}, worst ${(f[f.length - 1] || 0).toFixed(0)}`
    + `${window.__noLocalPlan ? '  (planner OFF)' : ''}`);
  window.__res = rows.join('\n');
  window.__lpDone = true;
  return window.__res;
};
