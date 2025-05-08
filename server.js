// === Serveur RealWar.io ===
const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http);

const PORT = 3000;
const PASSWORD = "MMS";

app.use(express.static("public"));

let players = {};
let bonuses = [];
let projectiles = [];
let targets = {};
let gameEnded = false;

const ARENA_WIDTH = 1920;
const ARENA_HEIGHT = 960;
const colors = ["red", "blue", "green", "purple", "orange"];

const walls = [...Array(20)].map(() => ({
  x: Math.random() * 1700 + 20,
  y: Math.random() * 700 + 20,
  w: 80 + Math.random() * 120,
  h: 80 + Math.random() * 120
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
  const type = rand < 0.1 ? 'red' : rand < 0.4 ? 'blue' : 'green';
  const amount = type === 'red' ? 5 : type === 'blue' ? 2 : 1;
  bonuses.push({ id: Date.now(), ...getSafePosition(), type, amount });
}
setInterval(spawnBonus, 1000);

function getRadius(units) {
  return 10 * (1 + units * 0.001);
}

io.on("connection", (socket) => {
  socket.emit("askPassword");

  socket.on("checkPassword", (pass) => {
    if (pass !== PASSWORD) {
      socket.disconnect();
      return;
    }
    socket.emit("askName");
  });

  socket.on("setName", (name) => {
    const pos = getSafePosition();
    const color = colors[Math.floor(Math.random() * colors.length)];
    players[socket.id] = {
      id: socket.id,
      ...pos,
      units: 10,
      name,
      color,
      direction: { x: 0, y: -1 },
      dead: false,
      score: 0
    };
    targets[socket.id] = null;
    socket.emit("init", { id: socket.id, players, bonuses, walls });
    socket.broadcast.emit("newPlayer", players[socket.id]);
  });

  socket.on("clickMove", (target) => {
    if (!players[socket.id] || players[socket.id].dead) return;
    targets[socket.id] = target;
  });

  socket.on("fire", (dir) => {
    const p = players[socket.id];
    if (!p || p.dead || p.units <= 1) return;
    if (typeof dir.x !== 'number' || typeof dir.y !== 'number') return;
    p.units--;
    projectiles.push({
      id: Date.now() + Math.random(),
      from: socket.id,
      x: p.x,
      y: p.y,
      dx: dir.x * 6,
      dy: dir.y * 6,
      color: p.color
    });
  });

  socket.on("disconnect", () => {
    delete players[socket.id];
    delete targets[socket.id];
    io.emit("removePlayer", socket.id);
  });
});

setInterval(() => {
  if (gameEnded) return;

  projectiles = projectiles.filter(p => {
    p.x += p.dx;
    p.y += p.dy;
    if (p.x < 0 || p.y < 0 || p.x > ARENA_WIDTH || p.y > ARENA_HEIGHT) return false;

    for (const id in players) {
      const t = players[id];
      if (t.dead || id === p.from) continue;
      const dist = Math.hypot(p.x - t.x, p.y - t.y);
      if (dist < getRadius(t.units)) {
        players[p.from].units += 2;
        players[p.from].score += 2;
        t.units -= 2;
        io.to(p.from).emit("hit");
        io.to(t.id).emit("hit");
        if (t.units <= 0) {
          t.dead = true;
          io.to(t.id).emit("dead");
          io.emit("laser");
        }
        return false;
      }
    }
    return true;
  });

  for (const id in targets) {
    const target = targets[id];
    const p = players[id];
    if (!p || p.dead || !target) continue;
    const dx = target.x - p.x;
    const dy = target.y - p.y;
    const dist = Math.hypot(dx, dy);
    const speed = 4;
    if (dist > speed) {
      const nx = p.x + (dx / dist) * speed;
      const ny = p.y + (dy / dist) * speed;
      if (!isInsideWall(nx, ny, getRadius(p.units))) {
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

  const ids = Object.keys(players);
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = players[ids[i]];
      const b = players[ids[j]];
      if (a.dead || b.dead) continue;
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (dist < getRadius(a.units) + getRadius(b.units)) {
        if (a.units > b.units) {
          const lost = Math.floor(b.units * 0.25);
          a.units += lost;
          a.score += lost;
          b.units -= lost;
          io.to(a.id).emit("death");
          io.to(b.id).emit("death");
          if (b.units <= 0) {
            b.dead = true;
            io.emit("laser");
          } else {
            const pos = getSafePosition();
            b.x = pos.x;
            b.y = pos.y;
          }
        } else if (b.units > a.units) {
          const lost = Math.floor(a.units * 0.25);
          b.units += lost;
          b.score += lost;
          a.units -= lost;
          io.to(a.id).emit("death");
          io.to(b.id).emit("death");
          if (a.units <= 0) {
            a.dead = true;
            io.emit("laser");
          } else {
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
      const dist = Math.hypot(p.x - b.x, p.y - b.y);
      if (dist < 20) {
        p.units += b.amount;
        p.score += b.amount;
        io.to(p.id).emit("bloop");
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
  console.log("✅ RealWar.io serveur actif sur http://localhost:" + PORT);
});
