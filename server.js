// === Serveur MMS-RealWar à jour avec envoi des obstacles ===
const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http);

const PORT = 3000;

app.use(express.static("public"));

let players = {};
let bonuses = [];
let targets = {};
let projectiles = [];

const ARENA_WIDTH = 1920;
const ARENA_HEIGHT = 960;

const walls = [...Array(10)].map(() => ({
  x: Math.random() * 1700 + 50,
  y: Math.random() * 700 + 50,
  w: 100 + Math.random() * 100,
  h: 100 + Math.random() * 100
}));

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
  return { x: 100, y: 100 };
}

function spawnBonus() {
  const rand = Math.random();
  let type = 'troop';
  if (rand < 0.1) type = 'vehicle';
  else if (rand < 0.4) type = 'weapon';

  const amount = type === 'troop' ? 1 : type === 'weapon' ? 2 : 5;
  const pos = getSafePosition();
  bonuses.push({ id: Date.now(), ...pos, type, amount });
}
setInterval(spawnBonus, 1000);

let gameEnded = false;
io.on("connection", (socket) => {
  if (gameEnded) return;

  const pos = getSafePosition();
  const colors = ["red", "blue", "green", "purple", "orange"];
  const color = colors[Math.floor(Math.random() * colors.length)];

  players[socket.id] = {
    id: socket.id,
    ...pos,
    units: 5,
    name: "",
    color,
    score: 0,
    direction: { x: 0, y: -1 },
    dead: false
  };

  targets[socket.id] = null;

  socket.emit("askName");

  socket.on("setName", (name) => {
    players[socket.id].name = name;
    socket.emit("init", { id: socket.id, players, bonuses, walls });
    socket.broadcast.emit("newPlayer", players[socket.id]);
  });

  socket.on("move", (dir) => {
    if (players[socket.id]?.dead || gameEnded) return;
    targets[socket.id] = null;
    const p = players[socket.id];
    const speed = 6;
    if (dir === "up") p.y -= speed, p.direction = { x: 0, y: -1 };
    if (dir === "down") p.y += speed, p.direction = { x: 0, y: 1 };
    if (dir === "left") p.x -= speed, p.direction = { x: -1, y: 0 };
    if (dir === "right") p.x += speed, p.direction = { x: 1, y: 0 };
  });

  socket.on("clickMove", (target) => {
    if (players[socket.id]?.dead || gameEnded) return;
    targets[socket.id] = target;
  });

  socket.on("shoot", () => {
    const p = players[socket.id];
    if (!p || p.dead || p.units <= 1) return;
    p.units -= 1;
    const speed = 6;
    projectiles.push({
      id: Date.now() + Math.random(),
      from: socket.id,
      x: p.x,
      y: p.y,
      dx: p.direction.x * speed,
      dy: p.direction.y * speed
    });
  });

  socket.on("disconnect", () => {
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

  projectiles = projectiles.filter(p => {
    p.x += p.dx;
    p.y += p.dy;
    if (p.x < 0 || p.y < 0 || p.x > ARENA_WIDTH || p.y > ARENA_HEIGHT) return false;

    for (const id in players) {
      if (id === p.from || players[id].dead) continue;
      const t = players[id];
      const dx = p.x - t.x;
      const dy = p.y - t.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < getRadius(t.units)) {
        players[p.from].units += 2;
        players[p.from].score += 2;
        t.units -= 2;
        io.to(p.from).emit("hit");
        io.to(t.id).emit("hit");
        if (t.units <= 1) {
          t.dead = true;
          io.to(t.id).emit("dead");
          io.to(p.from).emit("dead");
        }
        return false;
      }
    }
    return true;
  });

  for (const id in targets) {
    const target = targets[id];
    const p = players[id];
    if (!p || p.dead) continue;
    if (target) {
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
      if (a.dead || b.dead) continue;
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const rA = getRadius(a.units);
      const rB = getRadius(b.units);

      if (dist < rA + rB) {
        if (a.units > b.units) {
          const lost = Math.floor(b.units * 0.25);
          a.units += lost;
          a.score += lost;
          io.to(a.id).emit("flash", { x: b.x, y: b.y });
          if (b.units - lost <= 1) {
            b.dead = true;
            io.to(b.id).emit("dead");
            io.to(a.id).emit("dead");
          } else {
            b.units -= lost;
            const pos = getSafePosition();
            b.x = pos.x;
            b.y = pos.y;
          }
        } else if (b.units > a.units) {
          const lost = Math.floor(a.units * 0.25);
          b.units += lost;
          b.score += lost;
          io.to(b.id).emit("flash", { x: a.x, y: a.y });
          if (a.units - lost <= 1) {
            a.dead = true;
            io.to(a.id).emit("dead");
            io.to(b.id).emit("dead");
          } else {
            a.units -= lost;
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
    if (p.dead) continue;
    bonuses = bonuses.filter(b => {
      const dx = p.x - b.x;
      const dy = p.y - b.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 20) {
        p.units += b.amount;
        p.score += b.amount;
        return false;
      }
      return true;
    });

    if (p.units >= 500 && !gameEnded) {
      gameEnded = true;
      io.emit("win", p.name);
    }
  }

  io.emit("state", { players, bonuses, projectiles, walls });
}, 1000 / 30);

http.listen(PORT, () => {
  console.log("✅ MMS-RealWar prêt sur http://localhost:" + PORT);
});

