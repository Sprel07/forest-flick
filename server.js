// server.js
// npm i
// npm start
//
// Render Web Service settings:
// Build Command: npm install
// Start Command: npm start
//
// Multiplayer model:
// - Server authoritative
// - Turn based only
// - Boss is also turn based and acts every 2nd player turn (in boss mode)

const path = require("path");
const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();
app.use(express.static(path.join(__dirname)));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const TICK_HZ = 60;
const SNAP_HZ = 20;

const rooms = new Map(); // code -> room

function nowMs() { return Date.now(); }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function randId() { return Math.random().toString(36).slice(2, 8).toUpperCase(); }
function makeRoomCode() { return Math.random().toString(36).slice(2, 6).toUpperCase(); }

function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}
function broadcast(room, obj) {
  for (const ws of room.clients.keys()) send(ws, obj);
}

function sanitizeName(s) {
  s = String(s || "").trim();
  if (!s) return "Player";
  s = s.replace(/[^\w\s\-]/g, "").trim();
  if (!s) return "Player";
  if (s.length > 14) s = s.slice(0, 14);
  return s;
}

function makeRoom(code) {
  return {
    code,
    createdAt: nowMs(),
    clients: new Map(), // ws -> pid
    players: new Map(), // pid -> meta
    hostId: null,

    lobby: {
      mode: "race", // "race" | "boss"
      started: false,
      picks: {}, // pid -> charId
      ready: {}, // pid -> bool
      maxPlayers: 4
    },

    game: null,
    lastTick: nowMs(),
    lastSnap: 0
  };
}

// -------------------------
// MAPS
// -------------------------

// Wide corridor labyrinth maps (race)
const RACE_MAPS = [
  {
    id: "labyrinth_1",
    name: "Cocorite Labyrinth",
    W: 2800,
    H: 1400,
    bounds: { x: 40, y: 40, w: 2720, h: 1320 },
    finish: { x: 2660, y: 120, w: 90, h: 90 },
    // Walls are thick rectangles. Corridors are wide.
    walls: (function () {
      const walls = [];
      // outer thick frame
      walls.push({ x: 40, y: 40, w: 2720, h: 30 });
      walls.push({ x: 40, y: 1330, w: 2720, h: 30 });
      walls.push({ x: 40, y: 40, w: 30, h: 1320 });
      walls.push({ x: 2730, y: 40, w: 30, h: 1320 });

      // internal maze segments (wide corridors, no tiny gaps)
      const t = 36; // wall thickness
      walls.push({ x: 260, y: 160, w: 720, h: t });
      walls.push({ x: 260, y: 160, w: t, h: 540 });
      walls.push({ x: 260, y: 700, w: 540, h: t });
      walls.push({ x: 780, y: 520, w: t, h: 380 });
      walls.push({ x: 540, y: 900, w: 780, h: t });
      walls.push({ x: 1320, y: 260, w: t, h: 520 });
      walls.push({ x: 980, y: 260, w: 420, h: t });
      walls.push({ x: 1400, y: 420, w: 720, h: t });
      walls.push({ x: 2120, y: 420, w: t, h: 480 });
      walls.push({ x: 1680, y: 900, w: 520, h: t });
      walls.push({ x: 1680, y: 900, w: t, h: 250 });
      walls.push({ x: 1680, y: 1150, w: 820, h: t });
      walls.push({ x: 2480, y: 220, w: t, h: 680 });
      walls.push({ x: 2200, y: 220, w: 280, h: t });
      walls.push({ x: 2200, y: 220, w: t, h: 420 });
      walls.push({ x: 980, y: 1060, w: 520, h: t });
      walls.push({ x: 980, y: 1060, w: t, h: 240 });
      walls.push({ x: 520, y: 1120, w: 320, h: t });
      walls.push({ x: 840, y: 1120, w: t, h: 220 });
      walls.push({ x: 840, y: 1320 - 250, w: 520, h: t });

      // a few "islands" to create branching
      walls.push({ x: 1100, y: 560, w: 220, h: 90 });
      walls.push({ x: 1860, y: 620, w: 260, h: 90 });
      walls.push({ x: 1460, y: 240, w: 260, h: 90 });
      walls.push({ x: 2300, y: 980, w: 260, h: 90 });

      return walls;
    })(),
    pads: [
      { x: 240, y: 420, w: 160, h: 18 },
      { x: 1360, y: 820, w: 200, h: 18 },
      { x: 2280, y: 300, w: 200, h: 18 }
    ],
    traps: [
      { x: 980, y: 520, r: 18 },
      { x: 2140, y: 980, r: 18 }
    ],
    coins: (function () {
      const pts = [
        [360, 120], [520, 240], [720, 340], [600, 820],
        [980, 880], [1220, 980], [1500, 740], [1720, 520],
        [1960, 300], [2260, 180], [2520, 520], [2460, 1180]
      ];
      return pts.map(([x, y]) => ({ x, y, r: 12, takenBy: null }));
    })(),
    items: [
      { type: "dash", x: 820, y: 300, r: 14, takenBy: null },
      { type: "shield", x: 1500, y: 980, r: 14, takenBy: null },
      { type: "magnet", x: 2360, y: 520, r: 14, takenBy: null }
    ],
    spawns: (function () {
      // spawn lane on left, wide spacing
      const baseX = 120, baseY = 220, gap = 70;
      return [0, 1, 2, 3].map(i => ({ x: baseX, y: baseY + i * gap }));
    })()
  },

  {
    id: "labyrinth_2",
    name: "Maracas Switchbacks",
    W: 3000,
    H: 1500,
    bounds: { x: 40, y: 40, w: 2920, h: 1420 },
    finish: { x: 2860, y: 1240, w: 90, h: 90 },
    walls: (function () {
      const w = [];
      // outer
      w.push({ x: 40, y: 40, w: 2920, h: 30 });
      w.push({ x: 40, y: 1430, w: 2920, h: 30 });
      w.push({ x: 40, y: 40, w: 30, h: 1420 });
      w.push({ x: 2930, y: 40, w: 30, h: 1420 });

      const t = 36;

      // long horizontal lanes with breaks (switchbacks)
      for (let i = 0; i < 7; i++) {
        const y = 180 + i * 170;
        w.push({ x: 180, y, w: 2500, h: t });
      }

      // vertical blockers to force turns
      w.push({ x: 520, y: 180, w: t, h: 520 });
      w.push({ x: 900, y: 350, w: t, h: 520 });
      w.push({ x: 1280, y: 180, w: t, h: 520 });
      w.push({ x: 1660, y: 350, w: t, h: 520 });
      w.push({ x: 2040, y: 180, w: t, h: 520 });
      w.push({ x: 2420, y: 350, w: t, h: 520 });

      // mid box island
      w.push({ x: 1200, y: 980, w: 520, h: t });
      w.push({ x: 1200, y: 980, w: t, h: 360 });
      w.push({ x: 1684, y: 980, w: t, h: 360 });
      w.push({ x: 1200, y: 1320, w: 520, h: t });

      return w;
    })(),
    pads: [
      { x: 420, y: 520, w: 200, h: 18 },
      { x: 1320, y: 690, w: 200, h: 18 },
      { x: 2220, y: 860, w: 200, h: 18 }
    ],
    traps: [
      { x: 1500, y: 520, r: 18 },
      { x: 1980, y: 860, r: 18 },
      { x: 760, y: 1190, r: 18 }
    ],
    coins: (function () {
      const pts = [
        [260, 120], [420, 300], [600, 460], [780, 620],
        [960, 780], [1140, 940], [1320, 1100], [1500, 1260],
        [1920, 1200], [2240, 980], [2500, 760], [2700, 520]
      ];
      return pts.map(([x, y]) => ({ x, y, r: 12, takenBy: null }));
    })(),
    items: [
      { type: "dash", x: 980, y: 1080, r: 14, takenBy: null },
      { type: "shield", x: 1700, y: 520, r: 14, takenBy: null },
      { type: "magnet", x: 2520, y: 1190, r: 14, takenBy: null }
    ],
    spawns: (function () {
      const baseX = 120, baseY = 220, gap = 70;
      return [0, 1, 2, 3].map(i => ({ x: baseX, y: baseY + i * gap }));
    })()
  },

  {
    id: "labyrinth_3",
    name: "Bamboo Tunnels",
    W: 3200,
    H: 1600,
    bounds: { x: 40, y: 40, w: 3120, h: 1520 },
    finish: { x: 3040, y: 120, w: 90, h: 90 },
    walls: (function () {
      const w = [];
      w.push({ x: 40, y: 40, w: 3120, h: 30 });
      w.push({ x: 40, y: 1530, w: 3120, h: 30 });
      w.push({ x: 40, y: 40, w: 30, h: 1520 });
      w.push({ x: 3130, y: 40, w: 30, h: 1520 });

      const t = 36;

      // main "tunnel" blocks
      w.push({ x: 260, y: 240, w: 2600, h: t });
      w.push({ x: 260, y: 240, w: t, h: 1100 });
      w.push({ x: 260, y: 1340, w: 2600, h: t });
      w.push({ x: 2860, y: 240, w: t, h: 1140 });

      // internal zigzags
      w.push({ x: 520, y: 420, w: 2100, h: t });
      w.push({ x: 520, y: 420, w: t, h: 720 });
      w.push({ x: 520, y: 1140, w: 2100, h: t });
      w.push({ x: 2584, y: 420, w: t, h: 720 });

      // branching verticals
      w.push({ x: 880, y: 600, w: t, h: 360 });
      w.push({ x: 1240, y: 600, w: t, h: 360 });
      w.push({ x: 1600, y: 600, w: t, h: 360 });
      w.push({ x: 1960, y: 600, w: t, h: 360 });

      // little islands
      w.push({ x: 980, y: 880, w: 240, h: 90 });
      w.push({ x: 1840, y: 520, w: 260, h: 90 });
      w.push({ x: 2360, y: 940, w: 260, h: 90 });

      return w;
    })(),
    pads: [
      { x: 420, y: 980, w: 220, h: 18 },
      { x: 1500, y: 520, w: 220, h: 18 },
      { x: 2620, y: 980, w: 220, h: 18 }
    ],
    traps: [
      { x: 1140, y: 520, r: 18 },
      { x: 2220, y: 880, r: 18 }
    ],
    coins: (function () {
      const pts = [
        [320, 180], [520, 520], [760, 720], [980, 960],
        [1240, 520], [1500, 720], [1760, 960], [2020, 520],
        [2280, 720], [2540, 960], [2800, 520], [3000, 220]
      ];
      return pts.map(([x, y]) => ({ x, y, r: 12, takenBy: null }));
    })(),
    items: [
      { type: "dash", x: 980, y: 520, r: 14, takenBy: null },
      { type: "shield", x: 2020, y: 960, r: 14, takenBy: null },
      { type: "magnet", x: 2800, y: 720, r: 14, takenBy: null }
    ],
    spawns: (function () {
      const baseX = 120, baseY = 220, gap = 70;
      return [0, 1, 2, 3].map(i => ({ x: baseX, y: baseY + i * gap }));
    })()
  }
];

// Boss arenas (separate maps)
const BOSS_ARENAS = [
  {
    id: "arena_1",
    name: "Temple Clearing",
    W: 2000,
    H: 1200,
    bounds: { x: 40, y: 40, w: 1920, h: 1120 },
    walls: (function () {
      const w = [];
      // outer
      w.push({ x: 40, y: 40, w: 1920, h: 30 });
      w.push({ x: 40, y: 1130, w: 1920, h: 30 });
      w.push({ x: 40, y: 40, w: 30, h: 1120 });
      w.push({ x: 1930, y: 40, w: 30, h: 1120 });

      const t = 36;
      // cover walls
      w.push({ x: 520, y: 240, w: 360, h: t });
      w.push({ x: 520, y: 240, w: t, h: 420 });
      w.push({ x: 880, y: 420, w: 420, h: t });

      w.push({ x: 1200, y: 720, w: 520, h: t });
      w.push({ x: 1200, y: 420, w: t, h: 300 });
      w.push({ x: 920, y: 720, w: 280, h: t });

      return w;
    })(),
    pads: [
      { x: 260, y: 520, w: 220, h: 18 },
      { x: 1480, y: 520, w: 220, h: 18 }
    ],
    hazards: [
      { x: 980, y: 260, r: 18 },
      { x: 980, y: 940, r: 18 }
    ],
    items: [
      { type: "dash", x: 520, y: 940, r: 14, takenBy: null },
      { type: "dash", x: 1480, y: 260, r: 14, takenBy: null },
      { type: "shield", x: 980, y: 600, r: 14, takenBy: null }
    ],
    spawns: [{ x: 180, y: 520 }, { x: 180, y: 620 }, { x: 180, y: 720 }, { x: 180, y: 820 }],
    bossSpawn: { x: 1680, y: 600 }
  },

  {
    id: "arena_2",
    name: "Mangrove Ring",
    W: 2200,
    H: 1300,
    bounds: { x: 40, y: 40, w: 2120, h: 1220 },
    walls: (function () {
      const w = [];
      w.push({ x: 40, y: 40, w: 2120, h: 30 });
      w.push({ x: 40, y: 1230, w: 2120, h: 30 });
      w.push({ x: 40, y: 40, w: 30, h: 1220 });
      w.push({ x: 2130, y: 40, w: 30, h: 1220 });

      const t = 36;
      // ring-ish cover
      w.push({ x: 520, y: 260, w: 1160, h: t });
      w.push({ x: 520, y: 260, w: t, h: 720 });
      w.push({ x: 520, y: 980, w: 1160, h: t });
      w.push({ x: 1684, y: 260, w: t, h: 720 });

      // breaks
      w.push({ x: 980, y: 260, w: 220, h: t }); // still thick but part of ring
      w.push({ x: 980, y: 980, w: 220, h: t });

      return w;
    })(),
    pads: [
      { x: 340, y: 360, w: 220, h: 18 },
      { x: 1820, y: 940, w: 220, h: 18 }
    ],
    hazards: [
      { x: 700, y: 600, r: 18 },
      { x: 1500, y: 600, r: 18 }
    ],
    items: [
      { type: "dash", x: 980, y: 600, r: 14, takenBy: null },
      { type: "shield", x: 520, y: 600, r: 14, takenBy: null },
      { type: "magnet", x: 1680, y: 600, r: 14, takenBy: null }
    ],
    spawns: [{ x: 200, y: 520 }, { x: 200, y: 620 }, { x: 200, y: 720 }, { x: 200, y: 820 }],
    bossSpawn: { x: 1900, y: 600 }
  },

  {
    id: "arena_3",
    name: "Cliffside Grid",
    W: 2400,
    H: 1400,
    bounds: { x: 40, y: 40, w: 2320, h: 1320 },
    walls: (function () {
      const w = [];
      w.push({ x: 40, y: 40, w: 2320, h: 30 });
      w.push({ x: 40, y: 1330, w: 2320, h: 30 });
      w.push({ x: 40, y: 40, w: 30, h: 1320 });
      w.push({ x: 2330, y: 40, w: 30, h: 1320 });

      const t = 36;
      // grid cover
      for (let i = 0; i < 5; i++) {
        w.push({ x: 620 + i * 320, y: 260, w: t, h: 900 });
      }
      w.push({ x: 520, y: 520, w: 1400, h: t });
      w.push({ x: 520, y: 880, w: 1400, h: t });

      // a large block near boss
      w.push({ x: 1900, y: 360, w: 260, h: 260 });

      return w;
    })(),
    pads: [
      { x: 260, y: 1040, w: 220, h: 18 },
      { x: 1960, y: 1040, w: 220, h: 18 }
    ],
    hazards: [
      { x: 980, y: 360, r: 18 },
      { x: 980, y: 1040, r: 18 },
      { x: 1500, y: 700, r: 18 }
    ],
    items: [
      { type: "dash", x: 980, y: 700, r: 14, takenBy: null },
      { type: "shield", x: 620, y: 700, r: 14, takenBy: null },
      { type: "dash", x: 1900, y: 700, r: 14, takenBy: null }
    ],
    spawns: [{ x: 200, y: 520 }, { x: 200, y: 620 }, { x: 200, y: 720 }, { x: 200, y: 820 }],
    bossSpawn: { x: 2100, y: 700 }
  }
];

// Boss defs rotate with their own arenas
const BOSSES = [
  {
    id: "armored_crab",
    name: "Armored Crab King",
    hp: 18,
    hint: "Only dash strikes hurt it. Dash during movement to deal damage.",
    rules: { dashOnly: true, weakspot: false },
    arenaId: "arena_1",
    attack: "charge"
  },
  {
    id: "reef_golem",
    name: "Reef Golem",
    hp: 22,
    hint: "Hit the glowing weak spot. It changes on boss turns.",
    rules: { dashOnly: false, weakspot: true },
    arenaId: "arena_2",
    attack: "shock"
  },
  {
    id: "spirit_owl",
    name: "Spirit Owl Warden",
    hp: 20,
    hint: "Parry ring appears on boss turn. Dash through it to counter.",
    rules: { dashOnly: false, weakspot: false, parryOnly: true },
    arenaId: "arena_3",
    attack: "ring"
  }
];

function pickRaceMapByIndex(i) {
  return RACE_MAPS[i % RACE_MAPS.length];
}
function pickBossByIndex(i) {
  return BOSSES[i % BOSSES.length];
}
function findArena(arenaId) {
  return BOSS_ARENAS.find(a => a.id === arenaId) || BOSS_ARENAS[0];
}

// -------------------------
// GAME SIMULATION
// -------------------------

function makePlayer(pid, meta, x, y) {
  const charId = meta.charId || "agouti";
  const p = {
    id: pid,
    name: meta.name || pid,
    charId,
    colorIndex: meta.colorIndex || 0,

    x, y, vx: 0, vy: 0, r: 18,

    score: 0,
    coins: 0,

    // for boss mode
    hpMax: 6,
    hp: 6,
    lives: 3,

    // traits
    firstLaunchAvailable: true,
    dashCharges: 0,
    shield: false,
    magnetT: 0,

    canDashThisTurn: false,
    dashUsedThisTurn: false,
    dashStrikeWindow: 0,

    bounceKeep: (charId === "frog") ? 0.90 : 0.78,
    friction: 0.985,

    finished: false
  };

  // hummingbird starts with dash each round (race) or each life (boss)
  if (charId === "hummingbird") p.dashCharges = 1;
  // manicou starts with shield
  if (charId === "manicou") p.shield = true;

  return p;
}

function makeGame(mode, playerIds, playerMeta, picks) {
  const game = {
    mode, // race | boss
    round: 1,
    phase: "play", // play | round_end
    winnerId: null,

    // turn
    turnOrder: [...playerIds], // only players here
    turnIndex: 0,
    activeId: playerIds[0],
    turnState: "aim", // aim | resolving | boss_turn
    turnMsLeft: 25000,

    // boss pacing
    turnCount: 0, // increments after each player turn
    bossActsEvery: 2,
    bossPending: false,
    bossActionT: 0,

    // world
    W: 960,
    H: 540,
    bounds: { x: 20, y: 20, w: 920, h: 500 },

    mapIndex: 0,
    mapId: null,
    mapName: "",
    finish: null,
    walls: [],
    pads: [],
    traps: [],
    hazards: [],
    coins: [],
    items: [],

    players: {},
    boss: null,

    bossIndex: 0,

    hint: "",
    toast: "",
    shake: 0,
    shakeT: 0
  };

  for (let i = 0; i < playerIds.length; i++) {
    const pid = playerIds[i];
    const meta = playerMeta.get(pid) || { name: pid, charId: "agouti", colorIndex: i % 8 };
    meta.charId = picks[pid] || meta.charId || "agouti";
    playerMeta.set(pid, meta);
    game.players[pid] = makePlayer(pid, meta, 120, 240 + i * 70);
  }

  if (mode === "race") {
    loadRaceMap(game, 0);
    game.hint = "Race to the finish. One flick per turn. First to touch wins.";
  } else {
    loadBossStage(game, 0);
  }

  return game;
}

function resetRoundPerks(game) {
  for (const pid of Object.keys(game.players)) {
    const p = game.players[pid];
    p.firstLaunchAvailable = true;
    p.magnetT = 0;
    p.finished = false;
    p.dashUsedThisTurn = false;
    p.dashStrikeWindow = 0;
    p.canDashThisTurn = false;

    if (p.charId === "hummingbird") p.dashCharges = Math.max(p.dashCharges, 1);
    if (p.charId === "manicou") p.shield = true;
  }
}

function circleRectCollide(cx, cy, cr, rx, ry, rw, rh) {
  const nx = clamp(cx, rx, rx + rw);
  const ny = clamp(cy, ry, ry + rh);
  const dx = cx - nx;
  const dy = cy - ny;
  return dx * dx + dy * dy <= cr * cr;
}

function resolveCircleRect(ent, w) {
  const rx = w.x, ry = w.y, rw = w.w, rh = w.h;
  const cx = ent.x, cy = ent.y, cr = ent.r;

  const nx = clamp(cx, rx, rx + rw);
  const ny = clamp(cy, ry, ry + rh);

  let dx = cx - nx;
  let dy = cy - ny;
  let dist = Math.hypot(dx, dy);
  if (dist === 0) { dx = 0; dy = -1; dist = 1; }

  const overlap = cr - dist;
  if (overlap > 0) {
    const ux = dx / dist, uy = dy / dist;
    ent.x += ux * overlap;
    ent.y += uy * overlap;

    const dot = ent.vx * ux + ent.vy * uy;
    ent.vx = ent.vx - 2 * dot * ux;
    ent.vy = ent.vy - 2 * dot * uy;

    const keep = ent.bounceKeep != null ? ent.bounceKeep : 0.84;
    ent.vx *= keep;
    ent.vy *= keep;

    // extra damping to stop endless wobble
    ent.vx *= 0.92;
    ent.vy *= 0.92;
  }
}

function clampSpeed(ent, maxSp) {
  const sp = Math.hypot(ent.vx, ent.vy);
  if (sp > maxSp) {
    const s = maxSp / sp;
    ent.vx *= s; ent.vy *= s;
  }
}

function isStopped(ent) {
  return Math.hypot(ent.vx, ent.vy) < 6;
}

function applyPadBoost(ent) {
  ent.vx *= 1.22;
  ent.vy *= 1.22;
}

function applyMagnet(game, p, dt) {
  if (p.magnetT <= 0) return;
  const radius = 170;
  const strength = 900;
  for (const c of game.coins) {
    if (c.takenBy) continue;
    const dx = p.x - c.x;
    const dy = p.y - c.y;
    const d = Math.hypot(dx, dy);
    if (d > 0 && d < radius) {
      const t = 1 - d / radius;
      c.x += (dx / d) * strength * t * dt;
      c.y += (dy / d) * strength * t * dt;
    }
  }
}

function outOfBounds(game, ent) {
  if (!Number.isFinite(ent.x) || !Number.isFinite(ent.y)) return true;
  if (ent.x < game.bounds.x - 400) return true;
  if (ent.y < game.bounds.y - 400) return true;
  if (ent.x > game.bounds.x + game.bounds.w + 400) return true;
  if (ent.y > game.bounds.y + game.bounds.h + 400) return true;
  return false;
}

function respawnPlayer(game, p, dmgReason) {
  // place back at spawn lane
  const ids = game.turnOrder;
  const idx = ids.indexOf(p.id);
  const spawn = game.spawns && game.spawns[idx] ? game.spawns[idx] : { x: 120, y: 240 + idx * 70 };

  p.x = spawn.x;
  p.y = spawn.y;
  p.vx = 0;
  p.vy = 0;

  if (game.mode === "boss") {
    p.hp = Math.max(0, p.hp - 2);
    game.toast = dmgReason || "Fell out of bounds";
    game.shake = Math.max(game.shake, 10);
    game.shakeT = Math.max(game.shakeT, 0.18);

    if (p.hp <= 0) {
      p.lives -= 1;
      if (p.lives <= 0) {
        p.lives = 0;
        p.hp = 0;
      } else {
        p.hp = p.hpMax;
        if (p.charId === "hummingbird") p.dashCharges = Math.max(p.dashCharges, 1);
        if (p.charId === "manicou") p.shield = true;
      }
    }
  }
}

function loadRaceMap(game, mapIndex) {
  const m = pickRaceMapByIndex(mapIndex);
  game.mapIndex = mapIndex;
  game.mapId = m.id;
  game.mapName = m.name;

  game.W = m.W;
  game.H = m.H;
  game.bounds = { ...m.bounds };

  game.finish = { ...m.finish };
  game.walls = m.walls.map(x => ({ ...x }));
  game.pads = (m.pads || []).map(x => ({ ...x }));
  game.traps = (m.traps || []).map(x => ({ ...x }));
  game.hazards = [];
  game.coins = (m.coins || []).map(c => ({ ...c, takenBy: null }));
  game.items = (m.items || []).map(it => ({ ...it, takenBy: null }));

  game.spawns = (m.spawns || []).map(s => ({ ...s }));

  // reset players
  const ids = game.turnOrder;
  for (let i = 0; i < ids.length; i++) {
    const p = game.players[ids[i]];
    const s = game.spawns[i] || { x: 120, y: 240 + i * 70 };
    p.x = s.x; p.y = s.y;
    p.vx = 0; p.vy = 0;
    p.finished = false;
  }
  resetRoundPerks(game);

  game.turnIndex = 0;
  game.activeId = game.turnOrder[0];
  game.turnState = "aim";
  game.turnMsLeft = 25000;
  game.phase = "play";
  game.winnerId = null;
  game.toast = "";
}

function loadBossStage(game, bossIndex) {
  const bdef = pickBossByIndex(bossIndex);
  const arena = findArena(bdef.arenaId);

  game.bossIndex = bossIndex;
  game.mapId = arena.id;
  game.mapName = arena.name;

  game.W = arena.W;
  game.H = arena.H;
  game.bounds = { ...arena.bounds };

  game.finish = null;
  game.walls = arena.walls.map(x => ({ ...x }));
  game.pads = (arena.pads || []).map(x => ({ ...x }));
  game.traps = []; // not used in boss mode
  game.hazards = (arena.hazards || []).map(x => ({ ...x }));
  game.coins = []; // keep boss cleaner
  game.items = (arena.items || []).map(it => ({ ...it, takenBy: null }));

  game.spawns = (arena.spawns || []).map(s => ({ ...s }));

  game.boss = {
    id: bdef.id,
    name: bdef.name,
    hpMax: bdef.hp,
    hp: bdef.hp,
    rules: { ...bdef.rules },
    hint: bdef.hint,
    attack: bdef.attack,

    x: arena.bossSpawn.x,
    y: arena.bossSpawn.y,
    r: 46,
    vx: 0,
    vy: 0,
    bounceKeep: 0.86,
    friction: 0.99,

    // weakspot / ring
    weakAngle: 0,
    weakArc: Math.PI / 3,
    ringActive: false,
    ringR: 0,
    ringX: 0,
    ringY: 0
  };

  // reset players for boss mode
  const ids = game.turnOrder;
  for (let i = 0; i < ids.length; i++) {
    const p = game.players[ids[i]];
    const s = game.spawns[i] || { x: 180, y: 520 + i * 70 };
    p.x = s.x; p.y = s.y;
    p.vx = 0; p.vy = 0;
    p.finished = false;

    // hp/lives setup (keep persistent through boss stages)
    p.hpMax = 6;
    p.hp = Math.min(p.hpMax, p.hp || p.hpMax);
    p.lives = (p.lives == null) ? 3 : p.lives;

    // perks
    p.firstLaunchAvailable = true;
    p.magnetT = 0;
    p.dashUsedThisTurn = false;
    p.dashStrikeWindow = 0;
    p.canDashThisTurn = false;

    if (p.charId === "hummingbird") p.dashCharges = Math.max(p.dashCharges, 1);
    if (p.charId === "manicou") p.shield = true;
  }

  game.turnIndex = 0;
  game.activeId = game.turnOrder[0];
  game.turnState = "aim";
  game.turnMsLeft = 25000;
  game.phase = "play";
  game.winnerId = null;

  game.turnCount = 0;
  game.bossPending = false;
  game.bossActionT = 0;

  game.hint = bdef.hint;
  game.toast = `${bdef.name} appeared. ${bdef.hint}`;
  game.shake = 0;
  game.shakeT = 0;
}

function bossTakeDamage(game, amount, source, hitAngle) {
  const boss = game.boss;
  if (!boss || boss.hp <= 0) return false;

  // Rules
  if (boss.rules.parryOnly) {
    if (source !== "PARRY") return false;
  }
  if (boss.rules.dashOnly) {
    if (source !== "DASH") return false;
  }
  if (boss.rules.weakspot) {
    if (hitAngle == null) return false;
    const diff = Math.abs(((hitAngle - boss.weakAngle + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
    if (diff > boss.weakArc * 0.5) return false;
  }

  boss.hp = Math.max(0, boss.hp - amount);
  game.shake = Math.max(game.shake, 14 + amount * 2);
  game.shakeT = Math.max(game.shakeT, 0.20);
  game.toast = "Boss hit!";
  return true;
}

function applyFlick(game, pid, vx, vy) {
  const p = game.players[pid];
  if (!p) return;

  let boost = 1.0;
  if (p.charId === "agouti" && p.firstLaunchAvailable) {
    boost = 1.22;
    p.firstLaunchAvailable = false;
  }

  p.vx += vx * boost;
  p.vy += vy * boost;
  clampSpeed(p, 1600);

  p.canDashThisTurn = true;
  p.dashUsedThisTurn = false;
}

function applyDash(game, pid) {
  const p = game.players[pid];
  if (!p) return false;
  if (!p.canDashThisTurn) return false;
  if (p.dashUsedThisTurn) return false;
  if (p.dashCharges <= 0) return false;

  const sp = Math.hypot(p.vx, p.vy);
  if (sp < 0.6) return false;

  const ux = p.vx / (sp || 1);
  const uy = p.vy / (sp || 1);

  const dashPower = 560;
  p.vx += ux * dashPower;
  p.vy += uy * dashPower;

  p.dashCharges -= 1;
  p.dashUsedThisTurn = true;
  p.dashStrikeWindow = 0.20;

  // parry check if ring is active
  const boss = game.boss;
  if (game.mode === "boss" && boss && boss.rules.parryOnly && boss.ringActive) {
    const dx = p.x - boss.ringX;
    const dy = p.y - boss.ringY;
    const dist = Math.hypot(dx, dy);
    const hitRing = Math.abs(dist - boss.ringR) < 28;
    if (hitRing) {
      boss.ringActive = false;
      bossTakeDamage(game, 2, "PARRY", Math.atan2(p.y - boss.y, p.x - boss.x));
      game.toast = "Parry! Counter hit!";
      game.shake = Math.max(game.shake, 18);
      game.shakeT = Math.max(game.shakeT, 0.24);
    }
  }

  return true;
}

function startResolving(game) {
  game.turnState = "resolving";
}

function beginBossTurn(game) {
  if (!game.boss || game.boss.hp <= 0) return false;
  game.turnState = "boss_turn";
  game.turnMsLeft = 12000;
  game.bossPending = false;
  game.bossActionT = 0;

  // weakspot changes only on boss turn (turn based only)
  if (game.boss.rules.weakspot) {
    // rotate weak angle in 90 degree steps
    const steps = [0, Math.PI / 2, Math.PI, Math.PI * 1.5];
    const idx = (game.turnCount / game.bossActsEvery) % steps.length;
    game.boss.weakAngle = steps[idx];
  }

  // ring appears on boss turn if parryOnly
  if (game.boss.rules.parryOnly) {
    game.boss.ringActive = true;
    game.boss.ringR = 10;
    game.boss.ringX = game.boss.x;
    game.boss.ringY = game.boss.y;
    game.toast = "Shock ring! Dash through to parry.";
  } else {
    game.toast = `${game.boss.name} is acting`;
  }

  return true;
}

function endBossTurn(game) {
  // stop boss movement
  if (game.boss) {
    game.boss.vx = 0;
    game.boss.vy = 0;
  }

  game.turnState = "aim";
  game.turnMsLeft = 25000;

  // advance to next player
  game.turnIndex = (game.turnIndex + 1) % game.turnOrder.length;
  game.activeId = game.turnOrder[game.turnIndex];
}

function endPlayerTurn(game, reason) {
  game.turnState = "aim";
  game.turnMsLeft = 25000;

  game.turnCount += 1;

  // schedule boss action every 2nd player turn in boss mode
  if (game.mode === "boss" && game.boss && game.boss.hp > 0) {
    if (game.turnCount % game.bossActsEvery === 0) {
      game.bossPending = true;
    }
  }

  if (reason) game.toast = reason;

  // If boss pending, boss goes next without changing player index.
  if (game.mode === "boss" && game.bossPending) {
    // keep same next player index but boss turn happens now
    beginBossTurn(game);
    return;
  }

  // normal next player
  game.turnIndex = (game.turnIndex + 1) % game.turnOrder.length;
  game.activeId = game.turnOrder[game.turnIndex];
}

function bossDoAttack(game, dt) {
  const boss = game.boss;
  if (!boss) return;

  // ring expands only during boss turn
  if (boss.ringActive) {
    boss.ringR += 520 * dt;
    if (boss.ringR > 900) boss.ringActive = false;
  }

  // boss attacks are deterministic and only during boss turn
  game.bossActionT += dt;

  // choose target: closest alive
  let target = null;
  let bestD = Infinity;
  for (const pid of Object.keys(game.players)) {
    const p = game.players[pid];
    if (p.lives <= 0 || p.hp <= 0) continue;
    const d = Math.hypot(p.x - boss.x, p.y - boss.y);
    if (d < bestD) { bestD = d; target = p; }
  }

  if (!target) {
    // no alive players
    boss.vx *= 0.9;
    boss.vy *= 0.9;
    return;
  }

  // each boss has a style
  if (boss.attack === "charge") {
    // quick charge for first 0.9s then stop
    if (game.bossActionT < 0.9) {
      const dx = target.x - boss.x;
      const dy = target.y - boss.y;
      const d = Math.hypot(dx, dy) || 1;
      const ux = dx / d, uy = dy / d;
      boss.vx += ux * 900 * dt;
      boss.vy += uy * 900 * dt;
    } else {
      boss.vx *= 0.92;
      boss.vy *= 0.92;
    }
  } else if (boss.attack === "shock") {
    // small reposition and "push" wave effect (handled by collisions)
    if (game.bossActionT < 1.0) {
      const dx = target.x - boss.x;
      const dy = target.y - boss.y;
      const d = Math.hypot(dx, dy) || 1;
      const ux = dx / d, uy = dy / d;
      boss.vx += ux * 520 * dt;
      boss.vy += uy * 520 * dt;
    } else {
      boss.vx *= 0.92;
      boss.vy *= 0.92;
    }
  } else if (boss.attack === "ring") {
    // owl mostly stays, ring is the real mechanic
    boss.vx *= 0.92;
    boss.vy *= 0.92;
  }
}

function stepGame(game, dt) {
  if (!game) return;

  // shake decay
  if (game.shakeT > 0) game.shakeT = Math.max(0, game.shakeT - dt);
  if (game.shakeT <= 0) game.shake *= 0.90;

  // turn timer
  game.turnMsLeft -= dt * 1000;
  if (game.turnMsLeft <= 0 && game.phase === "play") {
    // auto end if time up
    if (game.turnState === "boss_turn") endBossTurn(game);
    else if (game.turnState === "aim") endPlayerTurn(game, "Time up");
    else if (game.turnState === "resolving") endPlayerTurn(game, "Time up");
  }

  // boss turn simulation
  if (game.mode === "boss" && game.turnState === "boss_turn" && game.phase === "play") {
    // boss only acts during boss_turn
    bossDoAttack(game, dt);

    // integrate boss physics
    const b = game.boss;
    if (b) {
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.vx *= Math.pow(b.friction, dt * 60);
      b.vy *= Math.pow(b.friction, dt * 60);
      clampSpeed(b, 1400);

      // collide boss with walls
      for (const w of game.walls) {
        if (circleRectCollide(b.x, b.y, b.r, w.x, w.y, w.w, w.h)) resolveCircleRect(b, w);
      }
    }

    // integrate players lightly (they can be hit by boss)
    for (const pid of Object.keys(game.players)) {
      const p = game.players[pid];
      p.magnetT = Math.max(0, p.magnetT - dt);

      // slow drift
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= Math.pow(p.friction, dt * 60);
      p.vy *= Math.pow(p.friction, dt * 60);

      if (Math.abs(p.vx) < 2) p.vx = 0;
      if (Math.abs(p.vy) < 2) p.vy = 0;

      for (const w of game.walls) {
        if (circleRectCollide(p.x, p.y, p.r, w.x, w.y, w.w, w.h)) resolveCircleRect(p, w);
      }
      for (const pad of game.pads) {
        if (circleRectCollide(p.x, p.y, p.r, pad.x, pad.y, pad.w, pad.h)) applyPadBoost(p);
      }

      // hazards damage
      for (const hz of game.hazards) {
        const d = Math.hypot(p.x - hz.x, p.y - hz.y);
        if (d <= p.r + hz.r) {
          if (game.mode === "boss") {
            if (p.shield) p.shield = false;
            else {
              p.hp = Math.max(0, p.hp - 1);
              game.toast = "Hazard hit!";
              game.shake = Math.max(game.shake, 10);
              game.shakeT = Math.max(game.shakeT, 0.16);
              if (p.hp <= 0) {
                p.lives -= 1;
                if (p.lives <= 0) { p.lives = 0; p.hp = 0; }
                else { p.hp = p.hpMax; }
              }
            }
          }
        }
      }

      if (outOfBounds(game, p)) respawnPlayer(game, p, "Out of bounds");
    }

    // boss hits players
    if (game.boss) {
      for (const pid of Object.keys(game.players)) {
        const p = game.players[pid];
        if (p.lives <= 0 || p.hp <= 0) continue;

        const d = Math.hypot(p.x - game.boss.x, p.y - game.boss.y);
        if (d <= p.r + game.boss.r) {
          // knockback
          const ux = (p.x - game.boss.x) / (d || 1);
          const uy = (p.y - game.boss.y) / (d || 1);
          p.vx += ux * 420;
          p.vy += uy * 420;

          // damage
          if (p.shield) {
            p.shield = false;
            game.toast = `${p.name} blocked the hit`;
          } else {
            p.hp = Math.max(0, p.hp - 2);
            game.toast = `${game.boss.name} hit ${p.name}`;
          }
          game.shake = Math.max(game.shake, 14);
          game.shakeT = Math.max(game.shakeT, 0.22);

          if (p.hp <= 0) {
            p.lives -= 1;
            if (p.lives <= 0) { p.lives = 0; p.hp = 0; }
            else { p.hp = p.hpMax; }
            respawnPlayer(game, p, "Lost a life");
          }
        }

        // parry punish if ring active and you touch ring without dashing
        const b = game.boss;
        if (b && b.rules.parryOnly && b.ringActive) {
          const rr = Math.hypot(p.x - b.ringX, p.y - b.ringY);
          const hitRing = Math.abs(rr - b.ringR) < 14;
          if (hitRing && p.dashStrikeWindow <= 0) {
            if (p.shield) p.shield = false;
            else p.hp = Math.max(0, p.hp - 1);
          }
        }
      }
    }

    // end boss turn when boss has mostly stopped and at least 1.3s passed
    const bossStopped = game.boss ? isStopped(game.boss) : true;
    if (game.bossActionT > 1.3 && bossStopped) {
      endBossTurn(game);
    }

    return;
  }

  // player resolving simulation
  if (game.turnState === "resolving" && game.phase === "play") {
    for (const pid of Object.keys(game.players)) {
      const p = game.players[pid];
      p.magnetT = Math.max(0, p.magnetT - dt);
      if (p.dashStrikeWindow > 0) p.dashStrikeWindow = Math.max(0, p.dashStrikeWindow - dt);

      applyMagnet(game, p, dt);

      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= Math.pow(p.friction, dt * 60);
      p.vy *= Math.pow(p.friction, dt * 60);

      if (Math.abs(p.vx) < 2) p.vx = 0;
      if (Math.abs(p.vy) < 2) p.vy = 0;

      clampSpeed(p, 1600);

      for (const w of game.walls) {
        if (circleRectCollide(p.x, p.y, p.r, w.x, w.y, w.w, w.h)) resolveCircleRect(p, w);
      }

      for (const pad of game.pads) {
        if (circleRectCollide(p.x, p.y, p.r, pad.x, pad.y, pad.w, pad.h)) applyPadBoost(p);
      }

      // race coins
      for (const c of game.coins) {
        if (c.takenBy) continue;
        const d = Math.hypot(p.x - c.x, p.y - c.y);
        if (d <= p.r + c.r) {
          c.takenBy = pid;
          p.coins += 10;
          p.score += 25;
        }
      }

      // items
      for (const it of game.items) {
        if (it.takenBy) continue;
        const d = Math.hypot(p.x - it.x, p.y - it.y);
        if (d <= p.r + it.r) {
          it.takenBy = pid;
          if (it.type === "dash") p.dashCharges += 1;
          if (it.type === "shield") p.shield = true;
          if (it.type === "magnet") p.magnetT = 6.0;
        }
      }

      // traps (race)
      for (const t of game.traps) {
        const d = Math.hypot(p.x - t.x, p.y - t.y);
        if (d <= p.r + t.r) {
          if (p.shield) p.shield = false;
          else {
            // soft reset to spawn
            respawnPlayer(game, p, "Trap hit");
          }
        }
      }

      // hazards (boss)
      for (const hz of game.hazards) {
        const d = Math.hypot(p.x - hz.x, p.y - hz.y);
        if (d <= p.r + hz.r) {
          if (game.mode === "boss") {
            if (p.shield) p.shield = false;
            else p.hp = Math.max(0, p.hp - 1);
          }
        }
      }

      if (outOfBounds(game, p)) respawnPlayer(game, p, "Out of bounds");
    }

    // boss collisions and player dealing damage (only in boss mode during player resolve)
    if (game.mode === "boss" && game.boss && game.boss.hp > 0) {
      const b = game.boss;
      for (const pid of Object.keys(game.players)) {
        const p = game.players[pid];
        if (p.lives <= 0 || p.hp <= 0) continue;

        const dx = p.x - b.x;
        const dy = p.y - b.y;
        const dist = Math.hypot(dx, dy);

        if (dist <= p.r + b.r) {
          const ux = dx / (dist || 1);
          const uy = dy / (dist || 1);
          p.vx += ux * 220;
          p.vy += uy * 220;

          const ang = Math.atan2(dy, dx);

          // damage rules
          if (b.rules.parryOnly) {
            // only parry works, handled in dash
          } else if (b.rules.dashOnly) {
            if (p.dashStrikeWindow > 0) {
              bossTakeDamage(game, 2, "DASH", ang);
              p.dashStrikeWindow = 0;
            }
          } else if (b.rules.weakspot) {
            // allow either dash or strong impact, but must hit weak spot
            const sp = Math.hypot(p.vx, p.vy);
            if (sp > 140) {
              bossTakeDamage(game, p.dashStrikeWindow > 0 ? 2 : 1, p.dashStrikeWindow > 0 ? "DASH" : "BODY", ang);
              p.dashStrikeWindow = 0;
            }
          } else {
            // default: any hard hit
            const sp = Math.hypot(p.vx, p.vy);
            if (sp > 160) bossTakeDamage(game, 1, "BODY", ang);
          }
        }
      }
    }

    // race finish check
    if (game.mode === "race" && game.finish) {
      for (const pid of Object.keys(game.players)) {
        const p = game.players[pid];
        if (p.finished) continue;
        if (circleRectCollide(p.x, p.y, p.r, game.finish.x, game.finish.y, game.finish.w, game.finish.h)) {
          p.finished = true;
          game.winnerId = pid;
          game.phase = "round_end";
          game.toast = `Winner: ${p.name}`;
          p.score += 120;
          p.coins += 20;
        }
      }
    }

    // boss win check
    if (game.mode === "boss" && game.boss && game.boss.hp <= 0) {
      game.phase = "round_end";
      game.toast = `${game.boss.name} defeated!`;
      for (const pid of Object.keys(game.players)) {
        const p = game.players[pid];
        p.score += 100;
        p.coins += 40;
      }
    }

    // end resolving when everyone stopped
    const allStopped = Object.values(game.players).every(pl => isStopped(pl));
    if (allStopped) {
      endPlayerTurn(game, null);
    }
  }
}

function nextRound(game) {
  game.round += 1;
  game.phase = "play";
  game.winnerId = null;
  game.toast = "";

  // rotate starting player
  game.turnOrder.push(game.turnOrder.shift());
  game.turnIndex = 0;
  game.activeId = game.turnOrder[0];
  game.turnState = "aim";
  game.turnMsLeft = 25000;

  if (game.mode === "race") {
    loadRaceMap(game, game.mapIndex + 1);
  } else {
    // next boss + next arena
    loadBossStage(game, game.bossIndex + 1);
  }
}

function makeSnapshot(room) {
  const lobby = room.lobby;
  const game = room.game;

  const lobbyPlayers = [];
  for (const [pid, meta] of room.players.entries()) {
    const ready = !!lobby.ready[pid];
    const pick = lobby.picks[pid] || meta.charId || "agouti";
    lobbyPlayers.push({
      id: pid,
      name: meta.name,
      charId: pick,
      colorIndex: meta.colorIndex,
      ready
    });
  }

  // stable order: host first, then others
  lobbyPlayers.sort((a, b) => {
    if (a.id === room.hostId) return -1;
    if (b.id === room.hostId) return 1;
    return a.name.localeCompare(b.name);
  });

  return {
    t: "snap",
    serverTime: nowMs(),
    room: { code: room.code, hostId: room.hostId },
    lobby: {
      started: lobby.started,
      mode: lobby.mode,
      maxPlayers: lobby.maxPlayers,
      players: lobbyPlayers
    },
    game: game ? {
      mode: game.mode,
      round: game.round,
      phase: game.phase,
      winnerId: game.winnerId,

      turn: {
        activeId: game.activeId,
        state: game.turnState,
        msLeft: Math.max(0, Math.floor(game.turnMsLeft)),
        order: game.turnOrder,
        turnCount: game.turnCount,
        bossActsEvery: game.bossActsEvery
      },

      W: game.W,
      H: game.H,
      bounds: game.bounds,
      mapId: game.mapId,
      mapName: game.mapName,

      finish: game.finish,
      walls: game.walls,
      pads: game.pads,
      traps: game.traps,
      hazards: game.hazards,
      coins: game.coins,
      items: game.items,

      players: game.players,
      boss: game.boss ? {
        id: game.boss.id,
        name: game.boss.name,
        hp: game.boss.hp,
        hpMax: game.boss.hpMax,
        x: game.boss.x,
        y: game.boss.y,
        r: game.boss.r,
        rules: game.boss.rules,
        hint: game.boss.hint,
        weakAngle: game.boss.weakAngle,
        weakArc: game.boss.weakArc,
        ringActive: game.boss.ringActive,
        ringR: game.boss.ringR,
        ringX: game.boss.ringX,
        ringY: game.boss.ringY
      } : null,

      hint: game.hint,
      toast: game.toast,
      shake: game.shakeT > 0 ? game.shake : 0
    } : null
  };
}

// -------------------------
// ROOM LOOP
// -------------------------

function ensureRoomLoop(room) {
  if (room._loop) return;
  room._loop = setInterval(() => {
    if (!room.game) return;

    const t = nowMs();
    const dt = Math.min(0.05, (t - room.lastTick) / 1000);
    room.lastTick = t;

    stepGame(room.game, dt);

    room.lastSnap += dt;
    if (room.lastSnap >= (1 / SNAP_HZ)) {
      room.lastSnap = 0;
      broadcast(room, makeSnapshot(room));
      if (room.game) room.game.toast = "";
    }

    if (room.game && room.game.phase === "round_end") {
      room.game._endT = (room.game._endT || 0) + dt;
      if (room.game._endT > 2.0) {
        room.game._endT = 0;
        nextRound(room.game);
        broadcast(room, makeSnapshot(room));
      }
    }
  }, Math.floor(1000 / TICK_HZ));
}

// -------------------------
// WEBSOCKET HANDLERS
// -------------------------

wss.on("connection", (ws) => {
  ws.roomCode = null;
  ws.playerId = null;

  send(ws, { t: "hello" });

  ws.on("message", (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return; }

    // CREATE (creates room AND joins)
    if (msg.t === "create") {
      const code = makeRoomCode();
      const room = makeRoom(code);
      rooms.set(code, room);

      const pid = randId();
      const name = sanitizeName(msg.name);
      const colorIndex = Math.floor(Math.random() * 8);

      ws.roomCode = code;
      ws.playerId = pid;

      room.clients.set(ws, pid);
      room.players.set(pid, { id: pid, name, charId: "agouti", colorIndex });
      room.lobby.ready[pid] = false;
      room.lobby.picks[pid] = "agouti";

      room.hostId = pid;

      send(ws, { t: "joined", id: pid, code, hostId: room.hostId });
      broadcast(room, makeSnapshot(room));
      return;
    }

    // JOIN
    if (msg.t === "join") {
      const code = String(msg.code || "").trim().toUpperCase().slice(0, 6);
      if (!code) return send(ws, { t: "err", m: "No room code." });

      let room = rooms.get(code);
      if (!room) {
        room = makeRoom(code);
        rooms.set(code, room);
      }

      if (room.clients.size >= room.lobby.maxPlayers) {
        return send(ws, { t: "err", m: "Room full." });
      }

      const pid = randId();
      const name = sanitizeName(msg.name);
      const colorIndex = Math.floor(Math.random() * 8);

      ws.roomCode = code;
      ws.playerId = pid;

      room.clients.set(ws, pid);
      room.players.set(pid, { id: pid, name, charId: "agouti", colorIndex });

      if (!room.hostId) room.hostId = pid;

      room.lobby.ready[pid] = false;
      room.lobby.picks[pid] = "agouti";

      send(ws, { t: "joined", id: pid, code, hostId: room.hostId });
      broadcast(room, makeSnapshot(room));
      return;
    }

    // Must be in a room beyond this point
    const room = ws.roomCode ? rooms.get(ws.roomCode) : null;
    if (!room) return;

    const pid = ws.playerId;

    // Host can set mode in lobby
    if (msg.t === "set_mode") {
      if (pid !== room.hostId) return;
      if (room.lobby.started) return;
      room.lobby.mode = (msg.mode === "boss") ? "boss" : "race";
      broadcast(room, makeSnapshot(room));
      return;
    }

    // Player pick
    if (msg.t === "pick") {
      if (room.lobby.started) return;
      const charId = String(msg.charId || "agouti");
      room.lobby.picks[pid] = charId;
      room.lobby.ready[pid] = false;

      const meta = room.players.get(pid);
      if (meta) meta.charId = charId;

      broadcast(room, makeSnapshot(room));
      return;
    }

    // Ready toggle
    if (msg.t === "ready") {
      if (room.lobby.started) return;
      room.lobby.ready[pid] = !!msg.v;
      broadcast(room, makeSnapshot(room));
      return;
    }

    // Host start
    if (msg.t === "start") {
      if (pid !== room.hostId) return;
      if (room.lobby.started) return;

      const ids = Array.from(room.players.keys());
      if (ids.length < 1) return;

      // require everyone ready
      for (const id of ids) {
        if (!room.lobby.ready[id]) {
          send(ws, { t: "err", m: "Everyone must be Ready." });
          return;
        }
      }

      room.lobby.started = true;
      room.game = makeGame(room.lobby.mode, ids, room.players, room.lobby.picks);
      room.lastTick = nowMs();
      room.lastSnap = 0;

      ensureRoomLoop(room);
      broadcast(room, makeSnapshot(room));
      return;
    }

    // Host reset match
    if (msg.t === "reset") {
      if (pid !== room.hostId) return;
      room.lobby.started = false;
      room.game = null;
      // keep players, reset readiness
      room.lobby.ready = {};
      for (const id of room.players.keys()) room.lobby.ready[id] = false;
      broadcast(room, makeSnapshot(room));
      return;
    }

    // Host reload map (same stage)
    if (msg.t === "reload_map") {
      if (pid !== room.hostId) return;
      if (!room.game) return;

      const g = room.game;
      if (g.mode === "race") {
        loadRaceMap(g, g.mapIndex);
      } else {
        loadBossStage(g, g.bossIndex);
      }
      broadcast(room, makeSnapshot(room));
      return;
    }

    // Host reset positions (no stage change)
    if (msg.t === "reset_positions") {
      if (pid !== room.hostId) return;
      if (!room.game) return;

      const g = room.game;
      const ids = g.turnOrder;

      for (let i = 0; i < ids.length; i++) {
        const p = g.players[ids[i]];
        const s = (g.spawns && g.spawns[i]) ? g.spawns[i] : { x: 120, y: 240 + i * 70 };
        p.x = s.x; p.y = s.y; p.vx = 0; p.vy = 0;
      }
      if (g.boss) {
        // reset boss to spawn location for this arena
        const arena = findArena(g.mapId);
        const spawn = arena.bossSpawn || { x: g.W * 0.8, y: g.H * 0.5 };
        g.boss.x = spawn.x; g.boss.y = spawn.y; g.boss.vx = 0; g.boss.vy = 0;
      }

      broadcast(room, makeSnapshot(room));
      return;
    }

    // Gameplay inputs
    if (msg.t === "act") {
      if (!room.game) return;
      const g = room.game;
      if (g.phase !== "play") return;

      // Only active player can act, and only during aim
      if (g.activeId !== pid) return;
      if (g.turnState !== "aim") return;

      if (msg.kind === "flick") {
        const vx = clamp(Number(msg.vx || 0), -2400, 2400);
        const vy = clamp(Number(msg.vy || 0), -2400, 2400);
        applyFlick(g, pid, vx, vy);
        startResolving(g);
        g.toast = `${g.players[pid].name} launched`;
        broadcast(room, makeSnapshot(room));
        return;
      }
    }

    if (msg.t === "dash") {
      if (!room.game) return;
      const g = room.game;
      if (g.phase !== "play") return;
      if (g.activeId !== pid) return;
      if (g.turnState !== "resolving") return;

      const ok = applyDash(g, pid);
      if (ok) {
        g.toast = "Dash!";
        broadcast(room, makeSnapshot(room));
      }
      return;
    }
  });

  ws.on("close", () => {
    const room = ws.roomCode ? rooms.get(ws.roomCode) : null;
    if (!room) return;

    const pid = ws.playerId;

    room.clients.delete(ws);
    room.players.delete(pid);
    delete room.lobby.ready[pid];
    delete room.lobby.picks[pid];

    // host migration
    if (pid === room.hostId) {
      const next = room.players.keys().next().value || null;
      room.hostId = next;
    }

    // if game running, remove player
    if (room.game && room.game.players[pid]) {
      delete room.game.players[pid];
      room.game.turnOrder = room.game.turnOrder.filter(x => x !== pid);
      if (room.game.turnOrder.length > 0) {
        room.game.turnIndex = room.game.turnIndex % room.game.turnOrder.length;
        room.game.activeId = room.game.turnOrder[room.game.turnIndex];
      } else {
        room.game = null;
        room.lobby.started = false;
      }
    }

    if (room.players.size === 0) {
      if (room._loop) clearInterval(room._loop);
      rooms.delete(room.code);
    } else {
      broadcast(room, makeSnapshot(room));
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
