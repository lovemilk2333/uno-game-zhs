import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { WebSocket } from "ws";
import { startServer, stopServer } from "./helpers.js";

const PORT = 3020;

beforeAll(async () => {
  await startServer(PORT);
}, 20000);

afterAll(() => {
  stopServer();
});

async function openClient() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const buffer = [];
    const waiters = [];
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      buffer.push(msg);
      while (waiters.length && buffer.length) {
        const w = waiters[0];
        const idx = w.action ? buffer.findIndex((m) => m.action === w.action) : 0;
        if (idx === -1) break;
        const found = buffer.splice(idx, 1)[0];
        waiters.shift();
        clearTimeout(w.timer);
        w.resolve(found);
      }
    });
    ws.on("open", () => {
      const next = (action, timeoutMs = 5000) => {
        return new Promise((res, rej) => {
          if (buffer.length) {
            const idx = action ? buffer.findIndex((m) => m.action === action) : 0;
            if (idx !== -1) {
              const found = buffer.splice(idx, 1)[0];
              return res(found);
            }
          }
          const w = { action, resolve: res, reject: rej, timer: null };
          w.timer = setTimeout(() => {
            const i = waiters.indexOf(w);
            if (i !== -1) waiters.splice(i, 1);
            rej(new Error(`timeout waiting for ${action || "any"}`));
          }, timeoutMs);
          waiters.push(w);
        });
      };
      const send = (msg) => ws.send(JSON.stringify(msg));
      const drain = () => buffer.splice(0, buffer.length);
      resolve({ ws, next, send, drain, close: () => ws.close() });
    });
    ws.on("error", reject);
  });
}

async function startTwoPlayerGame(lobbyId, { drawMode = "chain" } = {}) {
  const a = await openClient();
  const b = await openClient();
  await a.next("init");
  await b.next("init");
  a.send({ action: "join", name: "Alice", lobbyId });
  await a.next("players");
  b.send({ action: "join", name: "Bob", lobbyId });
  await a.next("players");
  await b.next("players");
  if (drawMode !== "chain") {
    a.send({ action: "set_draw_mode", mode: drawMode });
    await a.next("players");
    await b.next("players");
  }
  a.send({ action: "ready" });
  await a.next("players");
  await b.next("players");
  b.send({ action: "ready" });
  await a.next("players");
  await b.next("players");
  const startA = await a.next("start");
  const startB = await b.next("start");
  return { a, b, startA, startB };
}

function whoseTurn(start, a, b) {
  const turnId = start.players[start.turn].id;
  return turnId === start.id ? a : b;
}

async function giveCardAndSync(client, card, otherClient) {
  client.send({ action: "dev_give_card", card });
  await client.next("update");
  await otherClient.next("update");
}

async function playAndSync(turnSocket, card, offSocket) {
  turnSocket.send({ action: "play", card });
  const offUpdate = await offSocket.next("update");
  const turnUpdate = await turnSocket.next("update");
  return { offUpdate, turnUpdate };
}

describe("TODO #6: draw1 and draw3 cards", { timeout: 30000 }, () => {
  it("draw1 card adds 1 card in direct mode", async () => {
    const { a, b, startA, startB } = await startTwoPlayerGame("d1-direct-" + Date.now(), { drawMode: "direct" });
    const turnSocket = whoseTurn(startA, a, b);
    const offSocket = turnSocket === a ? b : a;
    const turnStart = turnSocket === a ? startA : startB;
    const topCard = turnStart.discardPile[turnStart.discardPile.length - 1];
    const topColor = topCard.color;
    const offName = turnSocket === a ? "Bob" : "Alice";
    const offBefore = turnStart.players.find((p) => p.name === offName).cardCount;

    await giveCardAndSync(turnSocket, { color: topColor, type: "draw1" }, offSocket);
    const { offUpdate } = await playAndSync(turnSocket, { color: topColor, type: "draw1" }, offSocket);
    const offAfter = offUpdate.players.find((p) => p.name === offName).cardCount;
    expect(offAfter - offBefore).toBe(1);

    a.close();
    b.close();
  });

  it("draw3 card adds 3 cards in direct mode", async () => {
    const { a, b, startA, startB } = await startTwoPlayerGame("d3-direct-" + Date.now(), { drawMode: "direct" });
    const turnSocket = whoseTurn(startA, a, b);
    const offSocket = turnSocket === a ? b : a;
    const turnStart = turnSocket === a ? startA : startB;
    const topCard = turnStart.discardPile[turnStart.discardPile.length - 1];
    const topColor = topCard.color;
    const offName = turnSocket === a ? "Bob" : "Alice";
    const offBefore = turnStart.players.find((p) => p.name === offName).cardCount;

    await giveCardAndSync(turnSocket, { color: topColor, type: "draw3" }, offSocket);
    const { offUpdate } = await playAndSync(turnSocket, { color: topColor, type: "draw3" }, offSocket);
    const offAfter = offUpdate.players.find((p) => p.name === offName).cardCount;
    expect(offAfter - offBefore).toBe(3);

    a.close();
    b.close();
  });

  it("draw1 stacks with draw2 in chain mode", async () => {
    const { a, b, startA, startB } = await startTwoPlayerGame("d1-chain-" + Date.now());
    const turnSocket = whoseTurn(startA, a, b);
    const offSocket = turnSocket === a ? b : a;
    const turnStart = turnSocket === a ? startA : startB;
    const topCard = turnStart.discardPile[turnStart.discardPile.length - 1];
    const topColor = topCard.color;

    await giveCardAndSync(turnSocket, { color: topColor, type: "draw1" }, offSocket);
    const { offUpdate: afterDraw1Off } = await playAndSync(turnSocket, { color: topColor, type: "draw1" }, offSocket);
    expect(afterDraw1Off.drawingCount).toBe(1);

    await giveCardAndSync(offSocket, { color: topColor, type: "draw2" }, turnSocket);
    const { turnUpdate: afterDraw2Turn } = await playAndSync(offSocket, { color: topColor, type: "draw2" }, turnSocket);
    expect(afterDraw2Turn.drawingCount).toBe(3);

    a.close();
    b.close();
  });

  it("draw3 stacks with draw2 in chain mode", async () => {
    const { a, b, startA, startB } = await startTwoPlayerGame("d3-chain-" + Date.now());
    const turnSocket = whoseTurn(startA, a, b);
    const offSocket = turnSocket === a ? b : a;
    const turnStart = turnSocket === a ? startA : startB;
    const topCard = turnStart.discardPile[turnStart.discardPile.length - 1];
    const topColor = topCard.color;

    await giveCardAndSync(turnSocket, { color: topColor, type: "draw3" }, offSocket);
    const { offUpdate: afterDraw3Off } = await playAndSync(turnSocket, { color: topColor, type: "draw3" }, offSocket);
    expect(afterDraw3Off.drawingCount).toBe(3);

    await giveCardAndSync(offSocket, { color: topColor, type: "draw2" }, turnSocket);
    const { turnUpdate: afterDraw2Turn } = await playAndSync(offSocket, { color: topColor, type: "draw2" }, turnSocket);
    expect(afterDraw2Turn.drawingCount).toBe(5);

    a.close();
    b.close();
  });

  it("draw1 is playable on draw3 (N-card cross-play)", async () => {
    const { a, b, startA, startB } = await startTwoPlayerGame("d1x3-" + Date.now());
    const turnSocket = whoseTurn(startA, a, b);
    const offSocket = turnSocket === a ? b : a;
    const turnStart = turnSocket === a ? startA : startB;
    const topCard = turnStart.discardPile[turnStart.discardPile.length - 1];
    const topColor = topCard.color;

    await giveCardAndSync(turnSocket, { color: topColor, type: "draw3" }, offSocket);
    const { offUpdate: afterDraw3Off } = await playAndSync(turnSocket, { color: topColor, type: "draw3" }, offSocket);
    expect(afterDraw3Off.drawingCount).toBe(3);

    await giveCardAndSync(offSocket, { type: "draw1", color: topColor }, turnSocket);
    const { turnUpdate: afterDraw1Turn } = await playAndSync(offSocket, { type: "draw1", color: topColor }, turnSocket);
    expect(afterDraw1Turn.drawingCount).toBe(4);

    a.close();
    b.close();
  });
});

describe("TODO #7: reshuffle card", { timeout: 30000 }, () => {
  it("reshuffle card replaces hand with same count", async () => {
    const { a, b, startA, startB } = await startTwoPlayerGame("reshuffle-" + Date.now());
    const turnSocket = whoseTurn(startA, a, b);
    const offSocket = turnSocket === a ? b : a;
    const turnStart = turnSocket === a ? startA : startB;
    const topCard = turnStart.discardPile[turnStart.discardPile.length - 1];
    const topColor = topCard.color;
    const beforeCount = turnStart.hand.length;

    turnSocket.send({ action: "dev_give_card", card: { color: topColor, type: "reshuffle" } });
    await turnSocket.next("update");
    await offSocket.next("update");

    turnSocket.send({ action: "play", card: { color: topColor, type: "reshuffle" } });
    const turnUpdate = await turnSocket.next("update");
    await offSocket.next("update");

    expect(turnUpdate.hand.length).toBe(beforeCount);
    const reshuffleInPile = turnUpdate.discardPile.some((c) => c.type === "reshuffle");
    expect(reshuffleInPile).toBe(true);

    a.close();
    b.close();
  });

  it("reshuffle card breaks chain with penalty", async () => {
    const { a, b, startA, startB } = await startTwoPlayerGame("reshuffle-chain-" + Date.now());
    const turnSocket = whoseTurn(startA, a, b);
    const offSocket = turnSocket === a ? b : a;
    const turnStart = turnSocket === a ? startA : startB;
    const topCard = turnStart.discardPile[turnStart.discardPile.length - 1];
    const topColor = topCard.color;

    turnSocket.send({ action: "dev_give_card", card: { color: topColor, type: "draw2" } });
    await turnSocket.next("update");
    await offSocket.next("update");

    turnSocket.send({ action: "play", card: { color: topColor, type: "draw2" } });
    const afterDraw2 = await offSocket.next("update");
    await turnSocket.next("update");
    expect(afterDraw2.drawingCount).toBe(2);

    offSocket.send({ action: "dev_give_card", card: { color: topColor, type: "reshuffle" } });
    await offSocket.next("update");
    await turnSocket.next("update");

    const beforeCount = afterDraw2.players.find((p) => p.name === (turnSocket === a ? "Bob" : "Alice")).cardCount;
    offSocket.send({ action: "play", card: { color: topColor, type: "reshuffle" } });
    const turnUpdate = await turnSocket.next("update");
    await offSocket.next("update");

    expect(turnUpdate.drawingCount).toBe(0);
    expect(turnUpdate.gameState).toBe(0);

    a.close();
    b.close();
  });
});
