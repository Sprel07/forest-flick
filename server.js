// server.js
// Run:
//   npm i ws express
//   node server.js
// Open:
//   http://localhost:3000
//
// Multiplayer model:
// - Server is authoritative for turns and state
// - Clients send inputs only when it is their turn
// - Server simulates physics for deterministic gameplay

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
    clients: new Map(), // ws -> pid
    hostId: null,

    // lobby
    lobby: {
      mode: "race", // "race" | "boss"
      started: false,
      picks: {}, // pid -> characterId
      ready: {}, // pid -> bool
      maxPlayers: 4,
    },

    // game state
    game: null, // built on start
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
    turnMsLeft: 25000, // 25s per turn, resets each turn
    activeId: playerIds[0],

    // world
    W: 960,
    H: 540,
    bounds: { x: 20, y: 20, w: 920, h: 500 },

    levelId: "cocorite_cove",
    finish: null,
    walls: [],
    pads: [],
    traps: [],
    coins: [],
    items: [],

    // entities
    players: {}, // pid -> playerState
    boss: null,

    // boss roster
    bossIndex: 0,

    // messaging
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
    game.players[pid] = makePlayer(pid, charId, 120, startY + (i - playerIds.length / 2) * 44);
  }

  // build first stage
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

    // per round stats
    firstLaunchAvailable: true,
    dashCharges: 0,
    shield: false,
    magnetT: 0,

    // turn action
    canDashThisTurn: false,
    dashUsedThisTurn: false,
    dashStrikeWindow: 0,

    // scoring
    score: 0,
    coins: 0,
    finished: false,

    // physics tuning
    bounceKeep: 0.78,
    friction: 0.985,
  };

  if (charId === "frog") p.bounceKeep = 0.90;
  else p.bounceKeep = 0.78;

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

// -------------------------
// RACE MAPS (LONG / COMPLEX)
// -------------------------

const RACE_LEVELS = ["cocorite_cove", "maracas_bounce", "caroni_corridors"];

function _mergeRects(rects) {
  rects.sort((a, b) => (a.y - b.y) || (a.h - b.h) || (a.x - b.x));
  const out = [];
  for (const r of rects) {
    const last = out[out.length - 1];
    if (last && last.y === r.y && last.h === r.h && (last.x + last.w) >= r.x) {
      const nx2 = Math.max(last.x + last.w, r.x + r.w);
      last.w = nx2 - last.x;
    } else out.push({ ...r });
  }
  out.sort((a, b) => (a.x - b.x) || (a.w - b.w) || (a.y - b.y));
  const out2 = [];
  for (const r of out) {
    const last = out2[out2.length - 1];
    if (last && last.x === r.x && last.w === r.w && (last.y + last.h) >= r.y) {
      const ny2 = Math.max(last.y + last.h, r.y + r.h);
      last.h = ny2 - last.y;
    } else out2.push({ ...r });
  }
  return out2;
}

function addMazeFromAscii(game, ascii, opt = {}) {
  const cell = opt.cell || 64;
  const b = game.bounds;

  const rows = ascii.length;
  const cols = Math.max(...ascii.map(s => s.length));

  const totalW = cols * cell;
  const totalH = rows * cell;

  const x0 = b.x + Math.max(0, Math.floor((b.w - totalW) / 2));
  const y0 = b.y + Math.max(0, Math.floor((b.h - totalH) / 2));

  const rects = [];
  for (let r = 0; r < rows; r++) {
    const row = ascii[r];
    for (let c = 0; c < cols; c++) {
      const ch = row[c] || " ";
      if (ch === "X") rects.push({ x: x0 + c * cell, y: y0 + r * cell, w: cell, h: cell });
    }
  }

  const thick = opt.thick || 18;
  const thickRects = rects.map(w => ({ x: w.x - thick / 2, y: w.y - thick / 2, w: w.w + thick, h: w.h + thick }));
  return _mergeRects(thickRects);
}

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

  if (levelId === "cocorite_cove") {
    const ascii = [
      "XXXXXXXXXXXXXXXX",
      "X....X.....X...X",
      "X.XX.X.XXX.X.X.XX",
      "X.X..X...X...X..X",
      "X.X.XXX.X.XXXXX.X",
      "X...X...X.....X.X",
      "XXX.X.XXXXX.XXX.XX",
      "X...X.....X...X..X",
      "X.XXXXX.X.XXX.XX.X",
      "X.....X.X...X....X",
      "X.XXX.X.XXX.XXXX.X",
      "X...X.....X......X",
      "XXXXXXXXXXXXXXXX"
    ];
    game.walls.push(...addMazeFromAscii(game, ascii, { cell: 54, thick: 20 }));
    game.finish = { x: game.W - 165, y: 48, w: 120, h: 90 };

    game.pads = [
      { x: 160, y: 250, w: 120, h: 16 },
      { x: 420, y: 465, w: 140, h: 16 },
      { x: 720, y: 300, w: 150, h: 16 },
    ];

    game.traps = [
      { x: 310, y: 160, r: 14 },
      { x: 540, y: 250, r: 14 },
      { x: 650, y: 430, r: 14 },
    ];

    game.coins = [
      { x: 155, y: 95 }, { x: 190, y: 430 }, { x: 300, y: 470 },
      { x: 460, y: 120 }, { x: 515, y: 410 }, { x: 620, y: 95 },
      { x: 735, y: 165 }, { x: 790, y: 465 }, { x: 850, y: 260 },
    ].map(c => ({ ...c, r: 10, takenBy: null }));

    game.items = [
      { type: "dash", x: 260, y: 95, r: 12, takenBy: null },
      { type: "shield", x: 510, y: 470, r: 12, takenBy: null },
      { type: "magnet", x: 790, y: 165, r: 12, takenBy: null },
      { type: "dash", x: 745, y: 465, r: 12, takenBy: null },
    ];
  } else if (levelId === "maracas_bounce") {
    const ascii = [
      "XXXXXXXXXXXXXXXX",
      "X....X.....X...X",
      "X.XX.X.XXX.X.X.XX",
      "X.X..X...X...X..X",
      "X.X.XXX.X.XXX.X.XX",
      "X...X...X...X...XX",
      "XXX.X.XXXXX.X.XX.X",
      "X...X.....X.X..X.X",
      "X.XXXXX.XXX.XX.X.X",
      "X.....X.....X....X",
      "X.XXX.XXXXXXX.XX.X",
      "X...X.........X..X",
      "XXXXXXXXXXXXXXXX"
    ];
    game.walls.push(...addMazeFromAscii(game, ascii, { cell: 54, thick: 20 }));
    game.finish = { x: game.W - 165, y: 392, w: 120, h: 90 };

    game.pads = [
      { x: 140, y: 250, w: 130, h: 16 },
      { x: 330, y: 120, w: 150, h: 16 },
      { x: 500, y: 420, w: 150, h: 16 },
      { x: 710, y: 250, w: 160, h: 16 },
    ];

    game.traps = [
      { x: 360, y: 250, r: 14 },
      { x: 600, y: 250, r: 14 },
      { x: 760, y: 120, r: 14 },
      { x: 760, y: 420, r: 14 },
    ];

    game.coins = [
      { x: 165, y: 120 }, { x: 165, y: 420 }, { x: 300, y: 250 },
      { x: 430, y: 95 }, { x: 430, y: 465 }, { x: 560, y: 250 },
      { x: 700, y: 95 }, { x: 700, y: 465 }, { x: 850, y: 250 },
    ].map(c => ({ ...c, r: 10, takenBy: null }));

    game.items = [
      { type: "dash", x: 330, y: 120, r: 12, takenBy: null },
      { type: "shield", x: 500, y: 420, r: 12, takenBy: null },
      { type: "magnet", x: 700, y: 95, r: 12, takenBy: null },
      { type: "dash", x: 710, y: 250, r: 12, takenBy: null },
    ];
  } else if (levelId === "caroni_corridors") {
    const ascii = [
      "XXXXXXXXXXXXXXXXXXXX",
      "X....X.....X.......X",
      "X.XX.X.XXX.X.XXXXX.XX",
      "X.X..X...X...X...X..X",
      "X.X.XXX.X.XXXXX.X.XX.X",
      "X...X...X.....X.X....X",
      "XXX.X.XXXXX.XXX.XXXXXX",
      "X...X.....X...X......X",
      "X.XXXXX.X.XXX.XXXXXX.X",
      "X.....X.X...X....X...X",
      "X.XXX.X.XXX.XXXX.X.XX.X",
      "X...X.....X......X...X",
      "X.XXXXXXX.XXXXXXXXX.XX",
      "X.......X...........X",
      "XXXXXXXXXXXXXXXXXXXX"
    ];
    game.walls.push(...addMazeFromAscii(game, ascii, { cell: 46, thick: 22 }));
    game.finish = { x: game.W - 175, y: 230, w: 130, h: 95 };

    game.pads = [
      { x: 160, y: 250, w: 140, h: 16 },
      { x: 420, y: 250, w: 140, h: 16 },
      { x: 660, y: 250, w: 160, h: 16 },
    ];

    game.traps = [
      { x: 280, y: 120, r: 14 },
      { x: 280, y: 420, r: 14 },
      { x: 520, y: 250, r: 14 },
      { x: 760, y: 250, r: 14 },
    ];

    game.coins = [
      { x: 155, y: 95 }, { x: 185, y: 455 }, { x: 310, y: 250 },
      { x: 420, y: 95 }, { x: 450, y: 465 }, { x: 545, y: 250 },
      { x: 650, y: 95 }, { x: 690, y: 465 }, { x: 800, y: 250 },
      { x: 865, y: 120 }, { x: 865, y: 420 },
    ].map(c => ({ ...c, r: 10, takenBy: null }));

    game.items = [
      { type: "dash", x: 310, y: 250, r: 12, takenBy: null },
      { type: "shield", x: 545, y: 250, r: 12, takenBy: null },
      { type: "magnet", x: 865, y: 120, r: 12, takenBy: null },
      { type: "dash", x: 865, y: 420, r: 12, takenBy: null },
    ];
  } else {
    return buildRaceLevel(game, "caroni_corridors");
  }

  const ids = game.turnOrder;
  const startY = game.H / 2;
  for (let i = 0; i < ids.length; i++) {
    const p = game.players[ids[i]];
    p.x = 120;
    p.y = startY + (i - ids.length / 2) * 44;
    p.vx = 0; p.vy = 0;
    p.finished = false;
  }
  resetRoundPerks(game);

  game.hint = "Race to the finish. Long corridors, multiple routes. One flick per turn.";
}

// Boss code left as-is (you said boulder boss is lame, but that requires design changes, not a bug fix)
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

  game.walls.push({ x: 220, y: 90, w: 24, h: 340 });
  game.walls.push({ x: 340, y: 150, w: 260, h: 24 });
  game.walls.push({ x: 340, y: 346, w: 260, h: 24 });
  game.walls.push({ x: 600, y: 150, w: 24, h: 220 });

  game.pads = [{ x: 120, y: 250, w: 110, h: 16 }, { x: 720, y: 250, w: 120, h: 16 }];

  game.coins = [
    { x: 170, y: 110 }, { x: 170, y: 410 }, { x: 520, y: 110 },
    { x: 520, y: 410 }, { x: 780, y: 150 }, { x: 780, y: 370 }
  ].map(c => ({ ...c, r: 10, takenBy: null }));

  game.boss = null;
  game.hint = "Boss mode placeholder. We'll replace the boulder boss with something better next.";
  game.toast = "Boss mode placeholder.";
  game.shake = 0;
  game.shakeT = 0;

  const ids = game.turnOrder;
  const startY = game.H / 2;
  for (let i = 0; i < ids.length; i++) {
    const p = game.players[ids[i]];
    p.x = 120;
    p.y = startY + (i - ids.length / 2) * 44;
    p.vx = 0; p.vy = 0;
    p.finished = false;
  }
  resetRoundPerks(game);
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

    p.vx *= 0.90;
    p.vy *= 0.90;
  }
}

function circleRectCollide(cx, cy, cr, rx, ry, rw, rh) {
  const nx = clamp(cx, rx, rx + rw);
  const ny = clamp(cy, ry, ry + rh);
  const dx = cx - nx;
  const dy = cy - ny;
  return dx * dx + dy * dy <= cr * cr;
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

function stepGame(game, dt) {
  if (!game) return;

  game.turnMsLeft -= dt * 1000;
  if (game.turnMsLeft <= 0 && game.phase === "play") {
    endTurn(game, "Time up");
  }

  if (game.turnState === "resolving" && game.phase === "play") {
    for (const pid of Object.keys(game.players)) {
      const pl = game.players[pid];

      pl.x += pl.vx * dt;
      pl.y += pl.vy * dt;

      // safety snap-back if player leaves arena (prevents "lost forever")
      const bx0 = game.bounds.x - 220, by0 = game.bounds.y - 220;
      const bx1 = game.bounds.x + game.bounds.w + 220, by1 = game.bounds.y + game.bounds.h + 220;
      if (pl.x < bx0 || pl.x > bx1 || pl.y < by0 || pl.y > by1) {
        pl.x = 120;
        pl.y = game.H / 2;
        pl.vx = 0;
        pl.vy = 0;
      }

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
    }

    const stopped = Object.values(game.players).every(pl => isStopped(pl));
    if (stopped) endTurn(game, null);
  }

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

  return {
    t: "snap",
    serverTime: nowMs(),
    room: { code: room.code, hostId: room.hostId },
    lobby: {
      started: lobby.started,
      mode: lobby.mode,
      picks: lobby.picks,
      ready: lobby.ready,
      players: Object.values(room.clients),
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
// WEBSOCKET HANDLERS
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

wss.on("connection", (ws) => {
  ws.roomCode = null;
  ws.playerId = null;

  send(ws, { t: "hello" });

  ws.on("message", (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return; }

    if (msg.t === "create") {
      const code = makeRoomCode();
      const room = makeRoom(code);
      rooms.set(code, room);
      send(ws, { t: "created", code });
      return;
    }

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
      if (!room.hostId) room.hostId = ws.playerId;

      room.lobby.ready[ws.playerId] = false;

      send(ws, { t: "joined", id: ws.playerId, code, hostId: room.hostId });
      broadcast(room, makeSnapshot(room));
      return;
    }

    const room = ws.roomCode ? getRoom(ws.roomCode) : null;
    if (!room) return;

    const pid = ws.playerId;

    if (msg.t === "set_mode") {
      if (pid !== room.hostId) return;
      const m = msg.mode === "boss" ? "boss" : "race";
      if (room.lobby.started) return;
      room.lobby.mode = m;
      broadcast(room, makeSnapshot(room));
      return;
    }

    if (msg.t === "pick") {
      if (room.lobby.started) return;
      const charId = String(msg.charId || "agouti");
      room.lobby.picks[pid] = charId;
      room.lobby.ready[pid] = false;
      broadcast(room, makeSnapshot(room));
      return;
    }

    if (msg.t === "ready") {
      if (room.lobby.started) return;
      const v = !!msg.v;
      room.lobby.ready[pid] = v;
      broadcast(room, makeSnapshot(room));
      return;
    }

    if (msg.t === "start") {
      if (pid !== room.hostId) return;
      if (room.lobby.started) return;

      const ids = Object.values(room.clients);
      if (ids.length < 1) return;

      for (const id of ids) {
        if (!room.lobby.picks[id]) room.lobby.picks[id] = "agouti";
      }

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
    }

    if (msg.t === "reset") {
      if (pid !== room.hostId) return;
      room.lobby.started = false;
      room.game = null;
      room.lobby.ready = {};
      for (const id of Object.values(room.clients)) room.lobby.ready[id] = false;
      broadcast(room, makeSnapshot(room));
      return;
    }
  });

  ws.on("close", () => {
    const room = ws.roomCode ? getRoom(ws.roomCode) : null;
    if (!room) return;

    const pid = ws.playerId;
    room.clients.delete(ws);

    delete room.lobby.picks[pid];
    delete room.lobby.ready[pid];

    if (pid === room.hostId) {
      const next = room.clients.values().next().value || null;
      room.hostId = next;
    }

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
server.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
