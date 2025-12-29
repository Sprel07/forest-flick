// server.js
// Multiplayer authoritative server for Forest Flick

const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();
app.use(express.static("."));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const TICK_HZ = 60;
const SNAP_HZ = 20;

const rooms = new Map(); // roomCode -> room

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
    clients: new Map(), // ws -> playerId
    hostId: null,
    lobby: {
      mode: "race",
      started: false,
      picks: {},
      ready: {},
      maxPlayers: 4,
    },
    game: null,
    lastTick: nowMs(),
    lastSnap: 0,
    _loop: null,
  };
}

// ---------------- SNAPSHOT ----------------

function makeSnapshot(room) {
  const game = room.game;
  return {
    t: "snap",
    serverTime: nowMs(),
    room: { code: room.code, hostId: room.hostId },
    lobby: {
      started: room.lobby.started,
      mode: room.lobby.mode,
      picks: room.lobby.picks,
      ready: room.lobby.ready,
      players: [...room.clients.values()], // FIXED
      maxPlayers: room.lobby.maxPlayers,
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

// ---------------- GAME STUB (minimal for lobby testing) ----------------

function makeGame(mode, ids, picks) {
  return {
    mode,
    round: 1,
    phase: "play",
    winnerId: null,
    turnOrder: [...ids],
    turnIndex: 0,
    activeId: ids[0],
    turnState: "aim",
    turnMsLeft: 25000,
    players: Object.fromEntries(ids.map(id => [
      id,
      { id, charId: picks[id] || "agouti", x: 120, y: 200, vx: 0, vy: 0 }
    ])),
    levelId: "test",
    finish: null,
    walls: [],
    pads: [],
    traps: [],
    coins: [],
    items: [],
    boss: null,
    hint: "",
    toast: "",
    shake: 0,
    shakeT: 0,
  };
}

function ensureRoomLoop(room) {
  if (room._loop) return;
  room._loop = setInterval(() => {
    if (!room.game) return;
    const t = nowMs();
    const dt = Math.min(0.05, (t - room.lastTick) / 1000);
    room.lastTick = t;
    room.lastSnap += dt;
    if (room.lastSnap >= 1 / SNAP_HZ) {
      room.lastSnap = 0;
      broadcast(room, makeSnapshot(room));
      room.game.toast = "";
    }
  }, Math.floor(1000 / TICK_HZ));
}

// ---------------- WEBSOCKET ----------------

wss.on("connection", (ws) => {
  ws.roomCode = null;
  ws.playerId = null;

  send(ws, { t: "hello" });

  ws.on("message", (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return; }

    // CREATE ROOM
    if (msg.t === "create") {
      const code = makeRoomCode();
      const room = makeRoom(code);
      rooms.set(code, room);
      send(ws, { t: "created", code });
      return;
    }

    // JOIN ROOM
    if (msg.t === "join") {
      const code = String(msg.code || "").toUpperCase();
      let room = rooms.get(code);
      if (!room) {
        room = makeRoom(code);
        rooms.set(code, room);
      }
      if (room.clients.size >= room.lobby.maxPlayers) {
        send(ws, { t: "err", m: "Room full" });
        return;
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

    const room = ws.roomCode ? rooms.get(ws.roomCode) : null;
    if (!room) return;
    const pid = ws.playerId;

    // SET MODE
    if (msg.t === "set_mode" && pid === room.hostId && !room.lobby.started) {
      room.lobby.mode = msg.mode === "boss" ? "boss" : "race";
      broadcast(room, makeSnapshot(room));
      return;
    }

    // PICK CHARACTER
    if (msg.t === "pick" && !room.lobby.started) {
      room.lobby.picks[pid] = msg.charId || "agouti";
      room.lobby.ready[pid] = false;
      broadcast(room, makeSnapshot(room));
      return;
    }

    // READY
    if (msg.t === "ready" && !room.lobby.started) {
      room.lobby.ready[pid] = !!msg.v;
      broadcast(room, makeSnapshot(room));
      return;
    }

    // START
    if (msg.t === "start" && pid === room.hostId && !room.lobby.started) {
      const ids = [...room.clients.values()]; // FIXED
      for (const id of ids) {
        if (!room.lobby.picks[id]) room.lobby.picks[id] = "agouti";
        if (!room.lobby.ready[id]) {
          send(ws, { t: "err", m: "Everyone must be ready" });
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

    // RESET
    if (msg.t === "reset" && pid === room.hostId) {
      room.lobby.started = false;
      room.game = null;
      room.lobby.ready = {};
      for (const id of [...room.clients.values()]) room.lobby.ready[id] = false; // FIXED
      broadcast(room, makeSnapshot(room));
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

    if (pid === room.hostId) {
      room.hostId = room.clients.values().next().value || null;
    }

    if (room.clients.size === 0) {
      if (room._loop) clearInterval(room._loop);
      rooms.delete(room.code);
    } else {
      broadcast(room, makeSnapshot(room));
    }
  });
});

// ---------------- START SERVER ----------------

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
