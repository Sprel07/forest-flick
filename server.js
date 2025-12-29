// server.js
// Run locally:
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
app.use(express.static(".")); // serves index.html and assets in repo root

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

function roomPlayerIds(room) {
  // room.clients is Map(ws -> pid)
  return Array.from(room.clients.values());
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
    accum: 0,
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

  // hint for first stage
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
    game.walls.push({ x: 220, y: 130, w: 260, h: 24 });
    game.walls.push({ x: 300, y: 320, w: 330, h: 24 });
    game.walls.push({ x: 610, y: 170, w: 24, h: 220 });

    game.finish = { x: game.W - 170, y: 90, w: 110, h: 80 };

    game.coins = [
      { x: 200, y: 90 }, { x: 240, y: 440 }, { x: 520, y: 90 },
      { x: 520, y: 440 }, { x: 720, y: 360 }, { x: 760, y: 220 }
    ].map(c => ({ ...c, r: 10, takenBy: null }));

    game.traps = [{ x: 450, y: 250, r: 14 }];
    game.pads = [{ x: 140, y: 250, w: 90, h: 16 }, { x: 690, y: 440, w: 120, h: 16 }];

    game.items = [
      { type: "dash", x: 640, y: 95, r: 12, takenBy: null },
      { type: "shield", x: 255, y: 380, r: 12, takenBy: null },
      { type: "magnet", x: 760, y: 430, r: 12, takenBy: null },
    ];
  } else if (levelId === "maracas_bounce") {
    game.walls.push({ x: 230, y: 110, w: 440, h: 24 });
    game.walls.push({ x: 230, y: 386, w: 440, h: 24 });
    game.walls.push({ x: 230, y: 134, w: 24, h: 252 });
    game.walls.push({ x: 646, y: 134, w: 24, h: 252 });
    game.walls.push({ x: 360, y: 240, w: 180, h: 20 });
    game.walls.push({ x: 440, y: 190, w: 20, h: 140 });

    game.finish = { x: game.W - 170, y: 70, w: 110, h: 80 };

    game.coins = [
      { x: 160, y: 110 }, { x: 160, y: 410 }, { x: 450, y: 95 },
      { x: 450, y: 425 }, { x: 740, y: 220 }, { x: 780, y: 450 }
    ].map(c => ({ ...c, r: 10, takenBy: null }));

    game.traps = [{ x: 450, y: 290, r: 14 }, { x: 560, y: 230, r: 14 }];
    game.pads = [{ x: 120, y: 250, w: 110, h: 16 }, { x: 730, y: 320, w: 120, h: 16 }];

    game.items = [
      { type: "shield", x: 450, y: 165, r: 12, takenBy: null },
      { type: "magnet", x: 700, y: 140, r: 12, takenBy: null },
      { type: "dash", x: 300, y: 430, r: 12, takenBy: null },
    ];
  } else {
    game.finish = { x: game.W - 170, y: 90, w: 110, h: 80 };
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

  game.hint = "Race to the finish. One flick per turn. First to touch wins.";
}

const BOSS_DEFS = [
  { id: "moko_boulder", name: "Moko Boulder Idol", hp: 10, rules: ["BOULDER_ONLY"], hint: "Only the boulder can damage it. Flick yourself into the boulder to launch it." },
  { id: "armored_crab", name: "Armored Crab King", hp: 12, rules: ["DASH_ONLY"], hint: "Only dash strikes hurt it. Use dash during your movement to ram it." },
  { id: "spirit_owl", name: "Spirit Owl Warden", hp: 10, rules: ["PARRY_ONLY"], hint: "Parry the shockwave. Dash through the expanding ring at the right time." },
  { id: "reef_golem", name: "Reef Golem", hp: 14, rules: ["WEAKSPOT_CYCLE"], hint: "Hit the glowing weak spot. It moves every few seconds." },
  { id: "storm_manta", name: "Storm Manta", hp: 14, rules: ["RICOCHET_REQUIRED", "WEAKSPOT_CYCLE"], hint: "Boss only takes real damage after you bounce off a wall, then hit the weak glow." },
  { id: "totem_jaguar", name: "Totem Jaguar", hp: 16, rules: ["STUN_THEN_PUNISH"], hint: "Stun it first. Hit two arena objects into it to drop its shield, then strike fast." },
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

  game.walls.push({ x: 220, y: 90, w: 24, h: 340 });
  game.walls.push({ x: 340, y: 150, w: 260, h: 24 });
  game.walls.push({ x: 340, y: 346, w: 260, h: 24 });
  game.walls.push({ x: 600, y: 150, w: 24, h: 220 });

  game.pads = [{ x: 120, y: 250, w: 110, h: 16 }, { x: 720, y: 250, w: 120, h: 16 }];

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

  if (game.boss.rules.includes("DASH_ONLY") || game.boss.rules.includes("PARRY_ONLY")) {
    game.items.push({ type: "dash", x: 320, y: 110, r: 12, takenBy: null });
    game.items.push({ type: "dash", x: 320, y: 410, r: 12, takenBy: null });
  }
  if (game.boss.rules.includes("BOULDER_ONLY") || game.boss.rules.includes("STUN_THEN_PUNISH")) {
    game.items.push({ type: "boulder", x: game.W * 0.40, y: game.H * 0.50, r: 22, vx: 0, vy: 0 });
  }
  game.items.push({ type: "shield", x: 320, y: 250, r: 12, takenBy: null });
  game.items.push({ type: "magnet", x: 780, y: 260, r: 12, takenBy: null });

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

  if (boss.rules.includes("BOULDER_ONLY") && source !== "BOULDER") return false;
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

function updateBoulder(game, dt) {
  const b = game.items.find(it => it.type === "boulder");
  if (!b) return;

  b.x += (b.vx || 0) * dt;
  b.y += (b.vy || 0) * dt;
  b.vx *= 0.992;
  b.vy *= 0.992;

  const tmp = { x: b.x, y: b.y, vx: b.vx, vy: b.vy, r: b.r, bounceKeep: 0.92 };
  for (const w of game.walls) {
    if (circleRectCollide(tmp.x, tmp.y, tmp.r, w.x, w.y, w.w, w.h)) resolveCircleRect(tmp, w);
  }
  b.x = tmp.x; b.y = tmp.y; b.vx = tmp.vx; b.vy = tmp.vy;

  if (game.boss) {
    const dx = b.x - game.boss.x;
    const dy = b.y - game.boss.y;
    const d = Math.hypot(dx, dy);
    if (d <= b.r + game.boss.r) {
      const sp = Math.hypot(b.vx, b.vy);
      if (sp > 60) {
        bossTakeDamage(game, 1, "BOULDER", Math.atan2(dy, dx));
        b.vx *= 0.55; b.vy *= 0.55;
        game.shake = Math.max(game.shake, 16);
        game.shakeT = Math.max(game.shakeT, 0.20);
        game.toast = "Boulder smash!";
      }
    }
  }
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
    updateBoulder(game, dt);
  }

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
        if (it.type === "boulder") continue;
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
          if (pl.shield) pl.shield = false;
          else {
            pl.x = 120;
            pl.y = game.H / 2;
            pl.vx = 0; pl.vy = 0;
          }
        }
      }

      const b = game.items.find(x => x.type === "boulder");
      if (b) {
        const dx = b.x - pl.x, dy = b.y - pl.y;
        const d = Math.hypot(dx, dy);
        if (d <= b.r + pl.r) {
          const sp = Math.max(80, Math.min(360, Math.hypot(pl.vx, pl.vy)));
          const ux = dx / (d || 1), uy = dy / (d || 1);
          b.vx += ux * sp * 0.85;
          b.vy += uy * sp * 0.85;
          game.shake = Math.max(game.shake, 6);
          game.shakeT = Math.max(game.shakeT, 0.10);
        }
      }

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
          } else {
            if (!boss.rules.includes("BOULDER_ONLY") &&
                !boss.rules.includes("DASH_ONLY") &&
                !boss.rules.includes("PARRY_ONLY") &&
                !boss.rules.includes("RICOCHET_REQUIRED")) {
              const ang = Math.atan2(dy, dx);
              bossTakeDamage(game, 0.25, "BODY", ang);
            }
          }
        }

        if (boss.rules.includes("PARRY_ONLY") && boss.ring && boss.ring.active) {
          const rx = pl.x - boss.ring.x, ry = pl.y - boss.ring.y;
          const d = Math.hypot(rx, ry);
          const hitRing = Math.abs(d - boss.ring.r) < 10;
          if (hitRing && pl.dashStrikeWindow <= 0) {
            if (pl.shield) pl.shield = false;
            else {
              pl.x = 120;
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
    const next = (game.levelId === "cocorite_cove") ? "maracas_bounce" : "cocorite_cove";
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
      players: roomPlayerIds(room), // FIXED
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

      const ids = roomPlayerIds(room); // FIXED
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

    if (msg.t === "reset") {
      if (pid !== room.hostId) return;

      room.lobby.started = false;
      room.game = null;

      // keep picks (optional), but reset ready states
      const ids = roomPlayerIds(room); // FIXED
      room.lobby.ready = {};
      for (const id of ids) room.lobby.ready[id] = false;

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
      const nextHost = room.clients.values().next().value || null; // Map values are pids
      room.hostId = nextHost;
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
