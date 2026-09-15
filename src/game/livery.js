// Police livery, drawn to a canvas at runtime.
//
// There are no image files in this project, so the markings are generated on a
// 2D canvas the first time a police car is built and uploaded once as a single
// texture. That keeps the download at zero and means the livery is tunable in
// code rather than in an art package.
//
// The atlas holds five panels, laid out top to bottom:
//
//   flank    battenburg checks with POLICE over them, for a single door
//   bonnet   POLICE reversed, so it reads correctly in the mirror of the car
//            in front -- which is the whole reason real forces do it
//   rear     red and yellow chevrons for the tailgate
//   roof     a large unit number, so units are tellable apart from above
//   batten   the full-length band: checks nose to tail, POLICE in the middle
//
// Drawn at 1024 across. At 512 the wordmark on a band stretched down the whole
// side of a van was a smudge.

import * as THREE from 'three';

const ATLAS = 1024;
/** Everything was first laid out on a 512 canvas; sizes are scaled from that. */
const S = ATLAS / 512;

/**
 * UV rectangles into the atlas, as [u0, v0, u1, v1].
 * Canvas y runs downward and UV v runs upward, hence the subtraction.
 */
const band = (top, height) => [0, 1 - (top + height) / ATLAS, 1, 1 - top / ATLAS];
export const DECAL = {
  flank: band(0, 256),
  bonnet: band(256, 192),
  rear: band(448, 256),
  roof: band(704, 256),
  batten: band(960, 64),
};

let cached = null;

export function policeTexture() {
  if (cached) return cached;

  const c = document.createElement('canvas');
  c.width = c.height = ATLAS;
  const ctx = c.getContext('2d');

  ctx.fillStyle = '#e9edf2';
  ctx.fillRect(0, 0, ATLAS, ATLAS);

  drawFlank(ctx, 0, 256);
  drawBonnet(ctx, 256, 192);
  drawRear(ctx, 448, 256);
  drawRoof(ctx, 704, 256);
  drawBatten(ctx, 960, 64);

  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 8;
  tex.colorSpace = THREE.SRGBColorSpace;
  cached = tex;
  return tex;
}

const BLUE = '#0b3ea8';
const YELLOW = '#d7e63c';

/** Battenburg: two rows of offset blue and yellow blocks, with POLICE over. */
function drawFlank(ctx, top, h) {
  const cols = 10;
  const cw = ATLAS / cols;
  const rh = h / 2;

  ctx.fillStyle = YELLOW;
  ctx.fillRect(0, top, ATLAS, h);
  ctx.fillStyle = BLUE;
  for (let r = 0; r < 2; r++) {
    for (let i = 0; i < cols; i++) {
      if ((i + r) % 2 === 0) continue;
      ctx.fillRect(i * cw, top + r * rh, cw, rh);
    }
  }

  // Wordmark, outlined so it survives against either check colour.
  ctx.font = `700 ${74 * S}px "Arial Narrow", Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 9 * S;
  ctx.strokeStyle = 'rgba(10,14,20,0.85)';
  ctx.strokeText('POLICE', ATLAS / 2, top + h / 2);
  ctx.fillStyle = '#ffffff';
  ctx.fillText('POLICE', ATLAS / 2, top + h / 2);
}

/** Reversed wordmark for the bonnet. */
function drawBonnet(ctx, top, h) {
  ctx.fillStyle = '#e9edf2';
  ctx.fillRect(0, top, ATLAS, h);

  ctx.save();
  ctx.translate(ATLAS, 0);
  ctx.scale(-1, 1);                       // mirrored, to read in a wing mirror
  ctx.font = `700 ${78 * S}px "Arial Narrow", Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 8 * S;
  ctx.strokeStyle = '#ffffff';
  ctx.strokeText('POLICE', ATLAS / 2, top + h / 2);
  ctx.fillStyle = BLUE;
  ctx.fillText('POLICE', ATLAS / 2, top + h / 2);
  ctx.restore();
}

/** Rear chevrons: the high-visibility wedge every response car carries. */
function drawRear(ctx, top, h) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, top, ATLAS, h);
  ctx.clip();

  ctx.fillStyle = YELLOW;
  ctx.fillRect(0, top, ATLAS, h);

  ctx.fillStyle = '#c62914';
  const w = 54 * S;
  for (let x = -ATLAS; x < ATLAS * 2; x += w * 2) {
    ctx.beginPath();
    ctx.moveTo(x, top + h);
    ctx.lineTo(x + w, top + h);
    ctx.lineTo(x + w + ATLAS / 2, top);
    ctx.lineTo(x + ATLAS / 2, top);
    ctx.closePath();
    ctx.fill();
    // Mirror the wedge so the chevrons meet in the middle.
    ctx.beginPath();
    ctx.moveTo(ATLAS - x, top + h);
    ctx.lineTo(ATLAS - (x + w), top + h);
    ctx.lineTo(ATLAS - (x + w + ATLAS / 2), top);
    ctx.lineTo(ATLAS - (x + ATLAS / 2), top);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

/** Roof: a unit number, readable from a helicopter or a chase camera. */
function drawRoof(ctx, top, h) {
  ctx.fillStyle = '#e9edf2';
  ctx.fillRect(0, top, ATLAS, h);
  ctx.fillStyle = BLUE;
  ctx.fillRect(0, top, ATLAS, 14 * S);
  ctx.fillRect(0, top + h - 14 * S, ATLAS, 14 * S);

  ctx.font = `700 ${96 * S}px Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#16203a';
  ctx.fillText('PL 24', ATLAS / 2, top + h / 2);
}

/**
 * The full-length band. Stretched down the whole side of a car, so the checks
 * are narrow in the texture -- 26 across -- to come out a little longer than
 * they are tall on the bodywork, which is how the real pattern is proportioned.
 * The wordmark sits in the middle, where the doors are, on a white plate so it
 * reads at any distance.
 */
function drawBatten(ctx, top, h) {
  const cols = 26;
  const cw = ATLAS / cols;
  const rh = h / 2;
  ctx.fillStyle = YELLOW;
  ctx.fillRect(0, top, ATLAS, h);
  ctx.fillStyle = BLUE;
  for (let r = 0; r < 2; r++) {
    for (let i = 0; i < cols; i++) {
      if ((i + r) % 2 === 0) continue;
      ctx.fillRect(i * cw, top + r * rh, cw + 0.5, rh);
    }
  }
  const pw = cw * 6;
  ctx.fillStyle = '#f4f6f8';
  ctx.fillRect(ATLAS / 2 - pw / 2, top + 3, pw, h - 6);
  ctx.fillStyle = BLUE;
  ctx.fillRect(ATLAS / 2 - pw / 2, top + 3, pw, 5);
  ctx.fillRect(ATLAS / 2 - pw / 2, top + h - 8, pw, 5);
  ctx.font = `800 ${Math.round(h * 0.62)}px "Arial Narrow", Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = BLUE;
  // Slightly narrowed: a band this long is stretched along the car a little.
  ctx.save();
  ctx.translate(ATLAS / 2, top + h / 2 + 1);
  ctx.scale(0.9, 1);
  ctx.fillText('POLICE', 0, 0);
  ctx.restore();
}
