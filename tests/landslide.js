// A police car coming down sideways, seen and unseen.
//
// "Say a police car does a jump, and it lands next to me, and it's like sideways, and it just
// basically stops where it is. And then continues on." Dropped from 6 m with its nose `off` degrees from
// the way it is going, nobody steering, the assists a chasing unit has.
//
//   await import('/tests/landslide.js');
//   await __runLandSlide();
//
//   turned     how many degrees the way it is going swung in the first half second: the stop-and-go
//   lost       speed gone in that half second
//   sideways   how long it stays more than 10 degrees sideways
//   far        how far it goes in the first second
window.__runLandSlide = async function (kph = 110) {
  window.__res = null;
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.player); i++) await new Promise((r) => setTimeout(r, 100));
    const g = window.__game, p = g.player;
    g.onBusted = () => { g.outcome = null; };
    g.onEscaped = () => { g.outcome = null; };
    for (const u of g.dispatcher.units.slice()) if (!u.human) g.despawnPolice(u);
    const e = g.graph.edges.filter((x) => !x.cut && x.points && x.points.length > 3)
      .map((x) => {
        const a = x.points[0], b = x.points[x.points.length - 1];
        return { a, b, len: Math.hypot(b.x - a.x, b.z - a.z) };
      }).filter((x) => g.sim.surfaceAt(x.a.x, x.a.z) !== 0).sort((m, n) => n.len - m.len)[0];
    const h = Math.atan2(e.b.x - e.a.x, e.b.z - e.a.z);
    p.teleport({ x: e.a.x + 500, y: g.sim.heightAt(e.a.x + 500, e.a.z + 500) + 2, z: e.a.z + 500 }, 0);
    const u = g.spawnPoliceNear({ x: e.a.x, y: 0, z: e.a.z }, 5);
    const v = u.vehicle;
    const idle = { throttle: 0, brake: 1, steer: 0, handbrake: 1 };
    const speed = kph / 3.6;
    const rows = [];
    for (const seen of [false, true]) {
      for (const off of [30, 60, 85]) {
        let turned = 0, lost = 0, sideways = 0, far = 0;
        for (const sign of [1, -1]) {
          v.repair();
          v.assist.shielded = false;
          v.assist.noSpin = 0.3;
          v.landSeen = seen;
          v._bump = 0; v._knocked = 0;
          const nose = h + (sign * off * Math.PI) / 180;
          v.teleport({ x: e.a.x, y: g.sim.heightAt(e.a.x, e.a.z) + 6.5, z: e.a.z }, nose);
          v.setVelocity({ x: Math.sin(h) * speed, y: 0, z: Math.cos(h) * speed });
          v._readState();
          let t0 = -1, h0 = 0, s0 = 0, x0 = 0, z0 = 0;
          for (let i = 0; i < 300; i++) {
            v.setControls({ throttle: 0.5, brake: 0, steer: 0, handbrake: 0 });
            g.heat.value = 0;
            g.stepHeadless(1 / 60, idle);
            if (t0 < 0 && v.grounded > 0) {
              t0 = i; h0 = Math.atan2(v.linvel.x, v.linvel.z); s0 = v.speed; x0 = v.position.x; z0 = v.position.z;
            }
            if (t0 < 0) continue;
            const j = i - t0;
            if (Math.abs(v.slipAngleBody || 0) > 10 / 57.3) sideways += 1 / 60;
            if (j === 30) {
              let d = Math.atan2(v.linvel.x, v.linvel.z) - h0;
              while (d > Math.PI) d -= Math.PI * 2;
              while (d < -Math.PI) d += Math.PI * 2;
              turned += Math.abs(d) * 57.3;
              lost += 1 - v.speed / s0;
            }
            if (j === 60) far += Math.hypot(v.position.x - x0, v.position.z - z0);
            if (j > 120) break;
          }
        }
        rows.push(`${seen ? 'seen  ' : 'unseen'} nose ${off} off: way it goes turned ${(turned / 2).toFixed(0)} deg, speed lost ${Math.round((lost / 2) * 100)}%, sideways ${(sideways / 2).toFixed(2)} s, ${(far / 2).toFixed(0)} m in 1 s`);
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    window.__res = rows.join('\n');
  } catch (err) {
    window.__res = 'EX: ' + err.message + ' | ' + (err.stack || '').slice(0, 300);
  }
  return window.__res;
};

/** The same in a real chase: a unit on the player's tail, its own driver at the wheel. */
window.__runLandLive = async function (runs = 8, seen = true, kph = 110) {
  window.__res = null;
  try {
    const g = window.__game, p = g.player;
    g.onBusted = () => { g.outcome = null; };
    g.onEscaped = () => { g.outcome = null; };
    const ctl = { throttle: 0, brake: 1, steer: 0, handbrake: 1 };
    const out = [];
    let lost = 0, least = 0, side = 0, brake = 0, n = 0;
    for (let r = 0; r < runs; r++) {
      g.heat.value = 5;
      for (let i = 0; i < 300 && g.dispatcher.units.filter((o) => !o.human).length < 2; i++) { g.heat.value = 5; g.stepHeadless(1 / 30, ctl); }
      const u = g.dispatcher.units.find((o) => !o.human && !o.vehicle.disabled);
      if (!u) continue;
      const v = u.vehicle;
      u._canBeSeen = () => seen;
      v.repair();
      v.assist.shielded = false;
      // 70 m out, going past the player, nose well off the way it is going.
      const a = (r / runs) * Math.PI * 2;
      const x = p.position.x + Math.sin(a) * 70, z = p.position.z + Math.cos(a) * 70;
      const way = a + Math.PI * 0.8;
      const nose = way + (r % 2 ? 1 : -1) * (60 * Math.PI) / 180;
      v.teleport({ x, y: g.sim.heightAt(x, z) + 6.5, z }, nose);
      const s = kph / 3.6;
      v.setVelocity({ x: Math.sin(way) * s, y: 0, z: Math.cos(way) * s });
      v._readState();
      let t0 = -1, s0 = 0, min = 999, sideways = 0, bk = 0;
      for (let i = 0; i < 220; i++) {
        g.heat.value = 5;
        g.stepHeadless(1 / 60, ctl);
        if (v.removed) break;
        if (t0 < 0 && v.grounded > 0) { t0 = i; s0 = v.speed; }
        if (t0 < 0) continue;
        if (i - t0 > 90) break;
        min = Math.min(min, v.speed);
        if (Math.abs(v.slipAngleBody || 0) > 10 / 57.3) sideways += 1 / 60;
        if (v.controls && v.controls.brake > 0.5) bk += 1 / 60;
      }
      if (t0 < 0 || !s0) continue;
      lost += 1 - min / s0; least += min; side += sideways; brake += bk; n++;
      await new Promise((res) => setTimeout(res, 0));
    }
    window.__res = n ? `${seen ? 'seen' : 'unseen'}, ${n} landings: slowest in 1.5 s ${Math.round((least / n) * 3.6)} km/h, ${Math.round((lost / n) * 100)}% of its speed gone, sideways ${(side / n).toFixed(2)} s, on the brakes ${(brake / n).toFixed(2)} s` : 'none';
  } catch (err) {
    window.__res = 'EX: ' + err.message + ' | ' + (err.stack || '').slice(0, 300);
  }
  return window.__res;
};
