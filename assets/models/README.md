# Imported car bodies

Drop a `.glb` in here to replace the body of one kind of car. Nothing in this
folder is required: with no file, the game uses its own generated body exactly
as before.

| file | replaces |
|---|---|
| `suv.glb` | the police SUV |

Other kinds can be added to `CAR_MODELS` in `src/game/carmodel.js`.

## What the file should contain

* **glTF 2.0 binary (`.glb`)**, uncompressed. Draco and meshopt compression
  and KTX2 textures are not handled — export with those off.
* **The body only.** Anything named `wheel`, `tyre`, `tire`, `rim` or `hubcap`
  is dropped: the game supplies and steers its own wheels.
* **The livery baked into the texture.** The generated cars are painted from a
  texture atlas keyed to their own UVs, and an imported model has its own — so
  its markings have to be in its own texture.
* **One material, one texture, 5–15k triangles**, ideally. At five stars there
  can be eighteen police cars on screen at once, and they are all this model.

The light bar can stay in the model as unlit plastic; the flashing lights are
the game's own and are placed on top of it.

## What the game does for you

Scale, position and facing are fitted automatically to the body being replaced,
so a model in centimetres, or off-centre, or five times life size, still lands
on the road at the right size. What it cannot guess is a car modelled facing
backwards, or one whose light bar is somewhere unusual. Those are settings in
`CAR_MODELS`:

```js
suv: {
  url: 'assets/models/suv.glb',
  yaw: 0,        // radians; Math.PI if the car faces the wrong way
  lift: 0,       // metres up or down, if the sills sink or float
  lamps: null,   // [[x,y,z],[x,y,z]] in body-local metres, to place the flashers by hand
}
```

The collider never comes from the model — it is `spec.dims` for that kind of
car, and the model is fitted to match it. A car that looks much bigger or
smaller than it collides is a `dims` change, not a model change.

`tests/carmodel.js` checks the fitting, run from the browser console with
`__runCarModel()`.
