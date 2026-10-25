// The playable maps.
//
// Each entry only has to return { graph, surfaceAt, meshes }; everything after
// that -- physics, AI, spawning, HUD -- is map-agnostic.

import { buildCity } from './citygen.js';
import { buildTown } from './towngen.js';
import { buildCountry } from './countrygen.js';

export const MAPS = [
  {
    id: 'city',
    name: 'Ashfield City',
    tag: 'Grid · Ring motorway',
    blurb: 'Dense downtown blocks, long avenues and a three-lane ring motorway. '
         + 'Sightlines run straight down every street, so the police cut you off '
         + 'at junctions they can predict.',
    build: buildCity,
  },
  {
    id: 'wexbury',
    name: 'Wexbury',
    tag: 'Organic · Market town',
    blurb: 'An English market town that grew rather than being planned: crooked '
         + 'lanes round a market square, ring roads at odd radii, estates of '
         + 'crescents and dead ends, and a dual carriageway bypass joined by '
         + 'roundabouts. Nothing meets at a right angle.',
    build: buildTown,
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
