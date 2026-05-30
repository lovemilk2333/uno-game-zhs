// Integration tests against the real (compiled) server. The unit-test suite
// in server.test.js uses an inline simulated server that does not implement
// chain-drawing, draw modes, or the turn-timeout features — those need the
// full server and are exercised here.
//
// The dev_* events used below (dev_give_card, dev_set_top, dev_set_chain,
// dev_clear_hand, dev_skip) only exist when NODE_ENV=development, which is
// what the forked server below is started with.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { fork } from "child_process";
import path from "path";
import { WebSocket } from "ws";

const PORT = 3002;

let serverProcess;

beforeAll(async () => {
  serverProcess = fork(path.resolve("./dist/server.cjs"), ["--port", String(PORT)], {
    env: { ...process.env, NODE_ENV: "development" },
    silent: true,
  });
  await new Promise((r) => setTimeout(r, 1500));
});

afterAll(() => {
  if (serverProcess) serverProcess.kill();
});

// Open a client and return a small awaitable wrapper over the WebSocket so
// tests can `await c.next('update')` for the next message of a given action,
// or `await c.next()` for any next message. Messages that don't match the
// action filter are skipped (logged but discarded) so tests don't have to
// thread broadcast ordering manually.
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
          // Drain buffered first.
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

// Boilerplate: open two clients, join+ready them into the lobby, return both.
// `drawMode` lets tests pick chain vs. direct mode before the game starts.
async function startTwoPlayerGame(lobbyId, { drawMode = "chain" } = {}) {
  const a = await openClient();
  const b = await openClient();
  await a.next("init");
  await b.next("init");
  a.send({ action: "join", name: "Alice", lobbyId });
  await a.next("players");
  b.send({ action: "join", name: "Bob", lobbyId });
  // Both peers see a refreshed players list as the lobby fills up.
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
  // ready broadcast then start
  await a.next("players");
  await b.next("players");
  const startA = await a.next("start");
  const startB = await b.next("start");
  return { a, b, startA, startB };
}

// Find which client is up next and which card from the server-supplied top
// matches that player's hand. Returns the active client + matching card or
// null.
function whoseTurn(start, a, b) {
  const turnId = start.players[start.turn].id;
  return turnId === start.id ? a : b;
}

describe("Chain-drawing rules (bug #2 / #3)", () => {
  it("skip card breaks a chain by paying the penalty (chain mode)", async () => {
    // The bug was that `skip`/`reverse` silently zeroed `drawingCount` —
    // the breaker got off scot-free. Now they must absorb the penalty.
    const { a, b, startA } = await startTwoPlayerGame("chain-skip-" + Date.now(), {});
    const turnSocket = whoseTurn(startA, a, b);
    const offSocket = turnSocket === a ? b : a;
    const top = startA.discardPile[startA.discardPile.length - 1];

    // Stage: clear the active player's hand, give them a same-color skip,
    // and force the lobby into a chain with 4 pending penalty cards.
    turnSocket.send({ action: "dev_clear_hand" });
    await turnSocket.next("update");
    turnSocket.send({
      action: "dev_give_card",
      card: { color: top.color, type: "skip" },
    });
    await turnSocket.next("update");
    turnSocket.send({ action: "dev_set_chain", count: 4 });
    const chainUpdate = await turnSocket.next("update");
    expect(chainUpdate.gameState).toBe(1);
    expect(chainUpdate.drawingCount).toBe(4);

    const handBefore = chainUpdate.hand.length;
    turnSocket.send({
      action: "play",
      card: { color: top.color, type: "skip" },
    });
    const after = await turnSocket.next("update");
    // Active player must have absorbed the chain (hand grew by 4 minus the
    // played skip card). Without the fix this would be `handBefore - 1`.
    expect(after.hand.length).toBe(handBefore - 1 + 4);
    // Chain state cleared.
    expect(after.gameState).toBe(0);
    expect(after.drawingCount).toBe(0);
    a.close();
    b.close();
  });

  it("reverse card breaks a chain by paying the penalty (chain mode)", async () => {
    const { a, b, startA } = await startTwoPlayerGame("chain-rev-" + Date.now());
    const turnSocket = whoseTurn(startA, a, b);
    const top = startA.discardPile[startA.discardPile.length - 1];
    turnSocket.send({ action: "dev_clear_hand" });
    await turnSocket.next("update");
    turnSocket.send({
      action: "dev_give_card",
      card: { color: top.color, type: "reverse" },
    });
    await turnSocket.next("update");
    turnSocket.send({ action: "dev_set_chain", count: 6 });
    const chainUpdate = await turnSocket.next("update");
    const handBefore = chainUpdate.hand.length;
    turnSocket.send({
      action: "play",
      card: { color: top.color, type: "reverse" },
    });
    const after = await turnSocket.next("update");
    expect(after.hand.length).toBe(handBefore - 1 + 6);
    expect(after.gameState).toBe(0);
    expect(after.drawingCount).toBe(0);
    a.close();
    b.close();
  });

  it("regular number card breaks chain by paying penalty (chain mode)", async () => {
    const { a, b, startA } = await startTwoPlayerGame("chain-num-" + Date.now());
    const turnSocket = whoseTurn(startA, a, b);
    const top = startA.discardPile[startA.discardPile.length - 1];
    turnSocket.send({ action: "dev_clear_hand" });
    await turnSocket.next("update");
    turnSocket.send({
      action: "dev_give_card",
      card: { color: top.color, type: "5" },
    });
    await turnSocket.next("update");
    turnSocket.send({ action: "dev_set_chain", count: 2 });
    const chainUpdate = await turnSocket.next("update");
    const handBefore = chainUpdate.hand.length;
    turnSocket.send({ action: "play", card: { color: top.color, type: "5" } });
    const after = await turnSocket.next("update");
    expect(after.hand.length).toBe(handBefore - 1 + 2);
    expect(after.gameState).toBe(0);
    a.close();
    b.close();
  });

  it("wild (no number) breaks chain by paying penalty (chain mode)", async () => {
    // Bug #2: the server already broke the chain via wild cards but the
    // CLIENT didn't show a confirm. Server-side correctness is still
    // worth covering — a wild *must* trigger penalty in chain mode.
    const { a, b, startA } = await startTwoPlayerGame("chain-wild-" + Date.now());
    const turnSocket = whoseTurn(startA, a, b);
    turnSocket.send({ action: "dev_clear_hand" });
    await turnSocket.next("update");
    turnSocket.send({ action: "dev_give_card", card: { type: "wild" } });
    await turnSocket.next("update");
    turnSocket.send({ action: "dev_set_chain", count: 4 });
    const chainUpdate = await turnSocket.next("update");
    const handBefore = chainUpdate.hand.length;
    // Wild requires a color pick; the server only verifies type for wilds.
    turnSocket.send({ action: "play", card: { color: "red", type: "wild" } });
    const after = await turnSocket.next("update");
    expect(after.hand.length).toBe(handBefore - 1 + 4);
    expect(after.gameState).toBe(0);
    a.close();
    b.close();
  });

  it("draw2 extends the chain instead of paying it (chain mode)", async () => {
    const { a, b, startA } = await startTwoPlayerGame("chain-extend-" + Date.now());
    const turnSocket = whoseTurn(startA, a, b);
    const offSocket = turnSocket === a ? b : a;
    const top = startA.discardPile[startA.discardPile.length - 1];
    turnSocket.send({ action: "dev_clear_hand" });
    await turnSocket.next("update");
    turnSocket.send({
      action: "dev_give_card",
      card: { color: top.color, type: "draw2" },
    });
    await turnSocket.next("update");
    turnSocket.send({ action: "dev_set_chain", count: 2 });
    const chainUpdate = await turnSocket.next("update");
    const handBefore = chainUpdate.hand.length;

    turnSocket.send({
      action: "play",
      card: { color: top.color, type: "draw2" },
    });
    const after = await turnSocket.next("update");
    // Chain extended, breaker not penalized: hand simply -1.
    expect(after.hand.length).toBe(handBefore - 1);
    expect(after.gameState).toBe(1);
    expect(after.drawingCount).toBe(4); // 2 + 2
    a.close();
    b.close();
  });
});

describe("Direct draw mode", () => {
  it("draw2 in direct mode immediately deals 2 to next player", async () => {
    const { a, b, startA } = await startTwoPlayerGame("direct-d2-" + Date.now(), {
      drawMode: "direct",
    });
    const turnSocket = whoseTurn(startA, a, b);
    const offSocket = turnSocket === a ? b : a;
    const top = startA.discardPile[startA.discardPile.length - 1];
    turnSocket.send({ action: "dev_clear_hand" });
    await turnSocket.next("update");
    turnSocket.send({
      action: "dev_give_card",
      card: { color: top.color, type: "draw2" },
    });
    const giveUpdate = await turnSocket.next("update");
    const offId = startA.players[(startA.turn + 1) % startA.players.length].id;
    const offCardsBefore = giveUpdate.players.find((p) => p.id === offId).cardCount;

    turnSocket.send({
      action: "play",
      card: { color: top.color, type: "draw2" },
    });
    // Listen on the player who issued the play — server fans the broadcast
    // out to everyone but the off socket's queue may already contain stale
    // updates from earlier dev_* mutations.
    const after = await turnSocket.next("update", 5000);
    const offCardsAfter = after.players.find((p) => p.id === offId).cardCount;
    expect(offCardsAfter).toBe(offCardsBefore + 2);
    // Direct mode never enters the drawing state.
    expect(after.gameState).toBe(0);
    expect(after.drawingCount).toBe(0);
    a.close();
    b.close();
  });
});

describe("Turn timeout broadcast (task #5)", () => {
  it("broadcasts a turnDeadline on the start frame", async () => {
    const { a, b, startA, startB } = await startTwoPlayerGame("timeout-deadline-" + Date.now());
    expect(typeof startA.turnDeadline).toBe("number");
    expect(typeof startB.turnDeadline).toBe("number");
    // Deadline is in the near future (within 60s of now).
    expect(startA.turnDeadline).toBeGreaterThan(Date.now());
    expect(startA.turnDeadline).toBeLessThan(Date.now() + 60_000);
    a.close();
    b.close();
  });

  it("updates the deadline on each turn change", async () => {
    const { a, b, startA } = await startTwoPlayerGame("timeout-refresh-" + Date.now());
    const turnSocket = whoseTurn(startA, a, b);
    const top = startA.discardPile[startA.discardPile.length - 1];
    turnSocket.send({
      action: "dev_give_card",
      card: { color: top.color, type: "7" },
    });
    const give = await turnSocket.next("update");
    const before = give.turnDeadline;
    // Wait briefly so the deadline math is observably different.
    await new Promise((r) => setTimeout(r, 50));
    turnSocket.send({ action: "play", card: { color: top.color, type: "7" } });
    const after = await turnSocket.next("update");
    expect(typeof after.turnDeadline).toBe("number");
    expect(after.turnDeadline).toBeGreaterThan(before);
    a.close();
    b.close();
  });

  // Security regression: a player must NOT be able to refresh / reconnect
  // mid-turn to reset the auto-draw timer. The deadline is locked to the
  // turn instance, not the live socket — a reconnect within the same
  // turn must resume the existing budget, not mint a fresh one.
  it("reconnect within the same turn does NOT reset the deadline", async () => {
    const { a, b, startA } = await startTwoPlayerGame("timeout-refresh-exploit-" + Date.now());
    const turnSocket = whoseTurn(startA, a, b);
    const turnIsA = turnSocket === a;
    const turnPlayerId = turnIsA ? startA.id : startA.players.find((p) => p.id !== startA.id).id;

    const initialDeadline = startA.turnDeadline;
    expect(typeof initialDeadline).toBe("number");

    // Wait long enough that a "naive reset" would be obvious in the
    // post-reconnect deadline (~250ms).
    await new Promise((r) => setTimeout(r, 300));

    // Disconnect the active player and immediately reconnect with the
    // same playerId — exactly what `location.reload()` triggers in the
    // browser client.
    turnSocket.close();
    await new Promise((r) => setTimeout(r, 100));

    // Re-open the WS and send `reconnect` with the saved playerId.
    const reborn = await openClient();
    await reborn.next("init");
    reborn.send({ action: "reconnect", playerId: turnPlayerId });
    // The reconnect handler emits init → players → start (game in flight).
    await reborn.next("init");
    const start2 = await reborn.next("start");

    // The deadline shipped on the post-reconnect start frame must be
    // within a tight window of the original (small clock drift from
    // setTimeout re-arm is OK; minting a fresh PLAY_TIMEOUT_MS budget
    // would put it ~PLAY_TIMEOUT_MS / 3 later).
    expect(typeof start2.turnDeadline).toBe("number");
    expect(start2.turnDeadline).toBeLessThanOrEqual(initialDeadline + 50);
    expect(start2.turnDeadline).toBeGreaterThanOrEqual(initialDeadline - 50);

    reborn.close();
    if (turnIsA) b.close();
    else a.close();
  });
});

describe("Server validates dev events (task #8)", () => {
  it("dev_toggle_turn_timer pauses and resumes the active turn timer", async () => {
    // Pause: the broadcast `update` flips `turnTimerPaused: true` and
    // the deadline stops advancing while paused. Resume: re-arms with
    // the remaining time so the user gets the time-back-when-paused.
    const { a, b, startA } = await startTwoPlayerGame("dev-pause-" + Date.now());
    const turnSocket = whoseTurn(startA, a, b);
    const initialDeadline = startA.turnDeadline;
    expect(typeof initialDeadline).toBe("number");

    // Pause.
    turnSocket.send({ action: "dev_toggle_turn_timer" });
    const pauseUpdate = await turnSocket.next("update");
    expect(pauseUpdate.turnTimerPaused).toBe(true);

    // Wait long enough that an unpaused timer's deadline would change.
    await new Promise((r) => setTimeout(r, 350));

    // Resume.
    turnSocket.send({ action: "dev_toggle_turn_timer" });
    const resumeUpdate = await turnSocket.next("update");
    expect(resumeUpdate.turnTimerPaused).toBe(false);
    // The new deadline should be roughly Date.now() + remaining (where
    // remaining was captured at pause). It must be LATER than the
    // initial deadline by approximately the time spent paused.
    expect(typeof resumeUpdate.turnDeadline).toBe("number");
    expect(resumeUpdate.turnDeadline).toBeGreaterThan(initialDeadline + 200);

    a.close();
    b.close();
  });

  it("dev_toggle_turn_timer is a no-op when there is no active timer", async () => {
    // Joining a lobby without starting a game means no timer exists.
    // The handler should bail without crashing or sending an error.
    const lobbyId = "devpauseno-" + Date.now();
    const a = await openClient();
    await a.next("init");
    a.send({ action: "join", name: "Alice", lobbyId });
    await a.next("players");
    a.send({ action: "dev_toggle_turn_timer" });
    // GAME_NOT_STARTED — handled before the timer-lookup branch.
    const err = await a.next("error");
    expect(err.action).toBe("error");
    expect(err.errorKey).toBe("GAME_NOT_STARTED");
    a.close();
  });

  it("dev_set_top before game start is rejected", async () => {
    // dev_set_top before a started game should yield a GAME_NOT_STARTED
    // error rather than silently doing anything.
    const lobbyId = "devval-" + Date.now();
    const a = await openClient();
    await a.next("init");
    a.send({ action: "join", name: "Alice", lobbyId });
    await a.next("players");
    a.send({ action: "dev_set_top", card: { color: "red", type: "0" } });
    const err = await a.next("error");
    expect(err.action).toBe("error");
    expect(err.errorKey).toBe("GAME_NOT_STARTED");
    a.close();
  });
});

describe("Lobby ID normalization", () => {
  it("case-insensitive: mixed-case lobby ids land in the same room", async () => {
    // The browser client uppercases on join, but a non-browser client (or
    // an out-of-date frontend) could send a mixed-case id. The server
    // normalizes server-side so "Room", "room", and "ROOM" all route to
    // the same lobby — otherwise users get split into "looks-like-the-same
    // lobby" rooms and can't see each other.
    const a = await openClient();
    await a.next("init");
    a.send({ action: "join", name: "Alice", lobbyId: "norm-Mixed" });
    const aPlayers = await a.next("players");
    expect(aPlayers.lobbyId).toBe("NORM-MIXED");

    const b = await openClient();
    await b.next("init");
    // B uses a different case — should land in A's room, not a fresh one.
    b.send({ action: "join", name: "Bob", lobbyId: "norm-mixed" });
    const bPlayers = await b.next("players");
    expect(bPlayers.lobbyId).toBe("NORM-MIXED");
    expect(bPlayers.players.length).toBe(2);
    a.close();
    b.close();
  });

  it("trims surrounding whitespace before matching", async () => {
    const a = await openClient();
    await a.next("init");
    a.send({ action: "join", name: "Alice", lobbyId: "WS-TEST" });
    await a.next("players");

    const b = await openClient();
    await b.next("init");
    b.send({ action: "join", name: "Bob", lobbyId: "  ws-test  " });
    const bPlayers = await b.next("players");
    expect(bPlayers.lobbyId).toBe("WS-TEST");
    expect(bPlayers.players.length).toBe(2);
    a.close();
    b.close();
  });
});

describe("All-humans-gone abort", () => {
  // When the LAST real player leaves an in-flight game without a
  // proper `leave`, the lobby used to sit there with only AI players
  // for the full RECONNECT_DEADLINE_MS (15s) before the disconnect
  // timer cleaned up. The fix schedules a short ALL_HUMANS_GONE
  // grace so the game ends quickly when nobody can supervise it.
  it("aborts an AI-only lobby a few seconds after the last human disconnects", async () => {
    const lobbyId = "allgone-" + Date.now();
    const a = await openClient();
    const b = await openClient();
    await a.next("init");
    await b.next("init");
    a.send({ action: "join", name: "Human", lobbyId });
    await a.next("players");
    b.send({ action: "join", name: "Other", lobbyId });
    await a.next("players");
    await b.next("players");
    a.send({ action: "ready" });
    await a.next("players");
    await b.next("players");
    b.send({ action: "ready" });
    await a.next("players");
    await b.next("players");
    await a.next("start");
    await b.next("start");

    // Both humans drop their sockets. No `leave` action — server has
    // to detect the all-humans-gone state on disconnect.
    a.close();
    b.close();
    // The defer-close handler waits RECONNECT_DEFER_MS (500ms) before
    // marking each player as disconnected; then the all-humans-gone
    // grace fires ~4s later. Total: well under 6s.
    await new Promise((r) => setTimeout(r, 6500));

    // No way to assert via the now-closed sockets — instead, a NEW
    // client trying to join the same lobby should NOT find the
    // started game running (lobby has been wiped).
    const c = await openClient();
    await c.next("init");
    c.send({ action: "join", name: "Fresh", lobbyId });
    const players = await c.next("players");
    // If the abort fired, the lobby was wiped and Fresh becomes the
    // creator of a brand-new lobby of the same id.
    expect(players.players.length).toBe(1);
    expect(players.players[0].name).toBe("Fresh");
    expect(players.players[0].isCreator).toBe(true);
    c.close();
  }, 15000);

  // The grace window must not abort if the human reconnects within it
  // (the common refresh-the-page case).
  it("does NOT abort when the human reconnects within the grace window", async () => {
    const lobbyId = "allgone-rec-" + Date.now();
    const a = await openClient();
    const b = await openClient();
    await a.next("init");
    await b.next("init");
    a.send({ action: "join", name: "Reconnector", lobbyId });
    await a.next("players");
    b.send({ action: "join", name: "Buddy", lobbyId });
    await a.next("players");
    await b.next("players");
    a.send({ action: "ready" });
    await a.next("players");
    await b.next("players");
    b.send({ action: "ready" });
    await a.next("players");
    await b.next("players");
    const startA = await a.next("start");
    await b.next("start");
    const reconnectorId = startA.id;

    // Both humans drop. Within the grace window, reconnect tab A.
    a.close();
    b.close();
    await new Promise((r) => setTimeout(r, 1500));

    const a2 = await openClient();
    await a2.next("init");
    a2.send({ action: "reconnect", playerId: reconnectorId });
    // First message after reconnect — could be init, then start frame.
    await a2.next("init");
    const start = await a2.next("start");
    expect(start.action).toBe("start");

    // Wait past the grace window — reconnect should have cancelled
    // the abort, so the lobby is still alive.
    await new Promise((r) => setTimeout(r, 4500));
    // A new spectator joining should see the game still in progress.
    const spec = await openClient();
    await spec.next("init");
    spec.send({ action: "join", name: "NewObserver", lobbyId });
    const msg = await spec.next();
    expect(msg.action).toMatch(/^(spectate_offer|error)$/);
    a2.close();
    spec.close();
  }, 20000);
});
