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

  // Normal colored cards
  colors.forEach((color) => {
    // One zero per color
    deck.push({ id: idCounter++, color, value: 0, type: "number" });

    // Two of each 1–9 per color
    for (let v = 1; v <= 9; v++) {
      deck.push({ id: idCounter++, color, value: v, type: "number" });
      deck.push({ id: idCounter++, color, value: v, type: "number" });
    }

    // Two Skips, Reverses, +2 per color
    ["skip", "reverse", "draw2"].forEach((action) => {
      deck.push({ id: idCounter++, color, value: null, type: action });
      deck.push({ id: idCounter++, color, value: null, type: action });
    });
  });

  // Wild + Wild Draw 4 (no color yet)
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

  // Wilds are always playable
  if (card.type === "wild" || card.type === "wild4") return true;

  // same color
  if (card.color === top.color) return true;

  // same number
  if (card.type === "number" && top.type === "number" && card.value === top.value) return true;

  // same action type
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
// skip if player takes too long
function setTurnTimer(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  // Clear any old timer
  if (room.turnTimeout) {
    clearTimeout(room.turnTimeout);
    room.turnTimeout = null;
  }

  if (!room.currentTurn || room.isGameOver) return;

  const playerToTimeout = room.currentTurn;

  room.turnTimeout = setTimeout(() => {
    const r = rooms[roomCode];
    if (!r || r.isGameOver) return;

    // If turn already moved, don't double-skip
    if (r.currentTurn !== playerToTimeout) return;

    const other = r.players.find((id) => id && id !== playerToTimeout) || playerToTimeout;

    r.message = "⏱️ Player took too long. Turn skipped.";
    r.currentTurn = other;
    r.lastMoveAt = Date.now();

    r.turnTimeout = null;
    sendGameState(roomCode);

    // Start timer for the next player
    setTurnTimer(roomCode);
  }, 20000); // 20 seconds
}

function dealInitialCards(room, roomCode) {
  // ✅ NEW GAME ID + PHASE
  room.gameId = (room.gameId || 0) + 1;
  room.phase = "dealing";

  room.deck = createDeck();
  shuffle(room.deck);

  room.discardPile = [];
  room.isGameOver = false;
  room.winner = null;

  room.unoStatus = room.unoStatus || {};
  room.specialEffect = null;
  room.lastMoveAt = Date.now();

  // Ensure hands exist / reset hands fully for new game
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

  // First discard card (avoid wilds as first card if possible)
  let first = drawOne(room);
  if (!first) {
    first = { id: 9999, color: "red", value: 0, type: "number" };
  }
  // If first is wild / wild4, force a color so clients don't get weird UI
  if (first.type === "wild" || first.type === "wild4") {
    first.color = ["red", "yellow", "green", "blue"][Math.floor(Math.random() * 4)];
  }
  room.discardPile.push(first);

  // Random starter
  const starterIndex = Math.random() < 0.5 ? 0 : 1;
  room.currentTurn = room.players[starterIndex];
  room.message = "🃏 Game started!";
  room.lastMoveAt = Date.now();

  sendGameState(roomCode);

  // After first state push, switch to playing
  room.phase = "playing";
  setTurnTimer(roomCode);
}

function sendGameState(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  const top = room.discardPile[room.discardPile.length - 1] || null;

  room.players.forEach((playerId, index) => {
    if (!playerId) return;
    const socket = io.sockets.sockets.get(playerId);
    if (!socket) return;

    const opponentIndex = index === 0 ? 1 : 0;
    const opponentId = room.players[opponentIndex];

    const yourHand = room.hands[playerId] || [];
    const opponentCount = opponentId ? (room.hands[opponentId] || []).length : 0;

    socket.emit("gameState", {
      roomCode,
      youAre: index === 0 ? "P1" : "P2",

      // ✅ NEW: stable fields so client never guesses
      gameId: room.gameId || 0,
      phase: room.phase || "waiting",
      lastMoveAt: room.lastMoveAt || null,
      specialEffect: room.specialEffect || null,

      // existing
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

// Apply UNO penalty if needed.
// Called right after a card is removed from hand but before win check.
function maybeApplyUnoPenalty(room, playerId, hand, afterPlayCount) {
  const unoCalled = !!room.unoStatus[playerId];
  room.unoStatus[playerId] = false; // consume UNO if it was called

  // They just went down to 1 card (meaning afterPlayCount === 1) and DIDN'T call UNO
  if (afterPlayCount === 1 && !unoCalled) {
    const penaltyCards = 2;
    for (let i = 0; i < penaltyCards; i++) {
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
      unoStatus: {}, // playerId -> bool
      specialEffect: null,
      turnTimeout: null,

      // ✅ NEW
      gameId: 0,
      phase: "waiting",
      lastMoveAt: Date.now(),
    };

    socket.join(code);
    socket.emit("roomCreated", { roomCode: code, youAre: "P1" });
    sendGameState(code);
  });

  socket.on("joinRoom", ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room) {
      socket.emit("errorMessage", "Room not found.");
      return;
    }
    if (room.players[1]) {
      socket.emit("errorMessage", "Room is full.");
      return;
    }

    room.players[1] = socket.id;
    room.message = "Both players connected. Dealing cards...";
    room.lastMoveAt = Date.now();
    socket.join(roomCode);

    dealInitialCards(room, roomCode);
  });

  socket.on("playCard", ({ roomCode, cardId, chosenColor }) => {
    const room = rooms[roomCode];
    if (!room || room.isGameOver) return;

    if (socket.id !== room.currentTurn) {
      socket.emit("errorMessage", "Not your turn.");
      return;
    }

    const hand = room.hands[socket.id] || [];
    const index = hand.findIndex((c) => c.id === cardId);
    if (index === -1) {
      socket.emit("errorMessage", "Card not in hand.");
      return;
    }

    const card = hand[index];
    const top = room.discardPile[room.discardPile.length - 1];

    // Wild / Wild +4: require color
    if (card.type === "wild" || card.type === "wild4") {
      const validColors = ["red", "yellow", "green", "blue"];
      if (!chosenColor || !validColors.includes(chosenColor)) {
        socket.emit("errorMessage", "You must choose a color for a wild card.");
        return;
      }
      card.color = chosenColor;
    } else {
      // Normal cards must match something
      if (!canPlay(card, top)) {
        socket.emit("errorMessage", "You can't play that card.");
        return;
      }
    }

    // Remove from hand
    hand.splice(index, 1);

    // Put on discard pile
    room.discardPile.push(card);

    // special effect
    room.specialEffect = null;
    if (card.type === "wild4") room.specialEffect = "wild4";

    // UNO penalty check (afterPlayCount = hand.length)
    maybeApplyUnoPenalty(room, socket.id, hand, hand.length);

    // Win check AFTER possible penalty
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

    // Action effects
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

    // Who goes next?
    // (in 2-player UNO: reverse behaves like skip, so you go again — your logic is fine)
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

    if (socket.id !== room.currentTurn) {
      socket.emit("errorMessage", "Not your turn.");
      return;
    }

    // Drawing cancels any previous UNO call
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

    // AUTO-PLAY:
    // If drawn is playable AND not wild/wild4, auto-play it.
    const canAutoPlay = drawn.type !== "wild" && drawn.type !== "wild4" && canPlay(drawn, top);

    if (canAutoPlay) {
      // Remove it back from hand
      const idx = hand.findIndex((c) => c.id === drawn.id);
      if (idx !== -1) hand.splice(idx, 1);

      room.discardPile.push(drawn);

      // UNO penalty for auto-play
      maybeApplyUnoPenalty(room, socket.id, hand, hand.length);

      // Win check
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

      // Action effects for auto-played card
      if (drawn.type === "draw2" && opponentId) {
        for (let i = 0; i < 2; i++) {
          const extra = drawOne(room);
          if (extra) room.hands[opponentId].push(extra);
        }
      }

      // reverse/skip/draw2 give another turn (in 2-player, reverse behaves like skip)
      const turnAgain = drawn.type === "skip" || drawn.type === "reverse" || drawn.type === "draw2";

      room.currentTurn = turnAgain ? socket.id : (opponentId || socket.id);
      room.message = turnAgain
        ? `You drew and auto-played ${describeCard(drawn)}. You go again.`
        : `You drew and auto-played ${describeCard(drawn)}.`;

      room.lastMoveAt = Date.now();
      sendGameState(roomCode);
      setTurnTimer(roomCode);
      return;
    }

    // If we didn't auto-play (wild or not playable), pass turn
    room.message = "Player drew a card.";
    room.currentTurn = room.players.find((id) => id && id !== socket.id) || socket.id;
    room.lastMoveAt = Date.now();

    sendGameState(roomCode);
    setTurnTimer(roomCode);
  });

  // YELL UNO: must be at 2 or fewer cards; applies to the NEXT card play only.
  socket.on("yellUno", ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room) return;

    const hand = room.hands[socket.id] || [];
    if (hand.length > 2) {
      socket.emit("errorMessage", "You can only yell UNO with 2 or fewer cards.");
      return;
    }

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
