import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { createServer } from "http";

function trackedWs(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const buffer = [];
    ws.on("message", (data) => buffer.push(JSON.parse(data.toString())));
    ws.on("open", () => {
      const next = (timeout = 3000) => {
        if (buffer.length) return Promise.resolve(buffer.shift());
        return new Promise((resolve, reject) => {
          if (buffer.length) {
            resolve(buffer.shift());
            return;
          }
          const t = setTimeout(() => reject(new Error("timeout")), timeout);
          const handler = () => {
            clearTimeout(t);
            ws.removeListener("message", handler);
            if (buffer.length) resolve(buffer.shift());
          };
          ws.on("message", handler);
        });
      };
      resolve({ ws, next, close: () => ws.close() });
    });
    ws.on("error", reject);
  });
}

function send(ws, msg) {
  ws.send(JSON.stringify(msg));
}

describe("UNO Server", () => {
  let server, port, lobbiesRef;

  beforeEach(async () => {
    const httpServer = createServer();
    const wss = new WebSocketServer({ noServer: true });

    const clients = new Map();
    const lobbies = new Map();
    const startedLobbies = new Set();
    const sessions = new Map();
    lobbiesRef = lobbies;

    function createLobby(lobbyId) {
      return {
        id: lobbyId,
        players: [],
        game: {
          deck: [],
          discardPile: [],
          turn: 0,
          direction: 1,
          started: false,
        },
      };
    }

    function findOrCreateLobby(lobbyId) {
      if (!lobbies.has(lobbyId)) lobbies.set(lobbyId, createLobby(lobbyId));
      return lobbies.get(lobbyId);
    }

    function broadcastToLobby(lobbyId, message, excludeClientId = null) {
      for (const [client, meta] of clients) {
        if (meta.lobbyId === lobbyId && meta.id !== excludeClientId) {
          client.send(JSON.stringify(message));
        }
      }
    }

    function broadcastPlayers(lobbyId) {
      const lobby = lobbies.get(lobbyId);
      if (!lobby) return;
      broadcastToLobby(lobbyId, {
        action: "players",
        players: lobby.players,
        turn: lobby.game.turn,
        lobbyId,
      });
    }

    function checkStartGame(lobbyId) {
      const lobby = lobbies.get(lobbyId);
      if (lobby && lobby.players.length > 1 && lobby.players.every((p) => p.ready)) {
        startGame(lobbyId);
      }
    }

    function drawCardsFromDeck(lobby, lobbyId, count) {
      const drawn = [];
      while (drawn.length < count) {
        let card = lobby.game.deck.pop();
        if (!card) {
          if (lobby.game.discardPile.length >= 2) {
            const topCard = lobby.game.discardPile.pop();
            lobby.game.deck = lobby.game.discardPile;
            lobby.game.discardPile = [topCard];
            shuffleDeck(lobbyId);
            card = lobby.game.deck.pop();
          } else {
            break;
          }
        }
        drawn.push(card);
      }
      return drawn;
    }

    function createDeck(lobbyId) {
      const lobby = lobbies.get(lobbyId);
      if (!lobby) return;
      const colors = ["red", "yellow", "green", "blue"];
      const types = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "skip", "reverse", "draw2"];
      for (const color of colors) {
        for (const type of types) {
          lobby.game.deck.push({ color, type });
          if (type !== "0") lobby.game.deck.push({ color, type });
        }
      }
      for (let i = 0; i < 4; i++) {
        lobby.game.deck.push({ type: "wild" });
        lobby.game.deck.push({ type: "wild4" });
      }
    }

    function shuffleDeck(lobbyId) {
      const lobby = lobbies.get(lobbyId);
      if (!lobby) return;
      for (let i = lobby.game.deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [lobby.game.deck[i], lobby.game.deck[j]] = [lobby.game.deck[j], lobby.game.deck[i]];
      }
    }

    function uuidv4() {
      return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
        var r = (Math.random() * 16) | 0,
          v = c == "x" ? r : (r & 0x3) | 0x8;
        return v.toString(16);
      });
    }

    function sanitizePlayers(players) {
      return players.map((p) => {
        const { hand, ...rest } = p;
        return { ...rest, cardCount: hand ? hand.length : 0 };
      });
    }

    function startGame(lobbyId) {
      const lobby = lobbies.get(lobbyId);
      if (!lobby) return;
      lobby.game.started = true;
      startedLobbies.add(lobbyId);
      createDeck(lobbyId);
      shuffleDeck(lobbyId);
      for (const player of lobby.players) {
        player.hand = lobby.game.deck.splice(0, 7);
        player.uno = false;
      }
      let idx = lobby.game.deck.findIndex((c) => c.type !== "wild" && c.type !== "wild4");
      if (idx === -1) {
        shuffleDeck(lobbyId);
        idx = lobby.game.deck.findIndex((c) => c.type !== "wild" && c.type !== "wild4");
      }
      lobby.game.discardPile.push(lobby.game.deck.splice(idx, 1)[0]);
      for (const [client, meta] of clients) {
        if (meta.lobbyId === lobbyId) {
          const player = lobby.players.find((p) => p.id === meta.id);
          if (!player) continue;
          client.send(
            JSON.stringify({
              action: "start",
              players: sanitizePlayers(lobby.players),
              discardPile: lobby.game.discardPile,
              turn: lobby.game.turn,
              hand: player.hand,
              id: meta.id,
            }),
          );
        }
      }
    }

    function broadcastWin(lobbyId, winnerName) {
      const lobby = lobbies.get(lobbyId);
      if (!lobby) return;
      broadcastToLobby(lobbyId, { action: "win", winner: winnerName });
      for (const [, meta] of clients) {
        if (meta.lobbyId === lobbyId) meta.lobbyId = null;
      }
      lobby.players.length = 0;
      lobby.game = {
        deck: [],
        discardPile: [],
        turn: 0,
        direction: 1,
        started: false,
      };
      startedLobbies.delete(lobbyId);
    }

    function broadcastGameAborted(lobbyId, excludePlayerId) {
      const lobby = lobbies.get(lobbyId);
      if (!lobby) return;
      broadcastToLobby(lobbyId, { action: "game_aborted" }, excludePlayerId);
      for (const [client, meta] of clients) {
        if (meta.lobbyId === lobbyId && meta.id !== excludePlayerId) meta.lobbyId = null;
      }
      lobby.players = [];
      lobby.game = {
        deck: [],
        discardPile: [],
        turn: 0,
        direction: 1,
        started: false,
      };
      startedLobbies.delete(lobbyId);
    }

    function checkGameAborted(lobbyId, excludePlayerId) {
      const lobby = lobbies.get(lobbyId);
      if (!lobby || !lobby.game.started) return;
      const realPlayers = lobby.players.filter((p) => !p.isAI);
      if (realPlayers.length === 0) {
        broadcastGameAborted(lobbyId, excludePlayerId);
      }
    }

    function checkStartGame(lobbyId) {
      const lobby = lobbies.get(lobbyId);
      if (lobby && lobby.players.length > 1 && lobby.players.every((p) => p.ready)) {
        startGame(lobbyId);
      }
    }

    function handlePlay(lobbyId, playerId, card) {
      const lobby = lobbies.get(lobbyId);
      if (!lobby) return;
      const player = lobby.players.find((p) => p.id === playerId);
      const playerIndex = lobby.players.indexOf(player);
      if (lobby.game.turn !== playerIndex) return;
      let cardIndex =
        card.type === "wild" || card.type === "wild4"
          ? player.hand.findIndex((c) => c.type === card.type)
          : player.hand.findIndex((c) => c.color === card.color && c.type === card.type);
      if (cardIndex < 0) return;
      player.hand.splice(cardIndex, 1);
      lobby.game.discardPile.push(card);
      if (card.type === "skip") {
        lobby.game.turn =
          (lobby.game.turn + 2 * lobby.game.direction + lobby.players.length) %
          lobby.players.length;
      } else if (card.type === "reverse") {
        lobby.game.direction *= -1;
        lobby.game.turn =
          (lobby.game.turn + lobby.game.direction + lobby.players.length) % lobby.players.length;
      } else if (card.type === "draw2") {
        const n =
          (lobby.game.turn + lobby.game.direction + lobby.players.length) % lobby.players.length;
        lobby.players[n].hand.push(...drawCardsFromDeck(lobby, lobbyId, 2));
        lobby.game.turn =
          (lobby.game.turn + 2 * lobby.game.direction + lobby.players.length) %
          lobby.players.length;
      } else if (card.type === "wild4") {
        const n =
          (lobby.game.turn + lobby.game.direction + lobby.players.length) % lobby.players.length;
        lobby.players[n].hand.push(...drawCardsFromDeck(lobby, lobbyId, 4));
        lobby.game.turn =
          (lobby.game.turn + 2 * lobby.game.direction + lobby.players.length) %
          lobby.players.length;
      } else {
        lobby.game.turn =
          (lobby.game.turn + lobby.game.direction + lobby.players.length) % lobby.players.length;
      }
      broadcastGameUpdate(lobbyId);
      if (player.hand.length === 0) broadcastWin(lobbyId, player.name);
    }

    function broadcastGameUpdate(lobbyId) {
      const lobby = lobbies.get(lobbyId);
      if (!lobby) return;
      for (const [client, meta] of clients) {
        if (meta.lobbyId === lobbyId) {
          const player = lobby.players.find((p) => p.id === meta.id);
          client.send(
            JSON.stringify({
              action: "update",
              players: sanitizePlayers(lobby.players),
              discardPile: lobby.game.discardPile,
              turn: lobby.game.turn,
              hand: player ? player.hand : [],
            }),
          );
        }
      }
    }

    function handleDraw(lobbyId, playerId) {
      const lobby = lobbies.get(lobbyId);
      if (!lobby || !lobby.game.started) return;
      const playerIndex = lobby.players.findIndex((p) => p.id === playerId);
      if (lobby.game.turn !== playerIndex) return;

      const player = lobby.players[playerIndex];

      if (player.hand.length >= 100) {
        lobby.game.turn =
          (lobby.game.turn + lobby.game.direction + lobby.players.length) % lobby.players.length;
        broadcastGameUpdate(lobbyId);
        return;
      }

      const drawn = drawCardsFromDeck(lobby, lobbyId, 1);
      if (drawn.length > 0) {
        lobby.players[playerIndex].hand.push(drawn[0]);
      }

      lobby.game.turn =
        (lobby.game.turn + lobby.game.direction + lobby.players.length) % lobby.players.length;
      broadcastGameUpdate(lobbyId);
    }

    function handleLeave(lobbyId, playerId) {
      const lobby = lobbies.get(lobbyId);
      if (!lobby) return;
      const idx = lobby.players.findIndex((p) => p.id === playerId);
      if (idx > -1) {
        lobby.players.splice(idx, 1);
        checkGameAborted(lobbyId, playerId);
        broadcastToLobby(
          lobbyId,
          {
            action: "players",
            players: lobby.players,
            turn: lobby.game.turn,
            lobbyId,
          },
          playerId,
        );
        checkStartGame(lobbyId);
        if (lobby.players.length === 0) lobbies.delete(lobbyId);
      }
    }

    httpServer.on("upgrade", (req, socket, head) => {
      const { pathname } = new URL(req.url, `http://${req.headers.host}`);
      if (pathname === "/ws") {
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
      } else {
        socket.destroy();
      }
    });

    wss.on("connection", (ws) => {
      const id = uuidv4();
      clients.set(ws, { id });
      ws.send(JSON.stringify({ action: "init", dev: false }));

      ws.on("message", (raw) => {
        let message;
        try {
          message = JSON.parse(raw.toString());
        } catch {
          ws.close(1002, "invalid");
          return;
        }
        const meta = clients.get(ws);
        switch (message.action) {
          case "join": {
            meta.name = message.name;
            if (typeof message.lobbyId !== "string" || !message.lobbyId.length) {
              ws.send(JSON.stringify({ action: "error", message: "请提供大厅名称" }));
              return;
            }
            let lobby = findOrCreateLobby(message.lobbyId);
            if (startedLobbies.has(lobby.id)) {
              const disconnectedPlayer = lobby.players.find(
                (p) =>
                  p.disconnected && p.name.toLowerCase() === (message.name || "").toLowerCase(),
              );
              if (disconnectedPlayer) {
                disconnectedPlayer.disconnected = false;
                meta.name = disconnectedPlayer.name;
                meta.lobbyId = message.lobbyId;
                meta.id = disconnectedPlayer.id;
                ws.send(
                  JSON.stringify({
                    action: "init",
                    id: disconnectedPlayer.id,
                    dev: false,
                  }),
                );
                broadcastPlayers(message.lobbyId);
                ws.send(
                  JSON.stringify({
                    action: "start",
                    id: disconnectedPlayer.id,
                    players: lobby.players.map((p) => {
                      const { hand, ...rest } = p;
                      return { ...rest, cardCount: hand ? hand.length : 0 };
                    }),
                    discardPile: lobby.game.discardPile,
                    turn: lobby.game.turn,
                    hand: disconnectedPlayer.hand,
                  }),
                );
                return;
              }
              ws.send(
                JSON.stringify({
                  action: "error",
                  message: "大厅已开始对局, 请使用其他名称",
                }),
              );
              return;
            }
            if (lobby.players.some((p) => p.name.toLowerCase() === message.name.toLowerCase())) {
              const existing = lobby.players.find(
                (p) => p.name.toLowerCase() === message.name.toLowerCase(),
              );
              if (existing && (existing.id === message.playerId || existing.disconnected)) {
                existing.disconnected = false;
                existing.reconnectDeadline = null;
                meta.name = existing.name;
                meta.lobbyId = message.lobbyId;
                meta.id = existing.id;
                ws.send(
                  JSON.stringify({
                    action: "init",
                    id: existing.id,
                    dev: false,
                  }),
                );
                broadcastPlayers(message.lobbyId);
                return;
              }
              ws.send(
                JSON.stringify({
                  action: "error",
                  message: "该大厅中已存在同名玩家，请选择其他名称",
                }),
              );
              return;
            }
            meta.lobbyId = message.lobbyId;
            lobby.players.push({
              id: meta.id,
              name: meta.name,
              ready: false,
              isCreator: lobby.players.length === 0,
            });
            sessions.set(meta.id, { name: meta.name, lobbyId: meta.lobbyId });
            broadcastPlayers(meta.lobbyId);
            return;
          }
          case "ready": {
            const lobby = lobbies.get(meta.lobbyId);
            if (!lobby) {
              ws.send(JSON.stringify({ action: "error", message: "not in lobby" }));
              return;
            }
            let player = lobby.players.find((p) => p.id === meta.id);
            if (!player) {
              player = {
                id: meta.id,
                name: meta.name || "Player",
                ready: false,
                isCreator: lobby.players.length === 0,
              };
              lobby.players.push(player);
            }
            player.ready = !player.ready;
            broadcastPlayers(meta.lobbyId);
            checkStartGame(meta.lobbyId);
            return;
          }
          case "add_ai": {
            const lobby = lobbies.get(meta.lobbyId);
            const p = lobby && lobby.players.find((pl) => pl.id === meta.id);
            if (!p || !p.isCreator) {
              ws.send(
                JSON.stringify({
                  action: "error",
                  message: "只有房主可以邀请 AI",
                }),
              );
              return;
            }
            if (startedLobbies.has(lobby.id)) {
              ws.send(JSON.stringify({ action: "error", message: "对局已开始" }));
              return;
            }
            let idx = 1;
            while (lobby.players.some((pl) => pl.name === `AI-${idx}`)) idx++;
            lobby.players.push({
              id: uuidv4(),
              name: `AI-${idx}`,
              ready: true,
              isCreator: false,
              isAI: true,
            });
            broadcastPlayers(meta.lobbyId);
            return;
          }
          case "ai_ready": {
            const lobby = lobbies.get(meta.lobbyId);
            const p = lobby && lobby.players.find((pl) => pl.id === meta.id);
            if (!p || !p.isCreator) {
              ws.send(
                JSON.stringify({
                  action: "error",
                  message: "只有房主可以准备 AI",
                }),
              );
              return;
            }
            const ai = lobby.players.find((pl) => pl.id === message.playerId && pl.isAI);
            if (!ai) {
              ws.send(JSON.stringify({ action: "error", message: "AI 玩家未找到" }));
              return;
            }
            ai.ready = !ai.ready;
            broadcastPlayers(meta.lobbyId);
            checkStartGame(meta.lobbyId);
            return;
          }
          case "remove_ai": {
            const lobby = lobbies.get(meta.lobbyId);
            const p = lobby && lobby.players.find((pl) => pl.id === meta.id);
            if (!p || !p.isCreator) {
              ws.send(
                JSON.stringify({
                  action: "error",
                  message: "只有房主可以踢出 AI",
                }),
              );
              return;
            }
            if (startedLobbies.has(lobby.id)) {
              ws.send(JSON.stringify({ action: "error", message: "对局已开始" }));
              return;
            }
            const idx = lobby.players.findIndex((pl) => pl.id === message.playerId && pl.isAI);
            if (idx === -1) {
              ws.send(JSON.stringify({ action: "error", message: "AI 玩家未找到" }));
              return;
            }
            lobby.players.splice(idx, 1);
            broadcastPlayers(meta.lobbyId);
            return;
          }
          case "play":
            if (!lobbies.has(meta.lobbyId)) {
              ws.send(JSON.stringify({ action: "error", message: "房间不存在" }));
              return;
            }
            handlePlay(meta.lobbyId, meta.id, message.card);
            return;
          case "reconnect": {
            const session = sessions.get(message.playerId);
            if (!session) {
              const newId = uuidv4();
              meta.id = newId;
              ws.send(
                JSON.stringify({
                  action: "init",
                  id: newId,
                  dev: false,
                  reconnectLost: true,
                }),
              );
              return;
            }
            const rLobby = lobbies.get(session.lobbyId);
            const lobbyAlive = rLobby && rLobby.players.length > 0;
            if (!lobbyAlive) {
              const newId = uuidv4();
              meta.id = newId;
              ws.send(
                JSON.stringify({
                  action: "init",
                  id: newId,
                  dev: false,
                  reconnectLost: true,
                }),
              );
              return;
            }
            meta.name = session.name;
            const existingPlayer = rLobby.players.find((p) => p.id === message.playerId);
            if (!existingPlayer) {
              const newId = uuidv4();
              meta.id = newId;
              ws.send(
                JSON.stringify({
                  action: "init",
                  id: newId,
                  dev: false,
                  reconnectLost: true,
                }),
              );
              return;
            }
            meta.name = session.name;
            meta.lobbyId = session.lobbyId;
            meta.id = message.playerId;
            ws.send(
              JSON.stringify({
                action: "init",
                id: message.playerId,
                dev: false,
              }),
            );
            existingPlayer.disconnected = false;
            for (const [existingWs, existingMeta] of clients) {
              if (existingMeta.id === message.playerId && existingWs !== ws) {
                existingMeta.lobbyId = null;
              }
            }
            broadcastPlayers(session.lobbyId);
            if (rLobby.game.started) {
              const player = existingPlayer || rLobby.players[0];
              if (player && player.hand) {
                ws.send(
                  JSON.stringify({
                    action: "start",
                    id: message.playerId,
                    players: (() => {
                      return rLobby.players.map((p) => {
                        const { hand, ...rest } = p;
                        return { ...rest, cardCount: hand ? hand.length : 0 };
                      });
                    })(),
                    discardPile: rLobby.game.discardPile,
                    turn: rLobby.game.turn,
                    hand: player.hand,
                  }),
                );
              }
            } else {
              ws.send(
                JSON.stringify({
                  action: "players",
                  players: rLobby.players,
                  turn: rLobby.game.turn,
                  lobbyId: session.lobbyId,
                }),
              );
            }
            return;
          }
          case "draw":
            if (!lobbies.has(meta.lobbyId)) {
              ws.send(JSON.stringify({ action: "error", message: "房间不存在" }));
              return;
            }
            handleDraw(meta.lobbyId, meta.id);
            return;
          case "leave":
            if (!lobbies.has(meta.lobbyId)) {
              ws.send(JSON.stringify({ action: "error", message: "房间不存在" }));
              return;
            }
            handleLeave(meta.lobbyId, meta.id);
            return;
          case "surrender": {
            const sLobby = lobbies.get(meta.lobbyId);
            if (!sLobby || !sLobby.game.started) return;
            const surrenderPlayer = sLobby.players.find((p) => p.id === meta.id);
            if (!surrenderPlayer) return;
            const winner =
              sLobby.players.find((p) => p.id !== meta.id && !p.isAI) ||
              sLobby.players.find((p) => p.id !== meta.id);
            if (winner) broadcastWin(meta.lobbyId, winner.name);
            return;
          }
          case "dev_add_cards": {
            const lobby = findOrCreateLobby(meta.lobbyId);
            if (!lobby.game.started) return;
            const player = lobby.players.find((p) => p.id === meta.id);
            if (!player) return;
            const count = Math.min(message.count || 1, 20);
            let drawn = lobby.game.deck.splice(0, count);
            if (drawn.length < count && lobby.game.discardPile.length >= 2) {
              const topCard = lobby.game.discardPile.pop();
              lobby.game.deck = lobby.game.discardPile;
              lobby.game.discardPile = [topCard];
              shuffleDeck(meta.lobbyId);
              const more = lobby.game.deck.splice(0, count - drawn.length);
              drawn = [...drawn, ...more];
            }
            player.hand.push(...drawn);
            broadcastGameUpdate(meta.lobbyId);
            return;
          }
          case "dev_add_all_cards": {
            const lobby = findOrCreateLobby(meta.lobbyId);
            if (!lobby.game.started) return;
            const player = lobby.players.find((p) => p.id === meta.id);
            if (!player) return;
            let drawn = lobby.game.deck.splice(0, lobby.game.deck.length);
            if (drawn.length === 0 && lobby.game.discardPile.length >= 2) {
              const topCard = lobby.game.discardPile.pop();
              lobby.game.deck = lobby.game.discardPile;
              lobby.game.discardPile = [topCard];
              shuffleDeck(meta.lobbyId);
              drawn = lobby.game.deck.splice(0, lobby.game.deck.length);
            }
            if (drawn.length > 0 && lobby.game.discardPile.length < 2) {
              lobby.game.discardPile.push(drawn.shift());
            }
            player.hand.push(...drawn);
            broadcastGameUpdate(meta.lobbyId);
            return;
          }
        }
      });

      ws.on("close", () => {
        const meta = clients.get(ws);
        if (meta && meta.lobbyId) {
          const lobby = lobbies.get(meta.lobbyId);
          if (lobby) {
            const player = lobby.players.find((p) => p.id === meta.id);
            if (player) {
              player.disconnected = true;
              if (lobby.game.turn === lobby.players.indexOf(player)) {
                lobby.game.turn =
                  (lobby.game.turn + lobby.game.direction + lobby.players.length) %
                  lobby.players.length;
              }
              broadcastPlayers(meta.lobbyId);
              if (lobby.game.started) broadcastGameUpdate(meta.lobbyId);
            }
          }
        }
        clients.delete(ws);
      });
    });

    await new Promise((r) => httpServer.listen(0, r));
    port = httpServer.address().port;
    server = httpServer;
  });

  afterEach(() => {
    server.close();
  });

  it("connect and receive init", async () => {
    const c = await trackedWs(port);
    const msg = await c.next();
    expect(msg.action).toBe("init");
    expect(msg.dev).toBe(false);
    c.close();
  });

  it("reject join without lobbyId", async () => {
    const c = await trackedWs(port);
    await c.next();
    send(c.ws, { action: "join", name: "Alice" });
    const err = await c.next();
    expect(err.action).toBe("error");
    c.close();
  });

  it("reject join with empty lobbyId", async () => {
    const c = await trackedWs(port);
    await c.next();
    send(c.ws, { action: "join", name: "Alice", lobbyId: "" });
    const err = await c.next();
    expect(err.action).toBe("error");
    c.close();
  });

  it("join lobby with custom name", async () => {
    const c = await trackedWs(port);
    await c.next();
    send(c.ws, { action: "join", name: "Alice", lobbyId: "myroom" });
    const msg = await c.next();
    expect(msg.action).toBe("players");
    expect(msg.players).toHaveLength(1);
    expect(msg.players[0].name).toBe("Alice");
    expect(msg.players[0].isCreator).toBe(true);
    expect(msg.lobbyId).toBe("myroom");
    c.close();
  });

  it("reject duplicate names in same lobby", async () => {
    const a = await trackedWs(port);
    await a.next();
    send(a.ws, { action: "join", name: "Alice", lobbyId: "r" });
    await a.next();

    const b = await trackedWs(port);
    await b.next();
    send(b.ws, { action: "join", name: "Alice", lobbyId: "r" });
    const err = await b.next();
    expect(err.action).toBe("error");
    expect(err.message).toContain("已存在同名");
    a.close();
    b.close();
  });

  it("rejoin with same name and matching UUID is allowed", async () => {
    const a = await trackedWs(port);
    await a.next();
    send(a.ws, { action: "join", name: "Alice", lobbyId: "r" });
    await a.next();
    const lobby = lobbiesRef.get("r");
    const aliceId = lobby.players[0].id;

    // Same name + matching UUID >> allowed
    const b = await trackedWs(port);
    await b.next();
    send(b.ws, {
      action: "join",
      name: "Alice",
      lobbyId: "r",
      playerId: aliceId,
    });
    const msg = await b.next();
    expect(msg.action).not.toBe("error");
    a.close();
    b.close();
  });

  it("two players in same lobby", async () => {
    const a = await trackedWs(port);
    await a.next();
    send(a.ws, { action: "join", name: "Alice", lobbyId: "r" });
    await a.next();

    const b = await trackedWs(port);
    await b.next();
    send(b.ws, { action: "join", name: "Bob", lobbyId: "r" });
    const bob = await b.next();
    expect(bob.players).toHaveLength(2);

    await a.next();
    a.close();
    b.close();
  });

  it("second joiner is non-creator", async () => {
    const a = await trackedWs(port);
    await a.next();
    send(a.ws, { action: "join", name: "Alice", lobbyId: "r" });
    await a.next();

    const b = await trackedWs(port);
    await b.next();
    send(b.ws, { action: "join", name: "Bob", lobbyId: "r" });
    const bob = await b.next();
    expect(bob.players[0].isCreator).toBe(true);
    expect(bob.players[1].isCreator).toBe(false);
    a.close();
    b.close();
  });

  it("leave removes player", async () => {
    const a = await trackedWs(port);
    await a.next();
    send(a.ws, { action: "join", name: "Alice", lobbyId: "r" });
    await a.next();

    const b = await trackedWs(port);
    await b.next();
    send(b.ws, { action: "join", name: "Bob", lobbyId: "r" });
    await b.next();
    await a.next();

    send(b.ws, { action: "leave" });
    const aliceUpdate = await a.next();
    expect(aliceUpdate.players).toHaveLength(1);
    expect(aliceUpdate.players[0].name).toBe("Alice");
    a.close();
    b.close();
  });

  it("leaver not notified on leave", async () => {
    const a = await trackedWs(port);
    await a.next();
    send(a.ws, { action: "join", name: "Alice", lobbyId: "r" });
    await a.next();

    const b = await trackedWs(port);
    await b.next();
    send(b.ws, { action: "join", name: "Bob", lobbyId: "r" });
    await b.next();
    await a.next();

    let got = false;
    b.ws.once("message", () => {
      got = true;
    });
    send(b.ws, { action: "leave" });
    await new Promise((r) => setTimeout(r, 150));
    expect(got).toBe(false);
    await a.next();
    a.close();
    b.close();
  });

  it("start game when all ready", async () => {
    const a = await trackedWs(port);
    await a.next();
    send(a.ws, { action: "join", name: "Alice", lobbyId: "r" });
    await a.next();

    const b = await trackedWs(port);
    await b.next();
    send(b.ws, { action: "join", name: "Bob", lobbyId: "r" });
    await b.next();
    await a.next();

    send(a.ws, { action: "ready" });
    await a.next();
    await b.next();
    send(b.ws, { action: "ready" });

    await a.next(); // players
    await b.next(); // players
    const s1 = await a.next(); // start
    const s2 = await b.next(); // start
    expect(s1.action).toBe("start");
    expect(s2.action).toBe("start");
    expect(s1.hand).toHaveLength(7);
    a.close();
    b.close();
  });

  it("play a matching card", async () => {
    const a = await trackedWs(port);
    await a.next();
    send(a.ws, { action: "join", name: "Alice", lobbyId: "r" });
    await a.next();

    const b = await trackedWs(port);
    await b.next();
    send(b.ws, { action: "join", name: "Bob", lobbyId: "r" });
    await b.next();
    await a.next();

    send(a.ws, { action: "ready" });
    await a.next();
    await b.next();
    send(b.ws, { action: "ready" });
    await a.next();
    await b.next();

    const s1 = await a.next();
    await b.next();

    const topCard = s1.discardPile[0];
    const matching = s1.hand.find((c) => c.color === topCard.color || c.type === topCard.type);
    if (matching) {
      send(a.ws, { action: "play", card: matching });
      const u = await a.next();
      expect(u.action).toBe("update");
      expect(u.hand.length).toBeLessThan(7);
    }
    a.close();
    b.close();
  });

  it("draw card", async () => {
    const a = await trackedWs(port);
    await a.next();
    send(a.ws, { action: "join", name: "Alice", lobbyId: "r" });
    await a.next();

    const b = await trackedWs(port);
    await b.next();
    send(b.ws, { action: "join", name: "Bob", lobbyId: "r" });
    await b.next();
    await a.next();

    send(a.ws, { action: "ready" });
    await a.next();
    await b.next();
    send(b.ws, { action: "ready" });
    await a.next();
    await b.next();
    await a.next();
    await b.next();

    send(a.ws, { action: "draw" });
    const u = await a.next();
    expect(u.action).toBe("update");
    expect(u.hand).toHaveLength(8);
    a.close();
    b.close();
  });

  it("draw reshuffles discard pile when deck is empty", async () => {
    const a = await trackedWs(port);
    await a.next();
    send(a.ws, { action: "join", name: "Alice", lobbyId: "r" });
    await a.next();

    const b = await trackedWs(port);
    await b.next();
    send(b.ws, { action: "join", name: "Bob", lobbyId: "r" });
    await b.next();
    await a.next();

    send(a.ws, { action: "ready" });
    await a.next();
    await b.next();
    send(b.ws, { action: "ready" });
    await a.next();
    await b.next();
    await a.next();
    await b.next();

    const lobby = lobbiesRef.get("r");
    lobby.game.discardPile.push(...lobby.game.deck);
    lobby.game.deck = [];

    send(a.ws, { action: "draw" });
    const u = await a.next();
    expect(u.action).toBe("update");
    expect(u.hand).toHaveLength(8);
    a.close();
    b.close();
  });

  it("draw passes turn when deck and discard pile are exhausted and no donor has >1 card", async () => {
    const a = await trackedWs(port);
    await a.next();
    send(a.ws, { action: "join", name: "Alice", lobbyId: "r" });
    await a.next();

    const b = await trackedWs(port);
    await b.next();
    send(b.ws, { action: "join", name: "Bob", lobbyId: "r" });
    await b.next();
    await a.next();

    send(a.ws, { action: "ready" });
    await a.next();
    await b.next();
    send(b.ws, { action: "ready" });
    await a.next();
    await b.next();
    await a.next();
    await b.next();

    const lobby = lobbiesRef.get("r");
    // Move cards from Bob to deck so Bob has only 1 card
    lobby.game.deck.push(...lobby.players[1].hand.splice(1));
    // Ensure deck and discard are exhausted
    lobby.game.deck = [];
    lobby.game.discardPile.splice(1);

    send(a.ws, { action: "draw" });
    const u = await a.next();
    expect(u.action).toBe("update");
    expect(u.hand).toHaveLength(7);
    expect(u.turn).toBe(1);
    a.close();
    b.close();
  });

  it("draw passes turn when deck and discard pile are exhausted and no donor has >1 card", async () => {
    const a = await trackedWs(port);
    await a.next();
    send(a.ws, { action: "join", name: "Alice", lobbyId: "r" });
    await a.next();

    const b = await trackedWs(port);
    await b.next();
    send(b.ws, { action: "join", name: "Bob", lobbyId: "r" });
    await b.next();
    await a.next();

    send(a.ws, { action: "ready" });
    await a.next();
    await b.next();
    send(b.ws, { action: "ready" });
    await a.next();
    await b.next();
    await a.next();
    await b.next();

    const lobby = lobbiesRef.get("r");
    lobby.game.deck = [];
    lobby.game.discardPile.splice(1);

    send(a.ws, { action: "draw" });
    const u = await a.next();
    expect(u.action).toBe("update");
    expect(u.hand).toHaveLength(7);
    expect(u.turn).toBe(1);
    a.close();
    b.close();
  });

  it("draw works after dev_add_cards depletes the deck", async () => {
    const a = await trackedWs(port);
    await a.next();
    send(a.ws, { action: "join", name: "Alice", lobbyId: "r" });
    await a.next();

    const b = await trackedWs(port);
    await b.next();
    send(b.ws, { action: "join", name: "Bob", lobbyId: "r" });
    await b.next();
    await a.next();

    send(a.ws, { action: "ready" });
    await a.next();
    await b.next();
    send(b.ws, { action: "ready" });
    await a.next();
    await b.next();
    await a.next();
    await b.next();

    // Deplete the deck by moving all cards to Alice's hand
    const lobby = lobbiesRef.get("r");
    const remainingCards = lobby.game.deck.splice(0, lobby.game.deck.length);
    lobby.players[0].hand.push(...remainingCards);
    // Give discard pile enough cards to reshuffle count=2
    const extraCards = lobby.players[0].hand.splice(0, 4);
    lobby.game.discardPile.push(...extraCards);
    expect(lobby.game.deck.length).toBe(0);
    expect(lobby.game.discardPile.length >= 2).toBe(true);

    // dev_add_cards should reshuffle discard pile and add cards
    const aliceHandBefore = lobby.players[0].hand.length;
    send(a.ws, { action: "dev_add_cards", count: 2 });
    const u1 = await a.next();
    expect(u1.action).toBe("update");
    expect(u1.hand.length).toBe(aliceHandBefore + 2); // reshuffled 2 cards added
    a.close();
    b.close();
  });

  it("dev_add_all_cards adds all deck cards to hand", async () => {
    const a = await trackedWs(port);
    await a.next();
    send(a.ws, { action: "join", name: "Alice", lobbyId: "r" });
    await a.next();

    const b = await trackedWs(port);
    await b.next();
    send(b.ws, { action: "join", name: "Bob", lobbyId: "r" });
    await b.next();
    await a.next();

    send(a.ws, { action: "ready" });
    await a.next();
    await b.next();
    send(b.ws, { action: "ready" });
    await a.next();
    await b.next();
    await a.next();
    await b.next();

    const lobby = lobbiesRef.get("r");
    const deckSize = lobby.game.deck.length;

    send(a.ws, { action: "dev_add_all_cards" });
    const u = await a.next();
    expect(u.action).toBe("update");
    // Alice gets all deck cards minus 1 (which seeds the discard pile to enable draws)
    expect(u.hand.length).toBe(7 + deckSize - 1); // 1 card reserved for discard
    expect(lobby.game.deck.length).toBe(0);
    expect(lobby.game.discardPile.length).toBe(2);
    a.close();
    b.close();
  });

  it("player with >= 100 cards skips draw others pass when deck empty", async () => {
    const a = await trackedWs(port);
    await a.next();
    send(a.ws, { action: "join", name: "Alice", lobbyId: "r" });
    await a.next();

    const b = await trackedWs(port);
    await b.next();
    send(b.ws, { action: "join", name: "Bob", lobbyId: "r" });
    await b.next();
    await a.next();

    send(a.ws, { action: "ready" });
    await a.next();
    await b.next();
    send(b.ws, { action: "ready" });
    await a.next();
    await b.next();
    await a.next();
    await b.next();

    // Give Alice all deck cards (99 after reserve) then push to >= 100
    send(a.ws, { action: "dev_add_all_cards" });
    await a.next();
    send(a.ws, { action: "dev_add_cards", count: 1 }); // reshuffles the reserved card >> Alice 100
    await a.next();

    const lobby = lobbiesRef.get("r");
    const aliceHand = lobby.players[0].hand.length;
    const bobHand = lobby.players[1].hand.length;
    expect(aliceHand >= 100).toBe(true);

    // Alice draws >> >= 100, skips turn, hand unchanged
    send(a.ws, { action: "draw" });
    const u1 = await a.next();
    expect(u1.action).toBe("update");
    expect(u1.hand.length).toBe(aliceHand);
    expect(u1.turn).toBe(1);
    expect(lobby.players[0].hand.length).toBe(aliceHand);

    // Bob draws >> deck empty, discard < 2 >> pass turn, neither changes
    send(b.ws, { action: "draw" });
    const u2 = await a.next();
    expect(u2.action).toBe("update");
    expect(u2.hand.length).toBe(aliceHand);
    expect(lobby.players[0].hand.length).toBe(aliceHand);
    expect(lobby.players[1].hand.length).toBe(bobHand);
    a.close();
    b.close();
  });

  it("returns error when lobby does not exist for game action", async () => {
    const a = await trackedWs(port);
    await a.next();
    send(a.ws, { action: "join", name: "Alice", lobbyId: "r" });
    await a.next();
    const b = await trackedWs(port);
    await b.next();
    send(b.ws, { action: "join", name: "Bob", lobbyId: "r" });
    await b.next();
    await a.next();

    send(a.ws, { action: "ready" });
    await a.next();
    await b.next();
    send(b.ws, { action: "ready" });
    await a.next();
    await b.next();
    await a.next();
    await b.next();

    // Simulate server restart: delete the lobby
    lobbiesRef.delete("r");

    send(a.ws, { action: "draw" });
    const err = await a.next();
    expect(err.action).toBe("error");
    expect(err.message).toContain("房间");
    a.close();
    b.close();
  });

  it("rejoin restores game state after disconnect", async () => {
    const a = await trackedWs(port);
    await a.next();
    send(a.ws, { action: "join", name: "Alice", lobbyId: "r" });
    await a.next();

    const b = await trackedWs(port);
    await b.next();
    send(b.ws, { action: "join", name: "Bob", lobbyId: "r" });
    await b.next();
    await a.next();

    send(a.ws, { action: "ready" });
    await a.next();
    await b.next();
    send(b.ws, { action: "ready" });
    await a.next();
    await b.next();
    await a.next();
    await b.next();

    const lobby = lobbiesRef.get("r");
    const aliceId = lobby.players[0].id;
    const aliceHandSize = lobby.players[0].hand.length;

    // Directly mark as disconnected without closing WS
    lobby.players[0].disconnected = true;

    // Rejoin with a fresh connection
    const a2 = await trackedWs(port);
    await a2.next(); // initial init

    send(a2.ws, { action: "reconnect", playerId: aliceId });
    const rejoinInit = await a2.next();
    expect(rejoinInit.action).toBe("init");
    expect(rejoinInit.id).toBe(aliceId);

    await a2.next(); // players (broadcastPlayers)
    // Second players (direct ws.send in rejoin handler for non-started lobbies)
    // For started games this will be the 'start' message instead

    const rejoinState = await a2.next();
    expect(rejoinState.action).toBe("start");
    expect(rejoinState.hand.length).toBe(aliceHandSize);
    expect(lobby.players.find((p) => p.id === aliceId).disconnected).toBe(false);
    a2.close();
    b.close();
  });

  it("player disconnect marks as disconnected game continues", async () => {
    const a = await trackedWs(port);
    await a.next();
    send(a.ws, { action: "join", name: "Alice", lobbyId: "r" });
    await a.next();

    const b = await trackedWs(port);
    await b.next();
    send(b.ws, { action: "join", name: "Bob", lobbyId: "r" });
    await b.next();
    await a.next();

    send(a.ws, { action: "ready" });
    await a.next();
    await b.next();
    send(b.ws, { action: "ready" });
    await a.next();
    await b.next();
    await a.next();
    await b.next();

    const lobby = lobbiesRef.get("r");
    b.close();
    // Alice gets a players broadcast with Bob marked disconnected
    const update = await a.next();
    expect(update.action).toBe("players");
    expect(update.players.length).toBe(2);
    expect(update.players[1].disconnected).toBe(true);
    expect(lobby.players[0].disconnected).toBeFalsy();
    expect(lobby.players[1].disconnected).toBe(true);
    a.close();
  });

  it("game does not abort when one real player remains", async () => {
    const a = await trackedWs(port);
    await a.next();
    send(a.ws, { action: "join", name: "Alice", lobbyId: "r" });
    await a.next();

    const b = await trackedWs(port);
    await b.next();
    send(b.ws, { action: "join", name: "Bob", lobbyId: "r" });
    await b.next();
    await a.next();

    send(a.ws, { action: "ready" });
    await a.next();
    await b.next();
    send(b.ws, { action: "ready" });
    await a.next();
    await b.next();
    await a.next();
    await b.next();

    send(b.ws, { action: "leave" });
    // Alice receives players update confirming Bob left
    const msg = await a.next();
    expect(msg.action).toBe("players");
    // Bob left, but Alice still there >> game should continue
    const lobby = lobbiesRef.get("r");
    expect(lobby.game.started).toBe(true);
    expect(lobby.players.length).toBe(1);
    expect(lobby.players[0].name).toBe("Alice");
    a.close();
    b.close();
  });

  it("reject join to started lobby", async () => {
    const a = await trackedWs(port);
    await a.next();
    send(a.ws, { action: "join", name: "Alice", lobbyId: "r" });
    await a.next();

    const b = await trackedWs(port);
    await b.next();
    send(b.ws, { action: "join", name: "Bob", lobbyId: "r" });
    await b.next();
    await a.next();

    send(a.ws, { action: "ready" });
    await a.next();
    await b.next();
    send(b.ws, { action: "ready" });
    await a.next();
    await b.next();
    await a.next();
    await b.next();

    const c = await trackedWs(port);
    await c.next();
    send(c.ws, { action: "join", name: "Eve", lobbyId: "r" });
    const err = await c.next();
    expect(err.action).toBe("error");
    expect(err.message).toContain("已开始");
    a.close();
    b.close();
    c.close();
  });

  it("cannot join started lobby after opponent leaves one player remains", async () => {
    const a = await trackedWs(port);
    await a.next();
    send(a.ws, { action: "join", name: "Alice", lobbyId: "r" });
    await a.next();

    const b = await trackedWs(port);
    await b.next();
    send(b.ws, { action: "join", name: "Bob", lobbyId: "r" });
    await b.next();
    await a.next();

    send(a.ws, { action: "ready" });
    await a.next();
    await b.next();
    send(b.ws, { action: "ready" });
    await a.next();
    await b.next();
    await a.next();
    await b.next();

    // Bob leaves — game continues because Alice is still there
    send(b.ws, { action: "leave" });
    await a.next();

    // New player cannot join the still-running lobby
    const c = await trackedWs(port);
    await c.next();
    send(c.ws, { action: "join", name: "Eve", lobbyId: "r" });
    const msg = await c.next();
    expect(msg.action).toBe("error");
    expect(msg.message).toContain("已开始");
    c.close();
    a.close();
  });

  it("reject join should not leak lobbyId to metadata", async () => {
    const a = await trackedWs(port);
    await a.next();
    send(a.ws, { action: "join", name: "Alice", lobbyId: "r" });
    await a.next();

    const b = await trackedWs(port);
    await b.next();
    send(b.ws, { action: "join", name: "Bob", lobbyId: "r" });
    await b.next();
    await a.next();

    send(a.ws, { action: "ready" });
    await a.next();
    await b.next();
    send(b.ws, { action: "ready" });
    await a.next();
    await b.next();
    await a.next();
    await b.next();

    // Game started. A third client tries to join — should be rejected.
    const c = await trackedWs(port);
    await c.next();
    send(c.ws, { action: "join", name: "Eve", lobbyId: "r" });
    const err = await c.next();
    expect(err.action).toBe("error");
    expect(err.message).toContain("已开始");

    // A leaves — game aborts. c should NOT receive game_aborted since join was rejected.
    let cGotAbort = false;
    c.ws.once("message", () => {
      cGotAbort = true;
    });

    send(a.ws, { action: "leave" });
    await new Promise((r) => setTimeout(r, 150));
    expect(cGotAbort).toBe(false);
    a.close();
    b.close();
    c.close();
  });

  it("add_ai requires creator", async () => {
    const a = await trackedWs(port);
    await a.next();
    send(a.ws, { action: "join", name: "Alice", lobbyId: "r" });
    await a.next();

    const b = await trackedWs(port);
    await b.next();
    send(b.ws, { action: "join", name: "Bob", lobbyId: "r" });
    await b.next();
    await a.next();

    send(b.ws, { action: "add_ai" });
    const err = await b.next();
    expect(err.action).toBe("error");
    expect(err.message).toContain("只有房主");
    a.close();
    b.close();
  });

  it("add_ai creates AI player", async () => {
    const a = await trackedWs(port);
    await a.next();
    send(a.ws, { action: "join", name: "Alice", lobbyId: "r" });
    await a.next();

    send(a.ws, { action: "add_ai" });
    const msg = await a.next();
    expect(msg.action).toBe("players");
    expect(msg.players).toHaveLength(2);
    expect(msg.players[1].isAI).toBe(true);
    expect(msg.players[1].name).toMatch(/^AI-/);
    expect(msg.players[1].ready).toBe(true); // AI starts ready
    a.close();
  });

  it("ai_ready toggles AI player ready", async () => {
    const a = await trackedWs(port);
    await a.next();
    send(a.ws, { action: "join", name: "Alice", lobbyId: "r" });
    await a.next();

    send(a.ws, { action: "add_ai" });
    const addMsg = await a.next();
    const aiId = addMsg.players[1].id;
    expect(addMsg.players[1].ready).toBe(true); // AI starts ready

    send(a.ws, { action: "ai_ready", playerId: aiId });
    const msg = await a.next();
    expect(msg.players).toHaveLength(2);
    expect(msg.players[1].ready).toBe(false); // toggled off (was true>>false)
    a.close();
  });

  it("remove_ai kicks AI player", async () => {
    const a = await trackedWs(port);
    await a.next();
    send(a.ws, { action: "join", name: "Alice", lobbyId: "r" });
    await a.next();

    send(a.ws, { action: "add_ai" });
    const addMsg = await a.next();
    const aiId = addMsg.players[1].id;

    send(a.ws, { action: "remove_ai", playerId: aiId });
    const msg = await a.next();
    expect(msg.players).toHaveLength(1);
    a.close();
  });

  it("start game with AI players", async () => {
    const a = await trackedWs(port);
    await a.next();
    send(a.ws, { action: "join", name: "Alice", lobbyId: "r" });
    await a.next();

    send(a.ws, { action: "add_ai" });
    const addMsg = await a.next();
    const aiId = addMsg.players[1].id;

    const b = await trackedWs(port);
    await b.next();
    send(b.ws, { action: "join", name: "Bob", lobbyId: "r" });
    await b.next();
    await a.next();

    send(a.ws, { action: "ready" });
    await a.next();
    await b.next();
    // Bob readies >> AI is already ready >> game starts
    send(b.ws, { action: "ready" });
    const p1 = await a.next(); // players from Bob's ready
    await b.next();
    // Game starts after Bob's ready since all are ready (AI starts ready=true)
    const s1 = await a.next();
    const s2 = await b.next();
    expect(s1.action).toBe("start");
    expect(s2.action).toBe("start");
    expect(s1.players).toHaveLength(3);
    expect(s1.players[2].cardCount).toBe(7);
    a.close();
    b.close();
  });

  it("start game not crash when player left before startGame loop", async () => {
    const a = await trackedWs(port);
    await a.next();
    send(a.ws, { action: "join", name: "Alice", lobbyId: "r" });
    await a.next();

    const b = await trackedWs(port);
    await b.next();
    send(b.ws, { action: "join", name: "Bob", lobbyId: "r" });
    await b.next();
    await a.next();

    // Both ready
    send(a.ws, { action: "ready" });
    await a.next();
    await b.next();
    send(b.ws, { action: "ready" });
    await a.next();
    await b.next();

    // Bob closes BEFORE receiving start — simulates refresh
    b.close();

    // Alice should get start (or players if game didn't start)
    // Game should start with just Alice since all remaining (only Alice) are ready and >= 2? No, >= 2 fails.
    // So game should NOT start (only 1 player left), Bob left triggers checkStartGame but len=1.
    // Actually after Bob's close, lobby has 1 player. checkStartGame returns (len > 1 fails).
    // No crash should occur.
    const msg = await a.next();
    expect(msg.action).toMatch(/^(players|start)$/);
    a.close();
  });

  it("surrender makes opponent win", async () => {
    const a = await trackedWs(port);
    await a.next();
    send(a.ws, { action: "join", name: "Alice", lobbyId: "r" });
    await a.next();

    const b = await trackedWs(port);
    await b.next();
    send(b.ws, { action: "join", name: "Bob", lobbyId: "r" });
    await b.next();
    await a.next();

    send(a.ws, { action: "ready" });
    await a.next();
    await b.next();
    send(b.ws, { action: "ready" });
    await a.next();
    await b.next();
    await a.next();
    await b.next();

    send(a.ws, { action: "surrender" });
    const aWin = await a.next();
    expect(aWin.action).toBe("win");
    expect(aWin.winner).toBe("Bob");

    const bWin = await b.next();
    expect(bWin.action).toBe("win");
    expect(bWin.winner).toBe("Bob");
    a.close();
    b.close();
  });

  it("surrender works regardless of whose turn", async () => {
    const a = await trackedWs(port);
    await a.next();
    send(a.ws, { action: "join", name: "Alice", lobbyId: "r" });
    await a.next();

    const b = await trackedWs(port);
    await b.next();
    send(b.ws, { action: "join", name: "Bob", lobbyId: "r" });
    await b.next();
    await a.next();

    send(a.ws, { action: "ready" });
    await a.next();
    await b.next();
    send(b.ws, { action: "ready" });
    await a.next();
    await b.next();
    await a.next();
    await b.next();

    // It's Bob's turn (1), Alice surrenders anyway — still works
    send(a.ws, { action: "surrender" });
    const aWin = await a.next();
    expect(aWin.action).toBe("win");
    expect(aWin.winner).toBe("Bob");
    a.close();
    b.close();
  });

  it("surrender clears lobby so rejoin fails", async () => {
    const a = await trackedWs(port);
    await a.next();
    send(a.ws, { action: "join", name: "Alice", lobbyId: "r" });
    await a.next();

    const b = await trackedWs(port);
    await b.next();
    send(b.ws, { action: "join", name: "Bob", lobbyId: "r" });
    await b.next();
    await a.next();

    send(a.ws, { action: "ready" });
    await a.next();
    await b.next();
    send(b.ws, { action: "ready" });
    await a.next();
    await b.next();
    await a.next();
    await b.next();

    send(a.ws, { action: "surrender" });
    await a.next();
    await b.next();

    // After surrender, lobby is cleaned up — joining should create a fresh lobby
    const c = await trackedWs(port);
    await c.next();
    send(c.ws, { action: "join", name: "Charlie", lobbyId: "r" });
    const msg = await c.next();
    expect(msg.action).toBe("players");
    expect(msg.players).toHaveLength(1);
    expect(msg.players[0].name).toBe("Charlie");
    a.close();
    b.close();
    c.close();
  });

  it("surrender ignored when game not started", async () => {
    const a = await trackedWs(port);
    await a.next();
    send(a.ws, { action: "join", name: "Alice", lobbyId: "r" });
    await a.next();

    // Sending surrender before game starts should not crash
    send(a.ws, { action: "surrender" });
    // Connection persists — send join again to verify
    send(a.ws, { action: "join", name: "Alice", lobbyId: "r" });
    const msg = await a.next();
    // May be players or error (name taken)
    expect(msg.action).toMatch(/^(players|error)$/);
    a.close();
  });

  it("play draw2 skips next player in 3-player game", async () => {
    const a = await trackedWs(port);
    await a.next();
    send(a.ws, { action: "join", name: "Alice", lobbyId: "r" });
    await a.next();

    const b = await trackedWs(port);
    await b.next();
    send(b.ws, { action: "join", name: "Bob", lobbyId: "r" });
    await b.next();
    await a.next();

    const c = await trackedWs(port);
    await c.next();
    send(c.ws, { action: "join", name: "Charlie", lobbyId: "r" });
    await c.next();
    await a.next();
    await b.next();

    send(a.ws, { action: "ready" });
    await a.next();
    await b.next();
    await c.next();
    send(b.ws, { action: "ready" });
    await a.next();
    await b.next();
    await c.next();
    send(c.ws, { action: "ready" });
    await a.next();
    await b.next();
    await c.next();

    const s1 = await a.next();
    await b.next();
    await c.next();

    const lobby = lobbiesRef.get("r");
    lobby.game.discardPile = [{ color: "red", type: "5" }];
    lobby.players[0].hand = [
      { color: "red", type: "draw2" },
      { color: "blue", type: "3" },
    ];
    lobby.players[1].hand = [];
    lobby.players[2].hand = [];

    send(a.ws, { action: "play", card: { color: "red", type: "draw2" } });
    const u = await a.next();
    expect(u.action).toBe("update");
    const bob = lobby.players.find((p) => p.name === "Bob");
    expect(bob.hand).toHaveLength(2);
    expect(u.turn).toBe(2);
    a.close();
    b.close();
    c.close();
  });

  it("play wild4 skips next player in 3-player game", async () => {
    const a = await trackedWs(port);
    await a.next();
    send(a.ws, { action: "join", name: "Alice", lobbyId: "r" });
    await a.next();

    const b = await trackedWs(port);
    await b.next();
    send(b.ws, { action: "join", name: "Bob", lobbyId: "r" });
    await b.next();
    await a.next();

    const c = await trackedWs(port);
    await c.next();
    send(c.ws, { action: "join", name: "Charlie", lobbyId: "r" });
    await c.next();
    await a.next();
    await b.next();

    send(a.ws, { action: "ready" });
    await a.next();
    await b.next();
    await c.next();
    send(b.ws, { action: "ready" });
    await a.next();
    await b.next();
    await c.next();
    send(c.ws, { action: "ready" });
    await a.next();
    await b.next();
    await c.next();

    const s1 = await a.next();
    await b.next();
    await c.next();

    const lobby = lobbiesRef.get("r");
    lobby.game.discardPile = [{ color: "red", type: "5" }];
    lobby.players[0].hand = [{ type: "wild4" }, { color: "blue", type: "3" }];
    lobby.players[1].hand = [];
    lobby.players[2].hand = [];

    send(a.ws, { action: "play", card: { type: "wild4", color: "red" } });
    const u = await a.next();
    expect(u.action).toBe("update");
    const bob = lobby.players.find((p) => p.name === "Bob");
    expect(bob.hand).toHaveLength(4);
    expect(u.turn).toBe(2);
    a.close();
    b.close();
    c.close();
  });

  it("play draw2 reshuffles discard pile when deck is empty", async () => {
    const a = await trackedWs(port);
    await a.next();
    send(a.ws, { action: "join", name: "Alice", lobbyId: "r" });
    await a.next();

    const b = await trackedWs(port);
    await b.next();
    send(b.ws, { action: "join", name: "Bob", lobbyId: "r" });
    await b.next();
    await a.next();

    send(a.ws, { action: "ready" });
    await a.next();
    await b.next();
    send(b.ws, { action: "ready" });
    await a.next();
    await b.next();
    await a.next();
    await b.next();

    const lobby = lobbiesRef.get("r");
    lobby.game.discardPile = [
      { color: "red", type: "5" },
      { color: "blue", type: "3" },
      { color: "yellow", type: "skip" },
    ];
    lobby.game.deck = [];
    lobby.players[0].hand = [
      { color: "red", type: "draw2" },
      { color: "green", type: "7" },
    ];
    lobby.players[1].hand = [];

    send(a.ws, { action: "play", card: { color: "red", type: "draw2" } });
    const u = await a.next();
    expect(u.action).toBe("update");
    const bob = lobby.players.find((p) => p.name === "Bob");
    expect(bob.hand).toHaveLength(2);
    expect(lobby.game.deck.length).toBeGreaterThan(0);
    a.close();
    b.close();
  });

  it("play draw2 with 2 players returns turn to the same player", async () => {
    const a = await trackedWs(port);
    await a.next();
    send(a.ws, { action: "join", name: "Alice", lobbyId: "r" });
    await a.next();

    const b = await trackedWs(port);
    await b.next();
    send(b.ws, { action: "join", name: "Bob", lobbyId: "r" });
    await b.next();
    await a.next();

    send(a.ws, { action: "ready" });
    await a.next();
    await b.next();
    send(b.ws, { action: "ready" });
    await a.next();
    await b.next();
    await a.next();
    await b.next();

    const lobby = lobbiesRef.get("r");
    lobby.game.discardPile = [{ color: "red", type: "5" }];
    lobby.players[0].hand = [
      { color: "red", type: "draw2" },
      { color: "blue", type: "3" },
    ];
    lobby.players[1].hand = [];

    send(a.ws, { action: "play", card: { color: "red", type: "draw2" } });
    const u = await a.next();
    expect(u.action).toBe("update");
    expect(u.turn).toBe(0);
    const bob = lobby.players.find((p) => p.name === "Bob");
    expect(bob.hand).toHaveLength(2);
    a.close();
    b.close();
  });

  it("reconnect then ready works in lobby", async () => {
    const a = await trackedWs(port);
    await a.next();
    send(a.ws, { action: "join", name: "Alice", lobbyId: "r" });
    await a.next();

    const b = await trackedWs(port);
    await b.next();
    send(b.ws, { action: "join", name: "Bob", lobbyId: "r" });
    await b.next();
    await a.next();

    // Save player info before disconnect
    const lobby = lobbiesRef.get("r");
    const aliceId = lobby.players[0].id;
    const bobId = lobby.players[1].id;

    // Disconnect Alice
    a.close();
    // Wait for server to process the close event
    await new Promise((r) => setTimeout(r, 50));
    expect(lobby.players[0].disconnected).toBe(true);

    // New connection simulating auto-reconnect
    const a2 = await trackedWs(port);
    const initMsg = await a2.next();
    expect(initMsg.action).toBe("init");

    // Send rejoin
    send(a2.ws, { action: "reconnect", playerId: aliceId });
    const rejoinResp = await a2.next();
    expect(rejoinResp.action).toMatch(/^(init|players)$/);
    // If init, consume players from broadcastPlayers + direct ws.send
    if (rejoinResp.action === "init") {
      const p1 = await a2.next();
      expect(p1.action).toBe("players");
      const p2 = await a2.next();
      expect(p2.action).toBe("players");
    }

    // Now ready should work
    send(a2.ws, { action: "ready" });
    const readyResp = await a2.next();
    expect(readyResp.action).toBe("players");
    const aliceInLobby = readyResp.players.find((p) => p.id === aliceId);
    expect(aliceInLobby).toBeDefined();
    expect(aliceInLobby.ready).toBe(true);
    a2.close();
    b.close();
  });

  it("rejoin with fresh connection then ready succeeds", async () => {
    const a = await trackedWs(port);
    await a.next();
    send(a.ws, { action: "join", name: "Alice", lobbyId: "r" });
    await a.next();

    const b = await trackedWs(port);
    await b.next();
    send(b.ws, { action: "join", name: "Bob", lobbyId: "r" });
    await b.next();
    await a.next();

    const lobby = lobbiesRef.get("r");
    const aliceId = lobby.players[0].id;

    // Close both to simulate page refresh
    a.close();
    b.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(lobby.players[0].disconnected).toBe(true);

    // Fresh connection simulating page reload
    const a2 = await trackedWs(port);
    const initMsg = await a2.next();
    expect(initMsg.action).toBe("init");

    // Rejoin
    send(a2.ws, { action: "reconnect", playerId: aliceId });
    const rejoinResp = await a2.next();
    expect(rejoinResp.action).toMatch(/^(init|players)$/);
    if (rejoinResp.action === "init") {
      const p1 = await a2.next();
      expect(p1.action).toBe("players");
      const p2 = await a2.next();
      expect(p2.action).toBe("players");
    }

    // Also reconnect Bob
    const b2 = await trackedWs(port);
    await b2.next();
    send(b2.ws, { action: "reconnect", playerId: lobby.players[1].id });
    const bRejoin = await b2.next();
    expect(bRejoin.action).toMatch(/^(init|players)$/);
    if (bRejoin.action === "init") {
      await b2.next();
      await b2.next();
    }
    // Consume the broadcastPlayers from Bob's rejoin that was sent to all clients
    await a2.next();

    // Alice sends ready
    send(a2.ws, { action: "ready" });
    const readyResp = await a2.next();
    expect(readyResp.action).toBe("players");
    const aliceInLobby = readyResp.players.find((p) => p.id === aliceId);
    expect(aliceInLobby).toBeDefined();
    expect(aliceInLobby.ready).toBe(true);
    a2.close();
    b2.close();
  });

  it("reconnect with no session returns reconnectLost flag", async () => {
    const a = await trackedWs(port);
    await a.next();
    send(a.ws, { action: "join", name: "Alice", lobbyId: "r" });
    await a.next();
    const lobby = lobbiesRef.get("r");
    const aliceId = lobby.players[0].id;

    a.close();
    await new Promise((r) => setTimeout(r, 50));

    // New connection, reconnect with invalid UUID
    const a2 = await trackedWs(port);
    await a2.next();
    send(a2.ws, { action: "reconnect", playerId: "non-existent-uuid" });
    const msg = await a2.next();
    expect(msg.action).toBe("init");
    expect(msg.reconnectLost).toBe(true);
    expect(msg.id).not.toBe("non-existent-uuid");
    a2.close();
  });

  it("reconnect with dead lobby returns reconnectLost flag", async () => {
    const a = await trackedWs(port);
    await a.next();
    send(a.ws, { action: "join", name: "Alice", lobbyId: "r" });
    await a.next();

    const lobby = lobbiesRef.get("r");
    const aliceId = lobby.players[0].id;

    // Destroy the lobby
    lobby.players.length = 0;
    lobby.game.started = false;

    a.close();
    await new Promise((r) => setTimeout(r, 50));

    const a2 = await trackedWs(port);
    await a2.next();
    send(a2.ws, { action: "reconnect", playerId: aliceId });
    const msg = await a2.next();
    expect(msg.action).toBe("init");
    expect(msg.reconnectLost).toBe(true);
    a2.close();
  });

  it("reconnect with active lobby does not set reconnectLost", async () => {
    const a = await trackedWs(port);
    await a.next();
    send(a.ws, { action: "join", name: "Alice", lobbyId: "r" });
    await a.next();

    const b = await trackedWs(port);
    await b.next();
    send(b.ws, { action: "join", name: "Bob", lobbyId: "r" });
    await b.next();
    await a.next();

    const lobby = lobbiesRef.get("r");
    const aliceId = lobby.players[0].id;

    a.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(lobby.players[0].disconnected).toBe(true);

    const a2 = await trackedWs(port);
    await a2.next();
    send(a2.ws, { action: "reconnect", playerId: aliceId });
    const msg = await a2.next();
    expect(msg.action).toBe("init");
    expect(msg.reconnectLost).toBeFalsy();
    a2.close();
    b.close();
  });

  it("ready toggles even when other player is disconnected", async () => {
    const a = await trackedWs(port);
    await a.next();
    send(a.ws, { action: "join", name: "Alice", lobbyId: "r" });
    await a.next();

    const b = await trackedWs(port);
    await b.next();
    send(b.ws, { action: "join", name: "Bob", lobbyId: "r" });
    await b.next();
    await a.next();

    const lobby = lobbiesRef.get("r");

    // Mark Bob as disconnected
    lobby.players[1].disconnected = true;

    // Alice clicks ready — should toggle, game should NOT start
    send(a.ws, { action: "ready" });
    const r1 = await a.next();
    expect(r1.action).toBe("players");
    const alice = r1.players.find((p) => p.name === "Alice");
    expect(alice.ready).toBe(true);
    // Game should not have started (only 1 active player)
    expect(lobby.game.started).toBe(false);

    // Alice clicks ready again — toggles off
    send(a.ws, { action: "ready" });
    const r2 = await a.next();
    expect(r2.action).toBe("players");
    const alice2 = r2.players.find((p) => p.name === "Alice");
    expect(alice2.ready).toBe(false);
    a.close();
    b.close();
  });

  it("game starts when both active players ready", async () => {
    const a = await trackedWs(port);
    await a.next();
    send(a.ws, { action: "join", name: "Alice", lobbyId: "r" });
    await a.next();

    const b = await trackedWs(port);
    await b.next();
    send(b.ws, { action: "join", name: "Bob", lobbyId: "r" });
    await b.next();
    await a.next();

    const lobby = lobbiesRef.get("r");

    // Both ready
    send(a.ws, { action: "ready" });
    await a.next();
    await b.next();
    send(b.ws, { action: "ready" });
    await a.next();
    await b.next();

    // Game should start
    const startMsg = await a.next();
    expect(startMsg.action).toBe("start");
    expect(lobby.game.started).toBe(true);
    a.close();
    b.close();
  });

  it("game does not start with one active and one disconnected", async () => {
    const a = await trackedWs(port);
    await a.next();
    send(a.ws, { action: "join", name: "Alice", lobbyId: "r" });
    await a.next();

    const b = await trackedWs(port);
    await b.next();
    send(b.ws, { action: "join", name: "Bob", lobbyId: "r" });
    await b.next();
    await a.next();

    const lobby = lobbiesRef.get("r");

    // Bob disconnected >> Alice readies >> game should NOT start
    lobby.players[1].disconnected = true;
    send(a.ws, { action: "ready" });
    const r1 = await a.next();
    await b.next(); // drain Bob's broadcast
    expect(r1.action).toBe("players");
    expect(lobby.game.started).toBe(false);
    expect(lobby.players[0].ready).toBe(true);

    // Bob reconnects and readies >> now both ready >> game starts
    lobby.players[1].disconnected = false;
    send(b.ws, { action: "ready" });
    const r2 = await a.next(); // players broadcast from Bob's ready
    await b.next(); // Bob's own broadcast
    expect(r2.action).toBe("players");
    expect(lobby.players[1].ready).toBe(true);

    const startMsg = await a.next();
    expect(startMsg.action).toBe("start");
    expect(lobby.game.started).toBe(true);
    a.close();
    b.close();
  });

  it("A ready stays ready after B disconnects then reconnects", async () => {
    const a = await trackedWs(port);
    await a.next();
    send(a.ws, { action: "join", name: "Alice", lobbyId: "r" });
    await a.next();

    const b = await trackedWs(port);
    await b.next();
    send(b.ws, { action: "join", name: "Bob", lobbyId: "r" });
    await b.next();
    await a.next();

    const lobby = lobbiesRef.get("r");

    // 3. B disconnects (closes tab)
    lobby.players[1].disconnected = true;
    // broadcastPlayers happens on the server when it detects close

    // 4. A clicks ready
    send(a.ws, { action: "ready" });
    const r1 = await a.next();
    const alice1 = r1.players.find((p) => p.name === "Alice");
    expect(alice1.ready).toBe(true);
    // A should stay ready — consume any extra broadcasts
    await b.next(); // drain B's broadcast

    // Wait a beat to see if anything toggles A back
    await new Promise((r) => setTimeout(r, 50));
    expect(lobby.players[0].ready).toBe(true);
    expect(lobby.game.started).toBe(false);

    // 6. B reconnects
    lobby.players[1].disconnected = false;
    // B clicks ready
    send(b.ws, { action: "ready" });
    const r2 = await a.next(); // players broadcast from B's ready
    await b.next(); // B's own broadcast
    const alice2 = r2.players.find((p) => p.name === "Alice");
    // A should still be ready
    expect(alice2.ready).toBe(true);

    // 7. Game should start
    const startMsg = await a.next();
    expect(startMsg.action).toBe("start");
    expect(lobby.game.started).toBe(true);
    a.close();
    b.close();
  });

  it("rapid ready clicks toggle twice without client guard", async () => {
    // Two rapid ready messages >> two toggles >> net off (ready=false)
    const a = await trackedWs(port);
    await a.next();
    send(a.ws, { action: "join", name: "Alice", lobbyId: "r" });
    await a.next();

    const b = await trackedWs(port);
    await b.next();
    send(b.ws, { action: "join", name: "Bob", lobbyId: "r" });
    await b.next();
    await a.next();

    send(a.ws, { action: "ready" });
    send(a.ws, { action: "ready" }); // second — client guard would block this on UI

    // Consume responses
    await a.next();
    await b.next(); // first ready broadcast
    await a.next();
    await b.next(); // second ready broadcast

    const lobby = lobbiesRef.get("r");
    expect(lobby.players[0].ready).toBe(false); // toggled on then off
    a.close();
    b.close();
  });

  it("adding AI via handler does not reset creator ready state", async () => {
    const a = await trackedWs(port);
    await a.next();
    send(a.ws, { action: "join", name: "Alice", lobbyId: "r" });
    await a.next();

    const lobby = lobbiesRef.get("r");

    // Alice readies
    send(a.ws, { action: "ready" });
    const r1 = await a.next();
    expect(r1.players.find((p) => p.name === "Alice").ready).toBe(true);

    // Add AI via server handler (uses add_ai)
    send(a.ws, { action: "add_ai" });
    const r2 = await a.next();
    expect(r2.action).toBe("players");
    // Alice should still be ready
    expect(r2.players.find((p) => p.name === "Alice").ready).toBe(true);
    // Game should not start yet
    expect(lobby.game.started).toBe(false);
    a.close();
  });

  it("add_ai does not auto-start even with AI ready=true", async () => {
    const a = await trackedWs(port);
    await a.next();
    send(a.ws, { action: "join", name: "Alice", lobbyId: "r" });
    await a.next();

    const lobby = lobbiesRef.get("r");

    // Alice readies
    send(a.ws, { action: "ready" });
    await a.next();

    // Add AI (AI starts ready=true, but add_ai doesn't call checkStartGame)
    send(a.ws, { action: "add_ai" });
    const r2 = await a.next();
    const aiPlayer = r2.players.find((p) => p.isAI);
    expect(aiPlayer).toBeDefined();
    expect(aiPlayer.ready).toBe(true);
    // Game should NOT start from add_ai alone
    expect(lobby.game.started).toBe(false);
    a.close();
  });

  it("full flow: B closes tab >> A readies (stays ready) >> B reconnects >> B readies >> game starts", async () => {
    const a = await trackedWs(port);
    await a.next();
    send(a.ws, { action: "join", name: "Alice", lobbyId: "r" });
    await a.next();

    const b = await trackedWs(port);
    await b.next();
    send(b.ws, { action: "join", name: "Bob", lobbyId: "r" });
    await b.next();
    await a.next();

    const lobby = lobbiesRef.get("r");

    // 3. B closes tab — simulate by closing WS and marking disconnected
    b.close();
    await new Promise((r) => setTimeout(r, 50));
    // Server's close handler should have set B.disconnected = true
    expect(lobby.players[1].disconnected).toBe(true);
    // Drain the broadcastPlayers from B's close event
    const drainFromClose = await a.next();
    expect(drainFromClose.action).toBe("players");

    // 4. A clicks ready
    send(a.ws, { action: "ready" });
    const r1 = await a.next();
    expect(r1.action).toBe("players");
    const aliceAfterReady = r1.players.find((p) => p.name === "Alice");
    expect(aliceAfterReady.ready).toBe(true);
    // Game should not start (only 1 active player)
    expect(lobby.game.started).toBe(false);

    // 5. A stays ready for 3 seconds
    await new Promise((r) => setTimeout(r, 100));
    expect(lobby.players[0].ready).toBe(true); // still ready
    await new Promise((r) => setTimeout(r, 100));
    expect(lobby.players[0].ready).toBe(true); // still ready

    // 6. B reconnects — new WS, sends reconnect with UUID
    const bId = lobby.players[1].id;
    const b2 = await trackedWs(port);
    await b2.next(); // init from connection handler
    send(b2.ws, { action: "reconnect", playerId: bId });

    // Consume reconnect responses
    const rejoinResp = await b2.next();
    expect(rejoinResp.action).toBe("init");
    expect(rejoinResp.id).toBe(bId);
    // Consume broadcastPlayers + direct players
    const p1 = await b2.next();
    expect(p1.action).toBe("players");
    const p2 = await b2.next();
    expect(p2.action).toBe("players");
    // A should still be ready in the broadcast
    expect(p1.players.find((p) => p.name === "Alice").ready).toBe(true);
    expect(lobby.players[1].disconnected).toBe(false);

    // 7. B clicks ready >> game starts
    send(b2.ws, { action: "ready" });
    const readyResp = await b2.next(); // B's own broadcast
    expect(readyResp.action).toBe("players");
    const bobReady = readyResp.players.find((p) => p.name === "Bob");
    expect(bobReady.ready).toBe(true);

    // Both active players ready >> game starts
    const startMsg = await b2.next();
    expect(startMsg.action).toBe("start");
    expect(lobby.game.started).toBe(true);
    a.close();
    b2.close();
  });
});
