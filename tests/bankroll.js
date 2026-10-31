// Up the bank beside the quarry's dirt track, leaning. Haldon Vale.
//
// "When I was at the quarry and the car was like flying in midair doing weird
// stuff because I went up that mound. Tyre tracks still appear. Like above
// me." From the log (tests/data/my-driving-20261031-174012.json): the Badger
// along the track out of the quarry at 70 km/h, then left up the bank beside
// it, just past the rim -- and up, ten metres, onto its roof.
//
// A Badger put where the log has it at `from` and steered after the logged
// line, at the logged speed, to `to`. Then the same off the other side of the
// track, and square up either bank from its middle at `kph`. Per run:
//
//   vy      the fastest it went up, m/s
//   above   the highest a wheel's contact came above its own mount, m (a
//           contact above the mount is a wheel being shoved up out of the
//           ground it is "in", and the skid mark drawn up there)
//   upset   how far from upright it got at worst (1 - up.y)
window.__runBankRoll = async function ({ from = 31.5, to = 36, kph = 65, kind = 'offroad' } = {}) {
  window.__res = null;
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.player && window.__game.world.__map); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const g = window.__game;
    g.onBusted = () => { g.outcome = null; };
    g.heat.value = 0;
    const q = g.world.__map.quarry;
    const log = await (await fetch('/tests/data/my-driving-20261031-174012.json?' + Date.now())).json();
    const S = log.samples;
    g.player.teleport({ x: 0, y: g.sim.heightAt(0, 400) + 1, z: 400 }, 0);
    let ctl = { throttle: 0, brake: 0, steer: 0, handbrake: 0 };
    let v = null;
    const origU = g._update.bind(g);
    g._update = (dt) => { if (v) v.setControls(ctl); origU(dt); if (v) v.setControls(ctl); };
    const run = (x, z, head, speed, steer) => {
      v = g.createVehicle(kind, kind, { x, y: g.sim.heightAt(x, z) + 0.9, z }, head, {});
      v.assist.boost = 1; v.assist.grip = 1;
      v.setVelocity({ x: Math.sin(head) * speed, y: 0, z: Math.cos(head) * speed });
      let vy = 0, above = -9, upset = 0;
      for (let i = 0; i < 270; i++) {
        ctl = steer(i);
        g._update(1 / 60);
        if (i < 10) continue;
        vy = Math.max(vy, v.linvel.y);
        upset = Math.max(upset, 1 - v.up.y);
        for (const w of v.wheels) if (w.grounded) above = Math.max(above, w.contact.y - w.worldPos.y);
      }
      g.removeVehicle(v);
      v = null;
      return `vy ${vy.toFixed(1)} above ${above.toFixed(2)} upset ${upset.toFixed(2)}`;
    };
    // After the logged line; `mirror` sends it the same way off the other
    // side of the track instead.
    const follow = (mirror) => {
      const s0 = S.find((s) => s.t >= from);
      let t = from;
      const lineZ = (x) => {
        const a = q.track[0], b = q.track[1];
        return a.z + (b.z - a.z) * (x - a.x) / (b.x - a.x);
      };
      return run(s0.x, s0.z, s0.head / 57.3, s0.kph / 3.6, () => {
        const tgt = S.find((s) => s.t >= t + 0.4) || S[S.length - 1];
        const cur = S.find((s) => s.t >= t) || tgt;
        t += 1 / 60;
        const tz = mirror ? 2 * lineZ(tgt.x) - tgt.z : tgt.z;
        const want = Math.atan2(tgt.x - v.position.x, tz - v.position.z);
        const hd = Math.atan2(v.forward.x, v.forward.z);
        const e = Math.atan2(Math.sin(want - hd), Math.cos(want - hd));
        const k = v.forwardSpeed * 3.6;
        return { throttle: k < cur.kph ? 1 : 0, brake: k > cur.kph + 8 ? 0.5 : 0, steer: clampS(e * 2.5), handbrake: 0 };
      });
    };
    const clampS = (s) => Math.max(-1, Math.min(1, s));
    const rows = [];
    rows.push(`log line: ${follow(false)}`);
    rows.push(`mirrored: ${follow(true)}`);
    // Square up either bank, from the middle of the track past the rim.
    const ox = Math.cos(q.open), oz = Math.sin(q.open), tx = -oz, tz = ox;
    for (const along of [q.r + 6, q.r + 12, q.r + 20]) {
      for (const side of [1, -1]) {
        for (const ang of [0.5, 1.0]) {
          // `ang` off square, toward the way out of the quarry.
          const hx = tx * side * Math.cos(ang) + ox * Math.sin(ang), hz = tz * side * Math.cos(ang) + oz * Math.sin(ang);
          const x = q.x + ox * along, z = q.z + oz * along;
          rows.push(`up ${Math.round(along - q.r)}/${side}/${ang}: ${run(x, z, Math.atan2(hx, hz), kph / 3.6, () => ({ throttle: 1, brake: 0, steer: 0, handbrake: 0 }))}`);
        }
      }
    }
    g._update = origU;
    window.__res = rows.join('\n');
  } catch (e) {
    window.__res = 'EX: ' + e.message + ' | ' + (e.stack || '').slice(0, 300);
  }
};
