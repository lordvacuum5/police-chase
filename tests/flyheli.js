// Does the helicopter fly?
//
// A flight model is easy to get subtly wrong in ways that are miserable to
// find with a mouse in your hand -- a hover that slowly sinks, a lean that
// will not come back to level, a climb rate that depends on which way you are
// pointing. So each of those is a question with a number for an answer, asked
// without a renderer or a camera in the way.
//
// The aircraft is stepped directly rather than through the game loop: it does
// not touch the physics world at all, so there is nothing to synchronise.

import { FlyingHelicopter, ENDURANCE } from '../src/game/flyheli.js';

const STICK = { collective: 0, pitch: 0, roll: 0, yaw: 0 };

function fly(h, seconds, c = {}, dt = 1 / 60) {
  const stick = Object.assign({}, STICK, c);
  for (let i = 0; i < Math.round(seconds / dt); i++) h.update(dt, stick);
  return h;
}

function make() {
  const h = new FlyingHelicopter(window.__game, {});
  h.teleport({ x: 0, y: 120, z: 0 }, 0);
  return h;
}

window.__runFlyHeli = async function () {
  window.__flyDone = false;
  window.__res = null;
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.player); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const rows = [];
    const say = (s) => rows.push(s);

    // ---- hands off, it holds height ----
    // The collective centres on a hover, so a pilot who lets go to look at
    // something does not quietly descend into a roof.
    {
      const h = make();
      const y0 = h.position.y;
      fly(h, 10);
      say(`hands off 10 s: height ${(h.position.y - y0 >= 0 ? '+' : '')}`
        + `${(h.position.y - y0).toFixed(2)} m   drift `
        + `${Math.hypot(h.position.x, h.position.z).toFixed(2)} m`);
    }

    // ---- climb and descend ----
    {
      const h = make();
      fly(h, 6, { collective: 1 });
      const up = h.position.y - 120;
      const h2 = make();
      fly(h2, 6, { collective: -1 });
      const down = h2.position.y - 120;
      say(`collective 6 s: full up ${up >= 0 ? '+' : ''}${up.toFixed(0)} m `
        + `(${(up / 6).toFixed(1)} m/s)   full down ${down.toFixed(0)} m `
        + `(${(down / 6).toFixed(1)} m/s)`);
    }

    // ---- lean to go ----
    // Thrust is along the aircraft's own up, so the only way forward is to
    // put the nose down. If this does not accelerate, nothing else works.
    {
      const h = make();
      fly(h, 8, { pitch: 1 });
      say(`nose down 8 s: ${h.speed.toFixed(1)} m/s (${Math.round(h.kmh)} kph)   `
        + `forward ${h.position.z.toFixed(0)} m   sank ${(120 - h.position.y).toFixed(0)} m`);
    }

    // ---- and it comes back to level ----
    {
      const h = make();
      fly(h, 4, { pitch: 1, roll: 1 });
      const leaned = { p: h.pitch, r: h.roll };
      fly(h, 3);
      say(`stick released: pitch ${leaned.p.toFixed(2)} -> ${h.pitch.toFixed(3)}   `
        + `roll ${leaned.r.toFixed(2)} -> ${h.roll.toFixed(3)}`);
    }

    // ---- pedals turn it on the spot ----
    {
      const h = make();
      const y0 = h.position.y;
      fly(h, 4, { yaw: 1 });
      const deg = (h.yaw * 180 / Math.PI).toFixed(0);
      say(`full pedal 4 s: ${deg} degrees   height ${(h.position.y - y0).toFixed(2)} m   `
        + `drift ${Math.hypot(h.position.x, h.position.z).toFixed(2)} m`);
    }

    // ---- a turn does not depend on which way you point ----
    // Same input from four headings should give the same flight, or the model
    // is leaking the world frame into the body frame somewhere.
    {
      const got = [];
      for (const head of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
        const h = new FlyingHelicopter(window.__game, {});
        h.teleport({ x: 0, y: 120, z: 0 }, head);
        fly(h, 6, { pitch: 1 });
        got.push(h.speed);
      }
      const lo = Math.min(...got), hi = Math.max(...got);
      say(`same input from 4 headings: speed ${lo.toFixed(2)}..${hi.toFixed(2)} m/s   `
        + `spread ${((hi - lo) * 100 / hi).toFixed(1)}%`);
    }

    // ---- the ground is solid ----
    {
      const h = new FlyingHelicopter(window.__game, {});
      h.teleport({ x: 0, y: 40, z: 0 }, 0);
      fly(h, 14, { collective: -1 });
      say(`dropped onto the ground: y ${h.position.y.toFixed(2)}   `
        + `on skids ${h.onGround}   damage ${h.damage.toFixed(2)}`);
    }

    // ---- fuel ----
    {
      const h = make();
      fly(h, 60);
      const burnt = ENDURANCE - h.fuel;
      say(`hover 60 s: burnt ${burnt.toFixed(0)} s of ${ENDURANCE} `
        + `(${(ENDURANCE / 60).toFixed(0)} min tank, ${(ENDURANCE / burnt).toFixed(1)} min real)`);
    }

    window.__res = rows.join(String.fromCharCode(10));
    window.__flyDone = true;
    return window.__res;
  } catch (e) {
    window.__flyDone = true;
    window.__res = 'EX: ' + e.message + ' | ' + (e.stack || '').slice(0, 400);
    return window.__res;
  }
};
