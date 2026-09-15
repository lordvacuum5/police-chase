// Bodywork for the taller vehicles: the police SUV, the armoured van, and the
// Badger, a 4x4 you can drive.
//
// Built the way the Stiletto is (see buildSupercarGeometry): lofted cross
// sections for the body, with the arches cut as real curves round the hubs,
// a second loft for the glasshouse, and boxes for the details. Every height
// here is measured above the ground and converted to body space, because that
// is how a vehicle's proportions are actually described -- and a 4x4 on long
// springs sits a very different distance above its centre of mass than a
// saloon does.
//
// The police kit -- light bar, battenburg, chevrons, push bar, strobes -- is
// one function shared by all of them, laid out from a few measurements of the
// body it is going on.

import * as THREE from 'three';
import { MeshBuilder, buildGrouped } from '../util/meshbuild.js';
import { DECAL } from './livery.js';

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);

/** Where the ground is, in body space, with the vehicle settled on its springs. */
function groundOf(spec) {
  const sus = spec.suspension;
  const sag = (spec.mass * 9.81 * 0.25) / sus.stiffness;
  const hub = sus.mountY - (sus.rest - sag);
  const G = -(hub - spec.wheelRadius);
  return (h) => h - G;
}

/** A box turned about X (pitch) as well as Y, for raked glass and grilles. */
function addPitchedBox(b, w, h, d, x, y, z, color, pitch, yaw = 0) {
  const geo = new THREE.BoxGeometry(w, h, d);
  _e.set(pitch, yaw, 0, 'YXZ');
  _q.setFromEuler(_e);
  _p.set(x, y, z);
  _m.compose(_p, _q, _s);
  b.addGeometry(geo, _m, color);
  geo.dispose();
}

/** A cylinder along X, for wheels on the tailgate and round lamps facing forward. */
function addCylinder(b, r, len, x, y, z, color, axis = 'z', segments = 12) {
  const geo = new THREE.CylinderGeometry(r, r, len, segments, 1);
  _e.set(axis === 'z' ? Math.PI / 2 : 0, 0, axis === 'x' ? Math.PI / 2 : 0);
  _q.setFromEuler(_e);
  _p.set(x, y, z);
  _m.compose(_p, _q, _s);
  b.addGeometry(geo, _m, color);
  geo.dispose();
}

/**
 * A lofted body with round wheel arches. `keys` are stations along the car,
 * nose to tail in any order, each { z, ys, sill, xs, sh, xd, dk, crown } in
 * metres above the ground and out from the centreline: underside, sill,
 * flank half-width, shoulder, deck half-width, deck height.
 */
function loftBody(b, spec, y, keys, zf, zr, colour) {
  keys = keys.slice().sort((p, q) => p.z - q.z);
  const R = spec.wheelRadius + 0.07;
  const hubH = spec.wheelRadius;
  const sec = (z, h) => ({
    z,
    pts: [
      [0, y(h.ys)], [h.xs - 0.05, y(h.ys)], [h.xs, y(h.sill)], [h.xs, y(h.sh)],
      [h.xd, y(h.dk)], [0, y(h.dk + (h.crown || 0))],
    ],
  });
  const at = (z) => {
    let i = 0;
    while (i < keys.length - 2 && keys[i + 1].z < z) i++;
    const k0 = keys[i], k1 = keys[i + 1];
    const u = Math.min(1, Math.max(0, (z - k0.z) / (k1.z - k0.z)));
    const o = {};
    for (const f of ['ys', 'sill', 'xs', 'sh', 'xd', 'dk', 'crown']) o[f] = (k0[f] || 0) + ((k1[f] || 0) - (k0[f] || 0)) * u;
    return o;
  };
  const eps = 0.002;
  const sections = [];
  const inArch = (z) => Math.abs(z - zf) < R + 0.01 || Math.abs(z - zr) < R + 0.01;
  for (const k of keys) if (!inArch(k.z)) sections.push(sec(k.z, k));
  for (const zc of [zf, zr]) {
    sections.push(sec(zc - R - eps, at(zc - R - eps)));
    sections.push(sec(zc + R + eps, at(zc + R + eps)));
    for (const f of [-1, -0.92, -0.75, -0.45, 0, 0.45, 0.75, 0.92, 1]) {
      const dz = f * R, z = zc + dz;
      const h = at(z);
      h.ys = Math.max(h.ys, hubH + Math.sqrt(Math.max(0, R * R - dz * dz)));
      h.sill = Math.max(h.sill, h.ys + 0.01);
      h.sh = Math.max(h.sh, h.sill + 0.03);
      sections.push(sec(z, h));
    }
  }
  b.addLoft(sections, colour);
  // Arch liners, so you cannot see through the car beside each wheel.
  for (const zc of [zf, zr]) {
    const top = hubH + R - 0.01, bot = Math.min(...keys.map((k) => k.ys)) + 0.02;
    const xw = Math.min(...keys.map((k) => k.xs)) * 2 - 0.5;
    b.addBox(xw, y(top) - y(bot), R * 2, 0, (y(top) + y(bot)) * 0.5, zc, 0x08090b);
  }
  return at;
}

/** A glasshouse loft: { z, xb, hb, xt, ht, crown } stations. */
function loftCabin(b, y, stations, colour) {
  b.addLoft(stations.map((s) => ({
    z: s.z,
    pts: [[0, y(s.hb)], [s.xb, y(s.hb)], [s.xt, y(s.ht)], [0, y(s.ht + (s.crown || 0))]],
  })), colour);
}

// =================================================================== police

/**
 * Light bar, battenburg, chevrons, roof number, push bar and strobes.
 *
 * `k` describes the body it is going on, in body space:
 *   flankX         outer face of the flanks
 *   band           { y0, y1, z0, z1 } the battenburg band, tail to nose
 *   roof           { y, z, halfW } top of the roof where the bar sits
 *   roofId         { z0, z1 } where the unit number goes, or null
 *   bonnet         { y0, y1, z0, z1, halfW } for the reversed wordmark, or null
 *   rear           { z, y0, y1, halfW } the chevron panel
 *   nose           { z, y, halfW } for the push bar and grille strobes
 *   barW           light bar length
 * Returns the flasher positions for LightBars, which follow the bar.
 */
export function addPoliceKit(b, decals, k, trim) {
  const { roof } = k;
  const barW = k.barW || 1.4;
  const by = roof.y;
  // The bar: two feet, a tapered base, a dark body and a row of lens modules,
  // with clear end caps where the flashers sit.
  b.addBox(0.12, 0.04, 0.2, +barW * 0.34, by + 0.02, roof.z, trim);
  b.addBox(0.12, 0.04, 0.2, -barW * 0.34, by + 0.02, roof.z, trim);
  b.addTaperedBox(barW, 0.05, 0.3, 0, by + 0.065, roof.z, trim, 0.94, 0.86);
  b.addBox(barW - 0.12, 0.10, 0.24, 0, by + 0.135, roof.z, 0x0e1218);
  const mods = 7;
  for (let i = 0; i < mods; i++) {
    const t = (i + 0.5) / mods - 0.5;
    const col = i < 3 ? 0x2a4fb8 : i > 3 ? 0xb8302a : 0xdfe4ea;
    b.addBox((barW - 0.3) / mods - 0.02, 0.07, 0.25, t * (barW - 0.3), by + 0.14, roof.z, col);
  }
  for (const s of [1, -1]) b.addBox(0.12, 0.12, 0.26, s * (barW * 0.5 - 0.06), by + 0.135, roof.z, 0xe8edf3);

  // Battenburg the length of the car. u runs toward the tail on the left
  // flank and toward the nose on the right, so POLICE reads forwards on both.
  const { band } = k;
  const sx = k.flankX + 0.014;
  decals.addDecalQuad([
    { x: sx, y: band.y0, z: band.z1 }, { x: sx, y: band.y0, z: band.z0 },
    { x: sx, y: band.y1, z: band.z0 }, { x: sx, y: band.y1, z: band.z1 },
  ], { x: 1, y: 0, z: 0 }, DECAL.batten);
  decals.addDecalQuad([
    { x: -sx, y: band.y0, z: band.z0 }, { x: -sx, y: band.y0, z: band.z1 },
    { x: -sx, y: band.y1, z: band.z1 }, { x: -sx, y: band.y1, z: band.z0 },
  ], { x: -1, y: 0, z: 0 }, DECAL.batten);

  if (k.bonnet) {
    const bn = k.bonnet;
    decals.addDecalQuad([
      { x: -bn.halfW, y: bn.y0, z: bn.z0 }, { x: bn.halfW, y: bn.y0, z: bn.z0 },
      { x: bn.halfW, y: bn.y1, z: bn.z1 }, { x: -bn.halfW, y: bn.y1, z: bn.z1 },
    ], { x: 0, y: 1, z: 0.3 }, DECAL.bonnet);
  }
  if (k.roofId) {
    const ry = by + 0.004;
    decals.addDecalQuad([
      { x: -roof.halfW, y: ry, z: k.roofId.z0 }, { x: roof.halfW, y: ry, z: k.roofId.z0 },
      { x: roof.halfW, y: ry, z: k.roofId.z1 }, { x: -roof.halfW, y: ry, z: k.roofId.z1 },
    ], { x: 0, y: 1, z: 0 }, DECAL.roof);
  }
  const r = k.rear;
  decals.addDecalQuad([
    { x: r.halfW, y: r.y0, z: r.z }, { x: -r.halfW, y: r.y0, z: r.z },
    { x: -r.halfW, y: r.y1, z: r.z }, { x: r.halfW, y: r.y1, z: r.z },
  ], { x: 0, y: 0, z: -1 }, DECAL.rear);

  // Push bar and grille strobes.
  const n = k.nose;
  b.addBox(n.halfW * 1.5, 0.08, 0.08, 0, n.y + 0.12, n.z + 0.12, trim);
  b.addBox(n.halfW * 1.5, 0.07, 0.08, 0, n.y - 0.16, n.z + 0.12, trim);
  for (const px of [-0.55, 0.55]) b.addBox(0.07, 0.36, 0.07, px * n.halfW, n.y - 0.02, n.z + 0.12, trim);
  b.addBox(0.24, 0.06, 0.05, +n.halfW * 0.28, n.y + 0.02, n.z + 0.01, 0x2f7dff);
  b.addBox(0.24, 0.06, 0.05, -n.halfW * 0.28, n.y + 0.02, n.z + 0.01, 0xff2418);

  return [
    new THREE.Vector3(+(barW * 0.5 - 0.06), by + 0.14, roof.z),
    new THREE.Vector3(-(barW * 0.5 - 0.06), by + 0.14, roof.z),
  ];
}

// ====================================================================== SUV

/**
 * Police SUV: a big, square-shouldered modern 4x4 in full battenburg. Tall
 * enough that the band runs along the doors above the wheel arches, the way it
 * does on the real thing.
 */
export function buildSuvGeometry(spec, livery, opts = {}) {
  const b = new MeshBuilder();
  const decals = new MeshBuilder();
  const { body, accent, glass, trim } = livery;
  const y = groundOf(spec);
  const zf = spec.wheelbase * (1 - spec.frontWeight);
  const zr = -spec.wheelbase * spec.frontWeight;
  const hw = spec.dims.w * 0.5;
  const nose = zf + 0.98, tail = zr - 1.0;
  const X = (f) => f * hw;

  const keys = [
    { z: nose,        ys: 0.36, sill: 0.44, xs: X(0.88), sh: 0.96, xd: X(0.80), dk: 1.00 },
    { z: nose - 0.10, ys: 0.32, sill: 0.40, xs: X(0.96), sh: 1.02, xd: X(0.87), dk: 1.05, crown: 0.01 },
    { z: nose - 0.30, ys: 0.30, sill: 0.38, xs: X(0.99), sh: 1.07, xd: X(0.88), dk: 1.08, crown: 0.02 },
    { z: zf,          ys: 0.30, sill: 0.38, xs: X(1.00), sh: 1.11, xd: X(0.89), dk: 1.12, crown: 0.02 },
    { z: 0,           ys: 0.28, sill: 0.36, xs: X(0.99), sh: 1.14, xd: X(0.87), dk: 1.15, crown: 0.02 },
    { z: zr,          ys: 0.30, sill: 0.38, xs: X(1.00), sh: 1.15, xd: X(0.88), dk: 1.16, crown: 0.02 },
    { z: tail + 0.12, ys: 0.38, sill: 0.48, xs: X(0.97), sh: 1.14, xd: X(0.88), dk: 1.15, crown: 0.02 },
    { z: tail,        ys: 0.44, sill: 0.52, xs: X(0.93), sh: 1.10, xd: X(0.86), dk: 1.12 },
  ];
  loftBody(b, spec, y, keys, zf, zr, (edge) => (edge === 0 ? 0x0a0b0d : body));

  // Glasshouse: a fast screen, a long flat roof, and an upright tailgate.
  const scr = zf - 0.10;
  loftCabin(b, y, [
    { z: scr,         xb: X(0.87), hb: 1.12, xt: X(0.85), ht: 1.13 },
    { z: zf - 0.95,   xb: X(0.88), hb: 1.14, xt: X(0.77), ht: 1.69, crown: 0.02 },
    { z: zr - 0.20,   xb: X(0.88), hb: 1.15, xt: X(0.78), ht: 1.71, crown: 0.02 },
    { z: tail + 0.22, xb: X(0.87), hb: 1.15, xt: X(0.80), ht: 1.66, crown: 0.01 },
    { z: tail + 0.08, xb: X(0.86), hb: 1.13, xt: X(0.84), ht: 1.15 },
  ], (edge, run) => {
    if (edge <= 0) return body;
    if (edge === 1) return run === 3 ? body : glass;
    return run === 0 || run === 3 ? glass : body;
  });
  // Pillars, so it reads as windows rather than one black band.
  for (const s of [1, -1]) {
    for (const [pz, pw] of [[zf - 1.40, 0.12], [zr + 0.30, 0.16]]) {
      b.addBox(0.06, y(1.65) - y(1.16), pw, s * X(0.845), (y(1.65) + y(1.16)) * 0.5, pz, body);
    }
    // Roof rails.
    b.addBox(0.06, 0.05, (zf - 1.0) - (tail + 0.35), s * X(0.66), y(1.745), ((zf - 1.0) + (tail + 0.35)) * 0.5, 0xaab1b9);
    // Chunky plastic arch trims and a lower cladding band.
    for (const zc of [zf, zr]) {
      b.addTaperedBox(0.07, 0.10, (spec.wheelRadius + 0.07) * 2.1, s * (X(1.0) + 0.02), y(0.84), zc, trim, 1, 0.8);
    }
    b.addBox(0.05, 0.12, (zf - zr) - 1.0, s * (X(0.99) + 0.015), y(0.42), (zf + zr) * 0.5, trim);
    // Mirrors.
    b.addBox(0.10, 0.05, 0.05, s * (X(0.9) + 0.06), y(1.18), scr - 0.25, trim);
    b.addTaperedBox(0.20, 0.13, 0.12, s * (X(0.9) + 0.16), y(1.23), scr - 0.28, accent, 0.9, 0.85);
    // Headlamps, swept into the wings, and tail lamps up the corners.
    b.addBox(0.52, 0.18, 0.05, s * X(0.60), y(0.90), nose + 0.004, 0x0b0d10);
    b.addBox(0.44, 0.09, 0.05, s * X(0.60), y(0.92), nose + 0.012, 0xf2f6fb);
    b.addBox(0.44, 0.025, 0.05, s * X(0.60), y(0.86), nose + 0.012, 0x8ec8ff);
    b.addBox(0.10, 0.30, 0.06, s * X(0.84), y(0.92), tail - 0.005, 0xc0281f);
  }
  // Grille, bumper, skid plate; rear bumper and tailgate handle.
  b.addBox(X(0.62), 0.30, 0.06, 0, y(0.80), nose + 0.004, 0x07090c);
  b.addBox(X(1.6), 0.14, 0.12, 0, y(0.50), nose - 0.02, trim);
  b.addTaperedBox(X(1.1), 0.05, 0.40, 0, y(0.34), nose - 0.20, 0xa4abb3, 0.9, 0.9);
  b.addBox(X(1.7), 0.16, 0.10, 0, y(0.56), tail + 0.02, trim);
  b.addBox(X(0.6), 0.05, 0.04, 0, y(0.94), tail - 0.01, 0xb9c1cb);

  let lamps = null;
  if (opts.police) {
    lamps = addPoliceKit(b, decals, {
      flankX: X(0.995),
      band: { y0: y(0.84), y1: y(1.09), z0: tail + 0.14, z1: zf + 0.30 },
      roof: { y: y(1.73), z: zf - 1.30, halfW: X(0.62) },
      roofId: { z0: zr + 0.05, z1: zr + 0.70 },
      bonnet: { y0: y(1.132), y1: y(1.112), z0: zf - 0.02, z1: zf + 0.34, halfW: 0.62 },
      rear: { z: tail - 0.012, y0: y(0.62), y1: y(1.05), halfW: X(0.70) },
      nose: { z: nose, y: y(0.62), halfW: X(0.86) },
      barW: 1.5,
    }, trim);
  }
  const geo = buildGrouped([b, decals]);
  geo.userData.lamps = lamps;
  return geo;
}

// ====================================================================== van

/**
 * The armoured van: a high-roofed panel van on heavy springs, with mesh over
 * the windscreen, barred windows, a full push bar, and battenburg down the
 * whole side.
 */
export function buildVanGeometry(spec, livery, opts = {}) {
  const b = new MeshBuilder();
  const decals = new MeshBuilder();
  const { body, accent, glass, trim } = livery;
  const y = groundOf(spec);
  const zf = spec.wheelbase * (1 - spec.frontWeight);
  const zr = -spec.wheelbase * spec.frontWeight;
  const hw = spec.dims.w * 0.5;
  const nose = zf + 0.95;
  const X = (f) => f * hw;
  const tailZ = nose - spec.dims.l;

  const keys = [
    { z: nose,        ys: 0.36, sill: 0.44, xs: X(0.88), sh: 0.82, xd: X(0.80), dk: 0.86 },
    { z: nose - 0.14, ys: 0.32, sill: 0.40, xs: X(0.97), sh: 0.98, xd: X(0.88), dk: 1.00, crown: 0.01 },
    { z: zf,          ys: 0.32, sill: 0.40, xs: X(1.00), sh: 1.12, xd: X(0.90), dk: 1.14, crown: 0.01 },
    { z: zf - 0.55,   ys: 0.30, sill: 0.38, xs: X(1.00), sh: 1.16, xd: X(0.94), dk: 1.18 },
    { z: zr,          ys: 0.32, sill: 0.40, xs: X(1.00), sh: 1.16, xd: X(0.94), dk: 1.18 },
    { z: tailZ,       ys: 0.40, sill: 0.48, xs: X(0.99), sh: 1.16, xd: X(0.94), dk: 1.18 },
  ];
  loftBody(b, spec, y, keys, zf, zr, (edge) => (edge === 0 ? 0x0a0b0d : body));

  // The box: a raked screen up to a tall flat roof, and a square back.
  const scr = zf - 0.05;
  loftCabin(b, y, [
    { z: scr,          xb: X(0.92), hb: 1.14, xt: X(0.90), ht: 1.15 },
    { z: zf - 0.80,    xb: X(0.98), hb: 1.17, xt: X(0.90), ht: 2.02, crown: 0.02 },
    { z: zf - 1.12,    xb: X(0.99), hb: 1.17, xt: X(0.94), ht: 2.28, crown: 0.03 },
    { z: zf - 1.62,    xb: X(0.99), hb: 1.17, xt: X(0.94), ht: 2.28, crown: 0.03 },
    { z: tailZ + 0.02, xb: X(0.99), hb: 1.17, xt: X(0.94), ht: 2.28, crown: 0.03 },
    { z: tailZ,        xb: X(0.99), hb: 1.17, xt: X(0.94), ht: 2.27 },
  ], (edge, run) => {
    if (edge <= 0) return body;
    // Runs count from the tail: 4 is the windscreen, 2 and 3 the cab doors.
    if (edge === 1) return run >= 2 ? glass : body;
    return run === 4 ? glass : body;
  });

  // Mesh over the windscreen: the thing that says armoured.
  const rake = Math.atan2(0.75, 0.87);
  for (let i = 0; i < 6; i++) {
    const t = (i + 0.5) / 6;
    addPitchedBox(b, X(1.72), 0.035, 0.03, 0, y(1.18 + 0.84 * t), scr - 0.02 - 0.75 * t, 0x1a1e24, -rake);
  }
  for (const s of [1, -1]) {
    // Barred windows in the load area, two a side.
    for (const wz of [zf - 1.95, zr + 0.25]) {
      b.addBox(0.03, 0.46, 1.05, s * (X(0.99) + 0.012), y(1.72), wz, 0x0d1117);
      for (let i = -2; i <= 2; i++) b.addBox(0.03, 0.46, 0.035, s * (X(0.99) + 0.03), y(1.72), wz + i * 0.2, 0xb0b6bd);
    }
    // Cab doors: bodywork over the top of the glass, which the loft cannot do.
    b.addBox(0.05, y(2.27) - y(1.94), 0.84, s * X(0.965), (y(2.27) + y(1.94)) * 0.5, zf - 1.21, body);
    // Mirrors on long arms, like a van's.
    b.addBox(0.24, 0.05, 0.05, s * (X(0.98) + 0.12), y(1.40), scr - 0.30, trim);
    b.addBox(0.08, 0.32, 0.16, s * (X(0.98) + 0.26), y(1.46), scr - 0.30, trim);
    // Side step and rubbing strip.
    b.addBox(0.12, 0.05, 1.2, s * (X(1.0) + 0.05), y(0.40), zf - 1.0, 0x2b2f35);
    b.addBox(0.04, 0.10, (zf - zr) - 1.2, s * (X(1.0) + 0.02), y(0.62), (zf + zr) * 0.5 - 0.2, trim);
    // Lamps.
    b.addTaperedBox(0.44, 0.16, 0.16, s * X(0.60), y(0.93), nose - 0.07, 0xeef3fa, 0.95, 0.6);
    b.addBox(0.12, 0.42, 0.06, s * X(0.88), y(0.90), tailZ - 0.005, 0xc0281f);
    // Rear door hinges.
    b.addBox(0.05, 0.10, 0.05, s * X(0.92), y(1.0), tailZ - 0.02, trim);
    b.addBox(0.05, 0.10, 0.05, s * X(0.92), y(1.8), tailZ - 0.02, trim);
  }
  // Split between the rear doors; grille; bumpers; roof vent.
  b.addBox(0.03, y(2.2) - y(0.55), 0.03, 0, (y(2.2) + y(0.55)) * 0.5, tailZ - 0.012, 0x14171b);
  b.addBox(X(0.9), 0.30, 0.06, 0, y(0.70), nose - 0.01, 0x07090c);
  b.addBox(X(1.9), 0.18, 0.14, 0, y(0.48), nose + 0.01, trim);
  b.addBox(X(1.9), 0.18, 0.12, 0, y(0.50), tailZ + 0.02, trim);
  b.addBox(0.9, 0.12, 0.9, 0, y(2.34), zr + 0.4, 0xc9cdd2);

  let lamps = null;
  if (opts.police) {
    lamps = addPoliceKit(b, decals, {
      flankX: X(0.995),
      band: { y0: y(0.78), y1: y(1.12), z0: tailZ + 0.10, z1: zf + 0.30 },
      roof: { y: y(2.31), z: zf - 1.45, halfW: X(0.75) },
      roofId: { z0: zr - 0.9, z1: zr - 0.1 },
      bonnet: null,
      rear: { z: tailZ - 0.012, y0: y(0.62), y1: y(1.12), halfW: X(0.86) },
      nose: { z: nose, y: y(0.66), halfW: X(0.92) },
      barW: 1.75,
    }, trim);
    // A second, rear-facing bar over the back doors.
    b.addBox(1.2, 0.10, 0.2, 0, y(2.40), tailZ + 0.25, 0x0e1218);
    b.addBox(0.3, 0.07, 0.21, +0.4, y(2.41), tailZ + 0.25, 0x2a4fb8);
    b.addBox(0.3, 0.07, 0.21, -0.4, y(2.41), tailZ + 0.25, 0xb8302a);
    // A blue band along the top of the box, and POLICE above the windscreen.
    for (const s of [1, -1]) {
      b.addBox(0.02, 0.16, (zf - 1.15) - (tailZ + 0.05), s * (X(0.99) + 0.012), y(2.10), ((zf - 1.15) + (tailZ + 0.05)) * 0.5, 0x0b3ea8);
    }
    decals.addDecalQuad([
      { x: X(0.62), y: y(2.20), z: zf - 1.02 }, { x: -X(0.62), y: y(2.20), z: zf - 1.02 },
      { x: -X(0.62), y: y(2.02), z: zf - 0.84 }, { x: X(0.62), y: y(2.02), z: zf - 0.84 },
    ], { x: 0, y: 0.5, z: 1 }, DECAL.flank);
  }
  void accent;
  const geo = buildGrouped([b, decals]);
  geo.userData.lamps = lamps;
  return geo;
}

// =================================================================== Badger

/**
 * The Badger: a proper square-rigged 4x4. Flat panels, an upright screen,
 * a contrasting roof, wide black arch flares over big tyres, a bull bar,
 * a roof rack, a snorkel, and the spare wheel on the back door.
 */
export function buildOffroadGeometry(spec, livery) {
  const b = new MeshBuilder();
  const { body, accent, glass, trim } = livery;
  const y = groundOf(spec);
  const zf = spec.wheelbase * (1 - spec.frontWeight);
  const zr = -spec.wheelbase * spec.frontWeight;
  const hw = spec.dims.w * 0.5;
  const nose = zf + 0.88;
  const tailZ = nose - spec.dims.l;
  const X = (f) => f * hw;

  const keys = [
    { z: nose,        ys: 0.50, sill: 0.54, xs: X(0.92), sh: 1.02, xd: X(0.86), dk: 1.05 },
    { z: nose - 0.06, ys: 0.46, sill: 0.52, xs: X(0.98), sh: 1.08, xd: X(0.90), dk: 1.10, crown: 0.01 },
    { z: zf,          ys: 0.46, sill: 0.52, xs: X(0.99), sh: 1.10, xd: X(0.92), dk: 1.12, crown: 0.01 },
    // The step up from the bonnet to the waist of the body, at the screen.
    { z: zf - 0.27,   ys: 0.44, sill: 0.50, xs: X(0.98), sh: 1.11, xd: X(0.92), dk: 1.12 },
    { z: zf - 0.29,   ys: 0.44, sill: 0.50, xs: X(0.98), sh: 1.30, xd: X(0.93), dk: 1.31 },
    { z: zf - 0.62,   ys: 0.42, sill: 0.48, xs: X(0.97), sh: 1.30, xd: X(0.93), dk: 1.31 },
    { z: zr + 0.62,   ys: 0.42, sill: 0.48, xs: X(0.97), sh: 1.30, xd: X(0.93), dk: 1.31 },
    { z: zr,          ys: 0.46, sill: 0.52, xs: X(0.99), sh: 1.30, xd: X(0.93), dk: 1.31 },
    { z: tailZ,       ys: 0.48, sill: 0.54, xs: X(0.99), sh: 1.30, xd: X(0.93), dk: 1.31 },
  ];
  loftBody(b, spec, y, keys, zf, zr, (edge) => (edge === 0 ? 0x0a0b0d : body));

  const scr = zf - 0.28;
  loftCabin(b, y, [
    { z: scr,          xb: X(0.90), hb: 1.12, xt: X(0.88), ht: 1.13 },
    { z: zf - 0.50,    xb: X(0.92), hb: 1.30, xt: X(0.86), ht: 1.90, crown: 0.02 },
    { z: tailZ + 0.03, xb: X(0.93), hb: 1.30, xt: X(0.87), ht: 1.94, crown: 0.02 },
    { z: tailZ,        xb: X(0.93), hb: 1.30, xt: X(0.87), ht: 1.93 },
  ], (edge, run) => {
    if (edge <= 0) return body;
    // Runs count from the tail: 2 is the windscreen, 1 the side glass.
    if (edge === 1) return run >= 1 ? glass : body;
    return run === 2 ? glass : accent;
  });
  // Pillars, so the side glass reads as three windows; the contrasting roof
  // panel over the top.
  for (const s of [1, -1]) {
    for (const pz of [zf - 1.30, zr + 0.35, tailZ + 0.30]) {
      b.addBox(0.06, y(1.88) - y(1.31), 0.11, s * X(0.905), (y(1.88) + y(1.31)) * 0.5, pz, accent);
    }
    // Arch flares: the look of the thing.
    for (const zc of [zf, zr]) {
      const R = spec.wheelRadius + 0.07;
      b.addTaperedBox(0.16, 0.12, R * 2.25, s * (X(1.0) + 0.05), y(spec.wheelRadius + R + 0.02), zc, 0x14161a, 1, 0.78);
      b.addBox(0.10, 0.28, 0.10, s * (X(1.0) + 0.05), y(spec.wheelRadius + R - 0.12), zc + R * 1.08, 0x14161a);
      b.addBox(0.10, 0.28, 0.10, s * (X(1.0) + 0.05), y(spec.wheelRadius + R - 0.12), zc - R * 1.08, 0x14161a);
    }
    // Sills with a step.
    b.addBox(0.14, 0.07, (zf - zr) - 1.25, s * (X(1.0) + 0.03), y(0.50), (zf + zr) * 0.5, 0x1b1e22);
    // Mirrors.
    b.addBox(0.16, 0.18, 0.05, s * (X(0.93) + 0.14), y(1.28), scr - 0.10, 0x14161a);
    // Round headlamps in square surrounds; tail lamps.
    b.addBox(0.30, 0.26, 0.05, s * X(0.64), y(0.86), nose + 0.005, 0x14161a);
    addCylinder(b, 0.10, 0.05, s * X(0.64), y(0.86), nose + 0.03, 0xf2f5fa, 'z', 14);
    b.addBox(0.12, 0.26, 0.05, s * X(0.86), y(0.88), tailZ - 0.01, 0xc0281f);
    // Door hinges.
    b.addBox(0.03, 0.08, 0.06, s * (X(0.97) + 0.02), y(1.02), zf - 0.62, trim);
    b.addBox(0.03, 0.08, 0.06, s * (X(0.97) + 0.02), y(0.70), zf - 0.62, trim);
  }
  // Slatted grille and badge plate.
  b.addBox(X(0.84), 0.30, 0.05, 0, y(0.86), nose + 0.005, 0x0b0d10);
  for (let i = -3; i <= 3; i++) b.addBox(X(0.84), 0.022, 0.03, 0, y(0.86 + i * 0.038), nose + 0.03, 0x3a3f46);
  // Bull bar: two uprights, two hoops.
  for (const px of [-0.42, 0.42]) b.addBox(0.07, 0.62, 0.07, px, y(0.72), nose + 0.18, 0x121418);
  b.addBox(1.10, 0.07, 0.07, 0, y(1.02), nose + 0.18, 0x121418);
  b.addBox(1.60, 0.10, 0.12, 0, y(0.50), nose + 0.14, 0x121418);
  // Rear bumper and the spare wheel on the door.
  b.addBox(X(1.9), 0.12, 0.14, 0, y(0.52), tailZ - 0.02, 0x121418);
  addCylinder(b, spec.wheelRadius, 0.26, 0, y(1.02), tailZ - 0.16, 0x0b0c0e, "z", 16);
  addCylinder(b, spec.wheelRadius * 0.55, 0.28, 0, y(1.02), tailZ - 0.16, 0x5d646c, "z", 12);
  // Roof rack, with a pair of lamps across the front of it.
  const rackY = y(2.02);
  for (const s of [1, -1]) b.addBox(0.05, 0.05, (zf - 0.6) - (tailZ + 0.2), s * X(0.80), rackY, ((zf - 0.6) + (tailZ + 0.2)) * 0.5, 0x121418);
  for (let z = tailZ + 0.2; z <= zf - 0.6 + 1e-6; z += ((zf - 0.6) - (tailZ + 0.2)) / 5) {
    b.addBox(X(1.6), 0.04, 0.05, 0, rackY, z, 0x121418);
  }
  for (const s of [1, -1]) {
    b.addBox(0.06, 0.08, 0.06, s * X(0.80), y(1.97), zf - 0.62, 0x121418);
    b.addBox(0.06, 0.08, 0.06, s * X(0.80), y(1.97), tailZ + 0.22, 0x121418);
    addCylinder(b, 0.085, 0.08, s * 0.28, y(2.12), zf - 0.58, 0xf2f5fa, 'z', 12);
  }
  // Snorkel up the right-hand A-pillar.
  b.addBox(0.10, y(1.95) - y(0.95), 0.10, -(X(0.93) + 0.08), (y(1.95) + y(0.95)) * 0.5, scr - 0.02, 0x121418);
  b.addBox(0.14, 0.10, 0.20, -(X(0.93) + 0.08), y(2.0), scr + 0.04, 0x121418);
  void glass;
  const geo = buildGrouped([b]);
  geo.userData.lamps = null;
  return geo;
}
