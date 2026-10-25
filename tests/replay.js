// A real chase, replayed: the player's own recorded line, with a police car put
// where one actually was.
//
// "Is there any way that I can show you how I drive and you try to make the
// police like drive a bit like how I drive?" Typing `log` in the game saves the
// player's last minute (Game._driveReport): ten samples a second of where they
// were and how fast, and where each police car near them was. This drives a
// ghost along that line, puts one pursuing unit at a recorded police car's
// position and speed at the start time, and records what the unit does.
//
//   __runReplay({ file, from, to, unit: 'U2' })   // -> window.__res
//
// `file` is a log copied into tests/data/; `from`/`to` are game-clock seconds
// in it. The summary is the gap at the end, the closest it got, contacts, and
// a line every half second of what the unit was doing and why.
window.__runReplay = async function ({ file, from, to, unit = null, kind = 'interceptor', tweak = null } = {}) {
  window.__replayDone = false;
  window.__res = null;
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.player); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const g = window.__game;
    const { SKILL, ROLE, Officer } = window.__modules;
    const log = await (await fetch(`/tests/data/${file}?${Date.now()}`)).json();
    const S = log.samples.filter((q) => q.t >= from - 0.2 && q.t <= to + 0.2);
    if (S.length < 3) throw new Error('no samples in that window');
    const at = (t) => {
      let k = 0;
      while (k < S.length - 2 && S[k + 1].t < t) k++;
      const a = S[k], b = S[k + 1];
      const u = Math.min(1, Math.max(0, (t - a.t) / Math.max(1e-3, b.t - a.t)));
      return {
        x: a.x + (b.x - a.x) * u, z: a.z + (b.z - a.z) * u,
        vx: (b.x - a.x) / Math.max(1e-3, b.t - a.t), vz: (b.z - a.z) / Math.max(1e-3, b.t - a.t),
      };
    };

    g.onBusted = () => { g.outcome = null; g.heat.bustTimer = 0; };
    g.onEscaped = () => { g.outcome = null; };
    g.paused = true;
    const p = g.player;
    p.repair();

    // The unit: where the named police car was at `from`, or 15 m behind the
    // player if it was not recorded then.
    const first = S[0];
    let ux, uz, uh, uk;
    const rec = unit && first.police.find((q) => q[0] === unit);
    if (rec) {
      ux = rec[1]; uz = rec[2]; uk = rec[3];
      const nxt = S.find((q) => q.t > first.t + 0.25 && q.police.find((r) => r[0] === unit));
      const r2 = nxt && nxt.police.find((r) => r[0] === unit);
      uh = r2 ? Math.atan2(r2[1] - ux, r2[2] - uz) : (first.head / 57.3);
    } else {
      uh = first.head / 57.3;
      ux = first.x - Math.sin(uh) * 15; uz = first.z - Math.cos(uh) * 15; uk = first.kph;
    }
    const car = g.createVehicle(kind, kind, { x: ux, y: 0.95, z: uz }, uh, { police: true });
    const o = new Officer(g, car, { skill: SKILL.pursuit, kind });
    o.setRole(ROLE.PURSUE);
    o.driver.allowOffRoad = true;
    car.setVelocity({ x: Math.sin(uh) * uk / 3.6, y: 0, z: Math.cos(uh) * uk / 3.6 });
    car._readState();

    const lines = [];
    let hits = 0, lastAt = 0, closest = Infinity, f = 0;
    for (let t = from; t <= to; t += 1 / 60, f++) {
      const q = at(t);
      const h = Math.atan2(q.vx, q.vz);
      p.teleport({ x: q.x, y: 0.9, z: q.z }, h);
      p.setVelocity({ x: q.vx, y: 0, z: q.vz });
      p._readState();
      g.heat.value = Math.max(1, first.wanted || 1);
      const k = g.dispatcher.knowledge;
      k.seen = true; k.position.copy(p.position); k.velocity.set(q.vx, 0, q.vz); k.confidence = 1;
      o.update(1 / 60, p);
      if (tweak) tweak(o.driver, o, car);
      g.stepHeadless(1 / 60);
      const d = o.distanceTo(p.position);
      if (t > from + 0.5) closest = Math.min(closest, d);
      if (car.lastImpactAt && car.lastImpactAt !== lastAt && car.lastImpact > 4) {
        lastAt = car.lastImpactAt;
        if (d > 7) hits++;
      }
      if (f % (window.__replayEvery || 30) === 0) {
        const c = o.driver.caps || {};
        const kp = (x) => (x === undefined || !Number.isFinite(x) ? '-' : Math.round(x * 3.6));
        let low = 'asked', lv = c.asked;
        for (const key of ['sClear', 'sTravel', 'sRunout', 'sArc', 'sBack', 'wall', 'way']) {
          if (c[key] < lv - 0.01) { lv = c[key]; low = key; }
        }
        lines.push(`${t.toFixed(1)}s  ${Math.round(car.speed * 3.6)} kph  gap ${Math.round(d)} m  `
          + `${o._mode || '-'}  path ${o.driver.hasPath ? o.driver.path.length : 0}${o.driver.freeLined ? ' free' : ''}  `
          + `limit ${low} ${kp(lv)}  @${car.position.x.toFixed(0)},${car.position.z.toFixed(0)}  `
          + `ghost ${Math.round(Math.hypot(q.vx, q.vz) * 3.6)} kph @${q.x.toFixed(0)},${q.z.toFixed(0)}`
          + `  aim ${o._planAim ? `${o._planAim.x.toFixed(0)},${o._planAim.z.toFixed(0)}` : '-'}`
          + ` cut ${(o._cutBy || 0).toFixed(1)} steer ${((car.controls && car.controls.steer) || 0).toFixed(2)}`
          + ` wallNear ${Number.isFinite(o.driver.wallNear) ? o.driver.wallNear.toFixed(0) : '-'}`
          + ` gap ${o.driver.gapClear !== undefined ? o.driver.gapClear.toFixed(0) : '-'}`
          + ` avoid ${(o.driver.avoidBias || 0).toFixed(2)} wallB ${(o.driver.wallBias || 0).toFixed(2)}`
          + ` room ${(o.driver.roomLeft ?? -1).toFixed(0)}/${(o.driver.roomRight ?? -1).toFixed(0)}`
          + ` tree ${Number.isFinite(o.driver.treeNear) ? o.driver.treeNear.toFixed(0) : '-'}`
          + ` aimErr ${(o.driver.aimError || 0).toFixed(2)} fromGap ${o.driver._aimFromGap ? 1 : 0}`);
      }
    }
    const end = Math.round(o.distanceTo(p.position));
    g.despawnPolice(o);
    g.paused = false;
    g.heat.reset();
    window.__res = `end ${end} m  closest ${Math.round(closest)} m  hits ${hits}  damage ${car.damage.toFixed(2)}\n`
      + lines.join('\n');
  } catch (e) {
    window.__res = 'EX: ' + e.message + ' | ' + (e.stack || '').slice(0, 300);
  }
  window.__replayDone = true;
  return window.__res;
};
