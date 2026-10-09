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

    // ---- the mark ----
    // The rule the whole role balances on: close enough to tell what it is,
    // in front of you, and actually visible. Checked against a stand-in car
    // rather than the real thing, because what is being tested is the rule.
    {
      const h = make();
      h.position.set(0, 120, 0);
      h.yaw = 0; h.pitch = 0; h.roll = 0; h._applyAttitude();
      const at = (x, y, z) => ({ position: new (window.__modules.THREE.Vector3)(x, y, z) });
      const tests = [
        ['150 m ahead and below', at(0, 2, 150)],
        ['400 m ahead', at(0, 2, 400)],
        ['150 m behind', at(0, 2, -150)],
        ['150 m off to one side', at(150, 2, 0)],
        ['directly below', at(0, 2, 0)],
        ['60 m below, 40 m to the side', at(40, 60, 0)],
        ['above the aircraft', at(0, 200, 60)],
      ];
      for (const [what, t] of tests) {
        const range = Math.round(h.position.distanceTo(t.position));
        say(`  identify ${what} (${range} m): ${h.canIdentify(t) ? 'YES' : 'no'}`);
      }
      // And the cooldown: one call, then nothing for a while.
      const first = h.mark(at(0, 2, 150));
      const second = h.mark(at(0, 2, 150));
      say(`  mark, then mark again at once: ${first}, then ${second}`);
    }

    // ---- it has to answer everything the game asks of a player ----
    //
    // The aircraft is handed to code that was written for a car: placing a
    // police player, recovering one that fell out of the world, patching one
    // up. A method missing there is not a graceful degradation, it is an
    // exception inside the frame loop every frame -- which is precisely what
    // shipped: joining as the pilot threw out of _netPlaceNearSuspect, and
    // the helicopter then flew perfectly on every screen except the one
    // flying it. So the surface is checked rather than remembered.
    {
      const h = make();
      const NEEDS = ['teleport', 'setControls', 'repair', 'setVelocity', '_readState', 'update'];
      const missing = NEEDS.filter((m) => typeof h[m] !== 'function');
      const FIELDS = ['position', 'quaternion', 'linvel', 'forward', 'up', 'left',
        'speed', 'forwardSpeed', 'damage', 'wheels', 'spec', 'specKey',
        'prevPos', 'prevQuat', 'angvel', 'steerAngle'];
      const absent = FIELDS.filter((f) => h[f] === undefined);
      say(`player surface: ${missing.length ? 'MISSING ' + missing.join(' ') : 'all methods present'}`
        + `   ${absent.length ? 'MISSING ' + absent.join(' ') : 'all fields present'}`);

      // And that they actually run, not merely exist.
      let threw = null;
      try {
        h.repair();
        h.setVelocity({ x: 1, y: 2, z: 3 });
        h._readState();
        h.setControls({ throttle: 1 });
        h.teleport({ x: 10, y: 50, z: 10 }, 1);
      } catch (e) { threw = e.message; }
      say(`  called in anger: ${threw ? 'THREW ' + threw : 'all fine'}`);
    }

    // ---- buildings stop it, and never keep it ----
    //
    // Two failures, and the second is worse than the first. "You can fly
    // through buildings" was one. Then the fix collided as the rotor disc and
    // took the whole velocity away on contact, which wedged the aircraft in
    // mid-air with no way to climb off or back out -- a pilot stuck for the
    // rest of the game, saying nothing.
    //
    // Flown at a wall put here for the purpose rather than at the city,
    // because a tower block is surrounded by other tower blocks and the
    // question "did it go through that one" stops having a clean answer. A
    // slab on open ground, well away from everything, asks exactly what is
    // being asked.
    {
      const g = window.__game;
      const { addStaticBox, GROUP } = await import('../src/physics/world.js');
      const X = 760, Z = 760, Y = 60;            // out in the empty corner
      addStaticBox(g.world, X, Y, Z, 40, 40, 2, GROUP.BUILDING);
      g.world.step();                            // or the query pipeline cannot see it

      const h = new FlyingHelicopter(g, {});
      h.teleport({ x: X, y: Y, z: Z - 110 }, 0);
      fly(h, 16, { collective: 0.42, pitch: 1 });
      const gap = Z - 2 - h.position.z;          // to the near face
      const through = h.position.z > Z;

      // And then off it: climb, and back away.
      const atWall = { y: h.position.y, z: h.position.z };
      fly(h, 7, { collective: 1 });
      const climbed = h.position.y - atWall.y;
      fly(h, 7, { collective: 0.4, pitch: -1 });
      const away = atWall.z - h.position.z;

      say(`a wall 110 m ahead: ${through ? 'FLEW THROUGH IT' : `stopped ${gap.toFixed(1)} m short`}`
        + `   damage ${h.damage.toFixed(2)}`);
      say(`  and off it again: climbed ${Math.round(climbed)} m, backed off ${Math.round(away)} m `
        + `(${climbed > 8 || away > 8 ? 'got away' : 'TRAPPED'})`);
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
