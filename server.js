// server.js
const path = require("path");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PUBLIC_DIR = path.join(__dirname, "public");

// Serve static files
app.use(express.static(PUBLIC_DIR));

// Force root route to load index.html
app.get("/", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

// Optional: if you refresh on any route, still serve the app
app.get("*", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

const rooms = new Map();

function safeRoomId(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, 24);
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function defaultPlayer() {
  return {
    name: "Player",
    x: 120,
    y: 260,
    vx: 0,
    vy: 0,
    r: 16,
    t: Date.now()
  };
}

io.on("connection", (socket) => {
  socket.data.roomId = null;

  socket.on("create_room", ({ roomId, name }) => {
    const rid = safeRoomId(roomId) || ("room_" + Math.random().toString(16).slice(2, 8));
    if (!rooms.has(rid)) rooms.set(rid, { players: new Map(), createdAt: Date.now() });

    socket.emit("room_created", { roomId: rid });
    joinRoom(socket, rid, name);
  });

  socket.on("join_room", ({ roomId, name }) => {
    const rid = safeRoomId(roomId);
    if (!rid) {
      socket.emit("join_error", { message: "Invalid room name." });
      return;
    }
    if (!rooms.has(rid)) rooms.set(rid, { players: new Map(), createdAt: Date.now() });
    joinRoom(socket, rid, name);
  });

  socket.on("leave_room", () => leaveRoom(socket));

  socket.on("player_state", (state) => {
    const rid = socket.data.roomId;
    if (!rid) return;

    const room = rooms.get(rid);
    if (!room) return;

    const p = room.players.get(socket.id);
    if (!p) return;

    p.x = clamp(Number(state.x) || p.x, 0, 5000);
    p.y = clamp(Number(state.y) || p.y, 0, 5000);
    p.vx = clamp(Number(state.vx) || 0, -5000, 5000);
    p.vy = clamp(Number(state.vy) || 0, -5000, 5000);
    p.t = Date.now();

    socket.to(rid).emit("player_state", { id: socket.id, ...p });
  });

  socket.on("disconnect", () => leaveRoom(socket));
});

function joinRoom(socket, rid, name) {
  leaveRoom(socket);

  const room = rooms.get(rid);
  if (!room) return;

  socket.join(rid);
  socket.data.roomId = rid;

  const p = defaultPlayer();
  p.name = String(name || "Player").trim().slice(0, 18) || "Player";
  room.players.set(socket.id, p);

  const snapshot = [];
  for (const [id, data] of room.players.entries()) snapshot.push({ id, ...data });

  socket.emit("room_joined", { roomId: rid, you: socket.id, players: snapshot });
  socket.to(rid).emit("player_joined", { id: socket.id, ...p });
}

function leaveRoom(socket) {
  const rid = socket.data.roomId;
  if (!rid) return;

  const room = rooms.get(rid);
  if (room) {
    room.players.delete(socket.id);
    socket.to(rid).emit("player_left", { id: socket.id });
    if (room.players.size === 0) rooms.delete(rid);
  }

  socket.leave(rid);
  socket.data.roomId = null;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Server running on port", PORT));
