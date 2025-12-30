// server.js
// Run:
//   npm i ws express
//   node server.js
// Open:
//   http://localhost:3000
//
// Notes:
// - This server now supports player names and sends lobby.players as objects:
//   [{ id, name, ready, pick }]
// - Fixes "undefined" in lobby UI and enables proper Ready / Start flow.
// - Adds host actions: host_reload_map, host_reset_positions
// - Adds safety respawn if a player flies off the map.
// - Adds more complex maze-like race maps (still 960x540 because client has no camera scroll).

const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();
app.use(express.static("."));

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

function getRoom(code) {
  return rooms.get(code);
}

function makeRoom(code) {
  return {
    code,
    createdAt: nowMs(),

    // ws -> pid
    clients: new Map(),

    // pid -> ws
    socketsById: new Map(),

    hostId: null,

    // pid -> meta
    playerMeta: {},

    lobby: {
      mode: "race", // "race" | "boss"
      started: false,
      picks: {},  // pid -> characterId
      ready: {},  // pid -> bool
      maxPlayers: 4,
    },

    game: null,
    lastTick: nowMs(),
    lastSnap: 0,
  };
}

// -------------------------
// GAME SIMULATION (SERVER)
// -------------------------

function makeGame(mode, playerIds, picks) {
  const game = {
    mode,
    round: 1,
    phase: "play", // play | round_end
    winnerId: null,

    // turn
    turnIndex: 0,
    turnOrder: [...playerIds],
    turnState: "aim", // aim | resolving
    turnMsLeft: 25000,
    activeId: playerIds[0],

    // world (client canvas is 960x540)
    W: 960,
    H: 540,
    bounds: { x: 20, y: 20, w: 920, h: 500 },

    levelId: "maze_long_1",
    finish: null,
    walls: [],
    pads: [],
    traps: [],
    coins: [],
    items: [],

    players: {}, // pid -> playerState
    boss: null,

    bossIndex: 0,

    hint: "",
    toast: "",
    shake: 0,
    shakeT: 0,
  };

  // spawn players
  const startY = game.H / 2;
  for (let i = 0; i < playerIds.length; i++) {
    const pid = playerIds[i];
    const charId = picks[pid] || "agouti";
    game.players[pid] = makePlayer(pid, charId, 110, startY + (i - playerIds.length / 2) * 44);
  }

  if (mode === "race") buildRaceLevel(game, game.levelId);
  else buildBossRound(game);

  if (mode === "race") game.hint = "Race to the finish. One flick per turn. First to touch wins.";
  return game;
}

function makePlayer(pid, charId, x, y) {
  const p = {
    id: pid,
    charId,
    x, y, vx: 0, vy: 0, r: 18,

    firstLaunchAvailable: true,
    dashCharges: 0,
    shield: false,
    magnetT: 0,

    canDashThisTurn: false,
    dashUsedThisTurn: false,
    dashStrikeWindow: 0,

    score: 0,
    coins: 0,
    finished: false,

    bounceKeep: 0.78,
    friction: 0.985,
  };

  if (charId === "frog") p.bounceKeep = 0.90;

  return p;
}

function resetRoundPerks(game) {
  for (const pid of Object.keys(game.players)) {
    const p = game.players[pid];
    p.firstLaunchAvailable = true;
    p.magnetT = 0;
    p.finished = false;
    p.dashUsedThisTurn = false;
    p.dashStrikeWindow = 0;

    p.dashCharges = (p.charId === "hummingbird") ? 1 : 0;
    p.shield = (p.charId === "manicou");
  }
}

function baseBounds(game) {
  const b = game.bounds;
  return [
    { x: b.x, y: b.y, w: b.w, h: 12 },
    { x: b.x, y: b.y + b.h - 12, w: b.w, h: 12 },
    { x: b.x, y: b.y, w: 12, h: b.h },
    { x: b.x + b.w - 12, y: b.y, w: 12, h: b.h },
  ];
}

function addMazeWalls(game, segments) {
  for (const s of segments) game.walls.push(s);
}

// More complex maps, still inside 960x540
const RACE_LEVELS = [
  "maze_long_1",
  "maze_long_2",
  "maze_long_3",
  "maze_long_4",
];

function buildRaceLevel(game, levelId) {
  game.levelId = levelId;
  game.boss = null;
  game.winnerId = null;
  game.phase = "play";
  game.turnState = "aim";
  game.turnMsLeft = 25000;

  game.walls = baseBounds(game);
  game.pads = [];
  game.traps = [];
  game.coins = [];
  game.items = [];

  // Helper: corridors style map like your reference (lots of right angles)
  if (levelId === "maze_long_1") {
    addMazeWalls(game, [
      // big outer-ish corridors
      { x: 80, y: 70, w: 520, h: 20 },
      { x: 80, y: 70, w: 20, h: 330 },
      { x: 80, y: 380, w: 360, h: 20 },
      { x: 420, y: 220, w: 20, h: 180 },
      { x: 260, y: 220, w: 180, h: 20 },
      { x: 260, y: 150, w: 20, h: 90 },

      // mid labyrinth
      { x: 170, y: 140, w: 260, h: 18 },
      { x: 170, y: 140, w: 18, h: 140 },
      { x: 170, y: 262, w: 220, h: 18 },
      { x: 372, y: 262, w: 18, h: 90 },
      { x: 240, y: 334, w: 150, h: 18 },

      // right side path
      { x: 560, y: 110, w: 18, h: 320 },
      { x: 560, y: 110, w: 260, h: 18 },
      { x: 800, y: 110, w: 18, h: 260 },
      { x: 640, y: 200, w: 178, h: 18 },
      { x: 640, y: 200, w: 18, h: 180 },
      { x: 640, y: 360, w: 220, h: 18 },

      // blockers
      { x: 500, y: 160, w: 80, h: 18 },
      { x: 500, y: 300, w: 80, h: 18 },
    ]);

    game.finish = { x: game.W - 170, y: 70, w: 110, h: 80 };

    game.pads = [
      { x: 120, y: 430, w: 120, h: 16 },
      { x: 690, y: 430, w: 150, h: 16 },
    ];

    game.traps = [
      { x: 330, y: 205, r: 14 },
      { x: 610, y: 260, r: 14 },
      { x: 760, y: 180, r: 14 },
    ];

    game.coins = [
      { x: 140, y: 105 }, { x: 210, y: 310 }, { x: 360, y: 115 },
      { x: 520, y: 455 }, { x: 610, y: 145 }, { x: 740, y: 330 },
      { x: 860, y: 250 }
    ].map(c => ({ ...c, r: 10, takenBy: null }));

    game.items = [
      { type: "dash", x: 230, y: 110, r: 12, takenBy: null },
      { type: "shield", x: 360, y: 455, r: 12, takenBy: null },
      { type: "magnet", x: 720, y: 145, r: 12, takenBy: null },
    ];
  }

  if (levelId === "maze_long_2") {
    addMazeWalls(game, [
      // left maze block
      { x: 90, y: 90, w: 18, h: 340 },
      { x: 90, y: 90, w: 300, h: 18 },
      { x: 390, y: 90, w: 18, h: 220 },
      { x: 170, y: 160, w: 18, h: 270 },
      { x: 170, y: 160, w: 240, h: 18 },
      { x: 250, y: 240, w: 158, h: 18 },
      { x: 250, y: 240, w: 18, h: 190 },
      { x: 250, y: 410, w: 250, h: 18 },

      // right maze lanes
      { x: 480, y: 70, w: 18, h: 420 },
      { x: 480, y: 70, w: 360, h: 18 },
      { x: 820, y: 70, w: 18, h: 240 },
      { x: 590, y: 150, w: 250, h: 18 },
      { x: 590, y: 150, w: 18, h: 260 },
      { x: 610, y: 392, w: 230, h: 18 },
      { x: 720, y: 230, w: 18, h: 180 },
    ]);

    game.finish = { x: game.W - 170, y: 410, w: 110, h: 80 };

    game.pads = [
      { x: 120, y: 55, w: 130, h: 16 },
      { x: 700, y: 500 - 10, w: 170, h: 16 },
    ];

    game.traps = [
      { x: 320, y: 360, r: 14 },
      { x: 640, y: 300, r: 14 },
      { x: 790, y: 210, r: 14 },
    ];

    game.coins = [
      { x: 140, y: 450 }, { x: 230, y: 120 }, { x: 310, y: 200 },
      { x: 420, y: 470 }, { x: 560, y: 110 }, { x: 680, y: 220 },
      { x: 760, y: 470 }
    ].map(c => ({ ...c, r: 10, takenBy: null }));

    game.items = [
      { type: "dash", x: 560, y: 455, r: 12, takenBy: null },
      { type: "shield", x: 310, y: 470, r: 12, takenBy: null },
      { type: "magnet", x: 760, y: 110, r: 12, takenBy: null },
    ];
  }

  if (levelId === "maze_long_3") {
    addMazeWalls(game, [
      // zig corridor
      { x: 80, y: 90, w: 600, h: 18 },
      { x: 80, y: 90, w: 18, h: 360 },
      { x: 80, y: 432, w: 420, h: 18 },
      { x: 482, y: 220, w: 18, h: 230 },
      { x: 240, y: 220, w: 260, h: 18 },
      { x: 240, y: 140, w: 18, h: 98 },
      { x: 240, y: 140, w: 560, h: 18 },
      { x: 782, y: 140, w: 18, h: 300 },

      // inner blockers
      { x: 160, y: 160, w: 120, h: 18 },
      { x: 160, y: 160, w: 18, h: 170 },
      { x: 160, y: 312, w: 180, h: 18 },
      { x: 320, y: 312, w: 18, h: 110 },
      { x: 320, y: 404, w: 160, h: 18 },

      { x: 560, y: 180, w: 18, h: 240 },
      { x: 560, y: 180, w: 170, h: 18 },
      { x: 712, y: 180, w: 18, h: 170 },
      { x: 610, y: 332, w: 120, h: 18 },
    ]);

    game.finish = { x: game.W - 170, y: 70, w: 110, h: 80 };

    game.pads = [
      { x: 120, y: 500 - 22, w: 130, h: 16 },
      { x: 690, y: 110, w: 150, h: 16 },
    ];

    game.traps = [
      { x: 360, y: 250, r: 14 },
      { x: 620, y: 250, r: 14 },
      { x: 740, y: 420, r: 14 },
    ];

    game.coins = [
      { x: 120, y: 130 }, { x: 200, y: 420 }, { x: 340, y: 180 },
      { x: 470, y: 470 }, { x: 590, y: 420 }, { x: 740, y: 210 },
      { x: 850, y: 470 }
    ].map(c => ({ ...c, r: 10, takenBy: null }));

    game.items = [
      { type: "dash", x: 430, y: 470, r: 12, takenBy: null },
      { type: "shield", x: 610, y: 210, r: 12, takenBy: null },
      { type: "magnet", x: 200, y: 130, r: 12, takenBy: null },
    ];
  }

  if (levelId === "maze_long_4") {
    addMazeWalls(game, [
      // blocky spiral-ish maze
      { x: 120, y: 80, w: 720, h: 18 },
      { x: 120, y: 80, w: 18, h: 380 },
      { x: 120, y: 442, w: 560, h: 18 },
      { x: 662, y: 200, w: 18, h: 260 },
      { x: 260, y: 200, w: 420, h: 18 },
      { x: 260, y: 200, w: 18, h: 170 },
      { x: 260, y: 352, w: 320, h: 18 },
      { x: 562, y: 120, w: 18, h: 250 },
      { x: 340, y: 120, w: 240, h: 18 },
      { x: 340, y: 120, w: 18, h: 170 },
      { x: 340, y: 272, w: 160, h: 18 },

      // right side gates
      { x: 740, y: 110, w: 18, h: 290 },
      { x: 600, y: 110, w: 158, h: 18 },
      { x: 600, y: 382, w: 158, h: 18 },
    ]);

    game.finish = { x: game.W - 170, y: 430, w: 110, h: 80 };

    game.pads = [
      { x: 150, y: 110, w: 130, h: 16 },
      { x: 650, y: 500 - 22, w: 190, h: 16 },
    ];

    game.traps = [
      { x: 500, y: 250, r: 14 },
      { x: 720, y: 250, r: 14 },
      { x: 300, y: 430, r: 14 },
    ];

    game.coins = [
      { x: 160, y: 470 }, { x: 220, y: 140 }, { x: 380, y: 160 },
      { x: 520, y: 450 }, { x: 680, y: 160 }, { x: 820, y: 250 },
      { x: 860, y: 470 }
    ].map(c => ({ ...c, r: 10, takenBy: null }));

    game.items = [
      { type: "dash", x: 420, y: 450, r: 12, takenBy: null },
      { type: "shield", x: 820, y: 250, r: 12, takenBy: null },
      { type: "magnet", x: 220, y: 140, r: 12, takenBy: null },
    ];
  }

  // fallback if unknown level
  if (!game.finish) {
    game.finish = { x: game.W - 170, y: 90, w: 110, h: 80 };
  }

  // reset players positions and perks
  resetPlayersToSpawn(game);
  resetRoundPerks(game);

  game.hint = "Race to the finish. One flick per turn. First to touch wins.";
}

function resetPlayersToSpawn(game) {
  const ids = game.turnOrder;
  const startY = game.H / 2;
  for (let i = 0; i < ids.length; i++) {
    const p = game.players[ids[i]];
    if (!p) continue;
    p.x = 110;
    p.y = startY + (i - ids.length / 2) * 44;
    p.vx = 0; p.vy = 0;
    p.finished = false;
  }
}

const BOSS_DEFS = [
  {
    id: "armored_crab",
    name: "Armored Crab King",
    hp: 12,
    rules: ["DASH_ONLY"],
    hint: "Only dash strikes hurt it. Use dash during your movement to ram it."
  },
  {
    id: "spirit_owl",
    name: "Spirit Owl Warden",
    hp: 10,
    rules: ["PARRY_ONLY"],
    hint: "Parry the shockwave. Dash through the expanding ring at the right time."
  },
  {
    id: "reef_golem",
    name: "Reef Golem",
    hp: 14,
    rules: ["WEAKSPOT_CYCLE"],
    hint: "Hit the glowing weak spot. It moves every few seconds."
  },
  {
    id: "storm_manta",
    name: "Storm Manta",
    hp: 14,
    rules: ["RICOCHET_REQUIRED", "WEAKSPOT_CYCLE"],
    hint: "Boss takes damage only after a wall bounce, then hit the weak glow."
  },
  {
    id: "totem_jaguar",
    name: "Totem Jaguar",
    hp: 16,
    rules: ["STUN_THEN_PUNISH"],
    hint: "Stun it first. Hit arena objects into it to drop its shield, then strike fast."
  },
];

function pickBossByIndex(i) {
  return BOSS_DEFS[i % BOSS_DEFS.length];
}

function buildBossRound(game) {
  game.finish = null;
  game.walls = baseBounds(game);
  game.pads = [];
  game.traps = [];
  game.coins = [];
  game.items = [];
  game.phase = "play";
  game.winnerId = null;
  game.turnState = "aim";
  game.turnMsLeft = 25000;

  // slightly more interesting arena than before
  game.walls.push({ x: 210, y: 90, w: 18, h: 360 });
  game.walls.push({ x: 330, y: 130, w: 260, h: 18 });
  game.walls.push({ x: 330, y: 392, w: 260, h: 18 });
  game.walls.push({ x: 590, y: 130, w: 18, h: 280 });
  game.walls.push({ x: 430, y: 210, w: 18, h: 120 });

  game.pads = [
    { x: 120, y: 250, w: 120, h: 16 },
    { x: 720, y: 250, w: 170, h: 16 },
  ];

  game.coins = [
    { x: 170, y: 110 }, { x: 170, y: 410 }, { x: 520, y: 110 },
    { x: 520, y: 410 }, { x: 780, y: 150 }, { x: 780, y: 370 }
  ].map(c => ({ ...c, r: 10, takenBy: null }));

  const bdef = pickBossByIndex(game.bossIndex);
  game.bossIndex++;

  game.boss = {
    id: bdef.id,
    name: bdef.name,
    rules: [...bdef.rules],
    hp: bdef.hp,
    hpMax: bdef.hp,
    x: game.W * 0.72,
    y: game.H * 0.50,
    r: 44,
    t: 0,

    weakAngle: 0,
    weakArc: Math.PI / 3,
    weakCycleS: 1.8,

    ring: { active: false, r: 0, spd: 220, cd: 1.2, x: 0, y: 0 },

    stunnedT: 0,
    shielded: (bdef.rules.includes("STUN_THEN_PUNISH")),
    stunHits: 0,
  };

  game.hint = bdef.hint;
  game.toast = `${bdef.name} appeared. ${bdef.hint}`;
  game.shake = 0;
  game.shakeT = 0;

  // items based on boss rules
  if (game.boss.rules.includes("DASH_ONLY") || game.boss.rules.includes("PARRY_ONLY")) {
    game.items.push({ type: "dash", x: 320, y: 110, r: 12, takenBy: null });
    game.items.push({ type: "dash", x: 320, y: 410, r: 12, takenBy: null });
  }

  // Add a couple throwable "stones" that can be used to stun in STUN_THEN_PUNISH.
  // Client draws unknown items fine.
  if (game.boss.rules.includes("STUN_THEN_PUNISH")) {
    game.items.push({ type: "stone", x: 420, y: 250, r: 16, vx: 0, vy: 0 });
    game.items.push({ type: "stone", x: 520, y: 250, r: 16, vx: 0, vy: 0 });
  }

  game.items.push({ type: "shield", x: 320, y: 250, r: 12, takenBy: null });
  game.items.push({ type: "magnet", x: 780, y: 260, r: 12, takenBy: null });

  resetPlayersToSpawn(game);
  resetRoundPerks(game);
}

function circleRectCollide(cx, cy, cr, rx, ry, rw, rh) {
  const nx = clamp(cx, rx, rx + rw);
  const ny = clamp(cy, ry, ry + rh);
  const dx = cx - nx;
  const dy = cy - ny;
  return dx * dx + dy * dy <= cr * cr;
}

function resolveCircleRect(p, w) {
  const rx = w.x, ry = w.y, rw = w.w, rh = w.h;
  const cx = p.x, cy = p.y, cr = p.r;

  const nx = clamp(cx, rx, rx + rw);
  const ny = clamp(cy, ry, ry + rh);
  let dx = cx - nx;
  let dy = cy - ny;
  let dist = Math.hypot(dx, dy);
  if (dist === 0) { dx = 0; dy = -1; dist = 1; }

  const overlap = cr - dist;
  if (overlap > 0) {
    const ux = dx / dist, uy = dy / dist;
    p.x += ux * overlap;
    p.y += uy * overlap;

    const dot = p.vx * ux + p.vy * uy;
    p.vx = p.vx - 2 * dot * ux;
    p.vy = p.vy - 2 * dot * uy;

    p.vx *= p.bounceKeep;
    p.vy *= p.bounceKeep;

    // extra damping after collision so control returns faster
    p.vx *= 0.90;
    p.vy *= 0.90;
  }
}

function clampSpeed(p, maxSp) {
  const sp = Math.hypot(p.vx, p.vy);
  if (sp > maxSp) {
    const s = maxSp / sp;
    p.vx *= s; p.vy *= s;
  }
}

function angleDiff(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function isStopped(p) {
  return Math.hypot(p.vx, p.vy) < 6;
}

function applyPadBoost(p) {
  p.vx *= 1.22;
  p.vy *= 1.22;
}

function applyMagnet(game, p, dt) {
  if (p.magnetT <= 0) return;
  const radius = 150;
  const strength = 800;
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

function bossTakeDamage(game, amount, source, hitAngle = null) {
  const boss = game.boss;
  if (!boss) return false;

  if (boss.rules.includes("DASH_ONLY") && source !== "DASH") return false;
  if (boss.rules.includes("PARRY_ONLY") && source !== "PARRY") return false;

  if (boss.rules.includes("STUN_THEN_PUNISH")) {
    if (boss.shielded) return false;
  }

  if (boss.rules.includes("RICOCHET_REQUIRED") && source !== "RICOCHET_OK") return false;

  if (boss.rules.includes("WEAKSPOT_CYCLE")) {
    if (hitAngle == null) return false;
    const d = Math.abs(angleDiff(hitAngle, boss.weakAngle));
    if (d > boss.weakArc * 0.5) return false;
  }

  boss.hp = Math.max(0, boss.hp - amount);
  game.shake = Math.max(game.shake, 12 + amount * 2);
  game.shakeT = Math.max(game.shakeT, 0.18);
  game.toast = "Boss hit!";
  return true;
}

function updateBoss(game, dt) {
  const boss = game.boss;
  if (!boss) return;

  boss.t += dt;

  const tx = game.W * 0.72 + Math.sin(boss.t * 1.1) * 70;
  const ty = game.H * 0.50 + Math.cos(boss.t * 0.9) * 70;
  boss.x += (tx - boss.x) * 0.9 * dt;
  boss.y += (ty - boss.y) * 0.9 * dt;

  if (boss.rules.includes("WEAKSPOT_CYCLE")) {
    const phase = Math.floor(boss.t / boss.weakCycleS) % 4;
    boss.weakAngle = phase * (Math.PI / 2);
  }

  if (boss.rules.includes("STUN_THEN_PUNISH")) {
    if (!boss.shielded && boss.stunnedT > 0) boss.stunnedT = Math.max(0, boss.stunnedT - dt);
    if (boss.stunnedT <= 0 && !boss.shielded) {
      boss.shielded = true;
      boss.stunHits = 0;
    }
  }

  if (boss.rules.includes("PARRY_ONLY") && boss.ring) {
    boss.ring.cd -= dt;
    if (!boss.ring.active && boss.ring.cd <= 0) {
      boss.ring.active = true;
      boss.ring.x = boss.x;
      boss.ring.y = boss.y;
      boss.ring.r = 10;
      boss.ring.cd = 2.1;
      game.toast = "Shockwave. Dash through the ring to parry.";
    }
    if (boss.ring.active) {
      boss.ring.r += boss.ring.spd * dt;
      if (boss.ring.r > 540) boss.ring.active = false;
    }
  }
}

function updateStoneItems(game, dt) {
  // "stone" items can be shoved by player, used to stun shielded boss
  for (const it of game.items) {
    if (it.type !== "stone") continue;
    it.x += (it.vx || 0) * dt;
    it.y += (it.vy || 0) * dt;
    it.vx *= 0.992;
    it.vy *= 0.992;

    const tmp = { x: it.x, y: it.y, vx: it.vx, vy: it.vy, r: it.r, bounceKeep: 0.90 };
    for (const w of game.walls) {
      if (circleRectCollide(tmp.x, tmp.y, tmp.r, w.x, w.y, w.w, w.h)) resolveCircleRect(tmp, w);
    }
    it.x = tmp.x; it.y = tmp.y; it.vx = tmp.vx; it.vy = tmp.vy;

    if (game.boss) {
      const dx = it.x - game.boss.x;
      const dy = it.y - game.boss.y;
      const d = Math.hypot(dx, dy);
      if (d <= it.r + game.boss.r) {
        const sp = Math.hypot(it.vx, it.vy);
        if (sp > 70 && game.boss.rules.includes("STUN_THEN_PUNISH")) {
          // stun logic: two stone hits drops shield
          if (game.boss.shielded) {
            game.boss.stunHits += 1;
            game.toast = "Shield cracked!";
            game.shake = Math.max(game.shake, 10);
            game.shakeT = Math.max(game.shakeT, 0.16);
            it.vx *= 0.55; it.vy *= 0.55;

            if (game.boss.stunHits >= 2) {
              game.boss.shielded = false;
              game.boss.stunnedT = 2.2;
              game.toast = "Shield down! Hit it now!";
              game.shake = Math.max(game.shake, 18);
              game.shakeT = Math.max(game.shakeT, 0.24);
            }
          }
        }
      }
    }
  }
}

function keepInWorldOrRespawn(game, p) {
  // If player flies off the map, pull them back in
  // Hard bounds check with generous margin
  const margin = 220;
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return true;
  if (p.x < -margin || p.x > game.W + margin || p.y < -margin || p.y > game.H + margin) return true;
  return false;
}

function stepGame(game, dt) {
  if (!game) return;

  if (game.shakeT > 0) game.shakeT = Math.max(0, game.shakeT - dt);
  if (game.shakeT <= 0) game.shake *= 0.90;

  game.turnMsLeft -= dt * 1000;
  if (game.turnMsLeft <= 0 && game.phase === "play") {
    endTurn(game, "Time up");
  }

  if (game.mode === "boss") {
    updateBoss(game, dt);
    updateStoneItems(game, dt);
  }

  if (game.turnState === "resolving" && game.phase === "play") {
    for (const pid of Object.keys(game.players)) {
      const pl = game.players[pid];

      // safety respawn
      if (keepInWorldOrRespawn(game, pl)) {
        pl.x = 110;
        pl.y = game.H / 2;
        pl.vx = 0; pl.vy = 0;
        pl.dashStrikeWindow = 0;
        pl.canDashThisTurn = false;
      }

      pl.magnetT = Math.max(0, pl.magnetT - dt);
      if (pl.dashStrikeWindow > 0) pl.dashStrikeWindow = Math.max(0, pl.dashStrikeWindow - dt);

      applyMagnet(game, pl, dt);

      pl.x += pl.vx * dt;
      pl.y += pl.vy * dt;
      pl.vx *= Math.pow(pl.friction, dt * 60);
      pl.vy *= Math.pow(pl.friction, dt * 60);

      if (Math.abs(pl.vx) < 2) pl.vx = 0;
      if (Math.abs(pl.vy) < 2) pl.vy = 0;

      clampSpeed(pl, 1500);

      for (const w of game.walls) {
        if (circleRectCollide(pl.x, pl.y, pl.r, w.x, w.y, w.w, w.h)) resolveCircleRect(pl, w);
      }

      for (const pad of game.pads) {
        if (circleRectCollide(pl.x, pl.y, pl.r, pad.x, pad.y, pad.w, pad.h)) applyPadBoost(pl);
      }

      for (const c of game.coins) {
        if (c.takenBy) continue;
        const dx = pl.x - c.x, dy = pl.y - c.y;
        if (Math.hypot(dx, dy) <= pl.r + c.r) {
          c.takenBy = pid;
          pl.coins += 10;
          pl.score += 25;
        }
      }

      for (const it of game.items) {
        if (it.takenBy) continue;
        if (it.type === "stone") continue; // physics item
        const dx = pl.x - it.x, dy = pl.y - it.y;
        if (Math.hypot(dx, dy) <= pl.r + it.r) {
          it.takenBy = pid;
          if (it.type === "dash") pl.dashCharges += 1;
          if (it.type === "shield") pl.shield = true;
          if (it.type === "magnet") pl.magnetT = 6.0;
        }
      }

      for (const t of game.traps) {
        const dx = pl.x - t.x, dy = pl.y - t.y;
        if (Math.hypot(dx, dy) <= pl.r + t.r) {
          if (pl.shield) {
            pl.shield = false;
          } else {
            pl.x = 110;
            pl.y = game.H / 2;
            pl.vx = 0; pl.vy = 0;
          }
        }
      }

      // stone shove
      if (game.mode === "boss") {
        for (const it of game.items) {
          if (it.type !== "stone") continue;
          const dx = it.x - pl.x, dy = it.y - pl.y;
          const d = Math.hypot(dx, dy);
          if (d <= it.r + pl.r) {
            const sp = Math.max(90, Math.min(420, Math.hypot(pl.vx, pl.vy)));
            const ux = dx / (d || 1), uy = dy / (d || 1);
            it.vx = (it.vx || 0) + ux * sp * 0.9;
            it.vy = (it.vy || 0) + uy * sp * 0.9;
            game.shake = Math.max(game.shake, 6);
            game.shakeT = Math.max(game.shakeT, 0.10);
          }
        }
      }

      // boss collisions
      if (game.boss) {
        const boss = game.boss;
        const dx = pl.x - boss.x;
        const dy = pl.y - boss.y;
        const dist = Math.hypot(dx, dy);
        if (dist <= pl.r + boss.r) {
          const ux = dx / (dist || 1), uy = dy / (dist || 1);
          pl.vx += ux * 220;
          pl.vy += uy * 220;

          if (pl.dashStrikeWindow > 0) {
            let source = "DASH";
            if (boss.rules.includes("RICOCHET_REQUIRED")) source = "RICOCHET_OK";
            const ang = Math.atan2(dy, dx);
            bossTakeDamage(game, 1, source, ang);
            pl.dashStrikeWindow = 0;
          }
        }

        if (boss.rules.includes("PARRY_ONLY") && boss.ring && boss.ring.active) {
          const rx = pl.x - boss.ring.x, ry = pl.y - boss.ring.y;
          const d = Math.hypot(rx, ry);
          const hitRing = Math.abs(d - boss.ring.r) < 10;
          if (hitRing && pl.dashStrikeWindow <= 0) {
            if (pl.shield) pl.shield = false;
            else {
              pl.x = 110;
              pl.y = game.H / 2;
              pl.vx = 0; pl.vy = 0;
            }
          }
        }
      }
    }

    const stopped = Object.values(game.players).every(pl => isStopped(pl));
    if (stopped) endTurn(game, null);
  }

  // race win check
  if (game.mode === "race" && game.finish && game.phase === "play") {
    for (const pid of Object.keys(game.players)) {
      const p = game.players[pid];
      if (p.finished) continue;
      if (circleRectCollide(p.x, p.y, p.r, game.finish.x, game.finish.y, game.finish.w, game.finish.h)) {
        p.finished = true;
        game.winnerId = pid;
        game.phase = "round_end";
        game.toast = `Winner: ${pid}`;
        p.score += 100;
        p.coins += 20;
      }
    }
  }

  // boss win check
  if (game.mode === "boss" && game.boss && game.phase === "play") {
    if (game.boss.hp <= 0) {
      game.phase = "round_end";
      game.toast = "Boss defeated!";
      for (const pid of Object.keys(game.players)) {
        game.players[pid].coins += 40;
        game.players[pid].score += 80;
      }
    }
  }
}

function endTurn(game, reason) {
  if (game.phase !== "play") return;

  game.turnState = "aim";
  game.turnMsLeft = 25000;

  game.turnIndex = (game.turnIndex + 1) % game.turnOrder.length;
  game.activeId = game.turnOrder[game.turnIndex];

  if (reason) game.toast = reason;
}

function startResolving(game) {
  game.turnState = "resolving";
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
  clampSpeed(p, 1500);

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

  const dashPower = 520;
  p.vx += ux * dashPower;
  p.vy += uy * dashPower;

  p.dashCharges -= 1;
  p.dashUsedThisTurn = true;
  p.dashStrikeWindow = 0.18;

  const boss = game.boss;
  if (boss && boss.rules.includes("PARRY_ONLY") && boss.ring && boss.ring.active) {
    const dx = p.x - boss.ring.x;
    const dy = p.y - boss.ring.y;
    const dist = Math.hypot(dx, dy);
    const within = Math.abs(dist - boss.ring.r) < 22;
    if (within) {
      bossTakeDamage(game, 1, "PARRY", Math.atan2(p.y - boss.y, p.x - boss.x));
      boss.ring.active = false;
      game.toast = "Parry! Reflected damage!";
      game.shake = Math.max(game.shake, 16);
      game.shakeT = Math.max(game.shakeT, 0.22);
    }
  }

  return true;
}

function nextRound(game) {
  game.round += 1;
  game.phase = "play";
  game.winnerId = null;
  game.toast = "";

  game.turnOrder.push(game.turnOrder.shift());
  game.turnIndex = 0;
  game.activeId = game.turnOrder[0];
  game.turnState = "aim";
  game.turnMsLeft = 25000;

  if (game.mode === "race") {
    // rotate maps
    const idx = Math.max(0, RACE_LEVELS.indexOf(game.levelId));
    const next = RACE_LEVELS[(idx + 1) % RACE_LEVELS.length];
    buildRaceLevel(game, next);
  } else {
    buildBossRound(game);
  }
}

function makeSnapshot(room) {
  const game = room.game;
  const lobby = room.lobby;

  const ids = Array.from(room.clients.values());
  const players = ids.map((id) => {
    const name = (room.playerMeta[id] && room.playerMeta[id].name) ? room.playerMeta[id].name : `Player ${id.slice(0,4)}`;
    return {
      id,
      name,
      ready: !!lobby.ready[id],
      pick: lobby.picks[id] || null,
    };
  });

  return {
    t: "snap",
    serverTime: nowMs(),
    room: { code: room.code, hostId: room.hostId },
    lobby: {
      started: lobby.started,
      mode: lobby.mode,
      picks: lobby.picks,
      ready: lobby.ready,
      players,
      maxPlayers: lobby.maxPlayers,
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
      },

      levelId: game.levelId,
      finish: game.finish,
      walls: game.walls,
      pads: game.pads,
      traps: game.traps,
      coins: game.coins,
      items: game.items,

      players: game.players,
      boss: game.boss,
      hint: game.hint,
      toast: game.toast,
      shake: game.shakeT > 0 ? game.shake : 0,
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

    // Create room (client uses Create then Join manually)
    if (msg.t === "create") {
      const code = makeRoomCode();
      const room = makeRoom(code);
      rooms.set(code, room);
      send(ws, { t: "created", code });
      return;
    }

    // Join room
    if (msg.t === "join") {
      const code = String(msg.code || "").trim().toUpperCase().slice(0, 6);
      if (!code) return send(ws, { t: "err", m: "No room code." });

      let room = getRoom(code);
      if (!room) {
        room = makeRoom(code);
        rooms.set(code, room);
      }

      if (room.clients.size >= room.lobby.maxPlayers) {
        return send(ws, { t: "err", m: "Room full." });
      }

      ws.roomCode = code;
      ws.playerId = randId();

      room.clients.set(ws, ws.playerId);
      room.socketsById.set(ws.playerId, ws);

      if (!room.hostId) room.hostId = ws.playerId;

      // init meta
      room.playerMeta[ws.playerId] = room.playerMeta[ws.playerId] || { name: `Player ${ws.playerId.slice(0,4)}` };

      // init ready and pick state
      room.lobby.ready[ws.playerId] = false;

      send(ws, { t: "joined", id: ws.playerId, code, hostId: room.hostId });
      broadcast(room, makeSnapshot(room));
      return;
    }

    const room = ws.roomCode ? getRoom(ws.roomCode) : null;
    if (!room) return;

    const pid = ws.playerId;

    // Set player name (NEW)
    if (msg.t === "set_name") {
      const raw = String(msg.name || "").trim();
      const safe = raw.slice(0, 18).replace(/[^\w\s\-\.]/g, "");
      const name = safe || `Player ${pid.slice(0,4)}`;
      room.playerMeta[pid] = room.playerMeta[pid] || {};
      room.playerMeta[pid].name = name;
      broadcast(room, makeSnapshot(room));
      return;
    }

    // Host sets mode
    if (msg.t === "set_mode") {
      if (pid !== room.hostId) return;
      const m = msg.mode === "boss" ? "boss" : "race";
      if (room.lobby.started) return;
      room.lobby.mode = m;
      broadcast(room, makeSnapshot(room));
      return;
    }

    // Pick character
    if (msg.t === "pick") {
      if (room.lobby.started) return;
      const charId = String(msg.charId || "agouti");
      room.lobby.picks[pid] = charId;
      room.lobby.ready[pid] = false;
      broadcast(room, makeSnapshot(room));
      return;
    }

    // Ready toggle
    if (msg.t === "ready") {
      if (room.lobby.started) return;
      const v = !!msg.v;
      room.lobby.ready[pid] = v;
      broadcast(room, makeSnapshot(room));
      return;
    }

    // Start game
    if (msg.t === "start") {
      if (pid !== room.hostId) return;
      if (room.lobby.started) return;

      const ids = Array.from(room.clients.values());
      if (ids.length < 1) return;

      // default picks if missing
      for (const id of ids) {
        if (!room.lobby.picks[id]) room.lobby.picks[id] = "agouti";
      }

      // must be ready
      for (const id of ids) {
        if (!room.lobby.ready[id]) {
          send(ws, { t: "err", m: "Everyone must be Ready." });
          return;
        }
      }

      room.lobby.started = true;
      room.game = makeGame(room.lobby.mode, ids, room.lobby.picks);
      room.lastTick = nowMs();
      room.lastSnap = 0;

      ensureRoomLoop(room);
      broadcast(room, makeSnapshot(room));
      return;
    }

    // Host reset to lobby
    if (msg.t === "reset") {
      if (pid !== room.hostId) return;
      room.lobby.started = false;
      room.game = null;
      // preserve picks and names, reset ready
      room.lobby.ready = {};
      for (const id of Array.from(room.clients.values())) room.lobby.ready[id] = false;
      broadcast(room, makeSnapshot(room));
      return;
    }

    // Host reload map (NEW)
    if (msg.t === "host_reload_map") {
      if (pid !== room.hostId) return;
      if (!room.game) return;

      const g = room.game;
      if (g.mode === "race") {
        // choose a different map than current
        const currentIdx = Math.max(0, RACE_LEVELS.indexOf(g.levelId));
        const nextIdx = (currentIdx + 1) % RACE_LEVELS.length;
        buildRaceLevel(g, RACE_LEVELS[nextIdx]);
        g.toast = "Map reloaded!";
      } else {
        buildBossRound(g);
        g.toast = "Boss arena reloaded!";
      }

      broadcast(room, makeSnapshot(room));
      return;
    }

    // Host reset positions (NEW)
    if (msg.t === "host_reset_positions") {
      if (pid !== room.hostId) return;
      if (!room.game) return;

      resetPlayersToSpawn(room.game);
      room.game.toast = "Positions reset!";
      broadcast(room, makeSnapshot(room));
      return;
    }

    // Gameplay inputs
    if (msg.t === "act") {
      if (!room.game) return;

      const g = room.game;
      if (g.phase !== "play") return;
      if (g.activeId !== pid) return;
      if (g.turnState !== "aim") return;

      if (msg.kind === "flick") {
        const vx = clamp(Number(msg.vx || 0), -2000, 2000);
        const vy = clamp(Number(msg.vy || 0), -2000, 2000);

        applyFlick(g, pid, vx, vy);
        startResolving(g);
        g.toast = `${pid} launched`;
        broadcast(room, makeSnapshot(room));
        return;
      }
      return;
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
    const room = ws.roomCode ? getRoom(ws.roomCode) : null;
    if (!room) return;

    const pid = ws.playerId;
    room.clients.delete(ws);
    if (pid) room.socketsById.delete(pid);

    if (pid) {
      delete room.lobby.picks[pid];
      delete room.lobby.ready[pid];
      // keep name in playerMeta if you want reconnect memory, but safe to delete:
      // delete room.playerMeta[pid];
    }

    if (pid === room.hostId) {
      const next = room.clients.values().next().value || null;
      room.hostId = next;
    }

    if (room.game && pid && room.game.players[pid]) {
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

    if (room.clients.size === 0) {
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
