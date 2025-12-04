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
  if (card.type === "number" && top.type === "number" && card.value === top.value) {
    return true;
  }

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

function dealInitialCards(room) {
  room.deck = createDeck();
  shuffle(room.deck);
  room.discardPile = [];
  room.isGameOver = false;
  room.winner = null;
  room.unoStatus = room.unoStatus || {};

  // make sure hands exist
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
  if (!first) {
    first = { id: 9999, color: "red", value: 0, type: "number" };
  }
  room.discardPile.push(first);

  // random starter
  const starterIndex = Math.random() < 0.5 ? 0 : 1;
  room.currentTurn = room.players[starterIndex];
  room.message = "Game started!";
}

function sendGameState(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  const top = room.discardPile[room.discardPile.length - 1];

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
      yourHand,
      opponentCardCount: opponentCount,
      discardTop: top || null,
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
function maybeApplyUnoPenalty(room, roomCode, playerId, hand, beforePenaltyCount) {
  const unoCalled = !!room.unoStatus[playerId];
  room.unoStatus[playerId] = false; // consume UNO if it was called

  // They just went down to 1 card (from 2 to 1) and DIDN'T call UNO
  if (beforePenaltyCount === 1 && !unoCalled) {
    const penaltyCards = 2;
    for (let i = 0; i < penaltyCards; i++) {
      const penaltyCard = drawOne(room);
      if (penaltyCard) hand.push(penaltyCard);
    }
    room.message = "Penalty! You did not yell UNO. You draw 2 cards.";
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
    socket.join(roomCode);

    dealInitialCards(room);
    sendGameState(roomCode);
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
    const beforePenaltyCount = hand.length; // cards LEFT after playing

    // Put on discard pile
    room.discardPile.push(card);

    // UNO penalty check
    maybeApplyUnoPenalty(room, roomCode, socket.id, hand, beforePenaltyCount);

    // Win check AFTER possible penalty
    if (hand.length === 0) {
      room.isGameOver = true;
      room.winner = socket.id;
      room.message = "Game over!";
      sendGameState(roomCode);
      return;
    }

    // Opponent for action effects
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
    const turnAgain =
      card.type === "skip" ||
      card.type === "reverse" ||
      card.type === "draw2" ||
      card.type === "wild4";

    if (turnAgain) {
      room.currentTurn = socket.id;
    } else {
      room.currentTurn = opponentId || socket.id;
    }

    room.message = `Player played ${describeCard(card)}`;
    sendGameState(roomCode);
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

    const drawn = drawOne(room);
    if (!drawn) {
      room.message = "No cards left to draw.";
      sendGameState(roomCode);
      return;
    }

    room.hands[socket.id] = room.hands[socket.id] || [];
    const hand = room.hands[socket.id];
    hand.push(drawn);

    const top = room.discardPile[room.discardPile.length - 1];

    // AUTO-PLAY LOGIC:
    // If the drawn card is playable AND not a wild/wild4, auto-play it.
    const canAutoPlay =
      drawn.type !== "wild" && drawn.type !== "wild4" && canPlay(drawn, top);

    if (canAutoPlay) {
      // Remove it back from hand and treat like a play
      const idx = hand.findIndex((c) => c.id === drawn.id);
      if (idx !== -1) {
        hand.splice(idx, 1);
      }
      const beforePenaltyCount = hand.length;

      room.discardPile.push(drawn);

      // UNO penalty check for auto-play
      maybeApplyUnoPenalty(room, roomCode, socket.id, hand, beforePenaltyCount);

      // Win check
      if (hand.length === 0) {
        room.isGameOver = true;
        room.winner = socket.id;
        room.message = "Game over!";
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

      // skip / reverse / draw2 give another turn
      const turnAgain =
        drawn.type === "skip" ||
        drawn.type === "reverse" ||
        drawn.type === "draw2";

      if (turnAgain) {
        room.currentTurn = socket.id;
        room.message = `You drew and auto-played ${describeCard(drawn)}. You go again.`;
      } else {
        room.currentTurn = opponentId || socket.id;
        room.message = `You drew and auto-played ${describeCard(drawn)}.`;
      }

      sendGameState(roomCode);
      return;
    }

    // If we didn't auto-play (wild or not playable), pass turn like before
    room.message = "Player drew a card.";
    const other = room.players.find((id) => id && id !== socket.id);
    room.currentTurn = other || socket.id;

    sendGameState(roomCode);
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
