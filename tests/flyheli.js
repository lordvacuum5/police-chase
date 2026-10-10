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

/**
 * One already in the air with the rotor turning. An aircraft now starts shut
 * down on its skids and has to be started, which is right for a pilot and
 * only noise for a test about how it flies.
 */
function make() {
  const h = new FlyingHelicopter(window.__game, {});
  h.teleport({ x: 0, y: 120, z: 0 }, 0);
  running(h);
  return h;
}

/** Rotor up to speed, as if W had been held on the pad. */
function running(h) {
  h.engineOff = false;
  h.starting = 0;
  h.spin = 1;
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

    // ---- hands off, it comes down ----
    // The collective idles below a hover, so letting go is a descent rather
    // than a free hover -- but a flyable one, not a plummet.
    {
      const h = make();
      const y0 = h.position.y;
      fly(h, 10);
      const rate = (y0 - h.position.y) / 10;
      say(`hands off 10 s: sank ${(y0 - h.position.y).toFixed(1)} m `
        + `(${rate.toFixed(1)} m/s)   drift ${Math.hypot(h.position.x, h.position.z).toFixed(2)} m`);
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
        const h = running(new FlyingHelicopter(window.__game, {}));
        h.teleport({ x: 0, y: 120, z: 0 }, head);
        fly(h, 6, { pitch: 1 });
        got.push(h.speed);
      }
      const lo = Math.min(...got), hi = Math.max(...got);
      say(`same input from 4 headings: speed ${lo.toFixed(2)}..${hi.toFixed(2)} m/s   `
        + `spread ${((hi - lo) * 100 / hi).toFixed(1)}%`);
    }

    // ---- the ground is solid, and arriving at it matters ----
    {
      const soft = running(new FlyingHelicopter(window.__game, {}));
      soft.teleport({ x: 0, y: 12, z: 0 }, 0);
      // A hover needs about 0.22 on the lever; a shade under it walks down.
      fly(soft, 16, { collective: 0.16 });
      say(`set down gently: y ${soft.position.y.toFixed(2)}   on skids ${soft.onGround}   `
        + `damage ${soft.damage.toFixed(2)} ${soft.disabled ? '-- WRECKED, too harsh' : ''}`);

      const hard = running(new FlyingHelicopter(window.__game, {}));
      hard.teleport({ x: 0, y: 160, z: 0 }, 0);
      fly(hard, 16, { collective: -1 });           // dropped like a brick
      say(`  dropped from 160 m: y ${hard.position.y.toFixed(2)}   `
        + `damage ${hard.damage.toFixed(2)}   ${hard.disabled ? 'wrecked' : 'WALKED AWAY -- too soft'}`);
    }

    // ---- fuel ----
    {
      const h = make();
      fly(h, 60);
      const burnt = ENDURANCE - h.fuel;
      say(`idling 60 s: burnt ${burnt.toFixed(0)} s of ${ENDURANCE} `
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

      // Eased up to rather than flown at, so this measures stopping and
      // getting away again. Arriving fast is a crash, and that is the test
      // below.
      const h = running(new FlyingHelicopter(g, {}));
      h.teleport({ x: X, y: Y, z: Z - 30 }, 0);
      // Enough collective to hold height while it eases forward: at idle it
      // sinks, and below the slab is not the same as through it.
      fly(h, 24, { collective: 0.26, pitch: 0.06 });
      const gap = Z - 2 - h.position.z;          // to the near face
      const through = h.position.z > Z;

      // And then off it: climb, and back away.
      const atWall = { y: h.position.y, z: h.position.z };
      fly(h, 7, { collective: 1 });
      const climbed = h.position.y - atWall.y;
      fly(h, 7, { collective: 0.4, pitch: -1 });
      const away = atWall.z - h.position.z;

      say(`eased up to a wall: ${through ? 'WENT THROUGH IT' : `stopped ${gap.toFixed(1)} m short`}`
        + `   damage ${h.damage.toFixed(2)}`);
      say(`  and off it again: climbed ${Math.round(climbed)} m, backed off ${Math.round(away)} m `
        + `(${climbed > 8 || away > 8 ? 'got away' : 'TRAPPED'})`);
    }

    // ---- crashing into it, rather than parking against it ----
    //
    // "Hitting buildings isn't very realistic -- you can just hit one." You
    // could: a wall took the speed away and that was the whole event. Now a
    // rotor into a building at speed ends the sortie, and the aircraft comes
    // back on the pad a few seconds later rather than being gone for good.
    {
      const g = window.__game;
      const { addStaticBox, GROUP } = await import('../src/physics/world.js');
      const X = -760, Z = -760, Y = 60;
      addStaticBox(g.world, X, Y, Z, 40, 40, 2, GROUP.BUILDING);
      g.world.step();

      // Fast into it: wrecked.
      const fast = running(new FlyingHelicopter(g, {}));
      fast.teleport({ x: X, y: Y, z: Z - 150 }, 0);
      fly(fast, 20, { collective: 0.55, pitch: 0.7 });
      say(`flown into a wall at speed: ${fast.disabled ? 'wrecked' : 'NOT WRECKED'}   `
        + `damage ${fast.damage.toFixed(2)}`);

      // Nudged into it: a scrape, still flying.
      const slow = running(new FlyingHelicopter(g, {}));
      slow.teleport({ x: X, y: Y, z: Z - 12 }, 0);
      fly(slow, 6, { collective: 0.26, pitch: 0.04 });
      say(`  and nudged into one: ${slow.disabled ? 'WRECKED -- too harsh' : 'still flying'}   `
        + `damage ${slow.damage.toFixed(2)}`);

      // A wreck comes back, on the pad.
      const pad = g.garage && g.garage.helipad;
      if (pad) {
        // Open ground, not the pad: the game's own aircraft is parked there
        // and has a collider, so a second one dropped on top of it sits on
        // the first one's roof and never reaches the ground at all. Which is
        // correct, and not what this is asking about.
        fast.teleport({ x: 600, y: 40, z: 600 }, 0);
        fast.wreck();
        fast.linvel.set(0, 0, 0);
        fly(fast, 22, {});   // the fall, then the ten seconds down
        const home = Math.hypot(fast.position.x - pad.x, fast.position.z - pad.z);
        say(`  a wreck left on the ground: ${fast.disabled ? 'STILL DOWN' : 'flying again'}   `
          + `${home < 2 ? 'on the pad' : `${Math.round(home)} m from the pad`}`);
      }
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
