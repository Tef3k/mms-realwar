// === RealWar.io : Serveur complet avec lobby sécurisé ===
const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http);

const PORT = 3000;
const PASSWORD = "MMS";
const START_DELAY = 15000;
const START_UNITES = 10;
const WIN_CONDITION = 500;
const MINE_DURATION = 30000;

app.use(express.static("public"));

let players = {};
let targets = {};
let mines = [];
let bonuses = [];
let walls = [];
let readyPlayers = new Set();
let gameStarted = false;
let countdownStarted = false;

const COLORS = ["red", "blue", "green", "purple", "orange"];
const ARENA_WIDTH = 1920;
const ARENA_HEIGHT = 960;

// Génération des murs
walls = [...Array(20)].map(() => ({
  x: Math.random() * 1600 + 50,
  y: Math.random() * 700 + 50,
  w: 80 + Math.random() * 120,
  h: 80 + Math.random() * 120
}));

function isInsideWall(x, y, r = 20) {
  return walls.some(w => x + r > w.x && x - r < w.x + w.w && y + r > w.y && y - r < w.y + w.h);
}

function getSafePosition() {
  for (let i = 0; i < 100; i++) {
    const x = Math.random() * (ARENA_WIDTH - 40) + 20;
    const y = Math.random() * (ARENA_HEIGHT - 40) + 20;
    if (!isInsideWall(x, y, 25)) return { x, y };
  }
  return { x: 100, y: 100 };
}

function getRadius(units) {
  return 10 * (1 + units * 0.002);
}

function spawnBonus() {
  const r = Math.random();
  const type = r < 0.01 ? "gold" : r < 0.08 ? "brown" : r < 0.2 ? "red" : r < 0.5 ? "blue" : "green";
  const amount = type === "gold" ? 50 : type === "brown" ? 25 : type === "red" ? 5 : type === "blue" ? 2 : 1;
  bonuses.push({ id: Date.now(), ...getSafePosition(), type, amount });
}

setInterval(() => {
  if (gameStarted) spawnBonus();
}, 500);

io.on("connection", (socket) => {
  socket.emit("askPassword");

  socket.on("checkPassword", (pass) => {
    if (pass !== PASSWORD) return socket.disconnect();
    socket.emit("askName");
  });

  socket.on("setName", (name) => {
    const color = COLORS[Math.floor(Math.random() * COLORS.length)];
    const pos = getSafePosition();
    players[socket.id] = {
      id: socket.id,
      name,
      color,
      x: pos.x,
      y: pos.y,
      units: START_UNITES,
      dead: false,
      score: 0,
      ready: false
    };
    targets[socket.id] = null;
    io.emit("lobbyUpdate", getLobbyState());
  });

  socket.on("setReady", () => {
    if (players[socket.id]) {
      players[socket.id].ready = true;
      readyPlayers.add(socket.id);
      io.emit("lobbyUpdate", getLobbyState());
      checkStartConditions();
    }
  });

  socket.on("clickMove", (pos) => {
    if (players[socket.id]?.dead || !gameStarted) return;
    targets[socket.id] = pos;
  });

  socket.on("placeMine", () => {
    const p = players[socket.id];
    if (!p || p.dead || p.units < 3) return;
    p.units -= 2;
    const mine = {
      id: Date.now(),
      x: p.x,
      y: p.y,
      owner: socket.id,
      createdAt: Date.now()
    };
    mines.push(mine);
  });

  socket.on("disconnect", () => {
    delete players[socket.id];
    delete targets[socket.id];
    readyPlayers.delete(socket.id);
    io.emit("removePlayer", socket.id);
    if (!gameStarted) io.emit("lobbyUpdate", getLobbyState());
  });
});

function getLobbyState() {
  return Object.values(players).map(p => ({ name: p.name, ready: p.ready }));
}

function checkStartConditions() {
  if (!countdownStarted && Object.values(players).length > 1 && Object.values(players).every(p => p.ready)) {
    countdownStarted = true;
    io.emit("startCountdown", 15);
    setTimeout(() => {
      gameStarted = true;
      countdownStarted = false;
    }, START_DELAY);
  }
}

setInterval(() => {
  if (!gameStarted) return;

  for (const id in targets) {
    const p = players[id];
    if (!p || p.dead || !targets[id]) continue;
    const dx = targets[id].x - p.x;
    const dy = targets[id].y - p.y;
    const dist = Math.hypot(dx, dy);
    const speed = 4;
    if (dist > speed) {
      const nx = p.x + (dx / dist) * speed;
      const ny = p.y + (dy / dist) * speed;
      if (!isInsideWall(nx, ny, getRadius(p.units))) {
        p.x = nx;
        p.y = ny;
      }
    } else {
      targets[id] = null;
    }
  }

  // Collisions mines
  mines = mines.filter(m => {
    if (Date.now() - m.createdAt > MINE_DURATION) return false;
    for (const id in players) {
      const p = players[id];
      if (p.dead || id === m.owner) continue;
      if (Math.hypot(p.x - m.x, p.y - m.y) < 20) {
        p.units -= 20;
        if (players[m.owner]) players[m.owner].units += 20;
        io.emit("toc");
        return false;
      }
    }
    return true;
  });

  // Absorptions
  const ids = Object.keys(players);
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = players[ids[i]];
      const b = players[ids[j]];
      if (a.dead || b.dead) continue;
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (dist < getRadius(a.units) + getRadius(b.units)) {
        if (a.units > b.units) handleAbsorption(a, b);
        else if (b.units > a.units) handleAbsorption(b, a);
      }
    }
  }

  // Bonus
  for (const id in players) {
    const p = players[id];
    if (p.dead) continue;
    bonuses = bonuses.filter(b => {
      if (Math.hypot(p.x - b.x, p.y - b.y) < 20) {
        p.units += b.amount;
        p.score += b.amount;
        io.to(id).emit("bloop");
        return false;
      }
      return true;
    });

    if (p.units >= WIN_CONDITION && !p.dead) {
      io.emit("win", p.name);
      gameStarted = false;
    }
  }

  io.emit("state", {
    players,
    bonuses,
    walls,
    mines
  });
}, 1000 / 30);

function handleAbsorption(winner, loser) {
  const stolen = Math.floor(loser.units * 0.25);
  winner.units += stolen;
  winner.score += stolen;
  loser.units -= stolen;
  io.to(winner.id).emit("death");
  io.to(loser.id).emit("death");
  if (loser.units <= 0) {
    loser.dead = true;
    io.emit("laser");
  } else {
    const pos = getSafePosition();
    loser.x = pos.x;
    loser.y = pos.y;
  }
}

http.listen(PORT, () => {
  console.log("✅ RealWar.io prêt sur http://localhost:" + PORT);
});

