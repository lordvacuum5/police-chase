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

Rendering uses 4x multisampling. The world is flat-shaded faceted geometry, so
almost all of the aliasing is on polygon edges -- exactly what MSAA fixes, and
far cheaper than rendering at a higher pixel ratio, which is why the device
ratio stays capped at 1.

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

### Better brakes than yours

Fleet cars stop considerably shorter than the runner does, and it is built from
three separate things rather than a single fudge factor.

**Anti-lock.** Without it, brake torque past the grip limit simply stops the
wheel, and a locked tyre slides at the sliding-friction fraction of peak — so
the last part of the pedal makes the stop *longer*. It is modelled as a closed
loop on slip ratio, integrating the error to trim brake torque toward the peak
of the curve.

Getting there took two wrong turns worth recording. A bang-bang version that
waits for lock-up and then backs off stops nothing — by the time last step's
slip ratio says the wheel is locked, it *is* locked. A fixed torque cap at the
tyre's peak is no better, because that cap sits *above* the force a locked tyre
still generates, so nothing can spin the wheel back up.

**A bug in the wheel integrator**, which is what was really holding the wheels
down. The semi-implicit wheel update linearises the tyre about its current slip
using `f.stiffness` — but that is the slope at the *origin* of the force curve,
and past the peak the curve is flat. Out at full lock it is completely flat, so
the origin slope invents an enormous damping term that holds a stopped wheel
stopped however little brake torque is left on it. Anti-lock could correctly cut
the torque to a third and still not get a wheel turning. The stiffness estimate
now falls off with slip, so it is the real local slope; low-slip behaviour, which
is what the semi-implicit step was added for, is untouched. Wheel lock-up
through a stop went from 96% to **7%**.

**Braking rubber.** Anti-lock alone only brings the heavier patrol car level
with the runner, because in this tyre model a locked tyre keeps 84% of peak and
locking costs almost nothing. `brakes.gripBonus` scales the longitudinal force
while the pedal is down and the force opposes motion — so it buys stopping
distance and nothing else. A police car corners and accelerates exactly as it
did.

From 100 km/h on dry road:

| | stop | mean | wheels locked | vs runner |
|---|---|---|---|---|
| Runner (you) | 33.3 m | 1.18 g | 95% | — |
| Patrol | 26.8 m | 1.47 g | 7% | **6.5 m shorter** |
| Interceptor | 25.7 m | 1.56 g | 7% | **7.6 m shorter** |
| Unmarked | 24.4 m | 1.61 g | 7% | **8.9 m shorter** |

The AI plans against only four fifths of the advantage. Planning on all of it
means arriving at every junction on the limit with nothing in hand, and the
measured cost was five times as much car-to-car contact — a unit stops in the
distance it promised itself, and the one behind does not.

It is not free. Cars that can brake later carry more speed, and on the town map
the median pursuit pace went from 44 to 54 km/h with scenery contact rising
from 0.29 to 0.39 per car-minute. That is the trade being bought: they commit
harder because they can.

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

### Damage

Hard to collect, ruinous to carry. Contact is the texture of a pursuit -- kerbs,
cones, the pack bumping each other, a scrape along a wall -- and the runner was
taking bodywork damage from all of it. The impact threshold is up from 1.4 to
2.6 m/s of sudden velocity change, the rate is down, and the runner's
`durability` went from 1.25 to 3.2:

| impact | damage before | after |
|---|---|---|
| 3 m/s (a kerb) | 7% | **1%** |
| 10 m/s (a solid hit) | 38% | **10%** |
| 24 m/s (a real crash) | 99% | **28%** |

The trade is that what does get through matters. Engine torque used to bottom
out at a third; it now falls to **a tenth** at full damage, and starts falling
sooner:

| damage | 0% | 25% | 50% | 75% | 100% |
|---|---|---|---|---|---|
| torque | 100% | 100% | 80% | 35% | **10%** |

A clean run is now genuinely clean, and a wrecked car is genuinely wrecked --
rather than every chase ending with a car that is vaguely down on power.

### Pressure scales with the wanted level

One star should be shakeable by driving quickly; five stars should be what it
already was. Two things scale, and both land on exactly the old value at the
top of the range so nothing about a five-star chase changes.

**How far they can see.** The old rule gave a single first-star patrol car
142 m of vision, which is most of a city block in every direction and far more
than one car that has just been told to look out for you should have:

| stars | 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|
| before | 142 m | 164 m | 186 m | 208 m | 230 m |
| after | **102 m** | 134 m | 166 m | 198 m | 230 m |

**How hard they press.** `Officer.pace` caps the speed a unit will ask for as a
fraction of what its car can do, and the rubber-band catch-up boost scales the
same way -- giving a first-star patrol the same help as a five-star pursuit is
what let one car hang on to a flat-out runner it had no business staying with.

| stars | 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|
| pace | 0.74 | 0.81 | 0.87 | 0.94 | 1.00 |
| max boost | 1.25 | 1.38 | 1.50 | 1.63 | **1.75** |

Measured peak speed over one fixed motorway route, so the road is not a
variable: 151 km/h at one star rising to 163 at five, against 124 for the
player's car on the same route.

### Seeing behind them

Perception used to apply a forward cone while in contact, blanking anything
more than about 124 degrees off the nose -- which made a car sitting *directly
behind* a police unit completely invisible to it. Dropping in behind them is
the most natural thing in the world to do in a chase, and it worked far too
well. The cone is gone: a crew has mirrors, a passenger and a radio, and the
thing that actually stops them seeing you is a building, which the line-of-sight
test already handles.

### Roadblocks need to know where you are

They were going in while the force was *searching*. Siting a block needs a
direction of travel to put it ahead of, and a force that has lost you has no
business setting up in front of a car it cannot see. Placement now requires
contact.

The check is deliberately split from the one governing teardown: `allowed` is
just the heat tier, `canPlace` adds contact. Gating both on contact would
dissolve a block already standing the moment you broke line of sight for a
second.

### Air support

At five stars a helicopter comes up. It changes the shape of the chase rather
than adding another car to it: no route to follow, nothing to shake off in a
corner, and -- the point -- it sees over the rooftops. It is a spotter like any
other unit but exempt from the line-of-sight test, so ducking behind a building
stops working while it is overhead. What still works is distance: it has a
190 m radius like everything else, drawn on the minimap as its own ring.

It is deliberately not a physics body. It flies above the world, touches
nothing, and exists to feed the dispatcher a spotter. Flight is steer-and-
accelerate rather than a position lerp -- it has momentum, overshoots, and
swings back, which is most of what makes it read as flying rather than sliding
along a rail. It banks into its turns, noses down with speed, and puts a
searchlight on you once it is actually overhead.

Measured: silent below five stars; launches from about 420 m out and closes to
106 m within seventeen seconds; and with **every police car removed from the
map** it alone keeps the dispatcher in contact. Drop below five stars and it
goes home.

### The detection ring

A red ring on the minimap, always centred on your own marker, showing how far
the force can see you right now. It grows with the wanted level:

| stars | 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|
| radius | 142 m | 164 m | 186 m | 208 m | 230 m |

It is a *range limit, not a guarantee*. Line of sight still has to be clear, so
a unit inside the ring with a building between you cannot see you -- but a unit
outside it cannot see you whatever the geometry. That asymmetry is the whole
value of drawing it: every car outside the ring is one you do not have to think
about.

The ring vanishes the moment they lose contact, because the rule it draws is no
longer the one in force -- searching units use a much shorter reacquire range
and no forward cone. The last-known marker takes over instead.

The radius is published by the dispatcher from the same variable the perception
test uses, rather than recomputed for the HUD, so the circle cannot drift away
from the rule it is claiming to show.

### Tracking, and the three seconds after you break sight

Losing line of sight does not lose you instantly. For **three seconds** the
force keeps a hard fix on exactly where you are — radio, other units, a fair
guess at where that road goes. A bar appears the moment they lose sight and
drains over those three seconds, turning from orange to blue for the last
third; regaining sight clears it and resets the clock.

Ducking behind one building is not an escape. Staying out of sight is. Only
once the bar empties do they fall back to your last known position, and only
after that does it become the sixty-second search.

### Braking only for what is in the way

The obstacle sweep casts three swept boxes: one straight ahead and one
twenty-four degrees either side. All three were feeding the braking distance —
and the angled pair point at the kerb. On a fifteen-metre street they run into
the buildings alongside at about twenty metres with the way ahead completely
clear, so cars were hauling down to 50 km/h for a building they were never
going to touch.

Only the straight-ahead sweep sets the braking distance now. The angled pair
exist to say which side has more room, and that is all they do:

| | before | after |
|---|---|---|
| median pursuit speed | 49.2 km/h | **60.2 km/h** |
| nearest unit, median | 29.6 m | **14.6 m** |
| someone within 60 m | 69.4% | **85.4%** |
| scenery impacts /car-min | 0.12 | 0.12 |

Faster, closer, and no more likely to hit anything — the braking was pure loss.

### Cones

Roadblock cones are dynamic bodies of about 2.5 kg in their own collision
group, `DEBRIS`, which the AI's obstacle sweeps ignore entirely: a cone is
something you drive through, and a police car that brakes for one is worse than
useless. Driving through five of them at 90 km/h scatters them 1.6–3.2 m and
does **no damage at all**.

### Knowing how big the car is

Every lateral check used to be a constant. Length and wheelbase were read from
the spec properly, but width was not: one shared 2.36 m sweep shape for every
car, clearance rays at a fixed 1.1 m, a car-avoidance clearance of 2.2 m, and
-- the one that actually showed -- a pursuit corridor cast at plus and minus
2.2 m, demanding a **4.4 m** opening for a car 1.94 m wide. Gaps between
buildings that a police car would drive straight through were declared blocked,
and the unit went the long way round by road.

All of it now comes from `spec.dims`, through one accessor (`Driver.halfWidth`)
that adds the margin a driver would want before committing to a gap at speed.
The sweep shape is built per width and cached, so a wider vehicle added later
probes as its own size rather than inheriting somebody else's.

Measured on a wall with a hole in it, for the 1.94 m patrol car:

| gap | verdict | drives through | touches the sides |
|---|---|---|---|
| 1.6 m | blocked | no | yes, if forced |
| 2.2 m | blocked | no | yes, if forced |
| 2.6 m | **clear** | **yes** | no |
| 3.2 m | clear | yes | no |
| 4.4 m | clear | yes | no |

The threshold is about 2.6 m -- roughly a third of a metre each side -- and
everything from there up to the old 4.4 m limit is newly available. Below the
car's own width it correctly refuses, and would scrape if made to try.

The roadblock's coverage maths also took its car size from literals, which
mattered more quietly: a wider vehicle would have left a gap up the middle of a
block it believed it had closed.

### Seeing what will actually fit

Every obstacle check used to be a ray, and a ray is a line with no width. A fan
of them threads either side of a tree, or clips past the corner of a building,
and reports open road — which is how a car two metres wide ends up wrapped
round a lamp post that nothing ever saw.

They now sweep the car's own footprint (`sweepBox`, over Rapier's `castShape`):
three swept boxes along the line of travel and a little either side, which give
both the distance to slow for and a side to steer toward. It asks the question
the car actually cares about — will *this* fit through there.

| scenery impacts /car-min | ray fan | swept box |
|---|---|---|
| Ashfield | 0.13 | **0.10** |
| Wexbury | 0.12 | **0.07** |

The swept box on its own measured 0.04 on both maps. The faster fleet engines
above cost a little of that back — more speed means more energy to get rid of —
and the widened probe recovers part of it. Every remaining contact on either map
is the rolling block.

One thing tried and rejected: extending the close-range speed clamp into a
general "be slow enough to turn within whatever you can see" rule. It reads as
obviously correct and made the city *worse* — there is a building about thirty
metres ahead at every junction, so units simply became timid, the nearest one
sat 50 m back instead of 25, and contacts went up as they bunched behind each
other.

### Keeping up

The patrol car — the one you meet most, and the only kind fielded below three
stars — was genuinely slower than the runner: 0–100 in 8.18 s against your 7.50,
and 9 km/h down after ten seconds. Flooring it simply left them behind, which is
not a chase. The fleet engines are up, and every car they field now
out-accelerates you:

| | 0–100 km/h | at 10 s | vs you |
|---|---|---|---|
| Runner (you) | 7.50 s | 123 km/h | — |
| Patrol | 6.98 s | 129 km/h | **+6** |
| Interceptor | 6.45 s | 135 km/h | **+12** |
| Unmarked | 5.97 s | 143 km/h | **+20** |

The verge is less of a cliff for you too. Bare grass at μ 0.62 feels like ice
the moment you clip it; the runner now gets `offRoadGrip` as well, taking it to
about 0.96 — enough to gather the car up rather than be a passenger. Still well
short of the fleet's 1.80, so they keep the advantage off the tarmac.

### Going straight at you

A unit in pursuit drives at you as the crow flies, at any range. Distance is not
a reason to take the roads and neither is the surface — grass, verges, playing
fields and car parks are all just ground, and a car crosses them at whatever
speed they will take. The only thing that sends a pursuer back to the road
network is something solid actually in the way.

The obstruction test is a **corridor, not a ray**. A single centre line
threading the gap between two buildings reads as clear for something with no
width; the car is two metres across and closing at whatever you are doing, and
it takes the corner of the building. Three lines a car's width apart is the
difference.

Measured over 120 s at four stars, against the same code with the old
"direct only within 85 m" rule:

| | by road beyond 85 m | crow flies |
|---|---|---|
| nearest unit, median | 64.7 m | **31.4 m** |
| someone within 60 m | 44.8% | **81.9%** |
| scenery impacts /car-min | 0.10 | 0.13 |
| median pursuit speed | 55.3 km/h | 58.6 km/h |

Half the distance, for two extra scenery contacts in two minutes across a
dozen cars. On Wexbury the nearest unit sits at a median of 21 m with someone
inside 60 m for 84% of the chase.

Note what is *not* in that change: intercepts, responses to a shout, searches
and patrols still use the roads. An intercept's whole purpose is to get
somewhere you are not yet, and a unit crossing town to a position you were last
reported at is genuinely quicker on the network than in a straight line through
a housing estate.

### Cutting corners

Everything except a patrol car may leave the carriageway: cut a corner, put two
wheels on the verge, or take a line straight across open ground. A patrol car on
its beat keeps to the road, and that difference in how they move is part of how
you tell one from the other before the lights come on.

Allowing it is four changes, not one, because several separate things were
quietly holding units on the tarmac:

* **Lane keeping** is the term that stops a car cutting a corner, so a driver
  allowed off-road keeps only a quarter of it — enough not to wander.
* **Running out of road stops being a wall.** For these units it is a change of
  surface: the speed check brakes toward a pace the verge can hold rather than
  toward a stop.
* **The direct-pursuit test no longer requires the line to be road.** Driving
  at the target across whatever lies between *is* the corner cutting.
* **"Get back on the road" became a rescue, not a rule** — it now fires only
  for a unit that has genuinely bogged down, not one that is deliberately
  taking a line.

They also get tyres for it. `offRoadGrip` applies only on the loose, so a
police car is no better on tarmac — it is simply less helpless the moment it
leaves it. Grass mu goes 0.62 to about 0.96. Before, a unit that cut a corner
crawled at 6–10 km/h on the other side, which is not a shortcut; it now carries
about 42 km/h off-road.

### Not driving into buildings

Every clearance check before this answered "how hard must I brake", and braking
is not always the answer — a car that has run wide is going to touch the wall on
its outside whatever it does with the pedal, because the wall is not in front of
it. Units now cast a fan either side of the line of travel and steer toward
whichever side has more room.

Three details, each of which was a real bug found by measuring:

* **A wall dead ahead produced a bias of exactly zero.** Summing a push per ray
  gives the centre ray no side to push toward, so a building directly in front
  produced no avoidance at all and the car drove into it at 60 km/h. Measuring
  both flanks and steering to the roomier one fixes it.
* **The wide rays must not feed the braking clamp.** On any ordinary street
  there is a building about seven metres to either side; braking for those
  would reduce the whole force to a crawl everywhere. They steer, they do not
  slow. Only what is roughly in the way slows the car.
* **The rolling block was aiming into buildings.** It picked its aim point by
  extrapolating a straight line down the road's current tangent — fine on a
  straight, and on any bend it lands outside the curve, which is inside a
  building. Every scenery impact left in the pursuit was a blocker doing this,
  at 58–64 km/h with something solid at just about its own lead distance. It
  now follows the carriageway polyline.

The last-resort clamp inside `driveTo` is deliberately pessimistic where the
planners above are not: it fires only when the plan has already gone wrong,
which usually means the car is also turning and spending its friction on that,
so it assumes three quarters of the grip and keeps six metres in hand.

Scenery impacts per car-minute, measured over 150 s at four stars, counted as
step changes in speed with no other car nearby:

| | before | after |
|---|---|---|
| Ashfield | 0.44 | **0.07** |
| Wexbury | 0.49 | **0.03** |

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
  position for five, then searches for the rest of a **60 second** window —
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

### Tyre scrub

The squeal layer only starts once a wheel is properly sliding -- past 0.45 of
saturation -- which is a drift or a locked brake, not a corner. A tyre
complains long before that, as soon as it is asked to carry a slip angle, so
scrub has its own voice: lower and broader than the squeal, a growl rather than
a shriek, driven by the worst lateral slip angle any grounded wheel is holding
and scaled by speed. The two layer rather than compete.

Measured through a steering sweep at a steady 60 km/h:

| steering | worst slip | scrub | slide |
|---|---|---|---|
| 0.15 | 0.8 deg | silent | silent |
| 0.35 | 2.4 deg | just audible | silent |
| 0.60 | 5.7 deg | rising | starting |
| 1.00 | 15.1 deg | full | full |

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
    helicopter.js      air support at five stars
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
