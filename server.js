// server.js
const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();
app.use(express.static("."));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const rooms = new Map();

const PLAYER_HP = 3;

function id() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}
function code() {
  return Math.random().toString(36).slice(2, 6).toUpperCase();
}
function send(ws, o) {
  if (ws.readyState === 1) ws.send(JSON.stringify(o));
}
function broadcast(room, o) {
  room.clients.forEach(ws => send(ws, o));
}

function makeRoom(code) {
  return {
    code,
    clients: new Map(),
    host: null,
    lobby: { started:false, players:{} },
    game: null
  };
}

/* ---------- MAPS ---------- */

function raceMap() {
  return {
    walls: [
      {x:20,y:20,w:920,h:16},{x:20,y:504,w:920,h:16},
      {x:20,y:20,w:16,h:500},{x:924,y:20,w:16,h:500},

      {x:160,y:40,w:24,h:460},
      {x:340,y:40,w:24,h:360},
      {x:520,y:140,w:24,h:360},
      {x:700,y:40,w:24,h:360},

      {x:60,y:120,w:260,h:24},
      {x:240,y:260,w:260,h:24},
      {x:420,y:180,w:260,h:24},
      {x:420,y:360,w:260,h:24}
    ],
    finish:{x:780,y:420,w:120,h:80}
  };
}

function bossMap() {
  return {
    walls:[
      {x:20,y:20,w:920,h:16},{x:20,y:504,w:920,h:16},
      {x:20,y:20,w:16,h:500},{x:924,y:20,w:16,h:500},
      {x:300,y:120,w:360,h:24},
      {x:300,y:396,w:360,h:24}
    ]
  };
}

/* ---------- GAME ---------- */

function makeGame(players) {
  const order = Object.keys(players);
  const game = {
    mode: "race",
    turn: 0,
    bossTurnCounter: 0,
    order,
    players:{},
    boss:null,
    map:null
  };

  let y = 260;
  for (const pid of order) {
    game.players[pid] = {
      id:pid,
      name:players[pid].name,
      x:80,y,
      vx:0,vy:0,
      r:18,
      hp:PLAYER_HP,
      color:players[pid].color
    };
    y+=50;
  }

  game.map = raceMap();
  return game;
}

function startBoss(game) {
  game.mode = "boss";
  game.map = bossMap();
  game.boss = {
    hp:5,
    x:600,y:260,r:40
  };
  game.bossTurnCounter = 0;
}

/* ---------- SOCKET ---------- */

wss.on("connection", ws=>{
  ws.room=null; ws.player=null;

  ws.on("message", buf=>{
    let m; try{m=JSON.parse(buf)}catch{return};

    if(m.t==="create"){
      const c=code();
      const r=makeRoom(c);
      rooms.set(c,r);
      send(ws,{t:"created",code:c});
      return;
    }

    if(m.t==="join"){
      const c=m.code.toUpperCase();
      if(!rooms.has(c)) rooms.set(c,makeRoom(c));
      const r=rooms.get(c);

      const pid=id();
      const player={
        id:pid,
        name:m.name||"Player",
        ready:false,
        color:`hsl(${Math.random()*360},70%,60%)`
      };

      r.clients.set(ws,player);
      r.lobby.players[pid]=player;
      if(!r.host) r.host=pid;

      ws.room=r; ws.player=player;
      broadcast(r,{t:"lobby",room:r});
      return;
    }

    if(!ws.room) return;
    const r=ws.room;
    const p=ws.player;

    if(m.t==="ready"){
      p.ready=m.v;
      broadcast(r,{t:"lobby",room:r});
    }

    if(m.t==="start"){
      if(p.id!==r.host) return;
      if(!Object.values(r.lobby.players).every(x=>x.ready)) return;
      r.lobby.started=true;
      r.game=makeGame(r.lobby.players);
      broadcast(r,{t:"game",game:r.game});
    }

    if(m.t==="flick"){
      const g=r.game;
      if(!g) return;
      if(g.order[g.turn]!==p.id) return;

      const pl=g.players[p.id];
      pl.vx=m.vx; pl.vy=m.vy;

      g.turn=(g.turn+1)%g.order.length;
      g.bossTurnCounter++;

      if(g.mode==="race" && pl.x>750){
        startBoss(g);
      }

      if(g.mode==="boss" && g.bossTurnCounter===2){
        g.bossTurnCounter=0;
        const target=g.players[g.order[g.turn]];
        target.hp--;
        if(target.hp<=0){
          target.hp=PLAYER_HP;
          target.x=80; target.y=260;
        }
      }

      broadcast(r,{t:"game",game:g});
    }
  });

  ws.on("close",()=>{
    if(!ws.room) return;
    ws.room.clients.delete(ws);
    delete ws.room.lobby.players[ws.player.id];
    broadcast(ws.room,{t:"lobby",room:ws.room});
  });
});

server.listen(3000,()=>console.log("Running on 3000"));
