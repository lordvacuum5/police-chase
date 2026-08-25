# Police Chase

A 3D police pursuit game. You are the escapee; the police coordinate to stop you.

Runs in the browser on **three.js** (rendering) and **Rapier** (rigid-body physics),
both vendored locally in `vendor/` so the game works offline. No build step, no
Node, no bundler — the browser loads the ES modules directly. All sound is
synthesised at runtime, so there are no audio files either.

---

## Running it

```bash
powershell -ExecutionPolicy Bypass -File .\serve.ps1
```

That starts a small static server (built on .NET's `HttpListener`, so nothing to
install) and opens the game. Use `-Port 9000` to change the port, `-NoBrowser`
to skip opening a window.

The files **must** be served over HTTP. Opening `index.html` from disk will not
work — browsers refuse ES module imports and WASM loads on `file://`.

**Ctrl+C** stops the server. If you ever need to kill one from elsewhere, note
that the listening port belongs to the kernel's HTTP.sys driver, not to
PowerShell — looking up the port owner gives you PID 4 (System). Find it by
command line instead:

```powershell
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
  Where-Object { $_.CommandLine -like '*serve.ps1*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

## Controls

| Key | Action |
|---|---|
| `W` / `↑` | Throttle |
| `S` / `↓` | Brake — and reverse once you have stopped |
| `A` / `D` | Steer |
| `Space` | Handbrake |
| `Shift` | Clutch kick (dumps the clutch to break the rear loose) |
| `C` | Cycle camera — chase / close / bonnet / cinematic |
| `R` | Flip the car upright, or restart after being busted |
| `P` | Pause · `H` Controls · `M` Mute · `F3` Debug telemetry |

A gamepad works too: left stick steers, triggers are throttle and brake, `A`
handbrake, `X` clutch kick.

Sound only starts after your first key press — browsers refuse to play audio
until the page has been interacted with.

---

## How the driving model works

Nothing about the handling is scripted. Each car is one Rapier rigid body with
four raycast wheels:

* **Suspension** — a spring/damper per corner, plus anti-roll bars. Body roll,
  dive and squat all fall out of this rather than being animated.
* **Tyres** — a *combined-slip* Pacejka model. Longitudinal and lateral slip are
  normalised by the slip at which each peaks, combined into one slip vector, and
  a single curve gives the force magnitude, acting against the direction of that
  vector. Grip is also load sensitive: a tyre carrying 6 kN gives less than twice
  the grip of one carrying 3 kN, which is what makes weight transfer cost the car
  net grip and lets understeer and lift-off oversteer emerge on their own.
* **Wheel dynamics** — each wheel has its own angular velocity, integrated
  semi-implicitly (the tyre is far too stiff against a wheel's inertia to
  integrate explicitly at 120 Hz). Lock a wheel under braking and it stays
  locked; there is no ABS.
* **Drivetrain** — torque curve, six close ratios, reflected driveline inertia,
  engine braking, and traction control that backs the engine off when the driven
  wheels spin (disabled by the handbrake and the clutch kick, so deliberate
  slides still work).
* **Steering** — available lock is sized by what the tyres can actually use at
  the current speed: the Ackermann angle for the target lateral acceleration,
  plus an allowance for front tyre slip. It never drops below the lock needed to
  point the front wheels along the direction of travel, so a slide is always
  catchable. The rack also takes real time to move, because slamming to full
  lock in three frames just scrubs the front tyres.
* **Surfaces** — road (μ 1.42), pavement and city blocks (μ 1.12), grass
  (μ 0.62). Clipping a kerb costs you time, not the back of the car.

Measured behaviour of the player car (`runner`), on a flat asphalt pad:

| Test | Result |
|---|---|
| Static wheel loads | 14.55 kN vs 14.52 kN kerb weight, 52.5 % front |
| Steady-state skidpad | 0.98 g with all four wheels loaded |
| Braking from 100 km/h | 1.15 g, front wheels locked |
| 0–100 km/h | 7.3 s · 0–160 km/h 15.4 s · top speed 214 km/h |
| Handbrake turn | body slip to −37°, catchable on opposite lock |
| Full lock at 20 km/h, coasting | front tyres at 0.76 of the limit (no scrub) |
| Full lock at 20 km/h, full throttle | rear slip ratio 0.62 (was 2.18 uncontrolled) |

**Every police car runs this same code.** When an officer botches a PIT they spin
out for exactly the reasons you would.

### Rubber-banding

Units closing from a distance are helped, and the help is gone by the time they
reach you. A pursuing car gets up to **+50% speed** (scaled by how far behind it
is, reaching the full amount at 250 m), extra grip, and a stability assist that
keeps it from getting out of shape. All three taper away between 50 m and 30 m,
so the part of the chase you can actually see is fought on the same physics you
are driving on. Ambient patrols are never assisted.

A unit still on its way is also **shielded**: it records impacts for sound and
camera but takes no damage, so a crash en route costs it time rather than
putting it out of the chase. Shielding ends at the same 30 m boundary.

Tuned in `Officer._updateAssist` (`src/ai/officer.js`); the vehicle side is the
`assist` block in `src/physics/vehicle.js`.

### Driving within their means

Path following gets its speed from the curvature planner, but driving straight
at a target bypasses all of that -- which is how units ended up flat out into a
building the target happened to be behind. `Driver.safeSpeed` caps every
command by two things: the distance it could stop in, probed by raycast *toward
the aim point* (probing along the nose reads the building on the outside of
every corner as a wall and reduces the whole force to a crawl), and the grip
limit of the arc it is being asked to turn through.

### Braking for the junction, not for the target

A unit running alongside its target commits to a speed on the strength of a
clear line *to the target*. Then the target turns, and the unit arrives at the
junction far too fast to take it — and goes straight on into whatever is on the
far side. It cannot predict your moves, and should not: what it can do is never
be going faster than the road it is on can absorb.

Two things were missing. The clearance probe only ever looked toward the aim
point, which answers "is the way I want to go clear" — at speed a different
question from "is the way I am *going* clear", and the second one is the one
that ends with a car in a wall. And every check was collider-based, so open
ground was invisible: a bend with a field on the outside of it has nothing
solid anywhere near it, and the way ahead reads as completely clear right up
until the car is in the field.

So there are now two more caps on every speed command:

* a second clearance probe along the direction of travel, giving a plain
  stopping distance;
* **road runout** — how far the car can carry on along its current trajectory
  before it leaves the carriageway, walked over the surface raster rather than
  cast as a ray, because what is being looked for is the absence of road, not
  the presence of an obstacle. Arriving somewhere the road ends in thirty
  metres means being slow enough to *turn* within thirty metres, so the cap is
  the cornering limit for that radius.

The runout probe follows an **arc**, curving at whatever rate the car is
turning at right now, and that distinction is the whole value of it. Probed in
a straight line, a car correctly following a bend is forever about to leave the
road — on the town map the check fired 84% of the time and degenerated into a
flat speed limit. Along the arc, a car turning enough to make the bend sees
clear road ahead, and a car that is not sees the field it is about to arrive
in. That is exactly the difference between making a junction and going straight
on at it.

Measured over 90 s at four stars, same script both ways. Impacts are counted as
step changes in speed rather than as damage, because units more than 30 m from
the player are damage-shielded and a damage-based count quietly ignores most of
the map:

| per car-minute | Ashfield before | after | Wexbury before | after |
|---|---|---|---|---|
| hit scenery | 0.44 | **0.00** | 1.37 | **0.29** |
| hit another car | 0.51 | **0.12** | 0.26 | **0.23** |
| stopped dead | 0.06 | 0.12 | 0.85 | **0.35** |
| time on grass | 0.8% | **0.4%** | 18% | **11.6%** |
| median speed | 50.9 km/h | 49.3 | 39.9 km/h | **44.2** |

Ashfield pays about 1.6 km/h of median pace, and 7 km/h off the top end, for
never hitting the scenery at all. Wexbury gets it for free — it comes out
faster, because the time was not being spent driving.

### Knowing how much grip they have

Both of those planners used to assume dry tarmac — a hard-coded 1.42 — whatever
the car was actually standing on. Grass is 0.62, less than half, so a unit with
two wheels on a verge was planning corners against more than twice the grip it
had; and having started to slide it went on asking for exactly the speed that
caused the slide, so the slide continued to the next junction. Three things
changed:

* **Plan against the real surface.** `Vehicle.surfaceMu` averages the peak
  friction under the grounded wheels, and both planners use it.
* **Believe the evidence.** `gripEstimate` falls while the car is genuinely
  sliding and returns slowly once it has hooked up, so a driver who has just
  been caught out spends the next few seconds driving within itself. Floored
  well short of a crawl — the point is to stop chasing grip that is not there,
  not to turn everyone who steps out once into a learner.
* **Actually lift.** While sideways, the speed target is capped *below current
  speed*, scaled by how far gone the car is and by whether this driver can hold
  a slide at all.

### Getting back on the road

Two more failures put units on grass and kept them there, and neither was a
slide.

`_pursue` drove straight at the target whenever it had line of sight within
85 m. On a grid, a clear view of the car ahead usually does mean you are both
on the same street; on a town map of curving roads it means the line cuts the
bend, straight over whatever is inside it. Line of sight is now checked against
the surface as well as the geometry — a clear view over a field is not a road.

And nothing said what to do once off the carriageway. A unit shoved onto a
verge kept aiming at its lookahead point on the road it was no longer on and
ground along beside it at walking pace, sometimes for the rest of the chase.
Routes were never the problem: **not one planned waypoint was ever off-road** —
the cars had simply left them, a median of 25 m. Now, being off the hard
surface makes rejoining it the only job, aiming a little way *along* the road
rather than at the nearest point on it, because aiming at the nearest point
means driving at the kerb square on and sitting against it with the wheels
turned.

Measured over 90 s at four stars, same script both ways:

| | Ashfield before | after | Wexbury before | after |
|---|---|---|---|---|
| time on grass | 4.5% | **0.3%** | 25.5% | **12.4%** |
| more than 6 m off the carriageway | 15.7% | **7.9%** | 20.7% | **11.4%** |
| sideways past 26° | 0.5% | **0.3%** | 0.9% | **0.1%** |
| mean damage | 0.045 | **0.000** | 0.089 | **0.018** |
| median speed | 52.9 km/h | 51.7 | 42.9 km/h | **49.5** |

On the town map they end up both tidier and *faster*, because the time was
never being spent driving — it was being spent stuck on a verge.

### Backing out

A unit that has buried itself in something stops, selects reverse, backs out
with opposite lock so the nose swings toward where it wanted to go, and then
throws away its route — otherwise it drives straight back into whatever it just
left. It gives up early once it has made seven metres of room.

The detection has to work off the speed the *caller asked for*, not the speed
the safety limiter allowed. A car pinned against a wall is correctly told to
target zero, so testing the limited value means it is never considered stuck and
never reverses. That single confusion left reverse firing 0% of the time and
units stuck for over five seconds in 26% of samples.

### Lane keeping

Pure pursuit alone leaves a standing cross-track error through curves — the car
tracks a chord inside the bend rather than the lane. A Stanley-style correction
term pulls it back onto the line, scaled down with speed so it does not become a
twitch at motorway pace.

### One tactic at a time

A PIT and a rolling box are mutually exclusive across the whole pursuit. Boxing
units hold station relative to the target; a PIT car arriving across their line
wrecks both manoeuvres.

### Roadblocks

From three stars, control starts putting cars across roads. Sites are not
picked at random — they come out of the same forward expansion of the road
graph the dispatcher uses to solve intercepts, so a block only ever goes in
somewhere you are actually heading, and driving unpredictably is a real defence
against them.

They go in about 200 m ahead — beyond the point you could see one appear, close
enough that you have little time to re-plan — and are taken away once you are
200 m past.

**The cars are real police units, not scenery.** They are parked across the
carriageway with the handbrake on, they take damage, they can be shunted, and
they stay where they are until one of two things happens: you get through the
block, or you give up and go back the way you came. Either way the block has
done its job, so they come off the handbrake and join the chase. Beating a
roadblock therefore costs you three more cars behind you — which is the price
of going round rather than turning back.

"Turned back" is deliberately not the same as "far away". A target that has not
reached the block yet is far away by definition, and a block that abandoned its
post on that basis would never be there when you arrived. It means a target who
was closing and has stopped: they got near enough to see it, and are now well
beyond that again, for a sustained couple of seconds.

How many cars depends on how much road there is to cover. Two cars on a
fifteen-metre street leave a five-metre gap straight up the middle, which is
not a roadblock, it is a chicane — so the block works out what one angled car
actually spans and puts down enough of them to close the carriageway, staggered
into two rows so that packing them edge to edge does not sit them inside each
other. A line of cones goes in 11 m up the approach, so the block reads before
you are in it.

They are also deliberately occasional: at least 34 s apart, longer after one
has been beaten, and never within 320 m of the last one. Set any shorter and a
block stops being a set piece and becomes weather — you round a corner, there
is a block, you go round it, and there is another one.

Measured at four stars on both maps: never more than two alive, going in at a
median of 157–198 m ahead and coming out at a median of 200–202 m behind. Held
for the full 90 s of a test where the target never came near; released on
`past` when the target drove through at 54 km/h, and on `turned back` after
21.6 s when it went elsewhere.

One bug worth recording, because it produced behaviour that looked like
anything but its cause: the road tangent runs from an edge's `a` end to its
`b` end, so a target arriving *at* the `a` end is travelling against it.
Getting that sign backwards pointed every car the wrong way down the road and
made the block read every approaching car as one that had already gone
through — so blocks dissolved on the frame they were built.

### The rolling block

Distinct from an intercept, which races to a junction and waits. A rolling
block is a car put down on the road *in front of* you, pointing the same way
and already doing 18 m/s, whose whole job is to sit there and be slower than
you are.

How much slower depends on the gap: from a long way ahead it gives away a third
of your speed so the gap closes in seconds rather than half a minute, easing
back to just under your pace once you are on it — enough to hold the block, not
so little that it simply gets rammed off the road. It tracks the centreline of
whatever road it is on and matches your position across the carriageway, which
is what keeps it in front of you rather than politely alongside. Once you are
past it, or it has been left 14 m off to one side, it gives up the role and
rejoins the chase as an ordinary pursuer.

Three things about it took some finding, and all three are the same mistake in
different clothes — a unit that *is* the blocker being quietly treated as
though it were not:

* it was spawned into the roster after the frame's list of available units had
  already been taken, so the validation a few lines below decided it was not a
  real unit and dropped the block on the frame it was created;
* it gave up by returning pursuit controls while still holding the BLOCK role,
  so it came straight back in next frame and reported the block ended all over
  again — which held the dispatcher's cooldown open and stopped any further
  block ever being called;
* and because a car sitting on the road in front of you is one of the closest
  units there is, the pursuit loop drafted it straight back into the pack on
  the next role tick. Blocks lasted 0.2 s.

With those fixed, measured over 120 s at four stars on each map: eight blocks
called per run, **100% of them in front**, no spawn failures, at a median of
123–127 m. Blockers are the best-behaved cars on the road — **0%** of their
time is spent more than 6 m outside a carriageway, against 8–14% for ordinary
pursuers.

Every block ends the way it should: the give-up points recorded were the target
73 m past it, or 14–37 m off to one side. None ended for any other reason. A
block lives a median of 3.4–4.5 s against the test's harness driver, which
picks a fresh random destination every couple of hundred metres and so turns
off far more erratically than anyone actually fleeing; against a quarry
committed to a road the same code held blocks for a median of 12 s with half of
them turning into a sustained engagement. It is a tactic, not a wall — going
round it is meant to work, and costs you the time it takes.

### Getting busted

Drop below 3 km/h with a police car within 3 m of your bodywork and a five
second countdown starts, shown as a bar across the screen. Break contact or get
moving and it drains back at roughly twice the rate it filled, so shoving free
genuinely buys time rather than just pausing the clock.

### Gearbox

Six ratios that change at roughly **55 / 83 / 109 / 137 / 153 km/h**, so no single
gear dominates the run up to speed.

Above half throttle the box selects by *tractive force* rather than by an rpm
threshold: it evaluates every ratio at the current wheel speed, discards any that
would hit the limiter, and takes whichever puts the most torque at the wheel. So
if you crash in sixth and floor it, the car drops straight to the right gear
instead of crawling back down one at a time:

| Stuck in 6th at | Gear after flooring it | Engine |
|---|---|---|
| 8 km/h | 1st | 1 440 rpm |
| 20 km/h | 1st | 3 360 rpm |
| 45 km/h | 1st | 6 420 rpm |
| 80 km/h | 3rd | 5 150 rpm |
| 120 km/h | 4th | 5 860 rpm |

Downshifts are judged against a lower rev ceiling than upshifts. That gap is the
hysteresis which stops the box hunting where two ratios score equally.

## How the police work

The interesting part is `src/ai/dispatcher.js`. It holds the only shared model of
where you are, and hands each unit a job:

* **Perception** — units need range *and* line of sight, and buildings block
  the line. Range is deliberately asymmetric: holding a car you are already
  following is easy (up to ~230 m), picking a specific car back out of a city
  you have lost it in is not (~105 m, and less again if you have slowed right
  down and are keeping your head down). A unit that is *searching* has no
  forward cone at all — it is scanning every direction, not staring out of the
  windscreen — and 20% more range than a plain reacquire. Break contact and the
  dispatcher dead-reckons for a couple of seconds, drives at your last known
  position for five, then searches for the rest of a **30 second** window —
  which is exactly the countdown on the HUD, and exactly how long you must stay
  hidden before the heat starts to fall.
* **Routing starts where the car is.** A route returns a path beginning at a
  graph *node*, which on a long curving A-road can be seventy metres away; a car
  handed that path drives straight at its first waypoint, and therefore straight
  across whatever lies between. Every path is prefixed with the remainder of the
  carriageway the car is actually on.
* **Intercepts** — rather than driving at your current position, the dispatcher
  expands the road graph forward from you to find every junction you could
  plausibly reach in the next ~25 seconds, then asks each free unit whether it
  can get there first. A unit that can is sent there and ignores you completely
  until it arrives. This is why the police appear *in front* of you.
* **PIT manoeuvre** — a real car steered into your rear quarter, only authorised
  between roughly 25 and 155 km/h. Tested in isolation: no spin at 58 km/h,
  reliable spins at 79 and 101 km/h, officer wrecks himself at 122.
* **Rolling box** — three units take lead / flank / trail slots and squeeze.
* **Rolling block** — from two stars, a car put down on the road in front of you
  and driven deliberately slowly. See [The rolling block](#the-rolling-block).
* **Roadblocks** — from three stars, cars parked across a road you are heading
  for. See [Roadblocks](#roadblocks).
* **Escalation** — five heat tiers change how many units respond, what cars they
  bring (patrol → interceptor → unmarked) and which tactics they may attempt.
  Climbing a tier takes roughly **74 seconds** of being watched at a steady
  pace, 44 if you are giving them something to write down and 36 flat out. A
  tier is a real escalation — new car types, new tactics unlocked — and at the
  earlier rate you reached the top in half a minute and never played the middle
  of the range at all.

Police cars are **2.4–2.8× tougher** than yours, so they survive being shunted.
Once a unit is genuinely damaged it drops off the minimap, and it is removed from
the world as soon as it is more than 200 m away — far enough that you never see
one vanish.

Dispatch chatter in the bottom-right names real streets, so you can hear the plan
forming: *"U26 — cut them off at Fifteenth Street / Meridian Avenue, 3s"*.

## Police livery

Marked cars carry a full modern British livery, and like everything else in the
project it is generated at runtime rather than shipped as an image. `livery.js`
paints one 512 × 512 canvas holding four panels and uploads it once:

| Panel | Where it goes |
|---|---|
| Battenburg checks with **POLICE** over them | both flanks |
| **POLICE** reversed | bonnet — so it reads in the mirror of the car in front, which is the whole reason forces do it |
| Red and yellow chevrons | tailgate |
| Unit number | roof |

The bodywork stays vertex-coloured and the decals are textured quads; both live
in one geometry with a material group each, so a police car is two draw calls
rather than a separate mesh per marking. On top of that the cars carry a
low-profile light bar with individual lamp modules, a shark-fin aerial, an
A-pillar spotlight, a push bar and grille strobes.

Decal quads are proportioned to their texture panel. A near-square decal fed by
a 5:1 panel stretches the letters into something unreadable.

## Sound

Everything is synthesised with WebAudio except the engine, which is a recorded
loop with a synthesised layer underneath it.

### The engine

The supplied recording (`resources/sounds/freesound_community-engine-61234.mp3`)
was analysed before being used, and it turned out to be 31.75 s of **steady
idle** — a constant 50 Hz fundamental with no rev sweep anywhere in it. That
rules out the usual approach of slicing a recording into rev bands and
crossfading between them: there are no bands to slice. So it is used the only
way a single steady loop can be, pitch-shifted, with two things done to stop
that sounding like a tape being spooled:

* **Compressed pitch mapping.** Playback rate follows `(rpm / 750) ^ 0.62`
  rather than the literal ratio, so 750–7000 rpm maps to 1.08×–3.96× instead of
  1×–9.3×. A literal mapping is correct and sounds absurd — chipmunk at the top
  end — because pitching a recording up drags its formants and its noise floor
  up with it.
* **A synthesised sub underneath**, which does run at the true firing
  frequency. The loop supplies the texture and the sub supplies the weight, so
  the note keeps its bottom end at high revs even though the sample has been
  pitched well above where it was recorded.

The loop points are chosen inside the steady middle of the file and crossfaded
— material from past the loop end is faded back over its start — so there is no
click at the seam.

Underneath, and on its own if the sample fails to load, is the synthesised
engine. Three plain oscillators through a lowpass sound like a synth drone. A real
exhaust is a train of pressure pulses pushed through a resonant pipe, so the
engine is built the same way:

* a custom `PeriodicWave` whose harmonic series is shaped like an exhaust pulse
  — gentle rolloff with the odd harmonics favoured — rather than a sawtooth,
* a **half-order sub**, the weight a big V8 gets from firing unevenly across its
  two banks,
* **two banks a few cents apart**, beating against each other so the note has a
  lump in it instead of being a dead steady tone,
* a **waveshaper** path crossfaded in with throttle, because an engine under
  load is not merely louder, it is dirtier,
* a **resonant peak tracking the firing frequency**, standing in for the pipe,
* a slow burble on the level at idle that dies away as the revs rise.

Everything is locked to the firing frequency (`rpm / 60 × cylinders / 2`), so
the whole note moves as one. Measured by rendering the graph offline and
analysing the spectrum:

| rpm | throttle | peak | centroid | energy below 160 Hz |
|---|---|---|---|---|
| 850 | idle | 29 Hz | 107 Hz | **79%** |
| 2000 | 0.5 | 269 Hz | 258 Hz | 56% |
| 3500 | 0.8 | 232 Hz | 297 Hz | 45% |
| 5200 | 1.0 | 172 Hz | 434 Hz | 12% |
| 6900 | 1.0 | 232 Hz | 833 Hz | 8% |

Deep and dominated by low frequencies at idle; the centroid climbs steadily with
revs as the filter and the waveshaper open up. Every peak lands on a real
component of the note — the sub, the firing frequency, or its second harmonic.

### Everything else

Intake roar that swells with revs, narrow-band tyre squeal driven by the worst
wheel's slip, wind noise from road speed, one-shot impact thuds, and a wailing
siren that fades up as the nearest marked unit closes. A gentle limiter sits on
the output: engine at full chat, siren alongside and a collision thud all land
together often enough that without one the mix clips exactly when it matters.
Worst case measured at 0.53 peak — no clipping.

## The maps

Two, chosen from the menu at startup. Press **M** in game to come back and
switch. Both are 2 × 2 km, generated from authored layout rules with a fixed
seed, so each is identical every run.

### Ashfield City — grid

A dense downtown grid, a park superblock, thinned suburbs, an industrial strip,
a roundabout, a ring **motorway** open at the verges with six slip roads, and
winding **country** roads with hedgerows and a hamlet outside it. Sightlines run
straight down every street and the block structure is regular, so the dispatcher
can predict your route unusually well.

### Wexbury — organic market town

Built the way an English town accreted rather than the way one is planned:

* a medieval core of short crooked lanes around a market square,
* concentric ring lanes at whatever radius the town happened to stop at, joined
  by only about two thirds of the possible radial links — the missing ones are
  the point, because a full spiderweb is as predictable as a grid,
* long A-roads striking out to other towns, wandering as they go,
* post-war estates of crescents and cul-de-sacs hung off them,
* a dual carriageway **bypass** round one side, joined by **roundabouts** rather
  than slip roads, because that is how a bypass joins a town here,
* B-roads between hedgerows out to a village.

Buildings are placed along road *frontages* rather than inside blocks, which is
what produces terraced streets and makes the lanes feel enclosed: shops crowd
the pavement in the centre, terraces run in unbroken rows along the Victorian
streets, detached houses sit back behind gardens further out, and farms are
scattered along the B-roads. Nothing meets at a right angle unless it happens to.

Shared terrain, surfaces, road meshes and scenery live in `world/common.js`; a
map generator only has to lay out a road graph and decide where buildings go.

Two invariants the generator enforces, because both are the kind of thing that
silently breaks a chase:

* **No building is ever placed on a road.** The block inset handles the grid,
  but country roads and village lanes are laid out afterwards with no knowledge
  of the city, so every candidate building is finally tested against the road
  graph and dropped if it overlaps one.
* **Every tree is solid.** Woodland is scenery you can crash into, not a
  backdrop you drive through.
* **Slip roads have no sharp corners.** The approach is a Bezier that arrives
  already pointing along the merge taper, and a candidate junction is rejected
  outright if the resulting road would turn more than about 72 degrees
  anywhere -- so a node too close to the anchor is passed over for one that
  leaves room.
* **Nothing crosses the motorway.** Slip roads merge at about 23 degrees after
  running alongside the carriageway for 125 m, each junction claims its own
  stretch of ring, and a candidate junction is rejected outright if the ramp's
  approach would cut across the traffic to reach it.

Every road is registered in a graph with widths, speeds and junction types, which
is what the AI routes over. The minimap is heading-up: the map turns under a
fixed marker, with an `N` pointer for orientation.

---

## Performance

Measured on the target machine (Intel Core 3 N355, Intel UHD graphics, 8 GB), at
1280×720 with twelve cars in an active pursuit:

| | |
|---|---|
| Physics + AI | 1.2 ms |
| Render (GPU-synced) | 0.6 ms |
| **Total** | **1.8 ms/frame, against a 16.7 ms budget** |
| Draw calls | 45 |
| Triangles | 79 k |

Note these were taken with the browser pane not compositing, so the GPU figure is
optimistic; expect it to be higher in normal use. There is a wide margin either
way. If the frame rate does drop the game degrades itself: shadows off below
40 fps, then reduced resolution below 28.

## Layout

```
serve.ps1              dev server (also accepts POSTed screenshots to shots/)
index.html             canvas, HUD markup, import map
src/
  main.js              boot, fixed-timestep loop, rendering, spawning
  physics/
    world.js           Rapier wrapper, collision groups, raycasts
    tyre.js            combined-slip Pacejka, load sensitivity
    vehicle.js         suspension, tyre forces, gearbox, damage
  world/
    roadgraph.js       nodes/edges, A*, reachability, path smoothing
    common.js          shared terrain, surfaces, road meshes, trees
    citygen.js         Ashfield City — grid, motorway ring, slip roads
    towngen.js         Wexbury — organic rings, A-roads, bypass, village
    maps.js            map registry
  ai/
    dispatcher.js      perception, role assignment, intercept solver
    officer.js         per-unit state machine
    driver.js          pure-pursuit steering, counter-steer, speed planner
    tactics.js         PIT and rolling box
  game/
    vehicles.js        car specs and procedural bodywork
    livery.js          procedural police livery texture atlas
    heat.js            wanted level, cooldown, arrest
    roadblock.js       roadblock siting, construction, despawn
    audio.js           sampled + synthesised engine, tyres, siren, impacts
    camera.js  hud.js  effects.js
  core/
    menu.js            map selection at startup
```

### Tuning

The handling knobs are ordinary engineering quantities in `src/game/vehicles.js`:

* `gripBias.rear` — extra rear grip. Raise it for stability, lower it to let the
  tail out more easily.
* `suspension.arbRear` vs `arbFront` — roll stiffness split, the strongest
  balance lever. A stiffer rear bar means more oversteer.
* `frontWeight`, `brakes.handbrakeTorque`, `gears`, `finalDrive`.
* `durability` divides incoming collision damage.
* `tractionControl` (0–1) and `tcSlipThreshold` — how hard the engine is backed
  off when the rears spin. Set `tractionControl: 0` for no assistance at all.
* `steering.latLimit` / `overshoot` / `slipAllowance` size the available lock;
  `rate` and `returnRate` are how fast the rack winds on and unwinds. Raising
  `rate` makes the car feel sharper and more prone to scrubbing its fronts.

Tyre character lives in `TYRE_ROAD` in `src/physics/tyre.js`; `loadSensitivity`
and `slidingFriction` are the two that change the feel most. `slidingFriction` is
delicate — set it too high and a locked tyre keeps its cornering force, which
quietly stops the handbrake working.

Police aggression is in `SKILL` (`src/ai/driver.js`) and the per-tier rules table
at the top of `src/ai/dispatcher.js`.

Traffic drives on the **left**; flip `DRIVE_SIDE` in `src/world/roadgraph.js` for
right-hand traffic.

### Not yet implemented

Spike strips, static roadblocks, helicopter support, elevated overpasses (the
motorway is grade-level throughout), and civilian traffic.
