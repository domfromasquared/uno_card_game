// UNO-like online server using Express + Socket.IO (with optional CPU opponent)

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

const rooms = {}; // roomCode -> state
const CPU_ID = "CPU";

// ------------------ DECK / RULES ------------------

function createDeck() {
  const colors = ["red", "yellow", "green", "blue"];
  const deck = [];
  let idCounter = 1;

  colors.forEach((color) => {
    deck.push({ id: idCounter++, color, value: 0, type: "number" });
    for (let v = 1; v <= 9; v++) {
      deck.push({ id: idCounter++, color, value: v, type: "number" });
      deck.push({ id: idCounter++, color, value: v, type: "number" });
    }
    ["skip", "reverse", "draw2"].forEach((action) => {
      deck.push({ id: idCounter++, color, value: null, type: action });
      deck.push({ id: idCounter++, color, value: null, type: action });
    });
  });

  for (let i = 0; i < 4; i++) {
    deck.push({ id: idCounter++, color: null, value: null, type: "wild" });
    deck.push({ id: idCounter++, color: null, value: null, type: "wild4" });
  }

  return deck;
}

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
}

function drawOne(room) {
  if (room.deck.length === 0) {
    if (room.discardPile.length <= 1) return null;
    const top = room.discardPile.pop();
    room.deck = room.discardPile;
    room.discardPile = [top];
    shuffle(room.deck);
  }
  return room.deck.pop() || null;
}

function canPlay(card, top) {
  if (!card || !top) return false;
  if (card.type === "wild" || card.type === "wild4") return true;
  if (card.color === top.color) return true;
  if (card.type === "number" && top.type === "number" && card.value === top.value) return true;
  if (card.type !== "number" && card.type === top.type) return true;
  return false;
}

function describeCard(card) {
  if (!card) return "";
  if (card.type === "number") return `${card.color} ${card.value}`;
  if (card.type === "draw2") return `${card.color} +2`;
  if (card.type === "wild") return `Wild (${card.color || "no color"})`;
  if (card.type === "wild4") return `Wild +4 (${card.color || "no color"})`;
  const name = card.type === "skip" ? "Skip" : "Reverse";
  return `${card.color} ${name}`;
}

// ------------------ UNO PENALTY ------------------

function maybeApplyUnoPenalty(room, playerId, hand, afterPlayCount) {
  const unoCalled = !!room.unoStatus[playerId];
  room.unoStatus[playerId] = false; // consume

  // After playing a card, if they have exactly 1 card left and didn't call UNO -> +2
  if (afterPlayCount === 1 && !unoCalled) {
    for (let i = 0; i < 2; i++) {
      const penaltyCard = drawOne(room);
      if (penaltyCard) hand.push(penaltyCard);
    }
    room.message = "⚠️ Penalty! You did not yell UNO. You draw 2 cards.";
    room.lastMoveAt = Date.now();
  }
}

// ------------------ TIMERS ------------------

function clearTurnTimer(room) {
  if (room.turnTimeout) {
    clearTimeout(room.turnTimeout);
    room.turnTimeout = null;
  }
}

function clearCpuTimer(room) {
  if (room.cpuTimer) {
    clearTimeout(room.cpuTimer);
    room.cpuTimer = null;
  }
}

// Human-only timeout (CPU should never “time out”)
function setTurnTimer(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  clearTurnTimer(room);

  if (room.phase !== "playing" || room.isGameOver) return;
  if (!room.currentTurn) return;

  // ✅ Do NOT start a human timeout while CPU is to play
  if (room.currentTurn === CPU_ID) {
    // But make sure CPU is scheduled
    scheduleCpuTurn(roomCode);
    return;
  }

  const playerToTimeout = room.currentTurn;

  room.turnTimeout = setTimeout(() => {
    const r = rooms[roomCode];
    if (!r || r.isGameOver) return;
    if (r.phase !== "playing") return;

    // If turn already moved, do nothing
    if (r.currentTurn !== playerToTimeout) return;

    const other = r.players.find((id) => id && id !== playerToTimeout) || playerToTimeout;

    r.message = "⏱️ Turn expired. Turn skipped.";
    r.currentTurn = other;
    r.lastMoveAt = Date.now();

    // clear this timeout
    r.turnTimeout = null;

    sendGameState(roomCode);

    // ✅ CRITICAL FIX: always schedule CPU if CPU is now up
    if (r.currentTurn === CPU_ID) {
      scheduleCpuTurn(roomCode);
      return;
    }

    // otherwise start timer for next human
    setTurnTimer(roomCode);
  }, 20000);
}

// ------------------ CPU ------------------

function cpuPickColor(room) {
  const hand = room.hands[CPU_ID] || [];
  const counts = { red: 0, yellow: 0, green: 0, blue: 0 };
  for (const c of hand) {
    if (c.color && counts[c.color] != null) counts[c.color]++;
  }
  let best = "red";
  for (const k of Object.keys(counts)) {
    if (counts[k] > counts[best]) best = k;
  }
  if (counts[best] === 0) {
    const colors = ["red", "yellow", "green", "blue"];
    best = colors[Math.floor(Math.random() * colors.length)];
  }
  return best;
}

function cpuShouldCallUno(room) {
  const diff = room.cpuDifficulty || "easy";
  const hand = room.hands[CPU_ID] || [];
  if (hand.length !== 2) return false;

  const roll = Math.random();
  if (diff === "hard") return true;
  if (diff === "medium") return roll < 0.7;
  return roll < 0.35;
}

function cpuChooseCard(room) {
  const diff = room.cpuDifficulty || "easy";
  const hand = room.hands[CPU_ID] || [];
  const top = room.discardPile[room.discardPile.length - 1];

  const playable = hand.filter((c) => canPlay(c, top));
  if (playable.length === 0) return null;

  if (diff === "easy") {
    return playable[Math.floor(Math.random() * playable.length)];
  }

  const score = (card) => {
    let s = 0;
    if (card.type === "wild4") s += 50;
    else if (card.type === "draw2") s += 30;
    else if (card.type === "skip" || card.type === "reverse") s += 20;
    else s += 10;

    if (diff === "hard" && card.type === "wild") s -= 2;

    if (card.color) {
      const sameColor = hand.filter((c) => c.color === card.color).length;
      s += sameColor;
    }
    if (diff === "hard" && card.type !== "number") s += 2;

    return s + Math.random() * 0.5;
  };

  playable.sort((a, b) => score(b) - score(a));
  return playable[0];
}

function cpuTakeTurn(roomCode) {
  const room = rooms[roomCode];
  if (!room || room.isGameOver) return;
  if (room.phase !== "playing") return;
  if (room.currentTurn !== CPU_ID) return;

  // No human timer during CPU turn
  clearTurnTimer(room);

  if (cpuShouldCallUno(room)) {
    room.unoStatus[CPU_ID] = true;
    room.message = "UNO! CPU yelled UNO!";
    room.lastMoveAt = Date.now();
    sendGameState(roomCode);
  }

  const top = room.discardPile[room.discardPile.length - 1];
  const hand = room.hands[CPU_ID] || [];

  const chosen = cpuChooseCard(room);

  if (chosen) {
    const chosenColor =
      (chosen.type === "wild" || chosen.type === "wild4") ? cpuPickColor(room) : null;

    applyPlay(room, roomCode, CPU_ID, chosen.id, chosenColor);
    return;
  }

  // Draw 1
  const drawn = drawOne(room);
  if (!drawn) {
    room.message = "CPU tried to draw, but no cards left.";
    room.lastMoveAt = Date.now();
    room.currentTurn = room.players.find((id) => id && id !== CPU_ID) || CPU_ID;
    sendGameState(roomCode);
    if (room.currentTurn !== CPU_ID) setTurnTimer(roomCode);
    return;
  }

  hand.push(drawn);

  const canAuto =
    drawn.type !== "wild" && drawn.type !== "wild4" && canPlay(drawn, top);

  if (canAuto) {
    // Put it back “as playable” and play it using applyPlay
    const idx = hand.findIndex((c) => c.id === drawn.id);
    if (idx !== -1) hand.splice(idx, 1);
    hand.push(drawn);
    applyPlay(room, roomCode, CPU_ID, drawn.id, null);
    return;
  }

  room.message = "CPU drew a card.";
  room.lastMoveAt = Date.now();
  room.currentTurn = room.players.find((id) => id && id !== CPU_ID) || CPU_ID;

  sendGameState(roomCode);

  if (room.currentTurn !== CPU_ID) setTurnTimer(roomCode);
}

function scheduleCpuTurn(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  // ✅ Always clear and reschedule
  clearCpuTimer(room);

  if (!room.isCpuGame) return;
  if (room.phase !== "playing" || room.isGameOver) return;
  if (room.currentTurn !== CPU_ID) return;

  const diff = room.cpuDifficulty || "easy";
  const delay =
    diff === "hard" ? 650 :
    diff === "medium" ? 850 :
    1100;

  room.cpuTimer = setTimeout(() => {
    const r = rooms[roomCode];
    if (!r) return;
    r.cpuTimer = null;
    cpuTakeTurn(roomCode);
  }, delay);
}

// ------------------ GAME FLOW ------------------

function dealInitialCards(room, roomCode) {
  room.gameId = (room.gameId || 0) + 1;

  room.phase = "dealing";
  room.dealAcks = room.dealAcks || {};
  room.dealAcks[room.gameId] = {};

  room.deck = createDeck();
  shuffle(room.deck);
  room.discardPile = [];

  room.isGameOver = false;
  room.winner = null;
  room.unoStatus = room.unoStatus || {};
  room.specialEffect = null;

  room.hands = {};
  room.players.forEach((pid) => {
    if (pid) room.hands[pid] = [];
  });

  // 7 cards each
  for (let i = 0; i < 7; i++) {
    room.players.forEach((pid) => {
      if (!pid) return;
      const card = drawOne(room);
      if (card) room.hands[pid].push(card);
    });
  }

  // first discard card
  let first = drawOne(room);
  if (!first) first = { id: 9999, color: "red", value: 0, type: "number" };
  if (first.type === "wild" || first.type === "wild4") {
    first.color = ["red", "yellow", "green", "blue"][Math.floor(Math.random() * 4)];
  }
  room.discardPile.push(first);

  // pick starter
  const starterIndex = Math.random() < 0.5 ? 0 : 1;
  room.currentTurn = room.players[starterIndex];

  room.message = "🃏 Dealing cards...";
  room.lastMoveAt = Date.now();

  clearTurnTimer(room);
  clearCpuTimer(room);

  // CPU acks instantly
  if (room.isCpuGame) {
    room.dealAcks[room.gameId][CPU_ID] = true;
  }

  sendGameState(roomCode);
}

function startPlayingIfReady(room, roomCode) {
  const gameId = room.gameId || 0;
  const ackMap = room.dealAcks?.[gameId] || {};

  const p1 = room.players[0];
  const p2 = room.players[1];

  const ready = !!(ackMap[p1] && ackMap[p2]);
  if (!ready) return;

  room.phase = "playing";
  room.message = "🟢 Game started!";
  room.lastMoveAt = Date.now();

  sendGameState(roomCode);

  if (room.currentTurn === CPU_ID) scheduleCpuTurn(roomCode);
  else setTurnTimer(roomCode);
}

function sendGameState(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  const top = room.discardPile[room.discardPile.length - 1] || null;

  room.players.forEach((playerId, index) => {
    if (!playerId) return;
    if (playerId === CPU_ID) return;

    const sock = io.sockets.sockets.get(playerId);
    if (!sock) return;

    const opponentIndex = index === 0 ? 1 : 0;
    const opponentId = room.players[opponentIndex];

    const yourHand = room.hands[playerId] || [];
    const opponentCount = opponentId ? (room.hands[opponentId] || []).length : 0;

    sock.emit("gameState", {
      roomCode,
      youAre: index === 0 ? "P1" : "P2",

      gameId: room.gameId || 0,
      phase: room.phase || "waiting",
      lastMoveAt: room.lastMoveAt || null,
      specialEffect: room.specialEffect || null,

      yourHand,
      opponentCardCount: opponentCount,
      discardTop: top,
      deckCount: room.deck.length,

      currentTurn: room.currentTurn,
      isGameOver: room.isGameOver,
      winner: room.winner,
      message: room.message,

      opponentIsCpu: room.isCpuGame && opponentId === CPU_ID,
      cpuDifficulty: room.cpuDifficulty || null,
    });
  });
}

// ------------------ PLAY ACTION (shared human/CPU) ------------------

function applyPlay(room, roomCode, playerId, cardId, chosenColor) {
  const hand = room.hands[playerId] || [];
  const index = hand.findIndex((c) => c.id === cardId);
  if (index === -1) return { ok: false, error: "Card not in hand." };

  const card = hand[index];
  const top = room.discardPile[room.discardPile.length - 1];

  if (card.type === "wild" || card.type === "wild4") {
    const validColors = ["red", "yellow", "green", "blue"];
    if (!chosenColor || !validColors.includes(chosenColor)) {
      return { ok: false, error: "Must choose a color for wild." };
    }
    card.color = chosenColor;
  } else {
    if (!canPlay(card, top)) return { ok: false, error: "You can't play that card." };
  }

  // Remove and discard
  hand.splice(index, 1);
  room.discardPile.push(card);

  // Special effect
  room.specialEffect = null;
  if (card.type === "wild4") room.specialEffect = "wild4";

  // UNO penalty
  maybeApplyUnoPenalty(room, playerId, hand, hand.length);

  // Win
  if (hand.length === 0) {
    room.isGameOver = true;
    room.winner = playerId;
    room.phase = "gameover";
    room.message = "🏁 Game over!";
    room.lastMoveAt = Date.now();
    clearTurnTimer(room);
    clearCpuTimer(room);
    sendGameState(roomCode);
    return { ok: true, gameOver: true, played: card };
  }

  const opponentId = room.players.find((id) => id && id !== playerId);

  // Effects
  if (card.type === "draw2" && opponentId) {
    for (let i = 0; i < 2; i++) {
      const drawn = drawOne(room);
      if (drawn) room.hands[opponentId].push(drawn);
    }
  }
  if (card.type === "wild4" && opponentId) {
    for (let i = 0; i < 4; i++) {
      const drawn = drawOne(room);
      if (drawn) room.hands[opponentId].push(drawn);
    }
  }

  // Turn rule (your house rule: action cards grant another turn)
  const turnAgain =
    card.type === "skip" ||
    card.type === "reverse" ||
    card.type === "draw2" ||
    card.type === "wild4";

  room.currentTurn = turnAgain ? playerId : (opponentId || playerId);

  room.message = `Player played ${describeCard(card)}`;
  room.lastMoveAt = Date.now();

  sendGameState(roomCode);

  // ✅ Next step (CPU or timer)
  if (room.currentTurn === CPU_ID) scheduleCpuTurn(roomCode);
  else setTurnTimer(roomCode);

  return { ok: true, gameOver: false, played: card };
}

// ------------------ SOCKETS ------------------

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on("createRoom", () => {
    let code;
    do {
      code = Math.floor(1000 + Math.random() * 9000).toString();
    } while (rooms[code]);

    rooms[code] = {
      code,
      players: [socket.id, null],
      hands: {},
      deck: [],
      discardPile: [],
      currentTurn: null,
      isGameOver: false,
      winner: null,
      message: "Waiting for another player to join...",
      unoStatus: {},
      specialEffect: null,
      turnTimeout: null,
      cpuTimer: null,

      gameId: 0,
      phase: "waiting",
      lastMoveAt: Date.now(),
      dealAcks: {},

      isCpuGame: false,
      cpuDifficulty: null,
    };

    socket.join(code);
    socket.emit("roomCreated", { roomCode: code, youAre: "P1" });
    sendGameState(code);
  });

  socket.on("createRoomCpu", ({ difficulty }) => {
    const valid = ["easy", "medium", "hard"];
    const cpuDifficulty = valid.includes(difficulty) ? difficulty : "easy";

    let code;
    do {
      code = Math.floor(1000 + Math.random() * 9000).toString();
    } while (rooms[code]);

    rooms[code] = {
      code,
      players: [socket.id, CPU_ID],
      hands: {},
      deck: [],
      discardPile: [],
      currentTurn: null,
      isGameOver: false,
      winner: null,
      message: "Starting CPU game...",
      unoStatus: {},
      specialEffect: null,
      turnTimeout: null,
      cpuTimer: null,

      gameId: 0,
      phase: "waiting",
      lastMoveAt: Date.now(),
      dealAcks: {},

      isCpuGame: true,
      cpuDifficulty,
    };

    socket.join(code);
    socket.emit("roomCreated", { roomCode: code, youAre: "P1" });

    dealInitialCards(rooms[code], code);
  });

  socket.on("joinRoom", ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room) return socket.emit("errorMessage", "Room not found.");
    if (room.isCpuGame) return socket.emit("errorMessage", "This room is vs CPU.");
    if (room.players[1]) return socket.emit("errorMessage", "Room is full.");

    room.players[1] = socket.id;
    room.message = "Both players connected. Dealing cards...";
    room.lastMoveAt = Date.now();
    socket.join(roomCode);

    dealInitialCards(room, roomCode);
  });

  socket.on("dealDone", ({ roomCode, gameId }) => {
    const room = rooms[roomCode];
    if (!room) return;
    if ((room.gameId || 0) !== gameId) return;

    room.dealAcks = room.dealAcks || {};
    room.dealAcks[gameId] = room.dealAcks[gameId] || {};
    room.dealAcks[gameId][socket.id] = true;

    startPlayingIfReady(room, roomCode);
  });

  socket.on("playCard", ({ roomCode, cardId, chosenColor }) => {
    const room = rooms[roomCode];
    if (!room || room.isGameOver) return;
    if (room.phase !== "playing") return socket.emit("errorMessage", "Still dealing…");
    if (socket.id !== room.currentTurn) return socket.emit("errorMessage", "Not your turn.");

    const res = applyPlay(room, roomCode, socket.id, cardId, chosenColor);
    if (!res.ok) socket.emit("errorMessage", res.error || "Invalid play.");
  });

  socket.on("drawCard", ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.isGameOver) return;
    if (room.phase !== "playing") return socket.emit("errorMessage", "Still dealing…");
    if (socket.id !== room.currentTurn) return socket.emit("errorMessage", "Not your turn.");

    room.unoStatus[socket.id] = false;
    room.specialEffect = null;

    const drawn = drawOne(room);
    if (!drawn) {
      room.message = "No cards left to draw.";
      room.lastMoveAt = Date.now();
      sendGameState(roomCode);
      return;
    }

    room.hands[socket.id] = room.hands[socket.id] || [];
    const hand = room.hands[socket.id];
    hand.push(drawn);

    const top = room.discardPile[room.discardPile.length - 1];
    const canAuto = drawn.type !== "wild" && drawn.type !== "wild4" && canPlay(drawn, top);

    if (canAuto) {
      const idx = hand.findIndex((c) => c.id === drawn.id);
      if (idx !== -1) hand.splice(idx, 1);
      hand.push(drawn);

      const res = applyPlay(room, roomCode, socket.id, drawn.id, null);
      if (!res.ok) socket.emit("errorMessage", res.error || "Auto-play error.");
      return;
    }

    room.message = "Player drew a card.";
    room.lastMoveAt = Date.now();
    room.currentTurn = room.players.find((id) => id && id !== socket.id) || socket.id;

    sendGameState(roomCode);

    if (room.currentTurn === CPU_ID) scheduleCpuTurn(roomCode);
    else setTurnTimer(roomCode);
  });

  socket.on("yellUno", ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room) return;

    const hand = room.hands[socket.id] || [];
    if (hand.length > 2) return socket.emit("errorMessage", "You can only yell UNO with 2 or fewer cards.");

    room.unoStatus[socket.id] = true;
    room.message = "UNO! A player yelled UNO!";
    room.lastMoveAt = Date.now();
    sendGameState(roomCode);
  });

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);

    Object.keys(rooms).forEach((code) => {
      const room = rooms[code];
      if (!room) return;

      if (room.players.includes(socket.id)) {
        room.message = "Opponent disconnected. Game over.";
        room.isGameOver = true;
        room.phase = "gameover";
        room.lastMoveAt = Date.now();

        clearTurnTimer(room);
        clearCpuTimer(room);

        sendGameState(code);
        delete rooms[code];
      }
    });
  });
});

// ---- START SERVER ----
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Server listening on port", PORT);
});
