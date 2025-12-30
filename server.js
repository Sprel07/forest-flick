// server.js
const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();
app.use(express.static("."));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const rooms = new Map();

function randId() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}
function roomCode() {
  return Math.random().toString(36).slice(2, 6).toUpperCase();
}
function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}
function broadcast(room, msg) {
  room.clients.forEach(ws => send(ws, msg));
}

function makeRoom(code) {
  return {
    code,
    clients: new Map(), // ws -> player
    hostId: null,
    lobby: {
      started: false,
      players: {}, // id -> {id,name,char,ready}
      mode: "race"
    },
    game: null
  };
}

function buildMaze(game) {
  game.walls = [
    { x: 20, y: 20, w: 920, h: 16 },
    { x: 20, y: 504, w: 920, h: 16 },
    { x: 20, y: 20, w: 16, h: 500 },
    { x: 924, y: 20, w: 16, h: 500 },

    { x: 180, y: 40, w: 24, h: 460 },
    { x: 360, y: 40, w: 24, h: 360 },
    { x: 540, y: 140, w: 24, h: 360 },
    { x: 720, y: 40, w: 24, h: 360 },

    { x: 60, y: 120, w: 280, h: 24 },
    { x: 240, y: 260, w: 280, h: 24 },
    { x: 420, y: 180, w: 280, h: 24 },
    { x: 420, y: 360, w: 280, h: 24 }
  ];

  game.finish = { x: 780, y: 420, w: 120, h: 80 };
}

function makeGame(players) {
  const game = {
    turn: 0,
    order: Object.keys(players),
    players: {},
    walls: [],
    finish: null
  };

  let y = 260;
  for (const id of game.order) {
    game.players[id] = {
      x: 80,
      y,
      vx: 0,
      vy: 0,
      r: 18
    };
    y += 50;
  }

  buildMaze(game);
  return game;
}

wss.on("connection", ws => {
  ws.player = null;
  ws.room = null;

  ws.on("message", buf => {
    let msg;
    try { msg = JSON.parse(buf); } catch { return; }

    if (msg.t === "create") {
      const code = roomCode();
      const room = makeRoom(code);
      rooms.set(code, room);
      send(ws, { t: "created", code });
      return;
    }

    if (msg.t === "join") {
      const code = msg.code.toUpperCase();
      if (!rooms.has(code)) rooms.set(code, makeRoom(code));
      const room = rooms.get(code);

      const id = randId();
      const player = {
        id,
        name: msg.name || "Player",
        char: "agouti",
        ready: false
      };

      room.clients.set(ws, player);
      room.lobby.players[id] = player;
      if (!room.hostId) room.hostId = id;

      ws.player = player;
      ws.room = room;

      broadcast(room, { t: "lobby", room });
      return;
    }

    if (!ws.room) return;

    const room = ws.room;
    const player = ws.player;

    if (msg.t === "pick") {
      player.char = msg.char;
      broadcast(room, { t: "lobby", room });
    }

    if (msg.t === "ready") {
      player.ready = msg.v;
      broadcast(room, { t: "lobby", room });
    }

    if (msg.t === "start") {
      if (player.id !== room.hostId) return;
      if (!Object.values(room.lobby.players).every(p => p.ready)) return;

      room.lobby.started = true;
      room.game = makeGame(room.lobby.players);
      broadcast(room, { t: "start", game: room.game });
    }

    if (msg.t === "flick") {
      const g = room.game;
      if (!g) return;
      if (g.order[g.turn] !== player.id) return;

      const p = g.players[player.id];
      p.vx = msg.vx;
      p.vy = msg.vy;
      g.turn = (g.turn + 1) % g.order.length;
      broadcast(room, { t: "game", game: g });
    }
  });

  ws.on("close", () => {
    if (!ws.room) return;
    ws.room.clients.delete(ws);
    delete ws.room.lobby.players[ws.player.id];
    broadcast(ws.room, { t: "lobby", room: ws.room });
  });
});

server.listen(3000, () => console.log("Server running"));
