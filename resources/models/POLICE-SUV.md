# The police SUV model

A brief for a replacement police SUV body, for whoever builds it.

The game already has one: `police-suv.glb` in this folder. A new file of the
same name replaces it, and nothing else needs to change. Only the look changes;
how the car drives, its size to the physics and its collider all stay in the
game's code (`suv` in `src/game/vehicles.js`). If no file is present, the game
falls back to a body it generates itself.

## Work from the player's reference pictures

**Ask the player for their reference pictures, look at all of them, and build
to them.** They decide what it looks like: the shape, the proportions, the
lights, the livery. Do not invent an SUV, and do not copy the current model.
Everything below is the technical side only, and it does not constrain the
shape.

## The short version

A marked British police SUV, nose along **+Z**, **Y up**, in **metres**,
standing on its tyres. Four named wheels, the livery baked into one texture,
one material, 5,000–15,000 triangles. A `.glb` with no animation.

## Format

* **glTF 2.0 binary (`.glb`)**, uncompressed. Draco, meshopt and KTX2 are not
  handled, so export with all of them off.
* **One material, one texture.** Up to 30 police cars can be on screen at
  once, and they are all this model, so **5,000–15,000 triangles** is the
  budget. Spend triangles on the silhouette, not on hidden parts like the
  engine bay, the underside or the interior beyond what shows through the
  glass.
* **The livery is baked into that texture.** The game's generated cars are
  painted from a texture of their own; an imported model brings its own
  mapping, so its markings must be in its own texture. 2048 × 2048 at most;
  1024 is usually enough.

## Size

Model it at the real size of the car in the pictures. The game measures your
wheels and fits the body to its own numbers, so being a few centimetres out
does not matter. For reference, the game's SUV is:

| | |
|---|---|
| length | 4.95 m |
| width (body, not mirrors) | 2.00 m |
| height (roof, not light bar) | about 1.56 m body + ride height |
| wheelbase | 2.98 m |
| track, front and rear | 1.70 m |
| tyre radius | 0.39 m (a 0.78 m tyre) |
| tyre width | 0.28 m |

Close to those numbers, the car will look as big as it collides. A model with
very different proportions (much longer, or a short wheelbase) will be
stretched to fit and look wrong, so say so if the reference car is far off
these.

## Named nodes the game needs

* **`wheel_fl`, `wheel_fr`, `wheel_rl`, `wheel_rr`**: front-left, front-right,
  rear-left, rear-right, as seen from the driver's seat. A wheel can be one
  mesh or several parts all named after it (`wheel_fl_tyre`, `wheel_fl_rim`,
  ...). The game measures them to line the body up with its own wheels, then
  hides them and draws its own, which turn and steer. So model each wheel as a
  closed tyre-and-rim in its arch, with a clear gap to the arch, and **nothing
  else named `wheel_...`**.

Nothing else needs a name.

## Lights

* **The light bar stays in the model** as plain, unlit lens plastic: blue
  lenses, clear end caps, on the roof where the pictures have it. The game
  draws the flashing lights on top of it.
* If the bar is anywhere unusual (not centred on the roof), tell the player.
  The flasher positions are a setting (`lamps` in `CAR_MODELS`,
  `src/game/carmodel.js`) and will need setting by hand.
* Headlamps and tail lamps are just part of the texture or geometry. Nothing
  in the game switches them.

## Livery

UK marked car, the way the rest of the fleet wears it (see "Police livery" in
the README):

* full-length **Battenburg** (blue and yellow checks) down both flanks, with
  **POLICE** on it,
* **POLICE** written in reverse on the bonnet,
* red and yellow **chevrons** on the tailgate,
* a unit number on the roof.

Where the reference pictures show something different, follow the pictures.

## Don'ts

* No animation, no cameras, no lights (lamps) in the file.
* No collision meshes: the collider is a box in the game's code.
* Do not mirror the car with a negative scale. Mirrored parts render inside
  out.
* Apply all transforms before export (scale 1, no rotation on the root).

## Checking it

Drop it in as `resources/models/police-suv.glb` and load the game. In the
browser console, `__runCarModel()` from `tests/carmodel.js` checks it lands on
its wheels at the right size. If the car faces backwards, set `yaw: Math.PI`
for `suv` in `CAR_MODELS`. If it floats or sinks, set `lift` (metres).
