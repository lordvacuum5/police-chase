# The helicopter model

A brief for the model, and a note to whoever picks this up next.

The game already has a helicopter: `src/game/helicopter.js` builds one out of
faceted boxes, the same way the cars are built, and flies it as an NPC. This
replaces the geometry only. Nothing about how it flies, what it can see or how
the force uses it depends on this file.

Drop the finished model in here as `helicopter.glb`.

## The short version

A police helicopter, nose along **+Z**, **Y up**, in **metres**, sitting on its
skids with the origin on the ground between them. Main and tail rotors as
separate named nodes with their origins on their hubs. Livery baked in. No
animation in the file.

## Format

Same as the cars (see `README.md` in this folder):

* **glTF 2.0 binary (`.glb`)**, uncompressed. Draco, meshopt and KTX2 are not
  handled — export with all of them off.
* **Livery baked into its own texture.** The generated cars are painted from an
  atlas keyed to UVs the game makes; an imported model arrives with its own, so
  its markings have to be in its own texture.
* **One material, one texture.** The triangle budget is looser than the cars'
  5–15k, because there is only ever one helicopter and it is usually far away:
  **15–40k** is fine. Most of it should go on the silhouette — the thing is
  nearly always seen from below against the sky.

## Size and orientation

* **Nose along +Z, Y up, metres, real scale.** The generated one is about
  **8.5 m** nose to tail boom with a **12.4 m** main rotor disc and a cabin
  **2.5 m** wide — a light police twin, not a Chinook. Anywhere near that is
  right, and the game can scale it, but modelling to life size means the
  scale factor comes out at 1.00 and nothing has to be guessed.
* **Origin at ground level, centred between the skids**, with the skids resting
  on y = 0. The cars are fitted by their wheels, because that is the only way
  to stand a car on the road at the right height without being told; a
  helicopter on skids has no such landmark, so the model has to say where the
  ground is, and it says it by sitting on it.
* A model built facing the wrong way is a one-line `yaw` setting, so it is not
  fatal — but +Z is what the rest of the project uses.

## The parts that have to be named

The game spins the rotors in code, every frame, by looking the nodes up by
name. They must be **separate nodes**, and each one's **origin must be on its
own hub**, or it will orbit instead of spin.

| node | what it is | the game turns it about |
|---|---|---|
| `rotor_main` | the main rotor — hub and blades | its own **vertical** axis |
| `rotor_tail` | the tail rotor — hub and blades | the **lateral** axis, i.e. the hub's own spin axis |

Model the blades as actual blades. The current version cheats with two
translucent discs, because at rotor speed that is genuinely what you see, and
the game may still blur or disc them at speed — but it can only do that if the
real blades are there to begin with.

Everything else can be one mesh.

## Skids

Skids, not wheels. Wheeled gear was considered and dropped for the simple
reason that almost no light police helicopter has it — the references are all
skids, and skids are what the generated one already has.

Nothing about them needs naming or separating: they are part of the hull, and
the only thing the game asks of them is that **they are what the model is
resting on**, so their underside is y = 0 and the aircraft sits level.

This also takes a whole problem away. Wheeled gear would have wanted the cars'
spring and damper travel so it compressed under weight on landing; skids are
rigid, so a landing is the airframe meeting the ground and nothing has to be
modelled, named or tuned for it.

## What not to put in

* **No animation.** Rotor rotation is the game's, every frame. A baked spin
  would fight it.
* **No searchlight cone.** A light pod on the airframe is good; the beam itself,
  if there is ever one, is the game's.
* **No collider mesh.** As with the cars, the collider is the game's own and the
  model is fitted to it.

## Where this is going

Context for whoever picks this up, so the model is judged against the right
plan. The player is thinking about a **flyable** police helicopter as a
multiplayer role, and the intended design is:

* A real flight model, not a fixed altitude — the point is that flying it is a
  skill.
* **No automatic detection, and no searchlight.** The pilot's own eyes are the
  sensor. Seeing the car on screen does nothing by itself.
* The pilot presses a button to **mark** the car, which drops one fix on the
  ground units' maps. That fix then **decays** — the dispatcher already models
  a last-known position with a confidence that fades, and units already drive
  to it and search, so this feeds a system that exists rather than adding one.
* Altitude balances itself: high up you can see the road network but cannot
  tell which car is which, so a fix means coming down to where flying is hard.
* **Fuel**, with a landing to refuel. `Helicopter.refuelTimer` already exists.

None of that is built. The model is the first piece.
