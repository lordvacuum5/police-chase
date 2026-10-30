# The train model

A brief for the model, written to be handed to whoever builds it. The player
asked for one: "we want a modern train", and "shouldn't each part of the
train be movable?" -- yes, and this is how.

The game already has a train: `src/world/countryextras.js` (`carriageGeometry`,
`class Railway`) builds one out of boxes and runs it along the railway on Haldon
Vale. This replaces the geometry only. How it runs, the level crossings and what
it does to a car in its way do not depend on these files.

Drop the finished files in here: `train-cab.glb`, `train-coach.glb`,
`train-bogie.glb`.

## What it is

A **modern British intercity train** -- the look of an LNER Azuma or GWR
Intercity Express (Hitachi Class 800/801/802): long smooth aluminium bodies, a
long raked nose with a wide wraparound windscreen and the yellow warning panel
low on the front, flush windows in a continuous dark band, sliding plug doors
near each end of each carriage, a smooth roof with low equipment, a skirt
hiding most of the underframe. Not a copy of any operator's livery: our own --
white or silver body, one dark window band, one strong colour stripe low down
(the game's is blue), yellow nose panel. Clean and bright; it is seen from
across fields at 120 km/h as often as close up.

If the player sends reference pictures, those win on how it looks.

## Why three files: every part moves

The train is **five carriages, each moving on its own**: each one is a separate
body that follows the track, so on a curve the train bends at every joint
rather than sliding round as one rigid block. A carriage rides on **two
bogies** (the wheel frames under each end), and on a curve each bogie turns to
follow the rails, under its carriage. So:

* `train-cab.glb` -- an end carriage, nose and driver's cab at one end. Used
  twice: at the front, and turned round at the back.
* `train-coach.glb` -- a middle carriage. Used three times.
* `train-bogie.glb` -- one bogie: frame, two axles, four wheels. Used twice
  under every carriage. **Not part of the carriage files.** The game places and
  turns each one itself, and spins the wheels.

Nothing in any file is animated. The game does all the moving.

## Size, orientation, origin

* **glTF 2.0 binary (`.glb`)**, uncompressed (no Draco, meshopt or KTX2).
* **Metres**, **Y up**, the carriage's length along **Z**, the **nose toward
  -Z** (the same as the cars: see `README.md` in this folder).
* **Carriages: 23 m long** (the cab's 23 m includes its nose), **2.8 m wide**,
  **3.7 m tall** from the rails to the roof. The **origin on the rails**: at the
  middle of the carriage's length and width, at rail-top height -- so the body
  floats about 1 m above the origin, where the bogies hold it up.
* Leave space under each end for a bogie: centred **8 m** either side of the
  middle, about 3.2 m long and 1 m tall. The skirts can come down to just above
  them.
* **Bogie: about 3.2 m long, 2.7 m wide, 1.0 m tall**, origin on the rails at
  its middle, wheels 0.85 m across, axles 2.6 m apart, track gauge 1.435 m.
  Each **wheelset** (axle and two wheels) a **separate node named `axle_front`
  and `axle_rear`**, its origin on the axle's centre, so the game can spin it.
* The two ends of the coach should look the same, and the gangway between
  carriages (the flexible bellows) is part of each carriage, half each end.

## Materials

Named, because the game changes some of them:

* `body` -- the carriage sides and roof.
* `livery` -- the coloured stripe. The game may recolour it.
* `windows` -- all glass, dark, a little reflective.
* `lights` -- headlights and tail lights (cab only). The game turns them on and
  off and swaps white for red at the back.
* `nose` -- the yellow warning panel (cab only).
* `underframe` -- skirts, equipment, bogie frames: dark grey.
* `wheels` -- steel.

Livery and markings may be in a texture of their own (one per file, no more
than 2048 square); flat colours are fine too.

## Budget

It is seen far more often from a distance than up close, and five carriages
are drawn at once. **Up to about 12,000 triangles a carriage and 2,000 a
bogie** -- under 70,000 for the whole train. Smooth the nose, not the bolts.

## Checklist before handing it over

1. Each file opens in a glTF viewer at the right size (a carriage is 23 m).
2. The nose points down -Z; the origin is on the rails, mid-carriage.
3. Bogie wheelsets are separate nodes, `axle_front` and `axle_rear`.
4. Material names as above.
5. No animation, no cameras, no lights in the files.
