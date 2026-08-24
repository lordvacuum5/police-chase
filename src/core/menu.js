// Main menu: pick a map before anything heavy is built.
//
// The thumbnails are schematics drawn with 2D canvas rather than renders of the
// real map -- generating a map costs a second or so, and the whole point of the
// menu is to appear instantly.

import { MAPS } from '../world/maps.js';
import { makeRng, TAU } from '../util/math.js';

export function showMenu(onPick) {
  const menu = document.getElementById('menu');
  const holder = document.getElementById('maps');
  holder.innerHTML = '';
  menu.classList.remove('gone');

  for (const m of MAPS) {
    const card = document.createElement('div');
    card.className = 'mapcard';
    card.tabIndex = 0;

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

    const pick = () => { menu.classList.add('gone'); onPick(m); };
    card.addEventListener('click', pick);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); }
    });
    holder.appendChild(card);
  }
}

export function hideMenu() {
  document.getElementById('menu').classList.add('gone');
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
