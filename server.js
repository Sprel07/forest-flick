// server.js
// npm i ws express
// node server.js
// http://localhost:3000

const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();
app.use(express.static("."));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const TICK_HZ = 60;
const SNAP_HZ = 20;

const rooms = new Map();

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

function makeRoom(code) {
  return {
    code,
    createdAt: nowMs(),
    clients: new Map(), // ws -> pid
    hostId: null,

    // lobby state
    lobby: {
      mode: "race", // "race" | "boss"
      started: false,
      maxPlayers: 4,

      picks: {}, // pid -> charId
      ready: {}, // pid -> bool
      names: {}, // pid -> display name
      joinOrder: [], // pid[]
    },

    // game state
    game: null,
    lastTick: nowMs(),
    lastSnap: 0,
  };
}

// ---------- Maps (maze-like within 960x540) ----------
function baseBounds(game) {
  const b = game.bounds;
  const t = 18; // thicker walls to reduce tunneling
  return [
    { x: b.x, y: b.y, w: b.w, h: t },
    { x: b.x, y: b.y + b.h - t, w: b.w, h: t },
    { x: b.x, y: b.y, w: t, h: b.h },
    { x: b.x + b.w - t, y: b.y, w: t, h: b.h },
  ];
}

const LEVELS = [
  {
    id: "labyrinth_01",
    name: "Labyrinth Run 01",
    finish: { x: 820, y: 60, w: 110, h: 90 },
    walls: [
      // big maze blocks
      { x: 120, y: 80, w: 28, h: 380 },
      { x: 220, y: 80, w: 28, h: 260 },
      { x: 220, y: 372, w: 220, h: 28 },
      { x: 320, y: 140, w: 280, h: 28 },
      { x: 320, y: 140, w: 28, h: 240 },
      { x: 520, y: 240, w: 28, h: 200 },
      { x: 600, y: 80, w: 28, h: 260 },
      { x: 680, y: 160, w: 220, h: 28 },
      { x: 740, y: 240, w: 28, h: 220 },
      { x: 820, y: 320, w: 120, h: 28 },
    ],
    pads: [
      { x: 80, y: 250, w: 100, h: 16 },
      { x: 640, y: 450, w: 160, h: 16 },
    ],
    traps: [
      { x: 460, y: 300, r: 14 },
      { x: 700, y: 120, r: 14 },
    ],
    coins: [
      { x: 180, y: 120 }, { x: 180, y: 460 },
      { x: 280, y: 250 }, { x: 380, y: 90 },
      { x: 540, y: 190 }, { x: 560, y: 470 },
      { x: 760, y: 200 }, { x: 860, y: 460 },
    ],
    items: [
      { type: "dash", x: 260, y: 460, r: 12, takenBy: null },
      { type: "shield", x: 560, y: 90, r: 12, takenBy: null },
      { type: "magnet", x: 880, y: 120, r: 12, takenBy: null },
    ]
  },
  {
    id: "labyrinth_02",
    name: "Labyrinth Run 02",
    finish: { x: 820, y: 380, w: 110, h: 90 },
    walls: [
      { x: 160, y: 80, w: 520, h: 28 },
      { x: 160, y: 80, w: 28, h: 220 },
      { x: 280, y: 180, w: 28, h: 300 },
      { x: 380, y: 120, w: 28, h: 240 },
      { x: 500, y: 180, w: 28, h: 300 },
      { x: 600, y: 120, w: 28, h: 240 },
      { x: 160, y: 320, w: 340, h: 28 },
      { x: 560, y: 380, w: 340, h: 28 },
      { x: 740, y: 180, w: 220, h: 28 },
      { x: 820, y: 180, w: 28, h: 200 },
    ],
    pads: [
      { x: 90, y: 250, w: 120, h: 16 },
      { x: 720, y: 90, w: 160, h: 16 },
    ],
    traps: [
      { x: 330, y: 420, r: 14 },
      { x: 650, y: 260, r: 14 },
      { x: 840, y: 320, r: 14 },
    ],
    coins: [
      { x: 120, y: 110 }, { x: 120, y: 460 },
      { x: 240, y: 250 }, { x: 340, y: 150 },
      { x: 460, y: 430 }, { x: 560, y: 250 },
      { x: 760, y: 220 }, { x: 900, y: 120 },
    ],
    items: [
      { type: "dash", x: 440, y: 460, r: 12, takenBy: null },
      { type: "shield", x: 700, y: 460, r: 12, takenBy: null },
      { type: "magnet", x: 900, y: 460, r: 12, takenBy: null },
    ]
  },
  {
    id: "labyrinth_03",
    name: "Labyrinth Run 03",
    finish: { x: 820, y: 60, w: 110, h: 90 },
    walls: [
      { x: 140, y: 120, w: 28, h: 340 },
      { x: 240, y: 80, w: 28, h: 200 },
      { x: 240, y: 320, w: 220, h: 28 },
      { x: 340, y: 180, w: 360, h: 28 },
      { x: 420, y: 80, w: 28, h: 260 },
      { x: 520, y: 240, w: 28, h: 220 },
      { x: 620, y: 80, w: 28, h: 260 },
      { x: 700, y: 360, w: 240, h: 28 },
      { x: 780, y: 160, w: 28, h: 220 },
    ],
    pads: [
      { x: 80, y: 450, w: 140, h: 16 },
      { x: 680, y: 120, w: 160, h: 16 },
    ],
    traps: [
      { x: 460, y: 120, r: 14 },
      { x: 560, y: 360, r: 14 },
    ],
    coins: [
      { x: 170, y: 90 }, { x: 170, y: 470 },
      { x: 310, y: 250 }, { x: 470, y: 430 },
      { x: 620, y: 190 }, { x: 760, y: 250 },
      { x: 900, y: 430 }, { x: 880, y: 120 },
    ],
    items: [
      { type: "dash", x: 300, y: 90, r: 12, takenBy: null },
      { type: "shield", x: 520, y: 90, r: 12, takenBy: null },
      { type: "magnet", x: 860, y: 470, r: 12, takenBy: null },
    ]
  }
];

// ---------- Simulation ----------
function makeGame(mode, playerIds, lobby) {
  const game = {
    mode,
    round: 1,
    phase: "play", // play | round_end
    winnerId: null,

    turnIndex: 0,
    turnOrder: [...playerIds],
    turnState: "aim", // aim | resolving
    turnMsLeft: 25000,
    activeId: playerIds[0],

    W: 960,
    H: 540,
    bounds: { x: 20, y: 20, w: 920, h: 500 },

    levelIndex: 0,
    levelId: LEVELS[0].id,
    finish: null,
    walls: [],
    pads: [],
    traps: [],
    coins: [],
    items: [],

    players: {},
    hint: "",
    toast: "",
    shake: 0,
    shakeT: 0,

    // boss mode
    boss: null,
    bossTurnsUntilAttack: 2, // boss attacks every 2 player turns
    bossTurnCounter: 0,
  };

  for (let i = 0; i < playerIds.length; i++) {
    const pid = playerIds[i];
    const charId = lobby.picks[pid] || "agouti";
    const name = lobby.names[pid] || pid;
    const colorIndex = lobby.joinOrder.indexOf(pid);
    game.players[pid] = makePlayer(pid, name, charId, colorIndex, 120, game.H / 2 + (i - playerIds.length / 2) * 44);
  }

  if (mode === "race") {
    buildRaceLevel(game, 0);
    game.hint = "Race to the finish. One flick per turn. First to touch wins.";
  } else {
    buildBossRound(game);
    game.hint = "Boss is turn-based. It attacks every 2 player turns.";
  }

  resetRoundPerks(game);
  return game;
}

function makePlayer(pid, name, charId, colorIndex, x, y) {
  const p = {
    id: pid,
    name,
    charId,
    colorIndex: (colorIndex >= 0 ? colorIndex : 0),
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
  if (charId === "hummingbird") p.dashCharges = 1;
  if (charId === "manicou") p.shield = true;

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

function buildRaceLevel(game, levelIndex) {
  const level = LEVELS[levelIndex % LEVELS.length];
  game.levelIndex = levelIndex % LEVELS.length;
  game.levelId = level.id;

  game.boss = null;
  game.finish = { ...level.finish };

  game.walls = baseBounds(game).concat(level.walls.map(w => ({ ...w })));
  game.pads = level.pads.map(p => ({ ...p }));
  game.traps = level.traps.map(t => ({ ...t }));
  game.coins = level.coins.map(c => ({ ...c, r: 10, takenBy: null }));
  game.items = level.items.map(it => ({ ...it, takenBy: null }));

  resetPositions(game);
  resetRoundPerks(game);
}

function buildBossRound(game) {
  game.finish = null;
  game.walls = baseBounds(game);
  game.pads = [
    { x: 90, y: 250, w: 120, h: 16 },
    { x: 720, y: 250, w: 160, h: 16 },
  ];
  game.traps = [
    { x: 480, y: 160, r: 14 },
    { x: 480, y: 380, r: 14 },
  ];
  game.coins = [
    { x: 160, y: 110 }, { x: 160, y: 430 },
    { x: 520, y: 110 }, { x: 520, y: 430 },
    { x: 820, y: 140 }, { x: 820, y: 400 },
  ].map(c => ({ ...c, r: 10, takenBy: null }));

  game.items = [
    { type: "dash", x: 320, y: 110, r: 12, takenBy: null },
    { type: "dash", x: 320, y: 430, r: 12, takenBy: null },
    { type: "shield", x: 320, y: 250, r: 12, takenBy: null },
    { type: "magnet", x: 860, y: 250, r: 12, takenBy: null },
  ];

  // Turn-based boss that attacks every 2 player turns
  game.boss = {
    id: "forest_guardian",
    name: "Forest Guardian",
    hp: 14,
    hpMax: 14,
    x: game.W * 0.75,
    y: game.H * 0.50,
    r: 44,
    attackTelegraphT: 0,
    lastAttack: "",
  };

  game.bossTurnCounter = 0;
  game.hint = "Boss attacks every 2 player turns. Keep a shield for safety.";
  game.toast = `${game.boss.name} appeared. ${game.hint}`;

  resetPositions(game);
  resetRoundPerks(game);
}

function resetPositions(game) {
  const ids = game.turnOrder;
  const startY = game.H / 2;
  for (let i = 0; i < ids.length; i++) {
    const p = game.players[ids[i]];
    if (!p) continue;
    p.x = 120;
    p.y = startY + (i - ids.length / 2) * 44;
    p.vx = 0; p.vy = 0;
    p.finished = false;
  }
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

    // extra damping so control returns faster
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

function isStopped(p) {
  return Math.hypot(p.vx, p.vy) < 6;
}

function applyPadBoost(p) {
  p.vx *= 1.22;
  p.vy *= 1.22;
}

function clampToArena(game, p) {
  const b = game.bounds;
  const left = b.x + p.r + 2;
  const right = b.x + b.w - p.r - 2;
  const top = b.y + p.r + 2;
  const bottom = b.y + b.h - p.r - 2;

  if (p.x < left) { p.x = left; p.vx = Math.abs(p.vx) * 0.6; }
  if (p.x > right) { p.x = right; p.vx = -Math.abs(p.vx) * 0.6; }
  if (p.y < top) { p.y = top; p.vy = Math.abs(p.vy) * 0.6; }
  if (p.y > bottom) { p.y = bottom; p.vy = -Math.abs(p.vy) * 0.6; }
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

function bossTakeDamage(game, amount) {
  if (!game.boss) return false;
  game.boss.hp = Math.max(0, game.boss.hp - amount);
  game.shake = Math.max(game.shake, 12 + amount * 2);
  game.shakeT = Math.max(game.shakeT, 0.18);
  game.toast = "Boss hit!";
  return true;
}

function bossTurnAttack(game) {
  const boss = game.boss;
  if (!boss) return;

  // Attack styles are simple and fair (every 2 turns)
  // "VINE_SLAM": pushes players away from boss
  // "SEED_SHOT": spawns 3 small “shots” as temporary traps (we emulate by adding trap circles briefly)

  const roll = Math.random();
  if (roll < 0.55) {
    boss.lastAttack = "VINE_SLAM";
    game.toast = "Boss attack: Vine Slam!";
    game.shake = Math.max(game.shake, 18);
    game.shakeT = Math.max(game.shakeT, 0.22);

    for (const pid of Object.keys(game.players)) {
      const p = game.players[pid];
      const dx = p.x - boss.x;
      const dy = p.y - boss.y;
      const d = Math.hypot(dx, dy) || 1;
      const ux = dx / d, uy = dy / d;

      // shield blocks the worst of it
      const power = p.shield ? 180 : 320;
      p.vx += ux * power;
      p.vy += uy * power;

      if (!p.shield && d < boss.r + p.r + 30) {
        // mild penalty if you hug the boss without shield
        p.vx *= 0.7;
        p.vy *= 0.7;
      }
      if (p.shield) p.shield = false;
    }
  } else {
    boss.lastAttack = "SEED_SHOT";
    game.toast = "Boss attack: Seed Shot!";
    game.shake = Math.max(game.shake, 14);
    game.shakeT = Math.max(game.shakeT, 0.18);

    // temporary traps near mid
    const shots = [
      { x: boss.x - 120, y: boss.y - 70, r: 12 },
      { x: boss.x - 160, y: boss.y + 10, r: 12 },
      { x: boss.x - 120, y: boss.y + 90, r: 12 },
    ];
    for (const s of shots) game.traps.push({ ...s, _tmpT: 2.2 });
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
    endTurn(game, "Time up");
  }

  // temp traps decay (boss attack)
  for (const t of game.traps) {
    if (t._tmpT != null) t._tmpT = Math.max(0, t._tmpT - dt);
  }
  game.traps = game.traps.filter(t => t._tmpT == null || t._tmpT > 0);

  // physics only when resolving
  if (game.turnState === "resolving" && game.phase === "play") {
    for (const pid of Object.keys(game.players)) {
      const pl = game.players[pid];

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

      // walls
      for (const w of game.walls) {
        if (circleRectCollide(pl.x, pl.y, pl.r, w.x, w.y, w.w, w.h)) resolveCircleRect(pl, w);
      }

      // pads
      for (const pad of game.pads) {
        if (circleRectCollide(pl.x, pl.y, pl.r, pad.x, pad.y, pad.w, pad.h)) applyPadBoost(pl);
      }

      // coins
      for (const c of game.coins) {
        if (c.takenBy) continue;
        if (Math.hypot(pl.x - c.x, pl.y - c.y) <= pl.r + c.r) {
          c.takenBy = pid;
          pl.coins += 10;
          pl.score += 25;
        }
      }

      // items
      for (const it of game.items) {
        if (it.takenBy) continue;
        if (Math.hypot(pl.x - it.x, pl.y - it.y) <= pl.r + it.r) {
          it.takenBy = pid;
          if (it.type === "dash") pl.dashCharges += 1;
          if (it.type === "shield") pl.shield = true;
          if (it.type === "magnet") pl.magnetT = 6.0;
        }
      }

      // traps
      for (const t of game.traps) {
        if (Math.hypot(pl.x - t.x, pl.y - t.y) <= pl.r + t.r) {
          if (pl.shield) {
            pl.shield = false;
          } else {
            // reset
            pl.x = 120;
            pl.y = game.H / 2;
            pl.vx = 0; pl.vy = 0;
          }
        }
      }

      // boss collision and damage (turn-based boss, but you can still hit it during your resolve)
      if (game.mode === "boss" && game.boss) {
        const boss = game.boss;
        const dx = pl.x - boss.x;
        const dy = pl.y - boss.y;
        const dist = Math.hypot(dx, dy);
        if (dist <= pl.r + boss.r) {
          const ux = dx / (dist || 1), uy = dy / (dist || 1);
          pl.vx += ux * 220;
          pl.vy += uy * 220;

          // dash strike does 1, body does 0.25
          if (pl.dashStrikeWindow > 0) {
            bossTakeDamage(game, 1);
            pl.dashStrikeWindow = 0;
          } else {
            bossTakeDamage(game, 0.25);
          }
        }
      }

      // hard clamp safety (prevents “gone forever”)
      clampToArena(game, pl);
    }

    // end resolve when all are stopped
    const stopped = Object.values(game.players).every(pl => isStopped(pl));
    if (stopped) endTurn(game, null);
  }

  // race win
  if (game.mode === "race" && game.finish && game.phase === "play") {
    for (const pid of Object.keys(game.players)) {
      const p = game.players[pid];
      if (p.finished) continue;
      if (circleRectCollide(p.x, p.y, p.r, game.finish.x, game.finish.y, game.finish.w, game.finish.h)) {
        p.finished = true;
        game.winnerId = pid;
        game.phase = "round_end";
        game.toast = `Winner: ${game.players[pid].name || pid}`;
        p.score += 100;
        p.coins += 20;
      }
    }
  }

  // boss win
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

  const ux = p.vx / sp;
  const uy = p.vy / sp;

  const dashPower = 520;
  p.vx += ux * dashPower;
  p.vy += uy * dashPower;

  p.dashCharges -= 1;
  p.dashUsedThisTurn = true;
  p.dashStrikeWindow = 0.18;
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
    const nextIdx = (game.levelIndex + 1) % LEVELS.length;
    buildRaceLevel(game, nextIdx);
  } else {
    buildBossRound(game);
  }
}

function endTurn(game, reason) {
  if (game.phase !== "play") return;

  game.turnState = "aim";
  game.turnMsLeft = 25000;

  // Boss turn-based attack every 2 player turns
  if (game.mode === "boss" && game.boss) {
    game.bossTurnCounter += 1;
    if (game.bossTurnCounter >= game.bossTurnsUntilAttack) {
      game.bossTurnCounter = 0;
      bossTurnAttack(game);
    }
  }

  game.turnIndex = (game.turnIndex + 1) % game.turnOrder.length;
  game.activeId = game.turnOrder[game.turnIndex];

  if (reason) game.toast = reason;
}

function startResolving(game) {
  game.turnState = "resolving";
}

// ---------- Snapshots ----------
function makeSnapshot(room) {
  const g = room.game;
  const l = room.lobby;

  const playerList = l.joinOrder
    .filter(pid => !!l.names[pid] || !!l.ready[pid] || !!l.picks[pid])
    .map(pid => ({
      id: pid,
      name: l.names[pid] || pid,
      ready: !!l.ready[pid],
      pick: l.picks[pid] || "agouti",
    }));

  return {
    t: "snap",
    serverTime: nowMs(),
    room: { code: room.code, hostId: room.hostId },
    lobby: {
      started: l.started,
      mode: l.mode,
      maxPlayers: l.maxPlayers,
      players: playerList,
    },
    game: g ? {
      mode: g.mode,
      round: g.round,
      phase: g.phase,
      winnerId: g.winnerId,

      turn: {
        activeId: g.activeId,
        state: g.turnState,
        msLeft: Math.max(0, Math.floor(g.turnMsLeft)),
        order: g.turnOrder,
      },

      levelId: g.levelId,
      finish: g.finish,
      walls: g.walls,
      pads: g.pads,
      traps: g.traps,
      coins: g.coins,
      items: g.items,

      players: g.players,
      boss: g.boss,
      hint: g.hint,
      toast: g.toast,
      shake: g.shakeT > 0 ? g.shake : 0,
    } : null
  };
}

// ---------- Room loop ----------
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

// ---------- WebSocket handlers ----------
wss.on("connection", (ws) => {
  ws.roomCode = null;
  ws.playerId = null;

  send(ws, { t: "hello" });

  ws.on("message", (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return; }

    // Create room code (client still must join it)
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

      let room = rooms.get(code);
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
      if (!room.hostId) room.hostId = ws.playerId;

      // lobby init
      room.lobby.ready[ws.playerId] = false;
      room.lobby.picks[ws.playerId] = room.lobby.picks[ws.playerId] || "agouti";

      const rawName = String(msg.name || "").trim();
      const safeName = rawName ? rawName.slice(0, 14) : ws.playerId;
      room.lobby.names[ws.playerId] = safeName;

      if (!room.lobby.joinOrder.includes(ws.playerId)) room.lobby.joinOrder.push(ws.playerId);

      send(ws, { t: "joined", id: ws.playerId, code, hostId: room.hostId });
      broadcast(room, makeSnapshot(room));
      return;
    }

    // Must be in a room after this
    const room = ws.roomCode ? rooms.get(ws.roomCode) : null;
    if (!room) return;
    const pid = ws.playerId;

    // Change name (lobby or in game)
    if (msg.t === "set_name") {
      const raw = String(msg.name || "").trim();
      const safe = raw ? raw.slice(0, 14) : pid;
      room.lobby.names[pid] = safe;

      if (room.game && room.game.players[pid]) room.game.players[pid].name = safe;
      broadcast(room, makeSnapshot(room));
      return;
    }

    // Host set mode
    if (msg.t === "set_mode") {
      if (pid !== room.hostId) return;
      if (room.lobby.started) return;
      room.lobby.mode = (msg.mode === "boss") ? "boss" : "race";
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
      room.lobby.ready[pid] = !!msg.v;
      broadcast(room, makeSnapshot(room));
      return;
    }

    // Host start
    if (msg.t === "start") {
      if (pid !== room.hostId) return;
      if (room.lobby.started) return;

      const ids = Array.from(room.clients.values());
      if (ids.length < 1) return;

      // default picks + require ready
      for (const id of ids) {
        if (!room.lobby.picks[id]) room.lobby.picks[id] = "agouti";
        if (!room.lobby.names[id]) room.lobby.names[id] = id;
        if (!room.lobby.ready[id]) return send(ws, { t: "err", m: "Everyone must be Ready." });
      }

      room.lobby.started = true;
      room.game = makeGame(room.lobby.mode, ids, room.lobby);
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

      // keep names, keep joinOrder, reset readiness
      for (const id of Object.values(room.clients)) room.lobby.ready[id] = false;

      broadcast(room, makeSnapshot(room));
      return;
    }

    // Host reload map (race) or rebuild boss arena (boss)
    if (msg.t === "reload_map") {
      if (pid !== room.hostId) return;
      if (!room.game) return;

      const g = room.game;
      if (g.mode === "race") buildRaceLevel(g, g.levelIndex);
      else buildBossRound(g);

      g.toast = "Map reloaded by host";
      broadcast(room, makeSnapshot(room));
      return;
    }

    // Host reset positions only
    if (msg.t === "reset_positions") {
      if (pid !== room.hostId) return;
      if (!room.game) return;

      resetPositions(room.game);
      room.game.toast = "Positions reset by host";
      broadcast(room, makeSnapshot(room));
      return;
    }

    // Gameplay input
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
        g.toast = `${g.players[pid]?.name || pid} launched`;
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

    delete room.lobby.picks[pid];
    delete room.lobby.ready[pid];
    delete room.lobby.names[pid];
    room.lobby.joinOrder = room.lobby.joinOrder.filter(x => x !== pid);

    // host migration
    if (pid === room.hostId) {
      const next = room.clients.values().next().value || null;
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

    if (room.clients.size === 0) {
      if (room._loop) clearInterval(room._loop);
      rooms.delete(room.code);
    } else {
      broadcast(room, makeSnapshot(room));
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Server running on port " + PORT));
