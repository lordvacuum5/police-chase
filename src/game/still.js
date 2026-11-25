// What stands still, not walked over every frame.
//
// three.js visits every object in the scene each frame to bring its matrix up to date: 7,800 of them on Ashfield, 3.5-4.4 ms
// of the main thread, 6,200 of those tufts of grass and parked cars' cells, none of which move. A root stilled here is
// brought up to date once and then passed over. And a root's cells in blocks, a block hidden whole when far off: a hidden
// level of detail still works out its distance each frame, and there are 1,700 of the verges'.
import * as THREE from 'three';

/** The scene's children that hold nothing which moves; their instances may (the parked cars'), which is not these matrices. */
const STILL = new Set(['verges', 'parked', 'trees', 'terrain', 'terrain-edge', 'roads', 'kerbs', 'pavements', 'markings', 'deck-markings',
  'decks', 'deck-slabs', 'deck-edges', 'deck-barriers', 'deck-piers', 'houses', 'towers', 'road-wear']);

function nothing() {}

/** Pass over what stands still in `scene`, from now on. */
export function stillScene(scene) {
  if (window.__noStill) return;
  for (const o of scene.children) {
    if (!STILL.has(o.name) || o.updateMatrixWorld === nothing) continue;
    o.updateMatrixWorld(true);
    o.updateMatrixWorld = nothing;
  }
}

const BLOCK = 400, MARGIN = 70;

/** `root`'s children (each standing at its own position) in blocks, none drawn further off than `far`: `cullBlocks`. */
export function block(root, far) {
  const blocks = new Map();
  for (const o of root.children.slice()) {
    const i = Math.floor(o.position.x / BLOCK), j = Math.floor(o.position.z / BLOCK), key = `${i},${j}`;
    let b = blocks.get(key);
    if (!b) {
      blocks.set(key, (b = new THREE.Group()));
      b.userData.at = [(i + 0.5) * BLOCK, (j + 0.5) * BLOCK];
      b.name = 'block';
    }
    b.add(o);
  }
  for (const b of blocks.values()) root.add(b);
  root.userData.blocks = [...blocks.values()];
  root.userData.blockFar = far + BLOCK * 0.7072 + MARGIN;
}

/** Now and then: which of `root`'s blocks can be seen from `at`. */
export function cullBlocks(root, at) {
  const far2 = root.userData.blockFar ** 2;
  for (const b of root.userData.blocks) {
    const [x, z] = b.userData.at;
    b.visible = (x - at.x) ** 2 + (z - at.z) ** 2 < far2;
  }
}
