// UNO-like online server using Express + Socket.IO

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

const rooms = {}; // roomCode -> state

// ---- DECK / RULES ----

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

// ---- TURN TIMER ----

function setTurnTimer(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  if (room.turnTimeout) {
    clearTimeout(room.turnTimeout);
    room.turnTimeout = null;
  }

  // ✅ don't run timer until actually "playing"
  if (!room.currentTurn || room.isGameOver || room.phase !== "playing") return;

  const playerToTimeout = room.currentTurn;

  room.turnTimeout = setTimeout(() => {
    const r = rooms[roomCode];
    if (!r || r.isGameOver) return;
    if (r.phase !== "playing") return;
    if (r.currentTurn !== playerToTimeout) return;

    const other = r.players.find((id) => id && id !== playerToTimeout) || playerToTimeout;
    r.message = "⏱️ Player took too long. Turn skipped.";
    r.currentTurn = other;
    r.lastMoveAt = Date.now();
    r.turnTimeout = null;

    sendGameState(roomCode);
    setTurnTimer(roomCode);
  }, 20000);
}

// ---- GAME FLOW ----

function dealInitialCards(room, roomCode) {
  room.gameId = (room.gameId || 0) + 1;

  room.phase = "dealing";          // ✅ clients animate while in dealing
  room.dealAcks = {};              // ✅ reset acks per game
  room.dealAcks[room.gameId] = {}; // playerId -> true

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

  for (let i = 0; i < 7; i++) {
    room.players.forEach((pid) => {
      if (!pid) return;
      const card = drawOne(room);
      if (card) room.hands[pid].push(card);
    });
  }

  let first = drawOne(room);
  if (!first) first = { id: 9999, color: "red", value: 0, type: "number" };
  if (first.type === "wild" || first.type === "wild4") {
    first.color = ["red", "yellow", "green", "blue"][Math.floor(Math.random() * 4)];
  }
  room.discardPile.push(first);

  // choose starter now, but DON'T start timer until both clients done animating
  const starterIndex = Math.random() < 0.5 ? 0 : 1;
  room.currentTurn = room.players[starterIndex];

  room.message = "🃏 Dealing cards...";
  room.lastMoveAt = Date.now();

  // ✅ do NOT call setTurnTimer here
  sendGameState(roomCode);
}

function startPlayingIfReady(room, roomCode) {
  if (!room || room.isGameOver) return;
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
  setTurnTimer(roomCode);
}

function sendGameState(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  const top = room.discardPile[room.discardPile.length - 1] || null;

  room.players.forEach((playerId, index) => {
    if (!playerId) return;
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
    });
  });
}

function maybeApplyUnoPenalty(room, playerId, hand, afterPlayCount) {
  const unoCalled = !!room.unoStatus[playerId];
  room.unoStatus[playerId] = false;

  if (afterPlayCount === 1 && !unoCalled) {
    for (let i = 0; i < 2; i++) {
      const penaltyCard = drawOne(room);
      if (penaltyCard) hand.push(penaltyCard);
    }
    room.message = "⚠️ Penalty! You did not yell UNO. You draw 2 cards.";
    room.lastMoveAt = Date.now();
  }
}

// ---- SOCKET LOGIC ----

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

      gameId: 0,
      phase: "waiting",
      lastMoveAt: Date.now(),
      dealAcks: {},
    };

    socket.join(code);
    socket.emit("roomCreated", { roomCode: code, youAre: "P1" });
    sendGameState(code);
  });

  socket.on("joinRoom", ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room) return socket.emit("errorMessage", "Room not found.");
    if (room.players[1]) return socket.emit("errorMessage", "Room is full.");

    room.players[1] = socket.id;
    room.message = "Both players connected. Dealing cards...";
    room.lastMoveAt = Date.now();
    socket.join(roomCode);

    dealInitialCards(room, roomCode);
  });

  // ✅ client sends this after the deal animation finishes
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

    if (room.phase !== "playing") {
      socket.emit("errorMessage", "Still dealing…");
      return;
    }

    if (socket.id !== room.currentTurn) {
      socket.emit("errorMessage", "Not your turn.");
      return;
    }

    const hand = room.hands[socket.id] || [];
    const index = hand.findIndex((c) => c.id === cardId);
    if (index === -1) return socket.emit("errorMessage", "Card not in hand.");

    const card = hand[index];
    const top = room.discardPile[room.discardPile.length - 1];

    if (card.type === "wild" || card.type === "wild4") {
      const validColors = ["red", "yellow", "green", "blue"];
      if (!chosenColor || !validColors.includes(chosenColor)) {
        return socket.emit("errorMessage", "You must choose a color for a wild card.");
      }
      card.color = chosenColor;
    } else {
      if (!canPlay(card, top)) return socket.emit("errorMessage", "You can't play that card.");
    }

    hand.splice(index, 1);
    room.discardPile.push(card);

    room.specialEffect = null;
    if (card.type === "wild4") room.specialEffect = "wild4";

    maybeApplyUnoPenalty(room, socket.id, hand, hand.length);

    if (hand.length === 0) {
      room.isGameOver = true;
      room.winner = socket.id;
      room.phase = "gameover";
      room.message = "🏁 Game over!";
      room.lastMoveAt = Date.now();

      if (room.turnTimeout) {
        clearTimeout(room.turnTimeout);
        room.turnTimeout = null;
      }

      sendGameState(roomCode);
      return;
    }

    const opponentId = room.players.find((id) => id && id !== socket.id);

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

    const turnAgain =
      card.type === "skip" ||
      card.type === "reverse" ||
      card.type === "draw2" ||
      card.type === "wild4";

    room.currentTurn = turnAgain ? socket.id : (opponentId || socket.id);

    room.message = `Player played ${describeCard(card)}`;
    room.lastMoveAt = Date.now();

    sendGameState(roomCode);
    setTurnTimer(roomCode);
  });

  socket.on("drawCard", ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.isGameOver) return;

    if (room.phase !== "playing") {
      socket.emit("errorMessage", "Still dealing…");
      return;
    }

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

    const canAutoPlay =
      drawn.type !== "wild" && drawn.type !== "wild4" && canPlay(drawn, top);

    if (canAutoPlay) {
      const idx = hand.findIndex((c) => c.id === drawn.id);
      if (idx !== -1) hand.splice(idx, 1);

      room.discardPile.push(drawn);

      maybeApplyUnoPenalty(room, socket.id, hand, hand.length);

      if (hand.length === 0) {
        room.isGameOver = true;
        room.winner = socket.id;
        room.phase = "gameover";
        room.message = "🏁 Game over!";
        room.lastMoveAt = Date.now();

        if (room.turnTimeout) {
          clearTimeout(room.turnTimeout);
          room.turnTimeout = null;
        }

        sendGameState(roomCode);
        return;
      }

      const opponentId = room.players.find((id) => id && id !== socket.id);

      if (drawn.type === "draw2" && opponentId) {
        for (let i = 0; i < 2; i++) {
          const extra = drawOne(room);
          if (extra) room.hands[opponentId].push(extra);
        }
      }

      const turnAgain =
        drawn.type === "skip" ||
        drawn.type === "reverse" ||
        drawn.type === "draw2";

      room.currentTurn = turnAgain ? socket.id : (opponentId || socket.id);
      room.message = turnAgain
        ? `You drew and auto-played ${describeCard(drawn)}. You go again.`
        : `You drew and auto-played ${describeCard(drawn)}.`;

      room.lastMoveAt = Date.now();
      sendGameState(roomCode);
      setTurnTimer(roomCode);
      return;
    }

    room.message = "Player drew a card.";
    room.currentTurn = room.players.find((id) => id && id !== socket.id) || socket.id;
    room.lastMoveAt = Date.now();

    sendGameState(roomCode);
    setTurnTimer(roomCode);
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

        if (room.turnTimeout) {
          clearTimeout(room.turnTimeout);
          room.turnTimeout = null;
        }

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
