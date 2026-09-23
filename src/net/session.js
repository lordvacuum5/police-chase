// Multiplayer: one escapee, everyone else in a police car.
//
// There is no server-side simulation. Every client runs the same game, and
// each one owns exactly the cars it drives:
//
//   * the escapee (who created the game) owns their own car and every AI
//     police car, because the dispatcher, the heat and the roadblocks all
//     live on that machine already;
//   * each police player owns their own interceptor.
//
// An owner broadcasts what its cars are doing; everyone else receives those
// cars as ordinary cars and follows them along the line the packets describe.
// The consequence is that the player who hits somebody is the one whose
// physics decides what the hit felt like, which is the usual bargain: both
// cars bounce on both screens, and neither side can shove the other around
// from a stale packet.
//
// The transport is a WebSocket to the ASP.NET server (server/Program.cs),
// which is a relay and a room list and nothing more. With `?net=local` it is
// a BroadcastChannel instead, which reaches other tabs in the same browser --
// the whole of multiplayer, testable on one machine against the static dev
// server.

const PROTOCOL = 1;

/** How far behind the newest packet remote cars are drawn, in ms. */
const INTERP_DELAY = 120;
/** Snapshots kept per car. A second at the send rate is plenty. */
const BUFFER = 24;
/** Sends a second. */
export const SEND_HZ = 20;

/**
 * Car kinds, as an index: a snapshot is a list of numbers, and the kind is the
 * only string in it. Append only -- the position in this list is on the wire.
 */
const KINDS = ['runner', 'supercar', 'offroad', 'patrol', 'interceptor', 'suv', 'van', 'unmarked'];

export const FLAG = { POLICE: 1, UNMARKED: 2, DISABLED: 4, BLIP: 8 };

/** Longest name a police player can go by on the radio. */
export const UNIT_NAME_MAX = 7;

/**
 * A police player's name as the radio says it: letters, digits and single
 * spaces, at most UNIT_NAME_MAX of them. Empty if nothing usable was typed.
 * The placeholder names the menu used to send stand for "no name" too.
 */
export function cleanUnitName(name) {
  const n = String(name || '').replace(/[^A-Za-z0-9 ]/g, '').replace(/\s+/g, ' ').trim()
    .slice(0, UNIT_NAME_MAX).trim();
  return n === 'Unit' || n === 'Host' ? '' : n;
}

/** A car, as it goes on the wire: fifteen numbers and an id. */
export function packCar(id, v, extra = {}) {
  let flags = 0;
  if (v.isPolice) flags |= FLAG.POLICE;
  if (v.unmarked) flags |= FLAG.UNMARKED;
  if (v.disabled) flags |= FLAG.DISABLED;
  if (v.blipFor > 0 || extra.blip) flags |= FLAG.BLIP;
  const r2 = (n) => Math.round(n * 100) / 100;
  const r3 = (n) => Math.round(n * 1000) / 1000;
  return [
    id,
    KINDS.indexOf(v.specKey),
    r2(v.position.x), r2(v.position.y), r2(v.position.z),
    r3(v.quaternion.x), r3(v.quaternion.y), r3(v.quaternion.z), r3(v.quaternion.w),
    r2(v.linvel.x), r2(v.linvel.y), r2(v.linvel.z),
    r3(v.steerAngle || 0),
    r2(v.forwardSpeed || 0),
    Math.round((v.damage || 0) * 100) / 100,
    flags,
  ];
}

export function unpackCar(a) {
  return {
    id: a[0],
    kind: KINDS[a[1]] || 'patrol',
    x: a[2], y: a[3], z: a[4],
    qx: a[5], qy: a[6], qz: a[7], qw: a[8],
    vx: a[9], vy: a[10], vz: a[11],
    steer: a[12],
    speed: a[13],
    damage: a[14],
    flags: a[15],
  };
}

/**
 * Where one remote car is, smoothed.
 *
 * Packets arrive twenty times a second and at whatever jitter the network
 * adds, so the car is drawn a tenth of a second in the past and interpolated
 * between the two snapshots either side of that. Extrapolating instead reads
 * better on a straight and terribly everywhere else -- a car that brakes hard
 * carries on into the junction and is then yanked back.
 */
class Track {
  constructor(id) {
    this.id = id;
    this.snaps = [];
    this.kind = 'patrol';
    this.flags = 0;
    this.damage = 0;
    this.lastAt = 0;
  }

  push(car, at) {
    this.kind = car.kind;
    this.flags = car.flags;
    this.damage = car.damage;
    this.lastAt = at;
    this.snaps.push({ at, car });
    if (this.snaps.length > BUFFER) this.snaps.shift();
  }

  /** Interpolated state at `now`, or null if nothing has arrived yet. */
  sample(now) {
    const want = now - INTERP_DELAY;
    const n = this.snaps.length;
    if (!n) return null;
    if (n === 1 || want <= this.snaps[0].at) return this.snaps[0].car;
    let a = this.snaps[n - 1], b = null;
    for (let i = 0; i < n - 1; i++) {
      if (this.snaps[i].at <= want && this.snaps[i + 1].at >= want) {
        a = this.snaps[i]; b = this.snaps[i + 1];
        break;
      }
    }
    if (!b) return this.snaps[n - 1].car;      // running behind: hold the newest
    const span = b.at - a.at;
    const t = span > 1 ? (want - a.at) / span : 0;
    return lerpCar(a.car, b.car, t);
  }
}

function lerpCar(a, b, t) {
  const l = (x, y) => x + (y - x) * t;
  // Shortest arc: quaternions on opposite hemispheres would otherwise spin the
  // car the long way round between two packets.
  let d = a.qx * b.qx + a.qy * b.qy + a.qz * b.qz + a.qw * b.qw;
  const s = d < 0 ? -1 : 1;
  return {
    id: a.id, kind: b.kind,
    x: l(a.x, b.x), y: l(a.y, b.y), z: l(a.z, b.z),
    qx: l(a.qx, s * b.qx), qy: l(a.qy, s * b.qy), qz: l(a.qz, s * b.qz), qw: l(a.qw, s * b.qw),
    vx: b.vx, vy: b.vy, vz: b.vz,
    steer: l(a.steer, b.steer),
    speed: l(a.speed, b.speed),
    damage: b.damage,
    flags: b.flags,
  };
}

// ------------------------------------------------------------- transports

/** The real one: a WebSocket to the relay in server/Program.cs. */
function openSocket(query) {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const socket = new WebSocket(`${scheme}://${location.host}/ws?${query}`);
  return {
    kind: 'ws',
    socket,
    send(obj) {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(obj));
    },
    close() { try { socket.close(); } catch { /* already gone */ } },
    onOpen(fn) { socket.addEventListener('open', fn); },
    onMessage(fn) {
      socket.addEventListener('message', (e) => {
        let msg = null;
        try { msg = JSON.parse(e.data); } catch { return; }
        fn(msg);
      });
    },
    onClose(fn) { socket.addEventListener('close', fn); socket.addEventListener('error', fn); },
  };
}

/**
 * The local one: other tabs of this browser, over a BroadcastChannel, with no
 * server at all. Everything above this line is the same either way, so the
 * whole of multiplayer can be played -- and tested -- against the static dev
 * server. The creator answers joins, because in a game it is the host anyway.
 */
function openChannel(query) {
  const params = new URLSearchParams(query);
  const channel = new BroadcastChannel('pc:' + params.get('room'));
  const listeners = { open: [], message: [], close: [] };
  channel.addEventListener('message', (e) => {
    const msg = e.data;
    // Everything is addressed: to a peer, or to everyone but the sender.
    if (msg.to && msg.to !== params.get('id')) return;
    if (msg.from === params.get('id')) return;
    listeners.message.forEach((fn) => fn(msg));
  });
  setTimeout(() => listeners.open.forEach((fn) => fn()), 0);
  return {
    kind: 'bc',
    send(obj) { channel.postMessage(obj); },
    close() { channel.close(); },
    onOpen(fn) { listeners.open.push(fn); },
    onMessage(fn) { listeners.message.push(fn); },
    onClose(fn) { listeners.close.push(fn); },
  };
}

// --------------------------------------------------------------- session

class Session {
  constructor() {
    this.reset();
  }

  reset() {
    this.active = false;
    this.local = false;         // BroadcastChannel rather than a server
    this.role = null;           // 'escapee' or 'police'
    this.room = '';
    this.id = '';
    this.name = '';
    this.map = null;
    this.players = [];
    this.tracks = new Map();
    this.transport = null;
    this.heat = 0;
    this.seen = false;          // does the pursuit have eyes on the escapee
    this.escapeeId = null;
    this.error = '';
    this.closed = false;
    this._events = [];
    this._sendAt = 0;
  }

  get isHost() { return this.role === 'escapee'; }

  /**
   * Create a game, or join one by name. Resolves once the server (or, on a
   * BroadcastChannel, the host) has said which map is being played and which
   * side this player is on.
   */
  connect({ room, name, map, create }) {
    this.reset();
    this.room = room;
    this.name = name || (create ? 'Host' : 'Unit');
    this.id = Math.random().toString(36).slice(2, 10);
    this.local = new URLSearchParams(location.search).get('net') === 'local';

    const query = new URLSearchParams({
      v: String(PROTOCOL),
      room,
      id: this.id,
      name: this.name,
      create: create ? '1' : '0',
      map: map || '',
    }).toString();

    this.transport = this.local ? openChannel(query) : openSocket(query);
    if (create) {
      // The creator is the escapee, and on a BroadcastChannel it is also the
      // thing that answers joins, so it knows all of this without asking.
      this.role = 'escapee';
      this.map = map;
      this.escapeeId = this.id;
      this.players = [{ id: this.id, name: this.name, role: 'escapee' }];
    }

    this.transport.onMessage((msg) => this._receive(msg));
    this.transport.onClose(() => {
      if (!this.closed) { this.closed = true; this.error = this.error || 'Connection lost.'; }
    });

    return new Promise((resolve, reject) => {
      const done = (err) => {
        clearTimeout(timer);
        if (err) { this.close(); reject(new Error(err)); } else { this.active = true; resolve(this); }
      };
      const timer = setTimeout(() => done(this.local && !create
        ? `No game called "${room}" in this browser.`
        : 'The server did not answer.'), this.local ? 1500 : 8000);
      this._ready = done;

      this.transport.onOpen(() => {
        if (this.local) {
          // No server to register with: announce, and let the host reply.
          if (create) { done(null); } else { this.transport.send({ t: 'hello', from: this.id, name: this.name }); }
        }
        // Over a WebSocket the query string was the request; the server
        // answers with 'joined' or 'error'.
      });
    });
  }

  _receive(msg) {
    switch (msg.t) {
      case 'joined':
        this.id = msg.id || this.id;
        this.role = msg.role;
        this.map = msg.map;
        this.escapeeId = msg.escapee;
        this.players = msg.players || [];
        if (this._ready) { const r = this._ready; this._ready = null; r(null); }
        break;
      case 'error':
        this.error = msg.message || 'Refused.';
        if (this._ready) { const r = this._ready; this._ready = null; r(this.error); }
        break;
      case 'players':
        this.players = msg.players || [];
        break;
      case 'hello':
        // Only the host answers, and only on a BroadcastChannel: the server
        // does this itself when there is one.
        if (this.local && this.isHost) {
          if (!this.players.some((p) => p.id === msg.from)) {
            this.players.push({ id: msg.from, name: msg.name || 'Unit', role: 'police' });
          }
          this.transport.send({
            t: 'joined', to: msg.from, from: this.id, id: msg.from, role: 'police',
            map: this.map, escapee: this.id, players: this.players,
          });
          this.transport.send({ t: 'players', from: this.id, players: this.players });
        }
        break;
      case 'bye':
        this.players = this.players.filter((p) => p.id !== msg.from);
        this.tracks.delete(msg.from);
        if (msg.from === this.escapeeId) {
          this.closed = true;
          this.error = 'The escapee left the game.';
        }
        break;
      case 'w': {          // the host's world: its car, and every AI car
        const at = performance.now();
        this.heat = msg.h || 0;
        this.seen = !!msg.s;
        const live = new Set();
        for (const packed of msg.c) {
          const car = unpackCar(packed);
          live.add(car.id);
          this._track(car.id).push(car, at);
        }
        // AI cars that stopped being sent have been despawned.
        for (const id of [...this.tracks.keys()]) {
          if (String(id).startsWith('a') && !live.has(id)) this.tracks.delete(id);
        }
        break;
      }
      case 'p': {          // one player's own car
        const car = unpackCar(msg.c);
        if (car.id === this.id) break;
        this._track(car.id).push(car, performance.now());
        break;
      }
      case 'e':
        this._events.push(msg);
        break;
      default:
        break;
    }
  }

  _track(id) {
    let t = this.tracks.get(id);
    if (!t) { t = new Track(id); this.tracks.set(id, t); }
    return t;
  }

  /** Everything this client does not own, interpolated to now. */
  sample() {
    const now = performance.now();
    const out = [];
    for (const track of this.tracks.values()) {
      const car = track.sample(now);
      if (car) out.push(car);
    }
    return out;
  }

  /** Drop cars nobody has heard from for a while -- a player who crashed out. */
  prune(maxAgeMs = 5000) {
    const now = performance.now();
    const gone = [];
    for (const [id, track] of this.tracks) {
      if (now - track.lastAt > maxAgeMs) { this.tracks.delete(id); gone.push(id); }
    }
    return gone;
  }

  /** True at most SEND_HZ times a second, so callers can just ask every frame. */
  dueToSend() {
    const now = performance.now();
    if (now - this._sendAt < 1000 / SEND_HZ) return false;
    this._sendAt = now;
    return true;
  }

  sendWorld(cars, heat, seen) {
    if (!this.active) return;
    this.transport.send({ t: 'w', from: this.id, c: cars, h: heat, s: seen ? 1 : 0 });
  }

  sendCar(car) {
    if (!this.active) return;
    this.transport.send({ t: 'p', from: this.id, c: car });
  }

  sendEvent(event, data = {}) {
    if (!this.active) return;
    this.transport.send(Object.assign({ t: 'e', from: this.id, e: event }, data));
  }

  /** Events since the last call: busted, escaped, a restart. */
  takeEvents() {
    const events = this._events;
    this._events = [];
    return events;
  }

  close() {
    this.closed = true;
    this.active = false;
    if (this.transport) {
      try { this.transport.send({ t: 'bye', from: this.id }); } catch { /* gone */ }
      this.transport.close();
    }
    this.transport = null;
  }
}

export const session = new Session();
