// Main menu: settle everything before anything heavy is built.
//
// Three ways in, and the menu shows only what each one has to answer:
//
//   SINGLE PLAYER   car, weather, ground
//   HOST A GAME     a name for the game, then the same three -- you are the
//                   escapee, and what you pick is what everyone plays
//   JOIN A GAME     the name of the game, and which police car you turn up in.
//                   The ground and the weather are the host's; there is no
//                   point showing them here, and showing them greyed out only
//                   made it look broken.
//
// Nothing starts until START is pressed. Picking a map used to start the game
// on the spot, which meant you could not look at the second map without
// playing it.
//
// The thumbnails are schematics drawn with 2D canvas rather than renders of the
// real map -- generating a map costs a second or so, and the whole point of the
// menu is to appear instantly.

import { MAPS, mapById } from '../world/maps.js';
import { session } from '../net/session.js';
import { prefersTouch } from './touch.js';
import { bestScores } from '../game/score.js';
import { chosenConditions, setConditions } from '../game/weather.js';
import { makeRng, TAU } from '../util/math.js';
import {
  englishVoices, pickVoices, voiceChoices, setVoiceChoice, speakSample, SPEAKER_NAMES,
} from '../game/audio.js';

/**
 * The cars you can run in.
 *
 * Every figure is measured by tests/supercar.js, not estimated: top speed and
 * 0-60 on flat tarmac past the map edge, grip as the peak steady lateral
 * acceleration at 120 km/h, and toughness as how many 50 km/h shunts into a
 * parked patrol car it takes to wreck the car. Speeds are in mph, like the
 * speedometer and like the radio. Each bar is scaled to the best of the three,
 * so the cards read as a trade rather than a rating. Re-run the test and
 * update these if a spec changes.
 */
export const CARS = [
  {
    id: 'runner',
    name: 'Runner',
    tag: 'TOUGH',
    colour: '#d94f16',
    shape: 'saloon',
    stats: [
      ['Top speed', 134, 'mph'],
      ['0-60', 7.1, 's', true],
      ['Grip', 1.40, 'g'],
      ['Toughness', 11, 'hits'],
    ],
  },
  {
    id: 'supercar',
    name: 'Stiletto',
    tag: 'FAST, FRAGILE',
    colour: '#b3101e',
    shape: 'wedge',
    stats: [
      ['Top speed', 149, 'mph'],
      ['0-60', 4.8, 's', true],
      ['Grip', 1.58, 'g'],
      ['Toughness', 5, 'hits'],
    ],
  },
  {
    id: 'offroad',
    name: 'Badger',
    tag: 'OFF-ROAD',
    colour: '#4c7a3a',
    roof: '#e9e2c8',
    shape: 'boxy',
    stats: [
      ['Top speed', 88, 'mph'],
      ['0-60', 9.8, 's', true],
      ['Grip', 1.08, 'g'],
      ['Toughness', 18, 'hits'],
    ],
  },
];

/**
 * The police cars a human unit can turn up in.
 *
 * Joining a game puts you in the fleet rather than in front of it, so this is
 * the one thing that side of the menu picks. The figures are measured by
 * tests/policecars.js on the car as a person gets it -- the drivable tyre
 * model, the extra mass, the extra engine (see drivablePoliceSpec) -- and not
 * on the fleet car the AI drives, so the cards describe what you will actually
 * be holding. Bars are scaled within this list, as the escapee's are within
 * theirs: these three are a choice between each other, not against a Stiletto.
 *
 * There is no patrol car in the list on purpose. Measured, it is slower than
 * the interceptor, no tougher, and less grippy -- a choice nobody would make
 * for a reason. These three are a real triangle: the unmarked car is the
 * quickest thing the force owns and the easiest to break, and it carries no
 * light bar, so nothing moves out of your way; the SUV is half as breakable
 * again and a second and a half slower to sixty.
 */
export const POLICE_CARS = [
  {
    id: 'interceptor',
    name: 'Interceptor',
    tag: 'PURSUIT',
    colour: '#16233c',
    shape: 'saloon',
    stats: [
      ['Top speed', 152, 'mph'],
      ['0-60', 5.7, 's', true],
      ['Grip', 1.52, 'g'],
      ['Toughness', 12, 'hits'],
    ],
  },
  {
    id: 'suv',
    name: 'Police SUV',
    tag: 'HEAVY, 4WD',
    colour: '#eef2f6',
    roof: '#13233f',
    shape: 'suv',
    stats: [
      ['Top speed', 145, 'mph'],
      ['0-60', 7.1, 's', true],
      ['Grip', 1.43, 'g'],
      ['Toughness', 19, 'hits'],
    ],
  },
  {
    id: 'unmarked',
    name: 'Unmarked',
    tag: 'NO LIGHT BAR',
    colour: '#23272e',
    shape: 'saloon',
    stats: [
      ['Top speed', 155, 'mph'],
      ['0-60', 5.3, 's', true],
      ['Grip', 1.52, 'g'],
      ['Toughness', 10, 'hits'],
    ],
  },
];

const CAR_KEY = 'pc.car';
const POLICE_KEY = 'pc.policecar';
// Not 'pc.map': that name is taken, in sessionStorage, by the map a refresh
// drops you back into.
const MAP_KEY = 'pc.ground';

/** The car picked on the menu, remembered between visits. */
export function chosenCar() {
  let id = null;
  try { id = localStorage.getItem(CAR_KEY); } catch (e) { /* storage blocked */ }
  return CARS.some((c) => c.id === id) ? id : CARS[0].id;
}

function rememberCar(id) {
  try { localStorage.setItem(CAR_KEY, id); } catch (e) { /* storage blocked */ }
}

/** The police car picked for joining somebody else's game. */
export function chosenPoliceCar() {
  let id = null;
  try { id = localStorage.getItem(POLICE_KEY); } catch (e) { /* storage blocked */ }
  return POLICE_CARS.some((c) => c.id === id) ? id : POLICE_CARS[0].id;
}

/** The map picked on the menu. Only the escapee's side of it ever asks. */
export function chosenMap() {
  let id = null;
  try { id = localStorage.getItem(MAP_KEY); } catch (e) { /* storage blocked */ }
  return MAPS.some((m) => m.id === id) ? id : MAPS[0].id;
}

function remember(key, id) {
  try { localStorage.setItem(key, id); } catch (e) { /* storage blocked */ }
}

export function showMenu(onPick) {
  const menu = document.getElementById('menu');
  menu.classList.remove('gone');
  buildMaps();
  buildConditions();
  buildBestScores();
  buildVoicePicker();
  buildModes(onPick);
  if (prefersTouch()) {
    const hint = document.getElementById('menuhint');
    if (hint) hint.innerHTML = 'Tap <b>MENU</b> in game to come back here';
  }
}

/**
 * The ground. Picking one only selects it; START is what starts the game.
 */
function buildMaps() {
  const holder = document.getElementById('maps');
  if (!holder) return;
  holder.innerHTML = '';
  let current = chosenMap();
  const cards = [];

  const paint = () => {
    for (const c of cards) c.classList.toggle('chosen', c.dataset.id === current);
  };

  for (const m of MAPS) {
    const card = document.createElement('div');
    card.className = 'mapcard';
    card.tabIndex = 0;
    card.dataset.id = m.id;

    const canvas = document.createElement('canvas');
    canvas.width = 620; canvas.height = 300;
    card.appendChild(canvas);

    const title = document.createElement('h2');
    title.textContent = m.name;
    card.appendChild(title);

    const tag = document.createElement('div');
    tag.className = 'tag';
    tag.textContent = m.tag;
    card.appendChild(tag);

    const blurb = document.createElement('p');
    blurb.textContent = m.blurb;
    card.appendChild(blurb);

    if (m.id === 'wexbury') drawTown(canvas); else drawCity(canvas);

    const select = () => { current = m.id; remember(MAP_KEY, m.id); paint(); };
    card.addEventListener('click', select);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(); }
    });
    cards.push(card);
    holder.appendChild(card);
  }
  paint();
}

export function hideMenu() {
  document.getElementById('menu').classList.add('gone');
}

/**
 * Car cards. Picking one only selects it -- START is what starts the game --
 * so the choice is shown as a highlighted card rather than acted on.
 *
 * The same cards do both sides of the game: the escapee's three, or, for
 * somebody joining as a police unit, the three cars the fleet will hand them.
 */
function buildCarCards(list, key, chosen) {
  const holder = document.getElementById('cars');
  if (!holder) return;
  holder.innerHTML = '';
  let current = chosen();

  const best = list[0].stats.map((_, i) => {
    const vals = list.map((c) => c.stats[i][1]);
    return list[0].stats[i][3] ? Math.min(...vals) : Math.max(...vals);
  });

  const cards = [];
  for (const car of list) {
    const card = document.createElement('div');
    card.className = 'carcard';
    card.tabIndex = 0;
    card.setAttribute('role', 'radio');

    const canvas = document.createElement('canvas');
    canvas.width = 620; canvas.height = 168;
    card.appendChild(canvas);
    drawCarProfile(canvas, car);

    const title = document.createElement('h2');
    title.innerHTML = `<span>${car.name}</span><small>${car.tag}</small>`;
    card.appendChild(title);

    const stats = document.createElement('div');
    stats.className = 'stats';
    car.stats.forEach(([label, value, unit, lowerIsBetter], i) => {
      // Lower-is-better figures (a 0-100 time) fill by how close they are to
      // the best time rather than by their size.
      const frac = lowerIsBetter ? best[i] / value : value / best[i];
      const shown = unit === 's' ? `${value.toFixed(1)} s`
        : unit === 'g' ? `${value.toFixed(2)} g` : `${value} ${unit}`;
      stats.insertAdjacentHTML('beforeend',
        `<span>${label}</span><span class="bar"><i style="width:${Math.round(frac * 100)}%"></i></span>`
        + `<span class="v">${shown}</span>`);
    });
    card.appendChild(stats);

    const select = () => {
      current = car.id;
      remember(key, car.id);
      for (const c of cards) {
        const on = c.dataset.id === current;
        c.classList.toggle('chosen', on);
        c.setAttribute('aria-checked', on ? 'true' : 'false');
      }
    };
    card.dataset.id = car.id;
    card.addEventListener('click', select);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(); }
    });
    cards.push(card);
    holder.appendChild(card);
  }
  for (const c of cards) {
    const on = c.dataset.id === current;
    c.classList.toggle('chosen', on);
    c.setAttribute('aria-checked', on ? 'true' : 'false');
  }
}

/** Day or night, dry or rain: two switches, remembered for next time. */
/**
 * Single player, hosting, or joining.
 *
 * Multiplayer is one escapee and any number of police cars, and a game is just
 * a name: whoever hosts it is the one being chased and picks the ground and
 * the weather, and anyone who types the same name joins as a police unit in
 * that game. The name is the whole of the lobby -- there is no list of games
 * to browse and nothing to sign into.
 *
 * Hosting and joining are separate choices rather than two small buttons
 * inside one multiplayer panel, because they are not the same job: one of them
 * decides what everybody plays, and the other turns up to it. A joiner is
 * shown a car and nothing else -- the ground and the weather are already
 * settled, and greying them out only made the menu look broken.
 */
let netMode = 'single';       // 'single' | 'create' | 'join'
let starting = false;         // a connection is already in flight

function gameName() {
  const el = document.getElementById('gamename');
  return el ? el.value.trim().toUpperCase().replace(/\s+/g, ' ') : '';
}

function netStatus(text, kind) {
  const el = document.getElementById('netstatus');
  if (!el) return;
  el.textContent = text || '';
  el.className = kind || '';
}

const START_LABEL = { single: 'START CHASE', create: 'CREATE & START', join: 'JOIN GAME' };
const MODE_HINT = {
  single: '',
  create: 'You are the escapee. Others join by typing this name.',
  join: 'You are a police unit in this game.',
};

function buildModes(onPick) {
  const holder = document.getElementById('mode');
  const panel = document.getElementById('netpanel');
  const startBtn = document.getElementById('startbtn');
  const nameBox = document.getElementById('gamename');
  if (!holder || !panel || !startBtn) return;
  holder.innerHTML = '';
  netMode = 'single';
  starting = false;

  const modes = [
    ['SINGLE PLAYER', 'single'],
    ['HOST A GAME', 'create'],
    ['JOIN A GAME', 'join'],
  ];
  const seg = document.createElement('div');
  seg.className = 'seg';
  const buttons = modes.map(([label, value]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.addEventListener('click', () => setMode(value));
    seg.appendChild(b);
    return b;
  });
  holder.appendChild(seg);

  function setMode(mode) {
    netMode = mode;
    starting = false;
    startBtn.disabled = false;
    buttons.forEach((b, i) => b.classList.toggle('on', modes[i][1] === mode));

    // Joining picks a police car; the other two pick the escapee's.
    const joining = mode === 'join';
    buildCarCards(joining ? POLICE_CARS : CARS,
      joining ? POLICE_KEY : CAR_KEY,
      joining ? chosenPoliceCar : chosenCar);

    const show = (id, on, text) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.hidden = !on;
      if (text !== undefined) el.textContent = text;
    };
    show('netpanel', mode !== 'single');
    show('netlabel', true, mode === 'create' ? 'NAME YOUR GAME' : 'GAME TO JOIN');
    show('carsub', true, joining ? 'CHOOSE YOUR POLICE CAR' : 'CHOOSE YOUR CAR');
    show('conditions', !joining);
    show('menusub', !joining);
    show('maps', !joining);
    const note = document.getElementById('joinnote');
    if (note) {
      note.hidden = !joining;
      note.innerHTML = 'The host is the escapee, and picks the ground and the weather. '
        + 'You are <b>a police unit in their game</b> &mdash; all you choose is the car you turn up in.';
    }
    if (nameBox) nameBox.placeholder = mode === 'create' ? 'NEW GAME NAME' : 'GAME NAME';
    startBtn.textContent = START_LABEL[mode];
    netStatus(MODE_HINT[mode]);
    if (mode !== 'single' && nameBox) nameBox.focus();
  }

  const start = async () => {
    if (starting) return;
    if (netMode === 'single') {
      hideMenu();
      onPick(mapById(chosenMap()) || MAPS[0]);
      return;
    }
    const room = gameName();
    if (!room) {
      netStatus(netMode === 'create' ? 'Give the game a name first.'
        : 'Type the name of the game to join.', 'bad');
      if (nameBox) nameBox.focus();
      return;
    }
    starting = true;
    startBtn.disabled = true;
    netStatus(netMode === 'create' ? `Creating "${room}"...` : `Joining "${room}"...`);
    try {
      await session.connect({
        room,
        create: netMode === 'create',
        map: chosenMap(),
        conditions: chosenConditions(),
      });
    } catch (err) {
      netStatus(err.message, 'bad');
      starting = false;
      startBtn.disabled = false;
      return;
    }
    netStatus('In. Starting...', 'good');
    // The host plays the map it just picked; a joiner plays the host's,
    // whatever it is, which is why the join screen never showed one.
    const map = netMode === 'create'
      ? (mapById(chosenMap()) || MAPS[0])
      : (mapById(session.map) || MAPS[0]);
    hideMenu();
    onPick(map);
  };

  startBtn.onclick = start;
  if (nameBox) {
    nameBox.onkeydown = (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      start();
    };
  }
  setMode('single');
}

function buildConditions() {
  const holder = document.getElementById('conditions');
  if (!holder) return;
  holder.innerHTML = '';
  const cond = chosenConditions();
  const seg = (key, options) => {
    const wrap = document.createElement('div');
    wrap.className = 'seg';
    const buttons = options.map(([label, value]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.addEventListener('click', () => {
        cond[key] = value;
        setConditions(cond);
        for (const x of buttons) x.classList.toggle('on', x === b);
      });
      b.classList.toggle('on', cond[key] === value);
      wrap.appendChild(b);
      return b;
    });
    holder.appendChild(wrap);
  };
  seg('night', [['DAY', false], ['NIGHT', true]]);
  seg('rain', [['DRY', false], ['RAIN', true]]);
}

/** The best five runs so far, if there are any. */
function buildBestScores() {
  const wrap = document.getElementById('bestwrap');
  const holder = document.getElementById('bestscores');
  if (!wrap || !holder) return;
  const list = bestScores().slice(0, 5);
  wrap.hidden = !list.length;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  holder.innerHTML = list.map((r, i) => {
    const mins = Math.floor((r.seconds || 0) / 60), secs = String((r.seconds || 0) % 60).padStart(2, '0');
    return `<span class="rank">${i + 1}</span><b>${Number(r.score).toLocaleString()}</b>`
      + `<span>${esc(r.car || '')} · ${esc(r.map || '')}</span><span>${mins}:${secs} · ${'★'.repeat(r.peak || 0)}</span>`;
  }).join('');
}

/**
 * Which voice says each speaker's lines.
 *
 * The radio speaks with the browser's own voices, and which ones there are is
 * down to the machine and the browser: Windows has one British man, George,
 * who is noticeably quieter than the women and hard to make out under an
 * engine. Nothing in the game can make a speech voice louder, so the fix that
 * always works is a different voice -- and only the player can hear which one
 * suits them. Choosing one plays a sample; the choice is remembered.
 */
let voicesListening = false;
function buildVoicePicker() {
  const holder = document.getElementById('voices');
  const sub = document.getElementById('voicesub');
  const hint = document.getElementById('voicehint');
  const speech = window.speechSynthesis;
  if (!holder || !speech) return;

  const short = (v) => (v ? v.name
    .replace(/^(Microsoft|Google)\s+/, '')
    .replace(/\s+Online\s+\(Natural\)/i, ' (natural)')
    .replace(/\s+-\s+English\s+\((.+?)\)\s*$/, (m, where) => ` · ${where
      .replace('United Kingdom', 'UK').replace('United States', 'US')}`) : 'none');

  const render = () => {
    const all = speech.getVoices();
    const list = englishVoices(all);
    const shown = list.length > 0;
    holder.hidden = sub.hidden = hint.hidden = !shown;
    if (!shown) return;

    const auto = pickVoices(all, {});
    const chosen = voiceChoices();
    holder.innerHTML = '';
    for (const who of Object.keys(SPEAKER_NAMES)) {
      const card = document.createElement('div');
      card.className = 'voice';
      const id = `voice-${who}`;
      card.innerHTML = `<label for="${id}">${SPEAKER_NAMES[who].toUpperCase()}</label>`
        + `<div class="row"><select id="${id}"></select>`
        + `<button type="button" title="Hear it">&#9654;</button></div>`;
      const select = card.querySelector('select');
      select.add(new Option(`Auto: ${short(auto[who])}`, ''));
      for (const v of list) select.add(new Option(short(v), v.name, false, chosen[who] === v.name));
      const current = () => (pickVoices(speech.getVoices()) || {})[who];
      select.addEventListener('change', () => {
        setVoiceChoice(who, select.value);
        speakSample(who, current());
      });
      card.querySelector('button').addEventListener('click', () => speakSample(who, current()));
      holder.appendChild(card);
    }

    // Where more voices come from, when this browser has so few.
    const windows = /Windows/.test(navigator.userAgent);
    const edge = /Edg\//.test(navigator.userAgent);
    hint.textContent = !windows ? 'Pick a voice to hear it.'
      : `Pick a voice to hear it. More voices: Windows Settings › Time & language › Speech › Add voices${
        edge ? '.' : ', or play in Microsoft Edge, which has clearer natural voices.'}`;
  };

  render();
  if (!voicesListening) {
    voicesListening = true;
    // Most browsers fill the list in a moment after the page asks for it.
    speech.addEventListener('voiceschanged', render);
  }
}

/**
 * A side view of the car, drawn in the same flat schematic style as the map
 * thumbnails. Profiles are polylines in a 0..1 box (x forward, y up) so the
 * two shapes are easy to compare by eye.
 */
function drawCarProfile(canvas, car) {
  const ctx = base(canvas);
  const W = canvas.width, H = canvas.height;
  const ground = H - 26;
  const len = W * 0.74, x0 = (W - len) * 0.5;
  const px = (u) => x0 + u * len;
  const py = (v, tall) => ground - v * tall;

  // [u, v] outline from the rear bumper, over the roof, to the nose and back
  // along the sills. `glass` is the side window run.
  const shapes = {
    saloon: {
      tall: 118,
      body: [[0.00, 0.20], [0.00, 0.50], [0.04, 0.58], [0.22, 0.60], [0.34, 0.92],
        [0.40, 1.00], [0.62, 1.00], [0.72, 0.66], [0.96, 0.56], [1.00, 0.44],
        [1.00, 0.20], [0.86, 0.14], [0.14, 0.14]],
      glass: [[0.27, 0.64], [0.36, 0.90], [0.41, 0.95], [0.61, 0.95], [0.69, 0.65]],
      wheels: [0.20, 0.79], r: 0.19,
    },
    // Not a flat-decked eighties wedge: the roof is the high point, the
    // engine cover falls away behind it to a raised tail, and the nose is the
    // lowest part of the car.
    wedge: {
      tall: 96,
      body: [[0.00, 0.30], [0.00, 0.62], [0.05, 0.66], [0.30, 0.78], [0.42, 0.97],
        [0.47, 1.00], [0.60, 1.00], [0.73, 0.76], [0.90, 0.58], [0.985, 0.46],
        [1.00, 0.34], [1.00, 0.18], [0.86, 0.12], [0.14, 0.12]],
      glass: [[0.40, 0.80], [0.46, 0.95], [0.60, 0.95], [0.70, 0.76]],
      intake: [[0.29, 0.52], [0.37, 0.64], [0.37, 0.40], [0.31, 0.36]],
      wheels: [0.21, 0.80], r: 0.22,
    },
    // Square-rigged: an upright screen, a flat roof the full length of the
    // body, a short bonnet, and big wheels standing well clear of the ground.
    // A police estate: the boxy body without the ladder-frame spare on the
    // back door, sitting a little lower on smaller wheels.
    suv: {
      tall: 116,
      body: [[0.00, 0.26], [0.00, 0.93], [0.03, 0.97], [0.62, 0.97], [0.70, 0.62],
        [0.97, 0.60], [1.00, 0.54], [1.00, 0.26], [0.86, 0.20], [0.14, 0.20]],
      glass: [[0.06, 0.66], [0.06, 0.91], [0.60, 0.91], [0.67, 0.66]],
      roof: [[0.03, 0.97], [0.62, 0.97], [0.63, 0.935], [0.03, 0.935]],
      wheels: [0.19, 0.79], r: 0.22,
    },
    boxy: {
      tall: 124,
      body: [[0.00, 0.26], [0.00, 0.95], [0.02, 0.99], [0.66, 0.99], [0.69, 0.96],
        [0.72, 0.64], [0.98, 0.62], [1.00, 0.56], [1.00, 0.26], [0.86, 0.20], [0.14, 0.20]],
      glass: [[0.05, 0.68], [0.05, 0.93], [0.64, 0.93], [0.68, 0.68]],
      roof: [[0.02, 0.99], [0.66, 0.99], [0.67, 0.955], [0.02, 0.955]],
      spare: [-0.015, 0.60],
      wheels: [0.19, 0.81], r: 0.25,
    },
  };
  const s = shapes[car.shape];

  // Ground shadow.
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.beginPath();
  ctx.ellipse(W * 0.5, ground + 4, len * 0.52, 7, 0, 0, TAU);
  ctx.fill();

  ctx.fillStyle = car.colour;
  ctx.beginPath();
  s.body.forEach(([u, v], i) => (i ? ctx.lineTo(px(u), py(v, s.tall)) : ctx.moveTo(px(u), py(v, s.tall))));
  ctx.closePath();
  ctx.fill();

  // A highlight along the shoulder, so the shape reads as a body and not a
  // cut-out.
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  s.body.slice(1, 4).forEach(([u, v], i) => (i ? ctx.lineTo(px(u), py(v, s.tall) + 3) : ctx.moveTo(px(u), py(v, s.tall) + 3)));
  ctx.stroke();

  if (s.roof && car.roof) {
    ctx.fillStyle = car.roof;
    ctx.beginPath();
    s.roof.forEach(([u, v], i) => (i ? ctx.lineTo(px(u), py(v, s.tall)) : ctx.moveTo(px(u), py(v, s.tall))));
    ctx.closePath();
    ctx.fill();
  }
  if (s.spare) {
    ctx.fillStyle = '#07090c';
    ctx.beginPath();
    ctx.arc(px(s.spare[0]), py(s.spare[1], s.tall), s.r * s.tall * 0.8, -Math.PI / 2, Math.PI / 2, true);
    ctx.fill();
  }

  ctx.fillStyle = '#0c1118';
  for (const poly of [s.glass, s.intake]) {
    if (!poly) continue;
    ctx.beginPath();
    poly.forEach(([u, v], i) => (i ? ctx.lineTo(px(u), py(v, s.tall)) : ctx.moveTo(px(u), py(v, s.tall))));
    ctx.closePath();
    ctx.fill();
  }

  for (const u of s.wheels) {
    const r = s.r * s.tall;
    ctx.fillStyle = '#07090c';
    ctx.beginPath(); ctx.arc(px(u), ground - r + 2, r + 5, 0, TAU); ctx.fill();
    ctx.fillStyle = '#5c646e';
    ctx.beginPath(); ctx.arc(px(u), ground - r + 2, r * 0.58, 0, TAU); ctx.fill();
  }
}

function base(canvas) {
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#0d1116';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  return ctx;
}

function drawCity(canvas) {
  const ctx = base(canvas);
  const W = canvas.width, H = canvas.height;
  const cx = W / 2, cy = H / 2;

  // street grid
  ctx.strokeStyle = '#2f353d';
  ctx.lineWidth = 2;
  for (let i = -5; i <= 5; i++) {
    const x = cx + i * 26, y = cy + i * 26;
    ctx.beginPath(); ctx.moveTo(x, cy - 132); ctx.lineTo(x, cy + 132); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx - 132, y); ctx.lineTo(cx + 132, y); ctx.stroke();
  }
  // avenues
  ctx.strokeStyle = '#3b444f';
  ctx.lineWidth = 4;
  ctx.beginPath(); ctx.moveTo(cx, cy - 132); ctx.lineTo(cx, cy + 132); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(cx - 132, cy); ctx.lineTo(cx + 132, cy); ctx.stroke();

  // ring motorway
  ctx.strokeStyle = '#4a5766';
  ctx.lineWidth = 6;
  ctx.beginPath();
  const r = 40, x0 = cx - 160, y0 = cy - 118, w = 320, h = 236;
  ctx.moveTo(x0 + r, y0);
  ctx.arcTo(x0 + w, y0, x0 + w, y0 + h, r);
  ctx.arcTo(x0 + w, y0 + h, x0, y0 + h, r);
  ctx.arcTo(x0, y0 + h, x0, y0, r);
  ctx.arcTo(x0, y0, x0 + w, y0, r);
  ctx.closePath();
  ctx.stroke();
}

function drawTown(canvas) {
  const ctx = base(canvas);
  const W = canvas.width, H = canvas.height;
  const cx = W / 2, cy = H / 2;
  const rng = makeRng(99);

  // concentric ring lanes, deliberately wobbly
  const radii = [26, 54, 86, 120];
  ctx.strokeStyle = '#2f353d';
  for (let ri = 0; ri < radii.length; ri++) {
    ctx.lineWidth = ri === 0 ? 2 : 2.5;
    ctx.beginPath();
    for (let k = 0; k <= 48; k++) {
      const a = (k / 48) * TAU;
      const rr = radii[ri] * (1 + Math.sin(a * 3 + ri) * 0.07 + Math.cos(a * 5 - ri) * 0.05);
      const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr * 0.86;
      if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  // radial A-roads, wandering
  ctx.strokeStyle = '#3b444f';
  ctx.lineWidth = 3.5;
  const angles = [];
  for (let i = 0; i < 6; i++) angles.push((i / 6) * TAU + (rng() - 0.5) * 0.5);
  for (const a0 of angles) {
    ctx.beginPath();
    let a = a0;
    ctx.moveTo(cx + Math.cos(a) * 20, cy + Math.sin(a) * 20 * 0.86);
    for (let r = 20; r < 190; r += 22) {
      a += (rng() - 0.5) * 0.20;
      ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r * 0.86);
    }
    ctx.stroke();
  }

  // bypass round one side
  ctx.strokeStyle = '#4a5766';
  ctx.lineWidth = 6;
  ctx.beginPath();
  for (let k = 0; k <= 40; k++) {
    const a = -0.7 + (k / 40) * 3.1;
    const rr = 150 + Math.sin(a * 2) * 8;
    const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr * 0.86;
    if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // roundabouts where they meet
  ctx.strokeStyle = '#6d7178';
  ctx.lineWidth = 3;
  for (const a of [-0.4, 0.55, 1.6, 2.4]) {
    const rr = 150 + Math.sin(a * 2) * 8;
    ctx.beginPath();
    ctx.arc(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr * 0.86, 7, 0, TAU);
    ctx.stroke();
  }

  // market square
  ctx.fillStyle = '#3a4048';
  ctx.beginPath();
  ctx.arc(cx, cy, 11, 0, TAU);
  ctx.fill();
}
