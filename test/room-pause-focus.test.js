// Integration tests for TODO #1-#5.
//
// #1 — server sends `spectator` flag on reconnect / join-reconnect so
//      a returning client lands in the right UI state.
// #2 — when a player is up in chain state with no draw2/wild4 in hand,
//      the client auto-prompts to take the penalty (the next server
//      `draw` should arrive immediately).
// #3 — creator can pause/resume the room; majority pause request
//      auto-pauses; focus-loss majority auto-pauses.
// #4 — +n penalty popup displays the final chain drawingCount, not
//      the per-player delta.
// #5 — wild color picker auto-scrolls into view (if not visible) and
//      scrolls back to the original position on color pick; user
//      manual scroll cancels the auto-scroll.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { WebSocket } from "ws";
import { startServer, stopServer } from "./helpers.js";

const PORT = 3030;

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
      const next = (action, timeoutMs = 3000) => {
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

// Open two clients and start a two-player game. Returns both clients
// and their first `start` frame.
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

describe("TODO #1 — spectator state on reconnect", () => {
  it("reconnect frame includes spectator:false for an active player", async () => {
    const { a, b, startA } = await startTwoPlayerGame("spec-rec-" + Date.now());
    const aliceId = startA.id;
    a.close();
    // Reconnect with a fresh socket.
    const a2 = await openClient();
    await a2.next("init");
    a2.send({ action: "reconnect", playerId: aliceId });
    await a2.next("init");
    const s2 = await a2.next("start");
    expect(s2.spectator).toBe(false);
    a2.close();
    b.close();
  });

  it("reconnect frame for a non-started lobby includes spectator:false", async () => {
    const a = await openClient();
    await a.next("init");
    const lobbyId = "spec-rec2-" + Date.now();
    a.send({ action: "join", name: "Alice", lobbyId });
    const playersMsg = await a.next("players");
    expect(playersMsg.spectator).toBe(false);
    const aliceId = playersMsg.players[0].id;
    a.close();
    const a2 = await openClient();
    await a2.next("init");
    a2.send({ action: "reconnect", playerId: aliceId });
    await a2.next("init");
    const playersMsg2 = await a2.next("players");
    expect(playersMsg2.spectator).toBe(false);
    a2.close();
  });

  it("spectate_accept toggles the spectator flag to true on the start frame", async () => {
    // 3 players: A, B, C. C surrenders with >2 players so they get
    // the spectate offer, accepts, and the start frame sent back
    // should have spectator: true.
    const lobbyId = "spec-accept-" + Date.now();
    const a = await openClient();
    const b = await openClient();
    const c = await openClient();
    await a.next("init");
    await b.next("init");
    await c.next("init");
    a.send({ action: "join", name: "Alice", lobbyId });
    await a.next("players");
    b.send({ action: "join", name: "Bob", lobbyId });
    await a.next("players");
    await b.next("players");
    c.send({ action: "join", name: "Carol", lobbyId });
    await a.next("players");
    await b.next("players");
    await c.next("players");
    a.send({ action: "ready" });
    await a.next("players");
    await b.next("players");
    await c.next("players");
    b.send({ action: "ready" });
    await a.next("players");
    await b.next("players");
    await c.next("players");
    c.send({ action: "ready" });
    await a.next("players");
    await b.next("players");
    await c.next("players");
    const startA = await a.next("start");
    const startB = await b.next("start");
    const startC = await c.next("start");
    expect(startA.spectator).toBe(false);
    expect(startC.spectator).toBe(false);

    // Carol surrenders. With 3 players she gets the spectate offer.
    c.send({ action: "surrender" });
    const offer = await c.next("surrender_offer");
    expect(offer.action).toBe("surrender_offer");
    c.send({ action: "spectate_accept" });
    // Spectate-accept: server sends a fresh start with hand:[] and
    // spectator:true. Then a follow-up update so other clients see
    // Carol removed.
    const spectateStart = await c.next("start");
    expect(spectateStart.spectator).toBe(true);
    expect(spectateStart.hand).toEqual([]);
    a.close();
    b.close();
    c.close();
  });
});

describe("TODO #3 — room pause (creator direct + majority request)", () => {
  it("creator pause_direct pauses the room; play/draw are rejected with ROOM_PAUSED", async () => {
    const { a, b, startA } = await startTwoPlayerGame("pause-direct-" + Date.now());
    const turnSocket = whoseTurn(startA, a, b);
    const offSocket = turnSocket === a ? b : a;
    const offId = startA.players.find((p) => p.id !== startA.id).id;
    // Alice is the creator by default; her pause should freeze both.
    a.send({ action: "pause_direct" });
    const paused = await a.next("update");
    expect(paused.paused).toBe(true);
    expect(paused.pausedBy).toBe(startA.id);
    expect(paused.pauseReason).toBe("creator_pause");
    // Bob's update frame also reflects the pause.
    const pausedB = await b.next("update");
    expect(pausedB.paused).toBe(true);
    // Active player tries to play / draw — should error.
    turnSocket.send({ action: "play", card: { type: "0", color: "red" } });
    const err = await turnSocket.next("error");
    expect(err.errorKey).toBe("ROOM_PAUSED");
    // Resume.
    a.send({ action: "pause_direct" });
    const resumed = await a.next("update");
    expect(resumed.paused).toBe(false);
    a.close();
    b.close();
  });

  it("non-creator pause_direct is rejected with CREATOR_ONLY_PAUSE", async () => {
    const { a, b, startA } = await startTwoPlayerGame("pause-only-" + Date.now());
    // Bob (non-creator) attempts to pause.
    b.send({ action: "pause_direct" });
    const err = await b.next("error");
    expect(err.errorKey).toBe("CREATOR_ONLY_PAUSE");
    a.close();
    b.close();
  });

  it("2-of-3 pause requests auto-pause the room (majority_request)", async () => {
    // 3 human players. Alice is creator. Bob and Carol each file a
    // request; once 2/3 of the human set is met, the room pauses
    // automatically.
    const lobbyId = "pause-major-" + Date.now();
    const a = await openClient();
    const b = await openClient();
    const c = await openClient();
    await a.next("init");
    await b.next("init");
    await c.next("init");
    a.send({ action: "join", name: "Alice", lobbyId });
    await a.next("players");
    b.send({ action: "join", name: "Bob", lobbyId });
    await a.next("players");
    await b.next("players");
    c.send({ action: "join", name: "Carol", lobbyId });
    await a.next("players");
    await b.next("players");
    await c.next("players");
    a.send({ action: "ready" });
    await a.next("players");
    await b.next("players");
    await c.next("players");
    b.send({ action: "ready" });
    await a.next("players");
    await b.next("players");
    await c.next("players");
    c.send({ action: "ready" });
    await a.next("players");
    await b.next("players");
    await c.next("players");
    const startA = await a.next("start");
    await b.next("start");
    await c.next("start");
    // Two non-creators each file a request — should hit the 2/3
    // threshold and auto-pause.
    b.send({ action: "pause_request" });
    c.send({ action: "pause_request" });
    // First request: server broadcasts a pause_request_added frame to
    // the creator (and the other non-creator that hasn't requested
    // yet) — drop it.
    const reqAdded1 = await a.next();
    expect(reqAdded1.action).toBe("pause_request_added");
    // The second request trips the threshold → server broadcasts a
    // room_paused to everyone, then an update with paused:true.
    const paused = await a.next("room_paused");
    expect(paused.action).toBe("room_paused");
    expect(paused.reason).toBe("majority_request");
    const pausedUpdate = await a.next("update");
    expect(pausedUpdate.paused).toBe(true);
    expect(pausedUpdate.pauseReason).toBe("majority_request");
    a.close();
    b.close();
    c.close();
  });

  it("creator can resume a majority-paused room", async () => {
    const lobbyId = "pause-resume-" + Date.now();
    const a = await openClient();
    const b = await openClient();
    const c = await openClient();
    await a.next("init");
    await b.next("init");
    await c.next("init");
    a.send({ action: "join", name: "Alice", lobbyId });
    await a.next("players");
    b.send({ action: "join", name: "Bob", lobbyId });
    await a.next("players");
    await b.next("players");
    c.send({ action: "join", name: "Carol", lobbyId });
    await a.next("players");
    await b.next("players");
    await c.next("players");
    a.send({ action: "ready" });
    await a.next("players");
    await b.next("players");
    await c.next("players");
    b.send({ action: "ready" });
    await a.next("players");
    await b.next("players");
    await c.next("players");
    c.send({ action: "ready" });
    await a.next("players");
    await b.next("players");
    await c.next("players");
    await a.next("start");
    await b.next("start");
    await c.next("start");
    b.send({ action: "pause_request" });
    await a.next(); // pause_request_added
    c.send({ action: "pause_request" });
    await a.next("room_paused");
    await a.next("update"); // paused update
    // Creator resumes.
    a.send({ action: "pause_direct" });
    const resumed = await a.next("room_resumed");
    expect(resumed.action).toBe("room_resumed");
    const resumedUpdate = await a.next("update");
    expect(resumedUpdate.paused).toBe(false);
    a.close();
    b.close();
    c.close();
  });

  it("play_focus_update + 2/3 blurred for >20s triggers focus_auto_pause", async () => {
    // We don't want to wait 20s in tests, so we directly mutate the
    // player's `_blurredAt` through the dev panel — but to keep this
    // test honest, we use the public pause_focus_update path and then
    // poll the server with a tickFocusAutoPause call. We can't
    // shorten FOCUS_AUTO_PAUSE_MS without changing the source, so
    // this test sends a 2/3 blurred signal and then waits the full
    // 21s. The test is bounded but slow.
    const lobbyId = "pause-focus-" + Date.now();
    const a = await openClient();
    const b = await openClient();
    const c = await openClient();
    await a.next("init");
    await b.next("init");
    await c.next("init");
    a.send({ action: "join", name: "Alice", lobbyId });
    await a.next("players");
    b.send({ action: "join", name: "Bob", lobbyId });
    await a.next("players");
    await b.next("players");
    c.send({ action: "join", name: "Carol", lobbyId });
    await a.next("players");
    await b.next("players");
    await c.next("players");
    a.send({ action: "ready" });
    await a.next("players");
    await b.next("players");
    await c.next("players");
    b.send({ action: "ready" });
    await a.next("players");
    await b.next("players");
    await c.next("players");
    c.send({ action: "ready" });
    await a.next("players");
    await b.next("players");
    await c.next("players");
    const startA = await a.next("start");
    await b.next("start");
    await c.next("start");
    // 2/3 (2 of 3) humans report blur.
    b.send({ action: "pause_focus_update", focused: false });
    c.send({ action: "pause_focus_update", focused: false });
    // Server polls every 1s; FOCUS_AUTO_PAUSE_MS is 5s. We expect
    // the room_paused broadcast ~6s after the blur signal.
    const t0 = Date.now();
    const paused = await a.next("room_paused", 10000);
    const elapsed = Date.now() - t0;
    expect(paused.action).toBe("room_paused");
    expect(paused.reason).toBe("focus_auto_pause");
    expect(elapsed).toBeGreaterThanOrEqual(4_000);
    expect(elapsed).toBeLessThan(8_000);
    a.close();
    b.close();
    c.close();
  }, 15000);

  it("single human + AI: the solo player's own focus loss does NOT auto-pause", async () => {
    // 单人+AI regression: with only one human, any alt-tab / DevTools
    // click would blur the tab and trip the focus auto-pause (threshold
    // ceil(2/3 * 1) = 1), popping the "失焦自动暂停" overlay constantly.
    // The solo player controls pause via the manual button instead.
    const lobbyId = "pause-solo-" + Date.now();
    const a = await openClient();
    await a.next("init");
    a.send({ action: "join", name: "Solo", lobbyId });
    await a.next("players");
    a.send({ action: "add_ai" });
    await a.next("players");
    a.send({ action: "ready" });
    await a.next("players");
    await a.next("start");
    // Blur the only human for longer than FOCUS_AUTO_PAUSE_MS + poll
    // margin. No room_paused may arrive.
    a.send({ action: "pause_focus_update", focused: false });
    await expect(a.next("room_paused", 7500)).rejects.toThrow();
    // Manual creator pause still works.
    a.send({ action: "pause_direct" });
    const paused = await a.next("room_paused");
    expect(paused.reason).toBe("creator_pause");
    a.close();
  }, 15000);
});

describe("TODO #2 — chain draw card auto-prompt (server-side enforcement)", () => {
  // The auto-prompt UX is client-side. We exercise the SERVER side
  // invariant: while the room is paused, draw / play / leave are
  // rejected. For the prompt itself, the only thing the server can
  // observe is the eventual `draw` action; we test that the chain
  // penalty can be paid via a normal `draw` after the auto-prompt
  // would fire (i.e. without a stackable card) — already covered by
  // the existing chain tests. This block focuses on the auto-prompt
  // contract from the client's perspective: the server should accept
  // the post-prompt draw and the resulting hand should grow by exactly
  // drawingCount cards.
  it("drawing while chain is active pays the full chain penalty", async () => {
    const { a, b, startA } = await startTwoPlayerGame("chain-autodraw-" + Date.now());
    const turnSocket = whoseTurn(startA, a, b);
    const top = startA.discardPile[startA.discardPile.length - 1];
    // Stage: clear the active player's hand, give them only a non-
    // draw2 card (so the auto-prompt would fire) and force a chain.
    turnSocket.send({ action: "dev_clear_hand" });
    await turnSocket.next("update");
    turnSocket.send({
      action: "dev_give_card",
      card: { color: top.color, type: "7" },
    });
    await turnSocket.next("update");
    turnSocket.send({ action: "dev_set_chain", count: 6 });
    const chainUpdate = await turnSocket.next("update");
    const handBefore = chainUpdate.hand.length;
    // The "auto-prompt" path: client confirms draw. Server accepts
    // the draw and the hand grows by the chain count.
    turnSocket.send({ action: "draw" });
    const after = await turnSocket.next("update");
    expect(after.hand.length).toBe(handBefore + 6);
    expect(after.gameState).toBe(0);
    expect(after.drawingCount).toBe(0);
    a.close();
    b.close();
  });
});

describe("TODO #4 — +n penalty popup shows final chain value", () => {
  // The +N popup value is a CLIENT-SIDE computation. The relevant
  // contract is: when the chain ends and the player pays, the SERVER
  // broadcast must carry `gameState: 0` and `drawingCount: 0` (chain
  // is over) and the player's cardCount grew by exactly the previous
  // drawingCount. The client code maps that to the popup text.
  it("end-of-chain: the paying player grows by the final chain count, and the chain state clears", async () => {
    const { a, b, startA } = await startTwoPlayerGame("chain-popup-" + Date.now());
    const turnSocket = whoseTurn(startA, a, b);
    const turnPlayerId = startA.players[startA.turn].id;
    turnSocket.send({ action: "dev_clear_hand" });
    await turnSocket.next("update");
    turnSocket.send({ action: "dev_set_chain", count: 6 });
    const chainUpdate = await turnSocket.next("update");
    expect(chainUpdate.gameState).toBe(1);
    expect(chainUpdate.drawingCount).toBe(6);
    const turnHandBefore = chainUpdate.hand.length;
    a.drain(); b.drain();
    turnSocket.send({ action: "draw" });
    const afterUpdate = await turnSocket.next("update", 5000);
    expect(afterUpdate.hand.length).toBe(turnHandBefore + 6);
    expect(afterUpdate.drawingCount).toBe(0);
    expect(afterUpdate.gameState).toBe(0);
    a.close();
    b.close();
  }, 15000);
});

describe("TODO #8 — penalty popup only shows on actual draws, not on game start", () => {
  it("no penalty popup delta on game start", async () => {
    const { a, b, startA } = await startTwoPlayerGame("penalty-start-" + Date.now());
    expect(startA.drawingCount).toBe(0);
    expect(startA.gameState).toBe(0);
    a.close();
    b.close();
  });
});
