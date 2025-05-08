// === Serveur MMS-RealWar (Node.js + Socket.IO) ===
const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http);

const PORT = 3000;

app.use(express.static("public"));

let players = {};
let bonuses = [];
let targets = {};

const ARENA_WIDTH = 1920;
const ARENA_HEIGHT = 960;

const walls = [
  { x: 85, y: 569, w: 143, h: 167 },
  { x: 266, y: 732, w: 136, h: 178 },
  { x: 1049, y: 449, w: 172, h: 181 },
  { x: 137, y: 691, w: 170, h: 171 },
  { x: 1087, y: 309, w: 117, h: 109 },
  { x: 278, y: 209, w: 91, h: 164 },
  { x: 1142, y: 398, w: 92, h: 172 },
  { x: 676, y: 565, w: 93, h: 125 },
  { x: 807, y: 315, w: 166, h: 187 },
  { x: 1607, y: 331, w: 124, h: 92 },
  { x: 903, y: 293, w: 182, h: 186 },
  { x: 1122, y: 624, w: 137, h: 138 },
  { x: 1262, y: 229, w: 184, h: 131 },
  { x: 571, y: 625, w: 122, h: 112 },
  { x: 1015, y: 322, w: 165, h: 145 },
  { x: 755, y: 555, w: 197, h: 182 },
  { x: 494, y: 505, w: 181, h: 184 },
  { x: 1554, y: 219, w: 131, h: 165 },
  { x: 652, y: 190, w: 183, h: 197 },
  { x: 130, y: 400, w: 95, h: 110 }
];

function isInsideWall(x, y, radius = 20) {
  return walls.some(w =>
    x + radius > w.x && x - radius < w.x + w.w &&
    y + radius > w.y && y - radius < w.y + w.h
  );
}

function getSafePosition() {
  let tries = 0;
  while (tries < 100) {
    const x = Math.random() * (ARENA_WIDTH - 40) + 20;
    const y = Math.random() * (ARENA_HEIGHT - 40) + 20;
    if (!isInsideWall(x, y, 25)) return { x, y };
    tries++;
  }
  return { x: 100, y: 100 }; // fallback
}

function spawnBonus() {
  const rand = Math.random();
  let type = 'troop';
  if (rand < 0.1) type = 'vehicle';
  else if (rand < 0.4) type = 'weapon';

  const amount = type === 'troop' ? 1 : type === 'weapon' ? 2 : 5;
  const pos = getSafePosition();

  bonuses.push({
    id: Date.now(),
    ...pos,
    type,
    amount
  });
}

setInterval(spawnBonus, 1000);

let gameEnded = false;

io.on("connection", (socket) => {
  if (gameEnded) return;

  console.log("✅ Joueur connecté :", socket.id);

  const colors = ["red", "blue", "green", "purple", "orange"];
  const color = colors[Math.floor(Math.random() * colors.length)];
  const pos = getSafePosition();

  players[socket.id] = {
    id: socket.id,
    ...pos,
    units: 5,
    name: "",
    color,
    score: 0
  };

  targets[socket.id] = null;

  socket.emit("askName");

  socket.on("setName", (name) => {
    players[socket.id].name = name;
    socket.emit("init", { id: socket.id, players, bonuses });
    socket.broadcast.emit("newPlayer", players[socket.id]);
  });

  socket.on("move", (dir) => {
    if (gameEnded) return;
    targets[socket.id] = null;
    const speed = 6;
    const p = players[socket.id];
    if (!p) return;
    if (dir === "up") p.y -= speed;
    if (dir === "down") p.y += speed;
    if (dir === "left") p.x -= speed;
    if (dir === "right") p.x += speed;
  });

  socket.on("clickMove", (target) => {
    if (gameEnded) return;
    targets[socket.id] = target;
  });

  socket.on("disconnect", () => {
    console.log("❌ Joueur déconnecté :", socket.id);
    delete players[socket.id];
    delete targets[socket.id];
    io.emit("removePlayer", socket.id);
  });
});

function getRadius(units) {
  return 10 * (1 + units * 0.001);
}

setInterval(() => {
  if (gameEnded) return;

  for (const id in targets) {
    const target = targets[id];
    const p = players[id];
    if (target && p) {
      const dx = target.x - p.x;
      const dy = target.y - p.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const speed = 4;
      if (dist > speed) {
        const nx = p.x + (dx / dist) * speed;
        const ny = p.y + (dy / dist) * speed;
        const radius = getRadius(p.units);
        if (!isInsideWall(nx, ny, radius)) {
          p.x = nx;
          p.y = ny;
        } else {
          targets[id] = null;
        }
      } else {
        p.x = target.x;
        p.y = target.y;
        targets[id] = null;
      }
    }
  }

  const ids = Object.keys(players);
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = players[ids[i]];
      const b = players[ids[j]];
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      const radiusA = getRadius(a.units);
      const radiusB = getRadius(b.units);

      if (dist < radiusA + radiusB) {
        if (a.units > b.units) {
          const lostUnits = Math.floor(b.units * 0.25);
          a.units += lostUnits;
          a.score += lostUnits;
          io.emit("flash", { x: b.x, y: b.y });
          if (b.units - lostUnits <= 5) {
            io.to(b.id).emit("dead");
            delete players[b.id];
            delete targets[b.id];
            io.emit("removePlayer", b.id);
          } else {
            b.units -= lostUnits;
            const pos = getSafePosition();
            b.x = pos.x;
            b.y = pos.y;
          }
        } else if (b.units > a.units) {
          const lostUnits = Math.floor(a.units * 0.25);
          b.units += lostUnits;
          b.score += lostUnits;
          io.emit("flash", { x: a.x, y: a.y });
          if (a.units - lostUnits <= 5) {
            io.to(a.id).emit("dead");
            delete players[a.id];
            delete targets[a.id];
            io.emit("removePlayer", a.id);
          } else {
            a.units -= lostUnits;
            const pos = getSafePosition();
            a.x = pos.x;
            a.y = pos.y;
          }
        }
      }
    }
  }

  for (const id in players) {
    const p = players[id];
    bonuses = bonuses.filter((bonus) => {
      const dx = p.x - bonus.x;
      const dy = p.y - bonus.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 20) {
        p.units += bonus.amount;
        p.score += bonus.amount;
        return false;
      }
      return true;
    });

    if (p.units >= 500 && !gameEnded) {
      gameEnded = true;
      io.emit("win", p.name);
    }
  }

  io.emit("state", { players, bonuses });
}, 1000 / 30);

http.listen(PORT, () => {
  console.log("✅ MMS-RealWar prêt sur http://localhost:" + PORT);
});
