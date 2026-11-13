# The police interceptor model

A brief for a replacement interceptor body, for whoever builds it. The prompt below is written to be pasted
to that person or Claude as it stands, with the player's pictures attached.

The game already has an interceptor: `police-interceptor.glb` in this folder, a big modern American
saloon. The player wants something sleeker: *"our equivalent of a really fast police car is the
interceptor ... it's kind of just a modern American police car ... slow, big. So I kind of like maybe
something more sleek ... like a Lamborghini looking sort of thing. Not like an old Lamborghini, but like a
modern fast car."* A new file of the same name replaces the old one; nothing else needs to change.

---

## Prompt

Please build me a 3D model of a **police interceptor for a browser driving game**: a modern, low, wide
supercar in the spirit of a current Lamborghini (Huracán / Revuelto era), not a retro one, and done up as a
**complete, working police car**. Deliver one `.glb` file.

**Use my pictures.** I'm attaching several reference pictures. Look at all of them before you start and
build the shape from them: the silhouette, the proportions, the nose, the sharp angular lines, the
intakes, the lights. **The pictures do not show the complete car I want.** Some may be a road car with no
police markings, some may show only part of it, or only one side, or a different trim. Treat them as the
reference for the *shape and style*, and build the full police version of it: both sides, front and back,
all four corners consistent, with everything a police car has, below. Where the pictures disagree with
each other, go with the sleekest and most modern reading, and tell me what you chose.

What makes it a police car (where my pictures show their own version of any of this, follow the pictures):

* A **low-profile light bar** across the roof, centred, plain unlit plastic (red and blue lenses or clear
  lenses with red/blue tint). It must be the **highest thing on the car**: no spoiler, wing or fin
  standing taller. About **1.0–1.4 m wide** across the car and **0.25–0.5 m front to back**, sitting just
  behind the top of the windscreen. The game finds it by those numbers and puts its own flashing lights
  in it.
* A **police livery** baked into the texture: a mostly black car with white doors/flanks or a bold
  high-contrast pattern, **POLICE** large on both doors, **INTERCEPTOR** smaller under it or along the
  sills, POLICE across the nose, a unit number on the roof and on the rear. Keep it readable from a
  distance at a low angle, since the camera mostly sees it from behind and a little above.
* Small details that sell it: a slim push bar or reinforced front splitter if it suits the shape, a
  spotlight or antenna on the roof, dark tinted glass.

Technical (please keep to these exactly; the game depends on them):

* **glTF 2.0 binary (`.glb`)**, uncompressed: no Draco, no meshopt, no KTX2.
* **Nose along +Z, Y up, in metres**, standing on its tyres at the origin. Apply all transforms before
  export (scale 1, no rotation on the root). No negative-scale mirroring.
* **One material, one texture** (1024 or 2048 square), livery baked in. **5,000–15,000 triangles**: up to
  thirty police cars can be on screen at once. Spend them on the silhouette, not the underside, engine or
  interior beyond what shows through the glass.
* **Four wheels as separate nodes named `wheel_fl`, `wheel_fr`, `wheel_rl`, `wheel_rr`** (front-left,
  front-right, rear-left, rear-right from the driver's seat). Each a closed tyre and rim sitting in its arch
  with a clear gap to the bodywork. A wheel may be several parts all named after it (`wheel_fl_tyre`,
  `wheel_fl_rim`). Nothing else may have a name starting `wheel_`. The game measures these to line the
  body up, then hides them and draws its own wheels, which steer and turn.
* **Size**: the game's interceptor is 4.90 m long, 1.96 m wide (body, not mirrors), about 1.22 m tall to
  the roof, wheelbase 2.92 m, track 1.62 m front and rear, tyre radius 0.34 m. A real supercar is a little
  lower and shorter than that. Stay close to it, keep the wheelbase near 2.9 m, and use big wheels that fill
  the arches. The body is scaled to the game's wheelbase, so very different proportions get stretched and
  look wrong. If the car in my pictures is far off these numbers, tell me.
* No animation, cameras, lights or collision meshes in the file.

When you hand it over, tell me: the triangle count, the overall length/width/height and wheelbase as
built, where the light bar is (centre and width), and anything in my pictures you could not follow.

---

## For the game side, once it arrives

Drop it in as `resources/models/police-interceptor.glb` and load the game. `__runCarModel()` from
`tests/carmodel.js` checks it lands on its wheels at the right size; `findLightBar` in
`src/game/carmodel.js` should find the bar (the highest thing, over 0.8 m across, under 0.7 m long) and
put the flashers in it. If it faces backwards, `yaw: Math.PI` for `interceptor` in `CAR_MODELS`; if it
floats or sinks, `lift`. The menu card retakes its photograph on its own only if `pc.cards` is cleared or
`VERSION` in `src/game/cards.js` is bumped, so bump it. Only the look changes: how it drives and its
collider stay `interceptor` in `src/game/vehicles.js`, and a sleeker look may make the player want a
faster car to match, which is a separate change.
