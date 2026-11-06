// How does a car land off a big jump?
//
// "When I go over large jumps with the police SUV, it just seems to flip a little bit too
// much. It's just because it's so bouncy when it hits the ground." A police car a person
// drives, set off at `kph` from `drop` m up on the flat, nose down a touch as it would be
// coming off a crest, no controls. After first touching: how high it bounces back, how far
// it pitches and rolls, and whether it ends up over.
window.__runLanding = async function (kinds = ['suv', 'interceptor'], cases = [[8, 120, 0.1], [14, 150, 0.15], [20, 160, 0.25], [14, 130, -0.15]], tweak = null) {
  window.__res = null;
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.player); i++) await new Promise((r) => setTimeout(r, 100));
    const g = window.__game;
    const { drivablePoliceSpec } = await import('/src/game/vehicles.js');
    g.paused = true;
    g.onBusted = () => { g.outcome = null; };
    g.onEscaped = () => { g.outcome = null; };
    let e = null;
    for (const x of g.graph.edges) if (x.width >= 10 && (!e || x.length > e.length)) e = x;
    const a = e.points[0], b = e.points[e.points.length - 1];
    const L = Math.hypot(b.x - a.x, b.z - a.z), dx = (b.x - a.x) / L, dz = (b.z - a.z) / L;
    const rows = [];
    for (const kind of kinds) {
      const spec = drivablePoliceSpec(kind);
      if (tweak) tweak(spec, kind);
      for (const [drop, kph, nose] of cases) {
        const ground = g.sim.heightAt(a.x, a.z);
        const v = g.createVehicle(kind, kind, { x: a.x + 300, y: ground + 2 + 900, z: a.z }, 0, { police: true, spec });
        const h = Math.atan2(dx, dz), sp = kph / 3.6;
        const half = h * 0.5, cn = Math.cos(nose / 2), sn = Math.sin(nose / 2);
        v.teleport({ x: a.x, y: ground + drop, z: a.z }, h);
        // Nose down by `nose` about the car's own lateral axis.
        const qy = { w: Math.cos(half), y: Math.sin(half) };
        v.body.setRotation({ x: qy.w * sn, y: qy.y * cn, z: -qy.y * sn, w: qy.w * cn }, true);
        v.setVelocity({ x: dx * sp, y: 0, z: dz * sp });
        v._readState();
        let touched = false, bounce = 0, pitch = 0, roll = 0, over = 0, downAt = 0;
        for (let i = 0; i < 6 * 60; i++) {
          v.setControls({ throttle: 0, brake: 0, steer: 0, handbrake: 0 });
          g._update(1 / 60);
          const here = g.sim.heightAt(v.position.x, v.position.z);
          const above = v.position.y - here;
          if (!touched && v.wheels.some((w) => w.grounded)) { touched = true; downAt = i / 60; }
          if (touched) {
            bounce = Math.max(bounce, above - 0.7);
            pitch = Math.max(pitch, Math.abs(Math.asin(Math.max(-1, Math.min(1, v.forward.y)))));
            roll = Math.max(roll, Math.abs(Math.asin(Math.max(-1, Math.min(1, v.left.y)))));
            if (v.up.y < 0.25) over++;
          }
          if (i % 120 === 0) await new Promise((r) => setTimeout(r, 0));
        }
        rows.push(`${kind} ${drop} m at ${kph}, nose ${nose}: bounced ${bounce.toFixed(2)} m, pitched ${(pitch * 57.3).toFixed(0)}, rolled ${(roll * 57.3).toFixed(0)}, ${over ? `OVER for ${(over / 60).toFixed(1)} s` : 'stayed up'}, damage ${v.damage.toFixed(2)}`);
        g.removeVehicle(v);
      }
    }
    window.__res = rows;
  } catch (e2) {
    window.__res = ['EX: ' + e2.message, (e2.stack || '').slice(0, 300)];
  }
};
