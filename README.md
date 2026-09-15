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
| `P` | Pause · `H` Controls · `N` Sound on or off · `M` Back to the menu · `F3` Debug telemetry |

A gamepad works too: left stick steers, triggers are throttle and brake, `A`
handbrake, `X` clutch kick.

Sound only starts after your first key press — browsers refuse to play audio
until the page has been interacted with.

### On a phone or tablet

The touch controls appear on their own on a phone, or on any screen the moment
it is touched, and a key press on a machine with a mouse puts the desktop layout
back. Add `?touch` to the address to see them on a desktop.

| Touch | Action |
|---|---|
| Left half of the screen | Steer: put a thumb down anywhere and slide it left or right. Wherever it lands is the middle, so there is no stick to find without looking |
| `GAS` / `BRAKE` | Throttle and brake — slide between them without lifting, as you would rock a foot |
| `HANDBRAKE` | Handbrake, usable while holding either pedal |
| `II` `CAM` `FLIP` `SND` | Pause · camera · flip upright · sound on or off |
| `FULL` | Full screen, and landscape where the phone allows it to be locked |
| `MENU` | Back to the menu — tap twice, so a stray thumb does not end the run |

Sideways is the way to hold it. Upright works, with the view widened so there is
still road either side of the car, and a note suggesting you turn the phone.
The HUD shrinks to fit round the thumbs, and after being busted a `RUN AGAIN`
button stands in for `R`.

It is all in `src/core/touch.js`, and it does not drive anything itself: it
publishes throttle, brake, handbrake and steering for `Input.sample` to merge
with the keyboard, and its buttons press the same virtual keys the keyboard
does, so `_handleKeys` is still the one place that decides what a key does.
Two phone rules needed handling. A finger going *down* does not count as
interacting with the page — only lifting it does — so audio is also woken on
`pointerup`. And an iPhone will only let a page speak once it has spoken from
inside a tap, so the first tap speaks a silent empty line to unlock the radio.

**Playing it on a phone** needs the game served somewhere the phone can reach:
`serve.ps1` only listens on `localhost`. It is plain static files with relative
paths, so GitHub Pages serves it as it is.

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
  (μ 0.62). The footway also stands 140 mm above the carriageway, so clipping a
  kerb costs grip *and* unsettles the car — see **Kerbs**.

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

**Faster than any car — actually.** Its top speed was 62 m/s, 223 km/h, which
was faster than any car until the Stiletto turned up at 303. `tests/outrun.js`
flies it on its own over a car driven along a fixed course, starting on station
overhead, so nothing else in the chase helps or hinders it:

| car on a long straight at | 62 m/s: light on the car | 78 m/s: light on the car |
|---|---|---|
| 200 km/h | 100% | 100% |
| 230 km/h | 72%, then lost for good | **100%** |
| 257 km/h (the Stiletto flat out) | 19%, then lost for good | **100%** |
| 280 km/h | — | **100%** |
| 300 km/h | 13%, 2.4 km behind at the end | 32% |

Once the light slipped off a car going faster than the aircraft, it never came
back: the light hunts around where the car was last seen, and the car was
already well past that. On a course of city blocks — flat out down a 400 m
straight, braking for a right angle at 70 km/h — it held the car the whole two
minutes at either speed, because every corner lets it cut across. It is now
78 m/s, about 280 km/h, which is roughly what a light twin does flat out and is
clear of the fastest car in the game.

**Losing it means losing it.** Once the force has lost you, the aircraft flies
where its own searchlight is hunting — round the last place anybody saw you,
widening the circle the longer it has been — rather than on over your car
wherever you went, which gave the game away: *"the spotlight looks around, but
the helicopter still stays with me."* It follows the car only while somebody
actually has it: the light on it, a ground unit with eyes on, or the three
seconds of tracking after sight is lost. Measured with `tests/outrun.js`, it
still holds a car at every speed any car can reach; a car that did get away was
6.6 km from it two minutes later, where before it was followed the whole way.

**The searchlight lights the ground.** The pool used to be only a bright disc
laid just above the road, and footways stand a kerb higher than that, so
wherever the beam fell on a pavement the pavement covered it: *"the police
helicopter is not lighting up the pavements."* It is now a real spot light as
well, from the aircraft to wherever the beam is
pointing, sized to the beam, so kerbs, pavements, walls and cars inside it are
all lit by it, at night and in the rain most obviously. It exists from the
start at zero brightness rather than being added when the aircraft arrives:
adding a light to the scene makes every material rebuild its shaders, a visible
hitch in the middle of a chase.

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

### Junctions

Every road is drawn as a ribbon of its own full width, which is fine for the
tarmac — tarmac on tarmac is invisible — but not for anything drawn on top of
it. Kerb lines used to run straight out across the middle of a crossroads and
lane dashes carried on through it.

`src/world/junctions.js` works out, for every approach to every node, how far
back its markings have to stop in order to clear the other roads. For two roads
crossing at angle θ the corner where their kerb lines meet sits
`otherHalfWidth / sin θ` along each of them, so that is the setback; it is
floored so a shallow crossing does not run away, and capped at a third of a
short road. Kerbs and centre lines are sliced to it, each signalised approach
gets a stop line, and the re-entrant corner where the two ribbons meet is
filled out to a kerb radius so the carriageways run into each other on a curve.

Three separate things made roads look like they did not join up, and all three
are fixed: `addRibbon` mitred without scaling the join, so the ribbon pinched
in at every bend and left a wedge of bare ground on the outside; ribbons end
square at their node, so a bend leaves a notch even with a correct mitre (a
small apron disc at each node covers it, since both ends pass through the
node); and corners that fell on a node stayed sharp, which `smoothBends` now
replaces with an arc, moving the node to the middle of it so it is still a real
point on the road.

### Crossings the graph did not know about

A junction only exists if two edges share a **node**. Two roads can cross on
screen and share nothing at all, and then the police cannot turn between them:
the route search is never offered the turn, so a unit drives over a crossroads
it cannot see and carries straight on. On the city that was 18 crossings,
including country roads over the ring motorway — which is why a unit would sail
past a way onto the motorway it could plainly have taken.

`RoadGraph.stitchCrossings` finds them. Every segment goes into a 60 m bucket
grid; each pair from neighbouring buckets that intersects in both interiors and
shares no node is a junction the graph is missing. If one of the four end nodes
is already within 7 m, the roads meet there in all but name and it is left
alone; otherwise a node is created at the crossing and both edges are rebuilt
as a chain through it, so the turn then exists for routing, for `planJunctions`
and for the signal heads alike.

It runs **twice**, before and after `smoothBends`/`smoothEdges`, because moving
geometry to round off a bend creates crossings that were not there when the
first pass looked.

| on the city | |
|---|---|
| crossings with no junction | 18 → 2 (after smoothing) → **0** |
| motorway nodes joined to an ordinary road | 12 → **17** |
| random cross-map routes that use the motorway | **18 of 39** |

Wexbury reports one, and it is a false positive: two roads that meet 5 m apart
through a short link edge, which routing uses like any other.

### Kerbs

The footway stands **140 mm** above the carriageway, and you can feel it. It
used to be a colour stripe — pavements were drawn *below* the road, and the
world's only collision geometry is one flat plate, so there was nothing to
drive over.

It is done with a **height field**, not geometry. `sim.heightAt(x, z)` says how
high the surface is; the suspension ray lifts its contact by that and tilts the
normal by the local gradient. Colliders for every footway in two towns would
have been thousands of static boxes, and would have dragged the AI's obstacle
sweeps and the wheel rays into caring about them. This costs four lookups a
wheel — and because the answer arrives *through the suspension*, the car gets
the bump, the weight transfer and the tyre's reply to all of it for free.

| mounting it at | suspension (87 mm at rest) | body lift |
|---|---|---|
| 4 m/s | — | — |
| 10 m/s | 90 mm | — |
| 18 m/s | 178 mm | — |
| 26 m/s | 185 mm, near the bump stop | 34 mm |

No speed lost and no damage from the kerb itself: it unsettles you, it does not
stop you. Driving along the road is unaffected — 3 mm of body movement down the
middle, and 3 mm hard in the gutter.

The surface grid went from 4 m cells to 1 m, because it now carries height as
well as grip and a kerb two metres from where it is drawn is very much
something you can feel. Measured: the ground rises at 7.10 m against a drawn
half width of 7.50. That is *cheaper* than before, not dearer — disc painting
used to step by the cell size, so metre cells laid down sixteen times the discs
for a scallop of six centimetres. Stepping by a quarter of the disc radius took
the map build to 2.5 s, against 3.0 s before any of this.

**Raising it breaks the road, and it is worth understanding why.** A footway
band runs *alongside* its own road, so it also runs straight across every road
that crosses it. Harmless while the footway is the lower of the two and the
carriageway draws over the overlap — invert that and every band paints over the
junction it passes through, turning a town of crossing roads into a patchwork
of grey slabs. **14.5% of the town's carriageway ended up under pavement.**

Trimming the bands back at the junction mouths is the obvious fix and it is not
enough: it only helps where two roads actually meet, and does nothing for a
bend, for two estate roads that run close by without ever crossing, or for a
roundabout sitting across the corner of a city block. Twice I looked at
screenshots and called it fixed. What settled it was measuring —
`tests/surfaces.js` fires 4,000 rays straight down onto the carriageway and
asks which surface is nearest the sky.

The first fix clipped everything raised against the surface grid, which had the
carriageways burned into it and so knew where footway was. It measured well —
carriageway drawn over went from 14.5% to 0.00% in Wexbury — and it looked
terrible. A pavement cut to fit a metre grid has a metre-grid edge: every
junction mouth and every bend in the town grew a **staircase of grey teeth**,
block plates in the city got stepped edges along every road through them, and
from a distance the whole town shimmered with them.

**So the pavement is no longer cut at all.** Pavement shapes are back to the
smooth ones from before the kerbs were raised — a full-width ribbon along each
town road, a plain plate across each city block — only now at kerb height. What
changed is the *drawing order* (`DRAW_ORDER` in `world/common.js`): grass, then
pavement, then tarmac, and the tarmac ignores the pavement's depth, which is
what a road painted onto the ground is anyway. Where road and pavement overlap,
the road shows; everywhere else, the pavement. The kerbs — the face and the
stone on top, which are what actually tell you the footway is raised — are
drawn after that with an ordinary depth test. The catch is a sliver: at a very
low angle a raised pavement edge should hide a few centimetres of road just
behind it, and the road draws over that edge instead. From a chase camera it
cannot be seen.

That moved the problem onto the kerbs, which were never right either:

* **Kerb lines across other roads.** A kerb ran the length of its road, trimmed
  back only at the junctions at its two ends — so wherever another road crossed
  it mid-length, merged into it or passed close by, the kerb carried straight on
  across that road's tarmac. Kerbs are now walked a metre at a time and dropped
  wherever the kerb itself, or the ground just behind it, lies on another
  road's carriageway, tested against the roads' actual shapes rather than the
  metre grid. The kerb round each junction corner gets the same test: where
  more than two roads meet, a corner can land on a third road's tarmac, and a
  kerb there was a U of stone standing in the middle of the junction.
* **Kerbs crossing in an X at bends.** A kerb drawn road-piece by road-piece
  ends at every node, so at a bend the two inside kerbs ran past each other and
  the two outside ones stopped short. Kerbs are now drawn along whole runs of
  road joined through plain bends, so the offset line mitres round the corner
  like any other ribbon. Two traps on the way: splitting the run into metre
  pieces put points so close to the bend that the kerb, drawn five metres out,
  folded back over itself — only the road's own vertices and the cut points go
  into the line now — and a road that doubled back on itself joined into a
  hairpin, which mitred into a kerb shot straight across the carriageway, so
  runs only continue through genuine bends. The kerb *face* was also offset
  without a mitre and cut every corner short of the stone on top of it; it
  mitres now too.
* **Corners.** The gaps between square road ends at a node were filled with a
  disc the size of the widest road there, which at a junction of an avenue and
  two narrower streets stood out past the streets' kerbs as a polygon of tarmac.
  They are filled with the exact wedge between the ends now, reaching out to the
  mitred corner on the outside of a bend. Corner kerbs are raised like the rest,
  where they used to be flat stripes.

| what you would see on the carriageway (`tests/surfaces.js`) | grid clipping | now |
|---|---|---|
| Wexbury | 0.00% covered, but a staircase everywhere | **0.00%**, smooth |
| the city | 0.13% | **0.00%** |

`tests/surfaces.js` now works out what would actually be *drawn* at each point,
taking the drawing order into account, rather than what is nearest the sky —
which means a kerb carried across somebody else's road now counts against it.
`tests/roadshots.js` photographs fixed places on each map by coordinates, so the
same views can be taken of any version of the game and compared; that is how
every one of the problems above was found. The height field is untouched by any
of this, so the kerb feels exactly as it did.

**This is the mechanism terrain would use.** Give `heightAt` a hill and cars
drive over it, pitching and rolling on the gradient, with nothing else
changing. The one number that has to keep up is `GROUND_RELIEF` in
`physics/vehicle.js` — how far the ground may stand above the flat plate, and
therefore how far the suspension ray has to reach. It is 1.0 m for kerbs and
would be the terrain's relief for hills. The visible ground plane would have to
follow the field as well, which it does not yet.

### Traffic signals

Junctions with three or more street-grade approaches get signals. Two phases,
split by bearing — on a crossroads that is exactly the two carriageways — and a
UK sequence: green 13 s, amber 3 s, all-red 1.7 s, then red-and-amber 1.6 s on
the other phase. Junctions are staggered by position, so they do not all change
together. Not where an approach is shorter than 24 m: the A361 crossroads into
Wexbury sits seven metres from a roundabout, and its stop lines landed at odd
angles in the middle of the junction. Nobody signals a junction that close to a
roundabout anyway, so that one and any like it are left unsignalled.

The head goes on the nearside kerb at the stop line, facing back up the
approach. With `DRIVE_SIDE = +1` the nearside for arriving traffic works out as
the `+perp` side, which is the same side the stop line is drawn on.

Both the head and the stop line follow the road's own polyline out from the
node rather than projecting along the tangent there. That distinction is not
academic now that bends are smoothed: an approach curves away from its
junction, and on Wexbury the tangent put **102 of 131 heads in the
carriageway**. There is a clearance check behind it that walks a head onto the
footway if it still lands on tarmac, and drops the approach rather than
planting a pole in the road.

Signal posts are knockable, like everything else on the kerb. A flattened
signal goes dark and stops being a signal — the lamps hide and `stopDistance`
returns `Infinity`, so a patrol treats that arm as unsignalised rather than
obeying a light lying in the gutter.

**Only patrolling units obey them.** A unit running to a shout, searching, or
already in a pursuit has blue lights on and goes through — the same rule that
governs whether it will leave the carriageway. A patrol brakes at 3.4 m/s², so
it eases to a halt rather than standing on the pedal.

| | |
|---|---|
| stopped, on red | **0.8 m before the line** |
| furthest past the line | **0.0 m** |
| moved on in the 8 s after green | **93.3 m** |

Cost is close to nothing: the poles and housings merge into one static mesh,
and each head's three lamps sit at a fixed slot in three instanced meshes, with
the unlit ones scaled to nothing rather than packed out of the list. A signal
changing writes three matrices. 702 heads on the city map come to about
0.16 ms a frame and three draw calls.

### Street furniture

Lamp posts, bollards, bins and signs along the kerbs — 1608 of them on the city
map, 402 in the town. Standing, they are instanced meshes with a thin static
collider and cost nothing per frame. Hit one and it becomes a real dynamic body
that topples and slides, and the car takes the momentum it actually lost.

| | speed | damage |
|---|---|---|
| signal post (150 kg) | 20.5 → 17.8 m/s | +1.3% |
| lamp post (62 kg) | 23.7 → 22.5 m/s | +1.1% |
| bin (26 kg) | 24.7 → 23.8 m/s | +0.3% |
| bollard (24 kg) | 21.1 → 20.6 m/s | +0.2% |
| sign (18 kg) | 22.7 → 22.3 m/s | +1.3% |

*(Measured at 24 m/s, before bollards were made heavier — see below.)*

A shove and a scratch, not a wall. They live in `GROUP.STREET`, which no ray or
sweep in the game looks at — the police AI must not brake for a bollard and a
suspension ray must not climb a lamp post — so all the interaction happens in
`src/game/streetprops.js`, where it can be tuned. Toppled props stop being
simulated once they settle, and only the last 26 stay live at once.

The geometry is modelled with its base at the origin while the collider is
centred on the body, so a fallen prop's mesh sits half a height *below* its
body — along the body's own up axis, not the world's. Getting that wrong is
worth knowing about: subtracting on world Y is correct only while the prop is
upright, and once a lamp post is lying flat it buries it under the road by its
own length. Which way it fell decided how badly, which made it look like a
problem with one side of the street.

**Not a wall at 200.** *"I can do 200 miles an hour and they'll just stop me
dead."* They could. Knocking a prop over is decided once a frame, for anything
within 0.9 m of the car's nose — but physics runs up to five substeps in a
frame, and a fast car on a slow frame travels further than that before it is
checked again. It reached the post's static collider first, and a static
collider is an immovable wall. `tests/bollard.js` stands one bollard out past
the map edge and drives into it: at 60 frames a second everything was fine,
but at 30 — an ordinary phone — 230 km/h went to **21 km/h in one substep, and
the car was wrecked**. The check now sweeps the car's footprint along its
velocity for everything it will cover before the next check, so the prop goes
over before contact at any frame rate.

Asked for at the same time: *"they need to do damage and knock me back a bit."*
A bollard is now 95 kg rather than 24 (a real one is cast iron set in concrete)
with a little more bite, the knocked prop is sent off slightly faster than the
car so it is not hit a second time, and the speed loss no longer also gets
counted as a crash by the impact detector — the jolt and the thud are given
directly instead. Stiletto, straight on:

| | before, 60 fps | before, 30 fps | now, any frame rate |
|---|---|---|---|
| 100 km/h | −1 km/h, 0.5% | −1 km/h, 0.5% | −4 km/h, 2.3% |
| 190 km/h | −6 km/h, 1.0% | −8 km/h, 1.0% | −13 km/h, 4.4% |
| 230 km/h | −10 km/h, 1.2% | **−209 km/h, 100%** | −18 km/h, 5.3% |

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

### Following you, not the straight line

*"If they are close behind me and in pursuit then just make them follow me."*
The straight line is right on an open road and wrong everywhere else: you take
a corner past a house, and the line from the car behind you to your car goes
through the corner of the house. So the game keeps a breadcrumb trail of where
you have actually driven — a point every 2.5 m, the last 400 m or so — and a
pursuing unit that finds itself on it (within 9 m) drives it: through the same
gap, round the same corner, at a speed the path planner works out from the
trail's own bends. It stays on your line until it is close enough to ram, and
leaves it only for the straight-line pursuit above when it has fallen off it.

Everyone following the same line puts the whole pursuit in single file, and
every car in the file closed on the one in front as if it were you: twenty
police-on-police shunts a minute. So a unit with another police car between it
and you keeps a following distance, seven metres plus about half a second.
Only the car at the front closes, and a unit alongside you running a PIT does
not count as being in the way.

### Ramming

*"The police also seem reluctant to ram me — make them ram me more, and increase
the closing speed at which they ram me and aggression as the wanted level
increases."*

Set up on its own (`tests/ram.js`: one interceptor forty metres behind a car
doing 70 km/h, nothing else on the map), a pursuer arrived, hit once, and then
sat on the bumper for the rest of the run at exactly your speed with its foot
flat down. That is a push, not a ram — nothing registers as an impact, and from
the driver's seat it is barely there. Now contact, or half a second of leaning
on you, sends the unit back for a run-up, and when it has one it comes again.

How hard a ram lands is mostly how much road the unit had to build up speed
on: starting four metres back it reaches your bumper at five or six metres a
second whatever it asks for. So the run-up is what scales with the wanted
level — a shove from 7.5 m at one star, a proper hit from 17 m at five — along
with the speed it asks for on the way in, from 20 km/h faster than you to
58 km/h. None of it is extra power; the charge is the car's own acceleration.
Nor does a unit back off a car that has stopped: that is an arrest, and it
stays against you.

Three runs of 30 s at each level:

| | before: hits per 30 s | now: hits per 30 s | closing speed at impact | knock on your car |
|---|---|---|---|---|
| one star | 1.0 | **5.3** | 7.1 m/s (26 km/h) | 4.1 m/s |
| three stars | 1.0 | **3.7** | 9.3 m/s (33 km/h) | 5.9 m/s |
| five stars | 0.7 | **4.0** | 9.9 m/s (36 km/h) | 6.2 m/s |

No scenery contacts by the pursuer in any of them. At one and two stars a unit
still sits slightly off to one side once close, lined up for a PIT; from three
it puts its nose straight at your boot. Either way it aims through the car
rather than at it — up to 2.6 m past your middle at five stars — because a
driver aiming at a car arrives alongside it, and one aiming beyond it carries
on into it.

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

### Give way to the manoeuvre

A PIT or a box only works if the car running it can get to where it needs to
be, and in a pursuit of seven cars the main thing in its way is the pursuit.
Nothing used to say so: every unit treated every other unit as scenery to nudge
around, so a car authorised to strike had to thread the pack at whatever speed
the pack was doing.

A unit running a manoeuvre now carries right of way. Anyone who is not moves
off its line and eases back to let it through — short range, and only for a car
coming through from behind, because a unit two hundred metres back is not being
held up by anybody.

Mostly this is done with the throttle rather than the wheel, and that was
measured rather than assumed. A firm sideways push does let the manoeuvre car
past, at the cost of putting the rest of the pursuit on the verge: on the town
map the units well off the carriageway went from 5% of the chase to 15%. On a
street with a house either side there is nowhere to move *to*, and easing off
works there as well as it does on a dual carriageway.

### Closing a box

A box is called on units up to 55 m out and then has to form up, and for a long
time it could not: every unit was told to hold the target's speed plus 0.8 m/s,
which closes forty metres in fifty seconds — by which time the box has been
dropped for falling apart. So a crawling target simply collected two police
cars that sat beside it doing nothing. Three things were wrong, and the third
is the interesting one:

* **The speed.** A boxing unit now gets closing speed proportional to how far
  short of its slot it is, on a braking profile — fast from thirty metres, a
  walk over the last two, so it arrives rather than overshoots.
* **The aim.** Beyond 18 m from its slot it stops being a manoeuvre and goes
  back to being a chase, using the ordinary pursuit logic. That logic checks
  whether the line to the target is actually open and takes to the roads when
  it is not; driving straight at a point beside a car forty metres away was
  sending boxing units across gardens.
* **The direction.** Closing speed from the *distance* to the slot drives a car
  that has overshot faster and faster away from it, because going forward makes
  the distance bigger and the distance is all it is reading — a formed box came
  apart in three seconds with every unit flat out in the wrong direction. What
  speed can fix is the error *along the road*, measured in the target's frame,
  which is also heading-independent: a car knocked sideways in the scrum still
  knows which way its slot lies. Sideways error is the steering's job.

The pack also takes two cars off intercept duty when a box is genuinely on —
two units already in touch and the target down to walking pace. Without that
the third car was always away claiming a junction, and the box was never called
at all: there is nothing to get in front of at walking pace anyway.

Measured, 90 s at four stars: boxes called 0 → 3–4 a chase, and on a crawling
target the player is pinned and arrested. Three cars standing in their slots to
the centimetre stays rare, and that is fine — the box is for stopping you, not
for the formation.

### Why a PIT used to bounce off

The setup phase closes the gap and the strike phase turns in. Both were too
polite, in different ways.

The setup was allowed a flat 2 m/s of overspeed with a taper that had not begun
yet, so a car authorised from thirty metres back spent most of its twelve
second window barely gaining and timed out before it reached the strike window.
It now closes at a rate proportional to the gap, the way an ordinary pursuit
always has.

The strike was worse, and the cause is worth recording. It aims *through* the
target's far rear corner — a point three or four metres away and forty degrees
off the nose — and the driver's pure-pursuit grip limit reads that as a
four-metre-radius corner. So a 29 m/s strike was clamped to about 9 and the car
braked: measured, the unit arriving on the rear quarter exactly on the money,
then shedding half its speed and dropping sixteen metres back, every single
time. The strike is the one piece of driving that is *meant* to end in a
collision, so it now ignores the cornering limit for the second or so it lasts.
The last-resort clamp on anything solid straight ahead still applies — and the
ray it uses cannot see cars anyway.

| holding 22 m/s on a long straight | before | after |
|---|---|---|
| PITs authorised | 5 | 5 |
| reached the strike | 3 | 3 |
| speed held through the strike | 24 → 12 m/s | **24 m/s** |

Reaching the strike was never the problem. Carrying it through was.

### Roadblocks

From three stars, control starts putting cars across roads. Sites are not
picked at random — they come out of the same forward expansion of the road
graph the dispatcher uses to solve intercepts, so a block only ever goes in
somewhere you are actually heading, and driving unpredictably is a real defence
against them.

They go in 170–260 m ahead, close enough that you have little time to re-plan,
and are taken away once you are 200 m past. Distance alone did not keep them
out of sight — on a straight road 160 m is plainly visible, and four cars and a
line of cones appearing there was the most obvious spawn in the game — so a
site is only used if the camera cannot see the middle of the block or either
end of it (see [Nobody appears in view](#nobody-appears-in-view)). The soonest
hidden site wins; if every site is in view, there is no block this time.

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

**Stingers.** Every roadblock now lays a stinger right across the road, kerb to
kerb, 19 m up the approach — further out than the cones, so a car that sees the
block late and threads a gap between the cars still goes over it. A wheel that
crosses it is punctured and goes down over about two seconds to a third of its
grip (`FLAT` in `vehicle.js`): still drivable, but slow to accelerate and
hopeless at speed in a corner. The tyre lights on the dashboard flash red, the
radio says so, and the garage fits new ones. Going round the block on the
pavement is the one way past it clean.

Each wheel's *path* over the frame is tested, not just where it is: at 200 km/h
on a slow frame a wheel travels two metres, and a strip 90 cm deep is easily
stepped over between two checks. Driven out past the map edge straight at a
stinger: all four tyres at 252 km/h at both 60 and 20 frames a second, and
at 144 km/h two when driven down its very end and none a metre clear. A jump in
wheel position larger than the car could have driven — flipping it upright,
a restart — is ignored, after that exact case punctured all four tyres of a car
teleported past a strip.

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

**The police stay put while they arrest you.** *"When the police cars are
busting me, they should just stay still if they're near me, because otherwise
they just keep moving, and then it stops the busting."* They did: a unit that
had you pinned went on doing whatever its role said — backing out of the
contact, going round for another shove — which opened the gap and cancelled the
arrest it had started. Now any unit within 3 m of a stopped suspect, or within
5 m once the clock is running, sits on its brakes until you move off
(`Officer._holdingArrest`). Three cars driven in against a stopped car: all
three at a standstill within a second, and the arrest after exactly 5.0 s.

### Getting away

Getting arrested is an ending. Getting away is not, and it used to be: escaping
dropped the same full-screen curtain with *press R to run again* on it, so the
reward for a good escape was having the game taken away from you.

Now the heat clears, a banner says so for a few seconds and fades, and you are
still sitting in a car in the middle of a town. The force stands down: every
tactic is cancelled, every unit goes back on its beat at the posted limit, and
the shared model of where you are is thrown out — so a patrol that drives past
you a minute later has to notice you again from scratch, exactly as it would
have before any of it started. Drive badly in front of one and it will.

The roster comes back down with it. A five-star response is nine cars and an
ambient patrol is three, and nothing used to reduce that except the rule that
retires a unit 900 m away, so the town stayed full of police long after they
had stopped looking for you. Surplus units are now retired furthest-first, one
every couple of seconds, and only once a car is 260 m away or 110 m away and
out of sight — the force thins out over the next half minute rather than
blinking out in front of you.

Measured: five units at three stars, heat clear 68 s after they lose contact,
every remaining unit on patrol, and the roster back to the ambient count within
50 s — with the car still under your control throughout.

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
  carriageway the car is actually on — and inside a junction, the car may also
  turn there. See [Missing the turn](#missing-the-turn).
* **Intercepts** — rather than driving at your current position, the dispatcher
  follows the road graph forward from you to the junctions you are *likely* to
  reach in the next ~25 seconds — at your speed, and learning your habits —
  then asks each free unit whether it can get there first. A unit that can is
  sent there and ignores you completely until it arrives. This is why the police
  appear *in front* of you. See [Guessing where you are going](#guessing-where-you-are-going).
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
* **Contact counts once.** Hitting a police car starts a chase (heat 1) or adds
  0.28 to one already running, and nudges the dispatcher's PIT cooldown. An
  impact stays "recent" for 60 ms, and `Game._checkProvocation` used to count
  it on every frame inside that window: three or four times at 60 fps, and
  hundreds of times in headless tests, where `performance.now()` barely moves.
  One touch took heat from 1 to 5 and read out every escalation at once. It now
  remembers the last impact it handled, as the impact sound already did.

Police cars are **2.4–2.8× tougher** than yours, so they survive being shunted.
Once a unit is genuinely damaged it drops off the minimap, and it is removed from
the world as soon as it is more than 200 m away — far enough that you never see
one vanish.

Radio traffic names real streets, so you can hear the plan forming: *"U6,
cutting them off at Fifteenth Street and Meridian Avenue."*

### Evening it up

*"The Land Rover is a bit too fast. I think same with the really fast car ...
it's already relatively easy to lose the police just by going in between two
houses. Police cars still struggle to keep up, even on one to five. Just
increase their speed and grip a bit."* The levers are at the top of
`vehicles.js`, applied to whole groups of cars:

| | 0–100 before → after | top speed before → after |
|---|---|---|
| Stiletto (power ×0.85, shorter final drive) | 4.4 → **5.1 s** | 257 → **240 km/h** |
| Badger (power ×0.86) | 8.6 → **10.0 s** | 204 → **190 km/h** |
| Patrol | 7.0 → **6.4 s** | 215 → **230 km/h** |
| Interceptor | 6.5 → **5.9 s** | 222 → **241 km/h** |
| Unmarked | 6.0 → **5.5 s** | 222 → **247 km/h** |
| Police SUV | 8.2 → **7.5 s** | 218 → **230 km/h** |

The fleet has 12% more power, 8% more grip, and a taller sixth gear so the
extra power becomes top speed as well — before, every police car ran into its
limiter at 222 km/h however much help it had. Two more things turned out to
matter as much as the cars:

* **The drivers now plan on their own tyres.** A unit's corner speeds came from
  the road surface and its skill, and never from the car's own grip — so a car
  given more grip took every corner at exactly the same speed as before and
  simply had more in hand. `Driver._mu` now includes `gripScale`.
* **Less holding back at low wanted levels.** A unit's pace ran from 74% of
  what its car could do at one star to 100% at five; the floor is now 84%.

Measured with `tests/harness.js` — a driven quarry that brakes for corners, at
four stars with the police allowed contact — over the same three chases, old
settings against new, switched at runtime in the same page:

| | old | new |
|---|---|---|
| nearest unit, median | 60 m | **34 m** |
| time with a unit within 40 m | 39% | **56%** |
| police well off the road | 8% | **6%** |

Better in all three, including one where the quarry was driving faster than in
any other run. The kinematic tail test (`tests/tail.js`, a car moved at a
constant 100 km/h that never slows for a corner) was too noisy to call either
way — a car that takes right angles at 100 km/h is not one the police should be
able to follow round them anyway.

### Missing the turn

"Have the police got slower and worse at routing?" They had. `tests/response.js`
puts one patrol car on a quiet map and sends it to a junction 400–650 m away,
twelve fixed trips chosen by map position so every version of the game drives
the same ones, and times it. Run against older commits, the city trips took:

| version | arrived | total time |
|---|---|---|
| before raised kerbs | 12 of 12 | 592 s |
| raised kerbs | 12 of 12 | 649 s |
| crossings stitched into the motorway, and every commit since | 11 of 12 | 648 s |

Nothing after that changed the driving at all — the numbers were identical to
the tenth of a second through every later commit. Tracing the slow trips showed
the same thing each time. A unit re-plans its route every second or so, and a
new route starts at the junction *ahead* of the car — correct everywhere except
inside a junction, where the nearest road is as often the one straight on as the
one the car came in on. So a car slowing into its turn got a fresh route that
began a block further on, and went straight across. One trip missed four turns
in a row that way and never arrived. The kerbs made it common — a car corners
slower over them and spends longer in the junction — and stitching the crossings
added junctions for it to happen at.

`RoadGraph._turnHere` now asks, when the car is inside a junction, for a route
that turns off there too, and takes it if it is at least two seconds quicker. It
only offers turns the car can make: one it is already swinging into, or any turn
short of a U-turn below 47 km/h.

| | arrived | total time | average speed | stuck |
|---|---|---|---|---|
| city, the twelve trips, before | 11 of 12 | 648 s | — | 16 s |
| city, the twelve trips, after | **12 of 12** | **579 s** | — | 26 s |
| city, twenty other trips, before | 20 of 20 | 1004 s | 59 km/h | 50 s |
| city, twenty other trips, after | 20 of 20 | **851 s** | **70 km/h** | **17 s** |
| Wexbury, sixteen trips, before | 14 of 16 | 759 s | 66 km/h | 38 s |
| Wexbury, sixteen trips, after | **15 of 16** | **713 s** | 67 km/h | 67 s |

On the twenty city trips not one got slower; the worst were 80 s → 37 s and
89 s → 55 s. They also leave the carriageway less (5.8% of the time → 1.1%): the
wide sweeps across the pavement were mostly missed turns being recovered.
Wexbury's stuck time is one trip wedged on the same spot in both versions.

Two other fixes were tried and measured worse, and are not in: refusing to plan
a U-turn at the junction ahead (going round the block is a longer route with
more turns to miss — 12 of 12 trips became 9), and stopping the path follower
jumping onto the return leg of a route that doubles back (a real bug, but every
version of the fix cost more elsewhere than it saved — 10 of 12).

What this does not change is pursuit with the car in sight, which is not routed
at all — a unit with a clear line drives straight at you across whatever ground
is there. `tests/tail.js` moves the player's car along a fixed route at a fixed
speed that nothing can slow down and measures how closely the police stay with
it; on both routes measured it came out identical before and after this change.
Across older versions it moves about with the route — on one, the first unit
reached the car ten seconds later once spawns had to be out of sight, on the
other there was no difference — and two runs are not enough to say more than
that.

### Nobody appears in view

Every police car the game creates — joining the roster, put in front of you as a
rolling block, parked across a road as a roadblock — is placed only where the
camera cannot see it. `Game.inView` asks three things of a spot: is it inside
the camera's view (with a margin that grows with distance, since half a car
coming into shot is still a car appearing), is it within 700 m (beyond that it
is lost in the fog), and is there a clear line from the camera to it (a building
in the way hides it). A spot that passes all three is rejected and the next
candidate tried.

Before this, rolling blocks and roadblocks relied on distance alone and popped
into existence 140–160 m up the road. `tests/popin.js` drives a two-minute
four-star chase through the city and checks every police car at the moment it is
created: before, 7 of 20 were created in plain view; after, 0 of 16. Rolling
blocks still get placed — a failed attempt now looks again after 3 s rather
than waiting out the 14 s cooldown, since the next corner usually hides one.

### Guessing where you are going

*"Make the interceptors better at predicting where I am going to go."* The
intercept solver used to ask `RoadGraph.reachable` where the car *could* be in
the next 24 seconds, which has two blind spots for this job. Every junction was
as likely as every other, so units were spread over side streets the car was
never going to take. And every road was assumed to be driven at its limit, so
at 160 km/h the car was through a junction before the unit sent to it arrived.

`RoadGraph.predict` follows the car's likely choices instead:

* **Probability.** Each junction splits the chance between the ways on:
  straight on far more often than not, onto a road at least as big as the
  current one in preference to a smaller one, a dead end or doubling back only
  rarely. Junctions are then ranked by how likely the car is to come through
  them, times whether the timing is worth driving for.
* **The car's own speed**, where that is faster than the road's — less what a
  turn would cost it: braking to a speed the corner allows and getting back up
  again, which at motorway speed is several seconds and a large part of why a
  fast driver goes straight on.
* **Learning.** The dispatcher watches the heading going into and coming out of
  every junction it sees you take, and keeps a running share of how often you
  go straight on (`straightShare`, weighted to the last five or so). Throw the
  car down every side road and the intercepts spread across the side roads;
  stay on the main road and they wait on it.

Each unit then takes the junction with the best mix of likelihood and a
comfortable arrival margin, rather than simply the best margin.

`tests/intercept.js` measures it: the car is moved along a fixed route — the
same in every version — braking for corners the way a driver would, with four
stars held and contact forced, on three routes at 90 and at 160 km/h, two
minutes each:

| | old solver | new, 8% cut-off | **new, 3% cut-off** |
|---|---|---|---|
| junctions where a unit was already waiting | 7.8% | 12.1% | **12.7%** |
| intercept orders the car did then drive through | 8.9% | 34% | **19%** |
| seconds of *correct* intercept, all runs | 68 | 68 | **117** |

The 8% cut-off was right most often but sent so few cars that no more
intercepts came off; 3% is still twice as accurate as the old solver and makes
most of them count. Runs vary a lot — one collision changes the rest of a chase
— so these are totals across all six rather than any single run.

The catch-up assistance was checked and left alone on request. For the record,
because it is easy to misremember: yellow on the minimap is a unit on
intercept, which is routing and nothing else; the physics help (more power,
more grip, a stability aid, no damage on the way in) applies only to a unit
*more* than 30 m away and is gone by the time it is close enough to touch you.

## The cars you can run in

Picked on the menu, above the maps, and remembered between visits. Pressing
**M** in game goes back to change it.

**The Runner** is the car the whole game was tuned around: a quick rear-drive
saloon that is tough enough to lean on the police with. **The Stiletto** is
the other way to run — a mid-engined V12 supercar, and the trade is meant to be
real: much faster, much stickier, and the car you had better not let them touch.

`tests/supercar.js` measures both on flat tarmac out past the edge of the map,
with the surface forced to road, so neither is measured against a bend, a tree
or a verge — only against the other car. These are the figures on the menu:

| | Runner | Stiletto |
|---|---|---|
| 0–100 km/h | 7.37 s | **5.05 s** |
| 0–160 km/h | 15.3 s | **8.23 s** |
| 0–200 km/h | 28.0 s | **12.2 s** |
| top speed | 215 km/h, on the limiter in 6th | **240 km/h**, on the limiter in 7th |
| peak steady grip, 60 km/h | 1.28 g | **1.57 g** |
| peak steady grip, 120 km/h | 1.40 g | **1.77 g** |
| peak steady grip, 170 km/h | cannot hold the speed | **1.91 g** |
| braking from 100 km/h | 31.8 m | **26.1 m** |
| damage from one 50 km/h shunt | 8.5% | **20%** |
| shunts until the engine starts to fade | 4 | **2** |
| shunts to a wreck | 11 | **5** |

The shunt used to start sixty metres short of the parked car and coast in, so
engine braking decided how hard it hit — detuning the Stiletto's engine moved
its figure from five hits to four without the car being any less tough. It now
starts ten metres short and arrives at the speed it says.

**Not too fast to catch.** As first built the Stiletto did 0–200 in 9.7 s and
303 km/h. Every police car tops out at 222 km/h, rubber band or not — the
rubber band adds torque and cuts drag, but it cannot take a car past its own
limiter — and the helicopter at 223. So at five stars you could simply drive
away from everything on the first long straight: *"even on wanted level five,
I can easily escape the police, even the helicopter."* The torque curve is down
18% and the final drive shortened to match, so it still reaches seventh and
still pulls hardest at the top (`tests/outrun.js`):

| | 0–100 | 0–200 | top speed |
|---|---|---|---|
| Runner | 7.4 s | 28.0 s | 215 km/h |
| Stiletto, as built | 3.7 s | 9.8 s | 304 km/h |
| **Stiletto, now** | **4.4 s** | **12.2 s** | **257 km/h** |
| Unmarked, rubber band at full stretch | 5.2 s | 11.1 s | 222 km/h |
| Interceptor, rubber band at full stretch | 5.5 s | 12.1 s | 222 km/h |

Still far quicker than the Runner and still faster than the fleet flat out, but
a pursuit car closing on the rubber band can live with it, and the helicopter
can now outfly it (see Air support).

Grip rises with speed on the Stiletto and not on the Runner: that is 0.95 m²
of downforce against 0.42. And every police car still out-brakes both, because
they keep the anti-lock system neither player car has.

**How it gets there.** A V12 that revs to 8 800 on seven close ratios and a
twin-clutch box that changes in 0.06 s; 58% of the weight over the rear wheels
and less yaw inertia than a saloon, which is what makes it turn in; wider
tyres, more grip at both ends, and short, stiff suspension. The fragility is
one number — `durability` 1.4 against 3.2 — which also means the torque falloff
past 28% damage arrives after two hits instead of four.

**Launch control, and why it was needed.** The first build only did 0–100 in
4.3 s, and the rear tyres were never the limit — slip ratio never passed 0.06.
The engine model locks rpm to the driven wheels whenever the clutch is in, so
from a standstill it sat at 1 000 rpm making idle torque for the first second
of every start, at 0.6 g, on tyres with twice that to give. An optional
`engine.launchRpm` now lets the clutch slip and hold the engine up in first on
a big throttle, the way a twin-clutch launch does. Only the Stiletto has it:
the Runner's 0–100 is unchanged.

**It hates kerbs, and does not get hurt by them.** With 160 mm of travel, a
kerb at 26 m/s takes the suspension to the bump stop and throws the body up
71 mm (the Runner: 185 mm of its 200, and 34 mm). Still no damage and no speed
lost from the kerb itself — a bump stop is a vertical spike, and the collision
damage rule only reads a large velocity change, so it was worth measuring.

**Staying on its line.** `tests/handling.js` reads balance from yaw rate times
speed, which is the right number while a car is on its line and the wrong one
once the tail starts to come round — it reports the rotation as grip, and on
this car it produced lateral figures of over 2 g. `tests/stability.js` asks the
plainer question instead: hold a speed and a steering input, and see how far
the body ends up from the direction of travel. At half lock and 90 km/h, with
throttle holding the speed, the Runner spins and the Stiletto holds 1.3° of
body slip at 1.34 g.

### The Badger

The third way to run: a square-rigged old 4x4. Slow on the road, heavy in the
corners, and the toughest thing you can drive — four-wheel drive, long springs
that do not notice kerbs, and tyres that grip on grass nearly as well as on
tarmac (grass comes up from 0.62 to about 1.1, against the Stiletto's 0.74), so
the shortcut across the park that bogs everyone else down is yours.

| | Runner | Stiletto | **Badger** |
|---|---|---|---|
| 0–100 km/h | 7.4 s | 5.1 s | **10.0 s** |
| top speed | 215 km/h | 240 km/h | **190 km/h** |
| peak steady grip, 120 km/h | 1.40 g | 1.77 g | **1.08 g** |
| shunts to a wreck | 11 | 5 | **19** |

The body is lofted the same way as the police SUV and van (`bodies.js`): flat
panels, an upright screen, a raised waist behind the bonnet, a cream roof, wide
black arch flares over big tyres, a bull bar, round lamps, a roof rack with a
pair of spotlights, a snorkel and the spare wheel on the back door. First built
it did 9.5 s to 100 and took 23 shunts to wreck — more than twice the Runner —
so it got 10% more engine and slightly less armour. It sits high, so like the
SUV it takes cornering force in above the road, and it does not lift a wheel
at full lock at any speed.

### Grip at speed

Both cars slid too much at speed, and the cause was not what it looked like.
More downforce — two and a half times as much — barely changed anything. The
road tyre only reaches its peak cornering force at **8.6° of slip**, so a car
cornering hard at 140 km/h sits nine or ten degrees sideways even while it is
gripping perfectly well, and that reads as a slide.

So both player cars carry a `highSpeedTyre` in their spec: from 72 km/h, fully
by 150, the lateral curve stiffens (the limit arrives at a smaller slip angle,
so the car points where it is going) and grip rises a little. Below 72 km/h
nothing changes, so a handbrake turn is still yours. It had to be weighted to
the rear — on the Stiletto, with 58% of its weight at the back, stiffening or
adding grip evenly made the nose bite harder than the tail could follow, and it
spun at 140 km/h in every even configuration tried.

Full lock held for two seconds, throttle holding the speed — body slip, mean and
worst:

| | before | after |
|---|---|---|
| Runner, 140 km/h | 11.2° / 17.4° | **1.6° / 3.3°** |
| Runner, 180 km/h | 10.5° / 15.5° | **1.0° / 2.2°** |
| Stiletto, 140 km/h | 7.4° / 12.6° | **1.7° / 6.0°** |
| Stiletto, 180 km/h | 9.1° / 17.1° | **1.1° / 3.6°** |

Peak steady cornering grip (`tests/gripsweep.js`): the Runner is unchanged at
60 km/h (1.28 g) and goes from 1.29 g to 1.40 g at 120 and 1.50 g at 170; the
Stiletto is unchanged at 60 km/h (1.51 g) and goes from 1.58 g to 1.89 g at 120
and 1.62 g to 2.02 g at 170. The police cars do not have it.

### Keeping the Stiletto on its wheels

That extra grip put the Stiletto on its roof. The Stiletto figures above were
partly measured on a car already rolling: `tests/rollover.js` holds full lock
from a straight line, slaloms, and slides the car sideways into a 14 cm kerb,
and with that tuning the Stiletto went over on full lock at every speed from
100 km/h up, and in a 160 km/h slalom. The Runner never did.

The cause was where cornering force went into the car. Each tyre's sideways
force was applied at the contact patch, on the road, half a metre below the
centre of mass. On a real car the suspension links carry that force into the
body at the *roll centre*, well above the road, and only the height from there
to the centre of mass tries to roll it. Applied at the road, the Stiletto's
tipping point worked out at about 1.7 g, and at speed its tyres could do 2. Its
inside wheels were already lifting on full lock at 60 km/h, before the
high-speed grip existed; the grip only pushed it the rest of the way.

So a car's suspension now has a `rollCentre`, the height at which cornering
force enters the body. It is 0 — the road, unchanged — for every car except the
Stiletto, which has 18 cm. Longitudinal force still goes in at the road, where
dive under braking and squat under power come from.

| Stiletto | before | after |
|---|---|---|
| full lock, 100–220 km/h | **rolled over** every time | 1.7–2.2° of roll, all four wheels down |
| slalom, 80–200 km/h | rolled at 160; a wheel in the air for up to 3 s | 1.6–2.3°, all four wheels down |
| sideways into a kerb at 90 km/h | 5.0–5.4°, a wheel up for 0.15 s | 4.7–5.1°, 0.1 s |
| full lock at 130 km/h (`tests/stability.js`) | ended on its roof at 47 km/h | 1.80 g, 0.4° of slip, held |
| steady grip at 60 / 120 / 170 km/h | 1.51 / 1.89 / 2.02 g | 1.57 / 1.77 / 1.91 g |

The old 2.02 g at 170 km/h was being reached on two wheels. Full lock held at
speed (`tests/highspeed.js`) now gives 1.62–1.66 g at under 1° of slip, where
before it gave 0.7–1.0 g because the car was on its way over.

### The bodywork

The saloons are mostly flat panels, which tapered boxes suit. This car is all
curves along its length — a nose that rises into the wings, a roof that falls
away into the engine cover, haunches that swell over the rear wheels — and
stacking boxes to fake that gives a car made of steps. So it is lofted:
`MeshBuilder.addLoft` skins a series of cross-sections, mirrored about the
centreline, with a colour per edge and per run so one loft carries screen,
roof, buttresses and engine cover.

Two things were wrong in the first version and are worth recording:

* **Arches cut as notches.** Two sections a millimetre apart make a vertical
  step, which is a fine way to open an arch and a bad one to shape it: a square
  cut-out the length of the opening read as a black box round every wheel. The
  underside now follows a circle about the hub, 60 mm clear of the tyre.
* **One dark core the length of the car**, to stop you seeing through the
  arches, stood up through the bonnet near the nose where the bodywork is
  lower. One per arch, no taller than the underside over the wheel.

Winding comes from construction rather than from guessing which way is out: a
heuristic about the loft's axis gets the steeply raked faces of a nose wrong,
and a wrongly wound face on a single-sided material is simply a hole.

The body is placed on the axles, not centred on the centre of mass — with 58%
of the weight at the back, a body centred on it would have had a stubby nose
and a tail a metre and a half long — so the collider takes a matching
`colliderZ`. Wheels are instanced from one tyre and scaled per car, with wider
rears on this one. The engine note fires six times a revolution rather than
four, and the recording underneath it is pitched to match.

## Police livery

Marked cars carry a full modern British livery, and like everything else in the
project it is generated at runtime rather than shipped as an image. `livery.js`
paints one 1024 × 1024 canvas holding five panels and uploads it once:

| Panel | Where it goes |
|---|---|
| Battenburg the length of the car, with **POLICE** on a plate in the middle | both flanks, nose to tail |
| **POLICE** reversed | bonnet — so it reads in the mirror of the car in front, which is the whole reason forces do it |
| Red and yellow chevrons | tailgate |
| Unit number | roof |
| Battenburg with **POLICE** over it, door-sized | the armoured van, above the windscreen |

*"What I really want is some good-looking police cars."* The battenburg used to
cover one door, the light bar was a slim strip, and the push bar hid the
headlamps. Now the checks run the whole flank, the light bar is full-width with
seven lens modules and clear end caps, and every flashing lamp has a soft halo
round it (additive points in `LightBars`, one draw per colour however many
cars), which is what makes a lit lamp read as a light rather than a coloured
brick on the roof. The kit — bar, battenburg, chevrons, roof number, push bar
and strobes — is one function, `addPoliceKit` in `bodies.js`, laid out from a
handful of measurements of whichever body it is going on, so every police
vehicle wears it the same way and the flashers follow its bar.

The bodywork stays vertex-coloured and the decals are textured quads; both live
in one geometry with a material group each, so a police vehicle is two draw
calls rather than a separate mesh per marking.

### The fleet

| | from | 0–100 | top speed | grip | hits to wreck | |
|---|---|---|---|---|---|---|
| Patrol | 0 stars | 6.4 s | 230 km/h | — | — | the saloon everything starts with |
| **SUV** | 2 stars | 7.5 s | 230 km/h | 1.25 g | 17 | tall, heavy, four-wheel drive, best on grass |
| Interceptor | 3 stars | 5.9 s | 241 km/h | — | — | more engine than the patrol car |
| Unmarked | 4 stars | 5.5 s | 247 km/h | — | — | the quickest thing they have |
| **Armoured van** | 5 stars | 10.5 s | 167 km/h | 0.96 g | 67 | one at a time, and there to be in the way |

The SUV and the van are new bodies (`bodies.js`), built like the Stiletto from
lofted cross-sections with round wheel arches rather than stacked boxes, with
heights worked out above the ground: a tall vehicle on long springs sits a very
different distance above its centre of mass than a saloon does. The SUV is a
square-shouldered modern 4x4 with the band along its doors above the arches;
the van is a high-roofed panel van with mesh over the windscreen, barred
windows, a second light bar facing backwards and a blue stripe along the box.
Both take cornering force in above the road (`rollCentre`), and neither lifts a
wheel at full lock or in a slalom at any speed in `tests/rollover.js`. SUVs make
up about a quarter of the cars at two stars and more above, and stand in
roadblocks from three; the van is one car in seven at five stars, never two.

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

### The police radio

Every line that reaches the HUD also goes out over the net. `Game.radio` is the
single choke point for every call site, so the audio hangs off that and the two
can never drift apart.

**The voice actually speaks.** It used to be synthesised: a buzz through two
formant filters, stepped to a different vowel once a syllable, meant to read as
speech without ever saying anything. It did not read as speech — the verdict
was *"it just makes a really weird noise, it's not even speech"* — and that is
fair: nonsense syllables are uncanny in exactly the way a real voice is not.
So the line is now read out by the browser's own speech engine, rewritten
first into something a person would say (`speakable`): "U3" becomes "Unit 3",
"PIT" is a word rather than three letters, a slash between two roads is "and",
and dashes are pauses.

Voices are chosen from whatever the machine has (`pickVoices`): English only,
British first, local voices ahead of ordinary network ones — a network voice
can lag behind the HUD or not arrive at all offline. Control is a female voice
where there is one, units a male one, air support a third; on this machine that
is Hazel, George and Susan. With no English voice at all, a call is just the
key going down and coming up again.

**Picking a different voice.** Windows has one British man, George, and he is
the quiet one (see "The engine sits under the radio"): even after the mix was
ducked hard under him, *"I still can't hear them very well."* No game can make a
speech voice louder than full volume, so the menu now has a **Radio voices**
row under the maps: Control, Units and Air support each get a list of every
English voice the browser has, with a play button, and choosing one reads out a
sample line at the rate and pitch that speaker uses in a chase. The choice is
remembered, and a voice that has since gone from the machine falls back to the
automatic pick. Which voices are on the list is down to the browser: Chrome and
Vivaldi on Windows show the Windows voices, and more can be added under
*Settings › Time & language › Speech*; Edge also has Microsoft's natural
voices — Ryan and Thomas among the men — which are both louder and far clearer.
Those are now picked automatically when they are there, ahead of the local
voices, since the reason for preferring local voices was a line arriving late
and a natural voice starts quickly enough.

The speech engine plays outside Web Audio, so it cannot go through the radio
channel's filters. What makes it sound like a radio is everything around it:
the PTT click before, a faint open-carrier hiss underneath (and the rotor for
India 99), and the squelch crash after. The channel is held for as long as the
engine is actually speaking — nobody can know in advance how long a line takes
to say — with a timeout in case an engine never reports the end.

Three things had to be measured rather than guessed:

* **Speed.** At its default rate a Windows voice took 6.8 s over *"Control,
  reports of a vehicle driving dangerously, all units respond"* — about half
  the pace of real radio traffic — and every call behind it went stale
  waiting. Rate does not scale linearly on those voices either: 1.3 only took
  that line to 6.1 s, 2.1 to 4.9 s. So the rates are 1.8 to 2.1 — but only for
  the Windows desktop voices. Every other engine takes the rate at its word,
  and on a phone 2.0 really was double speed: *"the voices say the stuff way
  too fast"*. A phone's own voices report themselves as local, which is what
  used to earn the full rate, so `rateFor` now asks what the engine is — a
  local `Microsoft` voice that is not a natural one — and gives everything else
  the gentle version, about 1.25 to 1.35.
* **Staleness.** A call that has waited more than ten seconds is about
  something that has already happened — "PIT authorised" after the PIT — and is
  dropped rather than read out late.
* **Traffic.** The intercept solver re-picks junctions every second, and every
  unit announced every change: once calls took real time to say, *"U2 — cut
  them off at the roundabout, 4s"* was sixty lines a minute and more than half
  of everything on the net. A unit now says it is going to cut them off when it
  takes the job, and again only twenty seconds later.

A priority call from Control opens with a short attention beep, at most once
every 24 s. One transmission at a time: two units never talk over each other on
a real net, and it is the queueing that makes it sound like a net rather than a
soundboard. Muting cancels the speech directly, since it does not go through the
master volume, and so does leaving the page — speech otherwise carries on
through a reload, into the menu.

### What the police say

The dispatcher only ever spoke when it made a decision, so for most of a chase
the net was silent and nothing on it told you what they could see.
`game/commentary.js` watches the chase and reports it, the way a real pursuit
does — it never decides anything:

| When | Who | Says, for example |
|---|---|---|
| a unit takes the lead | the unit | *"Unit 2, primary, behind a red sports car, southbound."* |
| a second unit is on you | the unit | *"Unit 1, backing up Unit 2."* |
| every 22–30 s while they can see you | primary | *"Unit 1, coming up to Eighth Street and Ashcroft Road, 80."* — or *motorway, northbound*, *they're slowing*, *losing ground* |
| through a red light, mid-chase | whoever saw it | *"…through a red at Sixth Street and Bright Lane."* |
| through a red light **in front of a patrol car**, no chase | the patrol car | *"U1, an orange saloon just ran the red at Market Place and The Shambles. Going after it."* — and that starts the chase |
| off the road | primary | *"…they've left the road."* |
| you hit something, or ram a unit | primary, or the unit | *"…they've hit something, still mobile."* / *"…they've rammed us!"* |
| a police car is wrecked | the unit | *"…we're out, car's disabled."* |
| the wanted level rises | Control | pursuit authorised → tactical contact → authorised to box → critical incident |
| they lose sight | last primary, then Control | *"…lost visual, last seen eastbound on Sixth Street."* / *"all units, last seen on Carrick Road. Search the area."* |
| still searching | Control | *"any units, anything on that vehicle?"* |
| they find you again | the spotter | *"…eyes on! northbound on Faraday Road."* |
| air support has you in the light | India 99 | *"we have them, northbound. I'll commentate"*, then its own running commentary |
| you are pinned | nearest unit | *"they're stopped! Moving in."* → *"blocked in, going to the driver."* — or *"they've pushed free!"* |
| arrested | the unit, then Control | *"one detained"* → *"received. All units, stand down."* |

**Running a red light starts a chase** if a police car saw it. `Game._checkRedLight`
counts a red as run when the car is within nine metres of a signalised junction,
still above 30 km/h, with its own approach on red; the witness is the nearest
working police car within 120 m that has a line of sight — not the dispatcher's
shared knowledge, which at zero heat only reaches about 70 m, far less than a
patrol car sitting at a junction can see across. `tests/redlight.js` pins a
light on red and drives through it three ways: watched with no chase (heat 0 →
1, the witness line, then Control), unwatched (nothing), and mid-chase (the
primary reports it).

**Nothing says the same thing twice.** Every line on the net — commentary,
dispatcher, roadblocks, air support — comes from a set of wordings
(`game/phrases.js`), and a set will not reuse a wording until most of the
others have had a turn. On top of that `Game.radio` drops any sentence that went
out word for word in the last 45 seconds of game time. A search used to say
"still no further sighting, keep looking" three times in a row; the scripted
two-minute chase in `tests/commentary.js` now has no exact repeats at all.
Patrol cars coming on duty say so — *"U2, show me on duty"* — rather than that
they are responding to a chase that does not exist; only once there is a chase
does a new car say it is on its way.

Primary has hysteresis, so two cars trading places a length apart do not hand
it back and forth. And once you are arrested nothing else gets on the net:
before, units kept announcing intercepts after Control had stood everybody down.

**Less of it, and never late.** The net used to be talking almost all the time,
and a call could reach the speaker ten or fifteen seconds after the thing it
described — "PIT authorised" read out after the car had already spun. Nothing
could be dropped once queued, and every line took five seconds to say. Now:

* **Lines are short.** Radio traffic is clipped: *"U2, PIT authorised."*, not
  *"U2, tactical contact authorised, go when ready."* Nearly every wording was
  cut, most by half. Timed on this machine's voices, a line costs about 1.6 s
  of clicks and chirps plus one second per 16–19 characters, so length is
  airtime.
* **Routine lines only go out into a gap.** Commentary, units en route, units
  going for an intercept need two seconds of silence on the net, and at least
  12 s since the last routine line from anyone. With no gap they are not queued
  — they wait, unsaid and unspent, for the next one. The primary's running
  commentary is every 22–30 s rather than 11–15; secondary, off-road, crashes,
  air support and the search all have longer cooldowns; box calls, PIT calls
  and rolling blocks are each limited to one every 20–40 s whoever makes them.
* **A call that waits too long is dropped.** 4.5 s for a priority call, 3 s for
  anything else — about one line's worth. A newer call of the same kind replaces
  a waiting one, and the most important waiting call goes first (the arrest,
  then priority calls, then the rest).
* **Urgent calls cut routine ones off.** A priority call arriving while
  commentary is being read out stops it mid-sentence (key-up crash and all) and
  goes straight out.
* **The helicopter no longer flaps.** It launches at five stars but only goes
  home below four: heat hovering at five had it launch, stand down and launch
  again inside twenty seconds, with a call each time.

`tests/commentary.js` measures this on what would actually be *heard*: it runs
the game's real radio queue on a simulated clock, holding each line on the air
for as long as the voice takes to say it. `__runCommentary('scripted')` packs
every phase of a chase into two minutes; `__runCommentary('natural', 180)`
leaves the police to find and chase the car on their own. The same test on the
previous commit and on this one:

| | lines aired | channel busy | wait for the channel (median / worst) |
|---|---|---|---|
| scripted 130 s, before | 27 (12.8 a minute) | 97% | 7.9 s / 19.2 s |
| scripted 130 s, after | 26 (11.8 a minute) | 77% | 0.0 s / 5.9 s |
| natural 180 s, before | 33 (11.0 a minute) | 85% | 4.4 s / 14.2 s |
| natural 180 s, after | 25 (8.3 a minute) | 52% | 0.0 s / 3.6 s |

The scripted run's worst case is the closing "all units, stand down" after an
arrest, which is allowed to wait; nothing else in it waited more than 3.8 s.
The scripted run barely airs fewer lines because it is built to be saturated —
four escalations in seventy seconds — and shorter lines mean more of them fit;
what changes is that they go out when they are true. Before, the game tried to
say 73 lines in it and 118 in the natural run, and the queue read out whatever
it could hold however late it was; now it tries 33 in each and drops the ones
that miss their moment.

`tests/radio.js` measures what can be measured: the channel (white noise in,
0.1% below 300 Hz, 88% between 300 Hz and 3 kHz), the key-up crash against the
opening click (3.1×), what every line becomes when read aloud, the voice choice
on this machine and on lists it does not have, and — live, through the real
speech engine — three priority calls made at once (the first two spoken one at
a time, the third dropped for waiting too long), a routine line cut off by an
urgent one, and silence on mute.

### The signalling

A real digital net wraps every call in machine noise, and it is a lot of the
character. Around each transmission:

* **Control** opens with a short data burst — frequency-shift keying between
  1200 and 1800 Hz a few milliseconds a bit, with runs of the same bit rather
  than a steady alternation, which is what makes it a "brrrp" rather than a
  beep — and sends another as it lets go. Priority calls get the attention beep
  first, now as often as every nine seconds rather than twenty-four.
* **A unit** gets three quick talk-permit chirps before it can speak, a couple
  of pops of static while it does, and a rising roger beep as it lets go.
* **Between calls** the channel is not silent: every 14 to 32 seconds, if it is
  clear, somebody keys up and says nothing, a terminal sends a status burst, or
  a stray roger beep comes through.

All of it goes through the radio channel. Measured against the key-up crash,
which stays the loudest moment of a call: data burst 0.52×, talk-permit chirps
0.42×, roger beep 0.48×, attention beep 0.83×, crackle 0.30×.

### No recorded chatter

For a while two recordings of real police radio traffic played in the gaps
between calls, and stood in for the voice on a machine with no speech engine.
They were taken out on request, files and all. The net between calls is back to
what the game makes itself — somebody keying up and thinking better of it, a
status burst, a distant roger beep (`_pumpNetNoise`) — and with no English
voice a call is now just the key going down and up with nothing readable in
between.

### The siren

It has to be recognisable as a siren, and the first one was not. A square wave
swept slowly over a narrow interval, muffled by a fixed lowpass well below its
own harmonics, played quietly behind an engine: the report from the other side
of the screen was *"a weird sound, almost music, I don't know what it is"* —
which is exactly what it was.

What makes the real thing identifiable is a bright, harmonically rich tone
through a resonant horn sweeping a wide interval, and a *pattern* that carries
meaning. So: sawtooth for the harmonics, a second voice a fifth above and three
cents out so the pair beats the way two real horns do, and a bandpass riding an
octave above the fundamental — which stops the sweep sounding like a filter
opening and starts it sounding like a horn. Then **wail** while they are working
their way towards you, 640–1540 Hz over three seconds; **yelp** inside 55 m,
the same interval in a third of a second. The switch is information: the pattern
changing is how you know the car behind has closed without taking your eyes off
the road.

`tests/siren.js` records what the oscillators are *asked* for, rather than
reading the nodes back — `setTargetAtTime` is an exponential approach on the
audio clock, which does not advance between synchronous calls, so sampling the
node reports a sweep that never leaves its starting note:

| | |
|---|---|
| wail | 640–1540 Hz, 3.00 s cycle |
| yelp, inside 55 m | 640–1540 Hz, 0.33 s cycle |
| second voice | 1.502 × the fundamental |
| horn | 1.90 × the fundamental |
| level at 20 / 60 / 120 m | 0.060 / 0.035 / 0.010 |
| beyond 190 m | silent |

The radio's attention signal got the same treatment for the same reason. Two
sine notes a fifth apart, a fifth of a second each, is a real paging convention
and at game volume it reads as a little tune playing every time the net opens.
One short square beep through the channel's own band limiting belongs to a
radio instead. And the synthetic speech now *slides* between syllables: a 13%
stress on top of a 12% spread is three semitones held flat, and discrete
intervals held steady is the definition of a melody, which is why the radio
sounded like it was singing.

### Everything else

Intake roar that swells with revs, narrow-band tyre squeal driven by the worst
wheel's slip, wind noise from road speed, and one-shot impact thuds. A gentle
limiter sits on the output: engine at full chat, siren alongside and a collision
thud all land together often enough that without one the mix clips exactly when
it matters. Worst case measured at 0.53 peak — no clipping.

### The engine sits under the radio

The engine was the loudest thing in the mix and talked over the calls. It is
halved (`ENGINE_VOLUME`, intake roar included), and it ducks by a further 45%
while a call is being spoken — easing down over a fraction of a second and back
up over about a second. The ducking is the only way to make the voices louder
than they are: the speech engine plays outside Web Audio and is already at its
maximum volume of 1.

Measured at the master bus, Stiletto, RMS:

| | before | after |
|---|---|---|
| idle | 0.020 | 0.010 |
| cruising, 4 000 rpm | 0.042 | 0.022 |
| flat out, 7 500 rpm | 0.077 | 0.036 |
| flat out, during a call | 0.077 | **0.022** |

**The male voice needed more.** It was the one that was hard to hear, and
rendering the same sentence through the Windows speech engine Chrome uses
showed why: Hazel came out at −16.5 dBFS, Susan at −15.6, and George at
−23.5 — seven or eight dB quieter before the game touches it. Nothing can
raise a speech voice above full volume, so the duck is per speaker instead: the
mix drops 5.4 dB under Control and 11.8 dB under a unit, and the siren, tyres
and wind now go down with the engine, since the siren sweeps straight through
the band speech lives in and is loudest exactly when a nearby unit is talking.
The unit voice is also a touch slower and brighter (rate 1.8, pitch 1.08):
George is the fastest of the three at his default rate, and at 2.3 he was the
hardest to follow as well as the quietest. Measured flat out with a siren 40 m
away: 0.043 RMS with no call, 0.023 under Control, 0.011 under a unit.

The radio log that used to sit in the bottom right corner is hidden, since
everything on it is now spoken. It is still written to, so deleting one
`display: none` in `index.html` brings it back.

## Night and rain

Picked on the menu with two switches under the cars — **DAY / NIGHT** and
**DRY / RAIN** — and remembered for next time (`src/game/weather.js`).

**Night.** A dark sky and short fog, moonlight in place of the sun, and lights
that mean something. Your car throws a real headlight beam down the road ahead
(one spotlight, no shadows); every car on the road has glowing head and tail
lamps; every street lamp has a halo and a pool of light on the ground under it,
and goes out if you knock it over; the police light bars glow twice as big and
the helicopter's searchlight is much brighter — so the police are much easier
to see coming, and the light on you is much easier to see as well.

**Rain.** Rain falling round the camera — streaks fixed in the world and
wrapped into a box that follows you, so they fall straight past rather than
travelling with the car — a grey sky, closer fog, darker wet roads, the sound
of it, and **20% less grip** for every car on every surface. The police drivers
plan their braking on the same wet grip (`Vehicle.surfaceMu`), so they find it
as hard as you do.

Everything that glows is additive points or instanced quads: one draw per kind
of light however many there are. A real light per street lamp would be hundreds
of lights, and nothing — least of all a phone — would draw that.

## Score

A run lasts until you are arrested. Getting away does not end it — the town
carries on and so does the score — so the way to a big number is to keep
getting chased and keep getting away. The score sits under the wanted stars,
each bonus rises out from under it as it lands, and the arrest screen says what
the run was worth and whether it is a new best.

| | points |
|---|---|
| every second with the police after you | 5 / 10 / 20 / 35 / 60 at one to five stars |
| getting away | 400 × the most stars that chase reached |
| getting past a roadblock | 300 |
| a police car wrecked while you were close by | 250 |
| a near miss — a police car past you at speed, close enough to touch, no contact | 100 |

So surviving at five stars is worth twelve times surviving at one, and a
five-star escape is worth 2 000 on its own. The best ten runs are kept in the
browser (`localStorage`, `pc.scores`) with the car, the map, how long the run
lasted and the most stars it reached, and the top five are on the menu
(`src/game/score.js`). Checked by driving a chase by hand: 12 s at four stars
and an escape came to 2 020, five more seconds at two stars to 2 069, and the
arrest saved it as a new best and cleared the score for the next run.

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
* **No slip road cuts across the traffic.** They merge at about 23 degrees
  after running alongside the carriageway for 125 m, each junction claims its
  own stretch of ring, and a candidate junction is rejected outright if the
  ramp's approach would cut across the traffic to reach it. Country roads, laid
  out afterwards, *do* cross the ring, and those crossings are now real
  junctions rather than paint — see **Crossings the graph did not know
  about** — which is how a unit joins the motorway anywhere but a slip road.

Every road is registered in a graph with widths, speeds and junction types, which
is what the AI routes over. The minimap is heading-up: the map turns under a
fixed marker, with an `N` pointer for orientation.

---

### The garage

Each map has a petrol station with a repair bay, marked on the minimap with a
green spanner that sits on the edge of the map when it is out of range. Drive
into the bay — the hatched square on the workshop floor — and stop. After
three seconds sitting still the bay turns green and the car starts to mend at
5% a second, until it is back to 100% or you move; the meter at the bottom of
the screen counts the three seconds and then the repair. It works in a chase
too, but stopping is how you get arrested, so it is only safe if you have got
some distance first.

The site is found, not authored, so the same code (`src/game/garage.js`)
serves both maps: a straight stretch of ordinary road a few hundred metres from
the start with a 34 × 24 m lot of clear ground beside it — no road, no
building, no tree. The ground under the lot is repainted as footway in the
surface grid, so it is level (the physics reads its height from there) and
flush with the pavement you cross to get in, and street furniture is never
placed across its entrance. In the city it is on Ninth Street, 394 m from the
start; in Wexbury the town streets are built up to the kerb, so it is out on
Fosse Way at the edge of town, 359 m out.

`tests/garage.js` checks it on whichever map is loaded: the lot is level
(0.138–0.140 m), a car pointed at the bay from the road drives in with no
collisions, nothing happens for the first 2.8 s, the repair runs at 5.0% a
second, it stops when the car drives off, and 30% damage is gone 12 s later.

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
    garage.js          the petrol station and its repair bay
    score.js           the score and the best runs
    weather.js         night and rain
    bodies.js          SUV, van and Badger bodywork, and the police kit
    audio.js           sampled + synthesised engine, tyres, siren, impacts, radio
    camera.js  hud.js  effects.js
  core/
    menu.js            car, map and radio voice selection at startup
    input.js           keyboard and gamepad, merged with touch
    touch.js           on-screen steering, pedals and buttons for phones
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

Spike strips, elevated overpasses (the motorway is grade-level throughout), and
civilian traffic — which is the one that would give the traffic signals someone
to hold up besides the police.
