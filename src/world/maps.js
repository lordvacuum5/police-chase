// The playable maps.
//
// Each entry only has to return { graph, surfaceAt, meshes }; everything after
// that -- physics, AI, spawning, HUD -- is map-agnostic.

import { buildCity } from './citygen.js';
import { buildWexbury } from './wexbury.js';
import { buildCountry } from './countrygen.js';

export const MAPS = [
  {
    id: 'city',
    name: 'Ashfield City',
    tag: 'Big city · Motorway · River',
    blurb: 'The biggest map: towers downtown, a river through the middle crossed by '
         + 'bridges, the hilly streets of Ashfield Heights, suburbs of cul-de-sacs, '
         + 'docks, a raised motorway with slip roads and a downtown expressway, '
         + 'and a three-lane ring round it all. Stay in the river too long and the engine floods.',
    // 3 km across: Wexbury and Haldon Vale are 2 km (world/common.js setWorldSize).
    half: 1500,
    // Two garages, at opposite ends: "it's pretty hard to repair such a big map" (game/garage.js Garages).
    garages: 2,
    build: buildCity,
  },
  {
    id: 'wexbury',
    name: 'Wexbury',
    tag: 'Market town · River · Railway',
    blurb: 'An English market town on hills: crooked streets and back alleys round '
         + 'a market square, a river with stone bridges, a lake out in the fields, a '
         + 'railway with level crossings, mini roundabouts and the Magic Roundabout, a '
         + 'bypass, a ford, and a road up the Beacon. Stay in the river too long and the engine floods.',
    // As big as Ashfield City: "You can make it as big as the American map if you want."
    half: 1500,
    garages: 2,
    build: buildWexbury,
  },
  {
    id: 'haldon',
    name: 'Haldon Vale',
    tag: 'Open country · Hills',
    blurb: 'Rolling farmland under big hills: single-track lanes sunk between '
         + 'hedges, three villages round their greens, farms whose barns you can '
         + 'drive straight through, woods to lose them in, and humpback crests '
         + 'to leave the ground over. A ring lane loops the whole vale.',
    build: buildCountry,
  },
];

/** The maps the menu offers: the hidden ones only when unlocked for this tab. */
export function mapsOnMenu() {
  let open = false;
  try {
    if (new URLSearchParams(location.search).get('haldon') === '1') sessionStorage.setItem('pc.unhide', '1');
    open = sessionStorage.getItem('pc.unhide') === '1';
  } catch (e) { /* storage blocked */ }
  return MAPS.filter((m) => !m.hidden || open);
}

export function mapById(id) {
  return MAPS.find((m) => m.id === id) || MAPS[0];
}
