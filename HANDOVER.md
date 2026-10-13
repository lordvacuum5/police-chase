# Handover

Written for whoever picks this up next — most likely another Claude, on another
account, with none of the conversation that built it. Read `CLAUDE.md` first;
it carries the user's standing rules. This file is the state of play.

Everything that matters is already in the repo. The **commit messages are the
project's real history** — they carry the reasoning, the measurements and the
rejected attempts, and they are worth `git log`-ing before changing anything in
an area you are new to. The **README is long and is the design document**; it is
not marketing, and it is where the numbers live.

---

## What it is

A browser police-chase game. Three.js r185 and a Rapier WASM physics world, no
build step, no framework, ES modules served straight to the browser. 188 commits
at the time of writing.

You drive a getaway car and a police force chases you — or you play the police
and chase a getaway car the computer drives, or you do either with friends over
a WebSocket relay.

### Running it

```bash
powershell -ExecutionPolicy Bypass -File ./serve.ps1 -Port 8477
```

Or, inside Claude Code, `preview_start` with the name `police-chase` from
`.claude/launch.json`. The dev server sends `Cache-Control: no-store`, so stale
code is never the explanation for odd behaviour — do not waste time on it.

Deploys to Azure (free F1 plan) through GitHub Actions on push to `master`. See
the Azure rule in `CLAUDE.md`: never change the hosting.

### URL flags

| | |
|---|---|
| `?air=1` | Spawn solo in the helicopter, no chase. How flying is tested without two machines. |
| `?touch` | Force the phone control layout on a desktop. |
| `?net=local` | Multiplayer over BroadcastChannel between two tabs, no server. |
| `?apple=1` | The Apple joke mode (see the README). |

---

## Layout

```
src/
  main.js         the Game object: boot, the frame loop, spawning, multiplayer
                  glue, and the HUD/camera wiring. Large. Start here.
  ai/
    dispatcher.js perception, wanted-level tiers, role assignment, the
                  intercept solver, roster management
    officer.js    one police unit's state machine, role by role
    driver.js     the shared driving brain: pure-pursuit steering,
                  counter-steer, the speed planner, scenery avoidance, the
                  stuck/reverse recovery. Every car uses this.
    runner.js     the getaway driver, for BE THE POLICE
    tactics.js    PIT and the rolling box
  game/           vehicle specs, heat, HUD, audio, garage, roadblocks,
                  helicopter (AI) and flyheli.js (the flyable one), score,
                  commentary, weather, props
  world/          map generation: citygen.js, towngen.js, roadgraph.js,
                  cutgraph.js, common.js
  core/           input.js (keyboard/pad/mouse/touch), touch.js (the on-screen
                  controls), menu.js, platform.js
  net/session.js  rooms, roles, car packets, interpolation
  physics/world.js collision groups, masks, sweeps, raycasts
server/           the C# WebSocket relay; it forwards packets opaquely
tests/            ~60 measurement rigs (see below)
```

### The bits that are easy to get wrong

* **Collision masks** live in `physics/world.js`. `RAY_SOLID` is terrain and
  buildings and **does not include props** — trees and lamp posts are
  `GROUP.PROP`. `RAY_GROUNDS` includes them. Several real bugs have been "the
  probe used the mask that cannot see trees".
* **`Game.quarry`** is the car the force is chasing. It is the player normally
  and the AI runner in BE THE POLICE. The dispatcher, roadblocks, helicopter and
  heat all take it. If you add something that chases, take the quarry, not
  `game.player`.
* **The flyable helicopter is not a vehicle.** `flyheli.js` has no collider and
  is stepped by hand, but it is duck-typed to look like a car because the rest
  of the game treats "the player" generically. A missing field there is an
  exception inside the frame loop, every frame. `_update` is wrapped in
  try/catch so the frame still draws.
* **`Driver`** is shared by the police, the getaway AI and nothing else — a
  change there moves every car in the game at once.

---

## Testing

There is no node in this environment and the rigs are not unit tests. They are
**measurement rigs that run in the page**: load the game, import the rig, call
its global, read `window.__res`.

```js
// in the browser console, with a game running
await import('/tests/force.js?v=' + Date.now());
window.__runForce(30, 110, 8, 'a label');
// then, when window.__forceDone is true:
window.__res
```

The ones you will want most:

| rig | what it answers |
|---|---|
| `force.js` | `__runForce` — the whole force against a weaving player. The main one. Reports how close they stay, what they hit, role time, intercept quality. |
| `weave.js` | the weaving path other rigs drive the player along |
| `lonetree.js` | `__runLoneTree`, `__runCrossCountry` — driving at an isolated tree |
| `woods.js`, `trees.js` | the same through a copse |
| `flyheli.js` | the flyable helicopter end to end |
| `drivable.js`, `supercar.js`, `policeturn.js` | car handling figures; the numbers on the menu cards come from these |
| `wanted.js`, `response.js`, `standdown.js` | heat, how fast the force arrives, what happens after a chase |

**The measurement trap, stated once more because it has caught me twice:** two
settings compared back-to-back in one page session are not comparable. Damage,
debris and bent scenery carry forward, so whichever batch runs second scores
worse whatever it is. Reload and compare first-batch to first-batch. In one case
this made a real improvement look like a 50% regression, and in another it
hid a real improvement completely.

Some knobs are exposed on `window` for exactly this, so a rig can put the old
behaviour back without editing code: `__shovePatience`, `__arcLead`,
`__noCourseClamp`. Follow that pattern when you add a tunable.

---

## Where things stand

### Recently finished

* **BE THE POLICE** — a solo mode where you are the police and `ai/runner.js`
  drives the getaway car. It plans by running `RoadGraph.predict` (the same
  forward expansion the dispatcher uses to cut you off) and scoring junctions by
  distance from the nearest police car. It drives normally for 10–60 s before
  breaking, and the chase then starts through the ordinary provocation rule.
* **A flyable police helicopter** — `game/flyheli.js`, with its own flight
  model, fuel, a helipad on the workshop roof, and two-thumbstick phone
  controls. Multiplayer-aware.
* **The police pack cap raised 18 → 30**, which needed the tier budget and
  `MAX_VEHICLES` raising with it.
* **Losing contact is two phases, not one.** Past `LOST_CONTACT_SECONDS` a unit
  more than `SEARCH_FROM` (90 m) from the last known position gets ROLE.RESPOND
  and drives there at pursuit pace; inside that it gets ROLE.SEARCH, which runs
  at a 1.5x limiter rather than 3.0x. It used to flip everything to SEARCH at
  once, so a car 400 m out crawled to the scene. `window.__searchFrom` puts the
  old behaviour back (Infinity) for measurement.
* **`Driver._mu` reads `gripScale`, not `highSpeedTyre`.** Worth knowing before
  tuning any car: raising the tyre grip alone gives a car more grip and tells
  its driver nothing, so it corners at the old speed with the rest in hand. The
  getaway car had exactly that bug — the cornering clamp was the binding limit
  on 95% of its running frames — and raising `gripScale` in step with the
  rubber took its mean speed in a chase from 88 to 122 km/h.

### Known open problems

1. **Police cars occasionally hit a tree in a chase.** The lone-tree case is
   fixed (0 hits of 5 at 80/110/140/170 km/h). What remains needs the pack: a
   car shoved sideways by `avoidBias` while dodging another car is not going
   where it is pointing, and a trunk off the wing is outside every forward cone.
   Rare enough that an 8-run five-star chase came back with zero tree contacts,
   so there is nothing to iterate against. **Do not guess at this** — the
   avoidance is heavily tuned and past attempts measured worse.
2. **One reverse in five is followed by another within ten seconds.** A car
   reverses, re-routes, is handed much the same line, and meets the same thing.
   That is a routing problem rather than a recovery one, and it is untouched. The
   stall probe now fans out to ±25 and ±49 degrees when the direct line to the
   aim is blocked, so a car goes forward and steers round a trunk instead of
   reversing. Measured on the town map that improved the chase (near 39% to
   49%, seen 91% to 100%, closest 26 m to 19 m) but put light contacts up
   (walls 0 to 9, hard 0 to 16, with `wrecked 0` and `worst 0.00` either way,
   so scrapes rather than crashes). If that scraping becomes visible in play,
   narrowing the fan to the ±25 pair alone is the first thing to try.
3. **The off-road crawl.** The README section "why are they so slow" documents
   seven attempts that did not untie it: cutting across country causes crashes,
   the crashes cause an off-road crawl, and the crawl is a quarter of the chase.
   Read that before trying an eighth.
4. **A continuous 360° helicopter loop** is not possible. Attitude is commanded
   as Euler YXZ angles, so past 90° of pitch yaw and roll briefly couple. Going
   over and back works; round and round needs the attitude integrated from rates
   as a quaternion. The user has been told this and may ask for it.
5. **Multiplayer with the helicopter has never actually been play-tested** by
   either of us in a real pursuit — the user kept hitting bugs before getting
   that far. It is believed to work.

### Things the user has asked for and had

Worth knowing so you do not undo them: police cars are heavier than the getaway
car on purpose so shoving works; the getaway car is tougher and grippier than
anything the force has but **not** heavier, for the same reason; the mouse
cyclic is a position stick that does not self-centre; the police may cut corners
and use the width of the road, and a patrol car on its beat may not.

---

## The user

Plays the game, reports in long conversational messages, and often puts three or
four separate issues in one paragraph — read the whole thing and pick them all
out, because they will notice if one is dropped. Their diagnoses are frequently
wrong but their observations are almost always right: when they said buildings
were mis-mapped, the buildings were fine, but the cars really were rocking
backwards and forwards exactly as described. Treat the report as real and the
explanation as a hypothesis to test.

They do not read long replies. See `CLAUDE.md`.
