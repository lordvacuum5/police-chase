// Can you simply drive away from five stars?
//
// Two measurements, because "too fast to catch" is two separate questions.
//
// 1. Straight line, every car. Out past the map edge on forced tarmac like
//    tests/supercar.js: 0-100, 0-160, 0-200 and top speed. The police cars are
//    also run with the rubber band at full stretch, since that is the fastest
//    they will ever go -- and it cannot take them past their own limiter.
//
// 2. The helicopter against a car that does not stop. The aircraft is run on
//    its own, against a target moved along a fixed course at a fixed speed, so
//    nothing else in the chase can help or hinder it. Two courses: a long
//    straight, and blocks -- a straight at speed, braking to take a right angle
//    at 70 km/h, and back up to speed. Reports how much of the time the light
//    is on the car, the longest it is off, and whether it ever gets it back.
window.__runOutrun = async function (kinds = ['runner', 'supercar', 'patrol', 'interceptor', 'unmarked'],
  heliSpeeds = [160, 200, 230, 260, 300]) {
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.player); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const g = window.__game, THREE = window.__modules.THREE;
    if (g.audio) g.audio.muted = true;
    g.onBusted = () => { g.outcome = null; };
    g.onEscaped = () => { g.outcome = null; };
    g.heat.value = 0;
    const out = { straight: {}, heli: {} };

    // ------------------------------------------------------------ 1. straight
    if (kinds.length) {
      const realSurface = g.sim.surfaceAt, realHeight = g.sim.heightAt;
      g.sim.surfaceAt = () => 1;
      g.sim.heightAt = () => 0;
      const LANE_X = 1100, Z0 = -1150, Z1 = 1150;
      let subject = null, boost = 1, controls = { throttle: 0, brake: 0, steer: 0, handbrake: 0 };
      const origU = g._update.bind(g);
      g._update = (dt) => {
        if (subject) { subject.setControls(controls); subject.assist.boost = boost; }
        origU(dt);
        if (subject) { subject.setControls(controls); subject.assist.boost = boost; }
      };
      const treadmill = (v) => {
        if (v.position.z < Z1) return;
        const vel = { x: v.linvel.x, y: v.linvel.y, z: v.linvel.z };
        const gear = v.gear, rpm = v.rpm, omegas = v.wheels.map((w) => w.omega);
        v.teleport({ x: LANE_X, y: v.position.y, z: Z0 }, 0);
        v.setVelocity(vel);
        v.gear = gear; v.rpm = rpm;
        v.wheels.forEach((w, i) => { w.omega = omegas[i]; });
      };
      const police = new Set(['patrol', 'interceptor', 'unmarked']);
      const runs = [];
      for (const kind of kinds) {
        runs.push([kind, 1]);
        if (police.has(kind)) runs.push([kind, 1.75]);
      }
      for (const [kind, b] of runs) {
        boost = b;
        const v = g.createVehicle(kind, kind, { x: LANE_X, y: 0.9, z: Z0 }, 0, {});
        subject = v;
        controls = { throttle: 0, brake: 1, steer: 0, handbrake: 1 };
        g.stepHeadless(0.8);
        controls = { throttle: 1, brake: 0, steer: 0, handbrake: 0 };
        const marks = { 100: null, 160: null, 200: null, 250: null };
        let t = 0, top = 0, flatFor = 0, last = 0;
        const step = 1 / 60;
        while (t < 90) {
          g.stepHeadless(step);
          t += step;
          treadmill(v);
          const kph = Math.abs(v.forwardSpeed) * 3.6;
          for (const m of Object.keys(marks)) if (marks[m] === null && kph >= +m) marks[m] = t;
          top = Math.max(top, kph);
          if (Math.floor(t * 60) % 120 === 0) {
            if (kph - last < 0.5) flatFor++; else flatFor = 0;
            last = kph;
            if (flatFor >= 2 && t > 10) break;
          }
        }
        const r = {};
        for (const m of Object.keys(marks)) r[`0-${m}`] = marks[m] === null ? null : +marks[m].toFixed(2);
        r.topKph = Math.round(top);
        out.straight[b > 1 ? `${kind} (full rubber band)` : kind] = r;
        subject = null;
        g.removeVehicle(v);
        await new Promise((res) => setTimeout(res, 0));
      }
      g._update = origU;
      g.sim.surfaceAt = realSurface;
      g.sim.heightAt = realHeight;
    }

    // ---------------------------------------------------------- 2. helicopter
    const Heli = g.helicopter.constructor;
    const dummy = { add() {}, remove() {} };
    const k = { position: new THREE.Vector3(), seen: false, timeSinceSeen: 0 };
    const fake = {
      heat: { tier: 5 }, scene: dummy, rng: () => 0.37, say() {},
      dispatcher: { knowledge: k },
    };

    // A target moved by hand: position, heading and speed are all this needs.
    const course = (kind, cruise) => {
      const s = { x: 0, z: 0, h: 0, v: 20, phase: 'run', left: 400, turned: 0 };
      return (dt) => {
        if (kind === 'straight') s.v = Math.min(cruise, s.v + 6 * dt);
        if (kind === 'blocks') {
          if (s.phase === 'run') {
            s.v = Math.min(cruise, s.v + 6 * dt);
            s.left -= s.v * dt;
            // Braking distance to 70 km/h at 8 m/s^2.
            const need = Math.max(0, (s.v * s.v - 19.4 * 19.4) / 16);
            if (s.left <= need) s.phase = 'brake';
          } else if (s.phase === 'brake') {
            s.v = Math.max(19.4, s.v - 8 * dt);
            if (s.v <= 19.4) { s.phase = 'turn'; s.turned = 0; }
          } else {
            const rate = s.v / 25;
            s.h += rate * dt;
            s.turned += rate * dt;
            if (s.turned >= Math.PI / 2) { s.phase = 'run'; s.left = 400; }
          }
        }
        s.x += Math.sin(s.h) * s.v * dt;
        s.z += Math.cos(s.h) * s.v * dt;
        return s;
      };
    };

    for (const courseKind of ['straight', 'blocks']) {
      for (const kph of heliSpeeds) {
        const h = new Heli(fake);
        const move = course(courseKind, kph / 3.6);
        const target = {
          position: new THREE.Vector3(), forward: new THREE.Vector3(0, 0, 1),
          linvel: new THREE.Vector3(), speed: 0,
        };
        // Already on station overhead when the run starts: this is about
        // keeping up, not about how long it takes to arrive.
        k.position.set(0, 0, 0);
        h.launch(target);
        h.pos.set(0, 62, 0);
        h.beam.set(0, 0, 0);
        const dt = 1 / 30;
        let t = 0, lit = 0, off = 0, longest = 0, seenFor = 0, lastSeen = 0, everLost = false, regained = 0, first = null;
        while (t < 120) {
          const s = move(dt);
          target.position.set(s.x, 0, s.z);
          target.forward.set(Math.sin(s.h), 0, Math.cos(s.h));
          target.linvel.set(Math.sin(s.h) * s.v, 0, Math.cos(s.h) * s.v);
          target.speed = s.v;
          h.fuel = 999;
          h.update(dt, target);
          t += dt;
          const seen = h.canSee(target);
          // Ground units have the car for the first few seconds, as they would
          // when the aircraft is called up: that is where the light starts.
          if (t < 10) k.position.copy(target.position);
          // What the aircraft is allowed to know, as the dispatcher would tell it.
          k.seen = seen || t < 10;
          k.timeSinceSeen = k.seen ? 0 : (k.timeSinceSeen || 0) + dt;
          if (seen) {
            k.position.copy(target.position);
            if (first === null) first = t;
            if (everLost && off > 0) regained++;
            off = 0; seenFor += dt; lastSeen = t;
          } else if (seenFor > 0) {
            // The force keeps a fix for a few seconds after losing sight.
            if (t - lastSeen < 3) k.position.copy(target.position);
            off += dt;
            if (off > 1) everLost = true;
            longest = Math.max(longest, off);
          }
          if (seenFor > 0) lit += seen ? dt : 0;
        }
        out.heli[`${courseKind} @ ${kph} km/h`] = {
          litPct: first === null ? 0 : Math.round(100 * lit / (120 - first)),
          longestOff_s: +longest.toFixed(1),
          regained,
          endsLit: off === 0,
          gap_m: Math.round(h.distanceTo(target.position)),
        };
        await new Promise((res) => setTimeout(res, 0));
      }
    }
    window.__res = JSON.stringify(out, null, 1);
  } catch (e) {
    window.__res = 'EX ' + e.message + '\n' + String(e.stack).slice(0, 500);
  }
};
