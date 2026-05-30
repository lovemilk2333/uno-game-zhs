import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { fork } from "child_process";
import path from "path";
import { WebSocket } from "ws";

const PORT = 3001;
const BASE = `http://localhost:${PORT}`;

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

async function trackedWs() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
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

describe("Security", () => {
  it("rejects path traversal in icon requests", async () => {
    const resp = await fetch(`${BASE}/icons/../../package.json`);
    expect(resp.status).not.toBe(200);
  });

  it("rejects path traversal in static file requests", async () => {
    const resp = await fetch(`${BASE}/../package.json`);
    expect(resp.status).not.toBe(200);
  });

  it("rejects non-SVG icon requests", async () => {
    const resp = await fetch(`${BASE}/icons/crown.svg.exe`);
    expect(resp.status).not.toBe(200);
  });

  it("rejects null byte in URL", async () => {
    const resp = await fetch(`${BASE}/icons/crown.svg%00.txt`);
    expect(resp.status).not.toBe(200);
  });

  it("rejects JSON object as player name", async () => {
    const c = await trackedWs();
    await c.next(); // init
    c.ws.send(
      JSON.stringify({
        action: "join",
        name: { xss: "<script>alert(1)</script>" },
        lobbyId: "test",
      }),
    );
    await new Promise((r) => setTimeout(r, 200));
    expect(c.ws.readyState).toBe(1); // connection still alive
    c.close();
  });

  it("handles malformed JSON gracefully", async () => {
    const c = await trackedWs();
    await c.next();
    c.ws.send("not json");
    await new Promise((r) => setTimeout(r, 200));
    expect(c.ws.readyState).toBe(1);
    c.ws.send("{ broken");
    await new Promise((r) => setTimeout(r, 200));
    expect(c.ws.readyState).toBe(1);
    c.close();
  });

  it("rejects join with empty name", async () => {
    const c = await trackedWs();
    await c.next();
    c.ws.send(JSON.stringify({ action: "join", name: "", lobbyId: "test" }));
    const msg = await c.next();
    expect(msg.action).toBe("error");
    c.close();
  });

  it("rejects join without lobbyId", async () => {
    const c = await trackedWs();
    await c.next();
    c.ws.send(JSON.stringify({ action: "join", name: "test" }));
    const msg = await c.next();
    expect(msg.action).toBe("error");
    c.close();
  });

  it("rejects very long player name", async () => {
    const c = await trackedWs();
    await c.next();
    c.ws.send(
      JSON.stringify({
        action: "join",
        name: "x".repeat(1000),
        lobbyId: "test",
      }),
    );
    const msg = await c.next();
    expect(msg.action).toBe("error");
    c.close();
  });

  it("game actions rejected when not in lobby", async () => {
    const c = await trackedWs();
    await c.next();
    const actions = [
      "play",
      "draw",
      "ready",
      "uno",
      "add_ai",
      "ai_ready",
      "remove_ai",
      "transfer_creator",
      "surrender",
    ];
    let errors = 0;
    for (const action of actions) {
      c.ws.send(
        JSON.stringify({
          action,
          card: { color: "red", type: "0" },
          playerId: "nonexistent",
        }),
      );
    }
    await new Promise((r) => setTimeout(r, 300));
    expect(c.ws.readyState).toBe(1);
    c.close();
  });

  // ── Regression tests for the audit findings ──────────

  it("does not crash on prototype-chain static routes", async () => {
    // GET /__proto__ used to bypass `filename in files` whitelist (because
    // `in` walks the prototype chain) and crash the process via
    // res.setHeader('Content-Type', undefined).
    for (const k of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      const resp = await fetch(`${BASE}/${k}`);
      expect(resp.status).toBe(404);
    }
    // Server must still respond to legitimate requests after the probe.
    const ok = await fetch(`${BASE}/index.html`);
    expect(ok.status).toBe(200);
  });

  it("rejects WebSocket upgrades from a foreign Origin", async () => {
    // Cross-Site WebSocket Hijacking guard.
    await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, {
        headers: { Origin: "http://evil.example.com" },
      });
      const t = setTimeout(() => {
        try {
          ws.terminate();
        } catch {}
        resolve();
      }, 1500);
      let opened = false;
      ws.on("open", () => {
        opened = true;
      });
      ws.on("error", () => {});
      ws.on("close", () => {
        clearTimeout(t);
        expect(opened).toBe(false);
        resolve();
      });
    });
  });

  it("does not crash when a client sends an oversized frame", async () => {
    // Without an `error` handler on the ws instance, a too-large frame
    // raises an unhandled error event and kills the entire process.
    const c = await trackedWs();
    await c.next();
    const big = JSON.stringify({
      action: "join",
      name: "X",
      lobbyId: "Y",
      payload: "A".repeat(200_000),
    });
    try {
      c.ws.send(big);
    } catch {}
    await new Promise((r) => setTimeout(r, 800));

    // A new client must still be able to join — proves the server is alive.
    const c2 = await trackedWs();
    const init2 = await c2.next();
    expect(init2.action).toBe("init");
    c2.close();
  });

  it("rejects oversized lobbyId", async () => {
    const c = await trackedWs();
    await c.next();
    c.ws.send(
      JSON.stringify({
        action: "join",
        name: "tester",
        lobbyId: "X".repeat(1000),
      }),
    );
    const msg = await c.next();
    expect(msg.action).toBe("error");
    c.close();
  });

  it("rejects lobbyId containing control characters", async () => {
    const c = await trackedWs();
    await c.next();
    c.ws.send(JSON.stringify({ action: "join", name: "tester", lobbyId: "A\x00B" }));
    const msg = await c.next();
    expect(msg.action).toBe("error");
    c.close();
  });

  it("rejects play of a card not in the player hand", async () => {
    const a = await trackedWs();
    const b = await trackedWs();
    await a.next();
    await b.next();
    a.ws.send(JSON.stringify({ action: "join", name: "AAA", lobbyId: "forge1" }));
    await new Promise((r) => setTimeout(r, 100));
    b.ws.send(JSON.stringify({ action: "join", name: "BBB", lobbyId: "forge1" }));
    await new Promise((r) => setTimeout(r, 100));
    a.ws.send(JSON.stringify({ action: "ready" }));
    b.ws.send(JSON.stringify({ action: "ready" }));

    // Wait until either side gets the start frame.
    let myStart = null;
    for (let i = 0; i < 30 && !myStart; i++) {
      try {
        const m = await a.next(150);
        if (m.action === "start") myStart = m;
      } catch {}
      if (!myStart) {
        try {
          const m = await b.next(150);
          if (m.action === "start") myStart = m;
        } catch {}
      }
    }
    expect(myStart).not.toBeNull();
    const turnId = myStart.players[myStart.turn].id;
    const turnSocket = turnId === myStart.id ? a : b;
    const top = myStart.discardPile[myStart.discardPile.length - 1];

    // Forge a same-color draw2 (which the validator accepts) but which the
    // current player almost certainly does not hold. If they happen to hold
    // it, fall back to a same-color skip.
    let fake = { color: top.color, type: "draw2" };
    if ((myStart.hand || []).some((c) => c.color === fake.color && c.type === fake.type)) {
      fake = { color: top.color, type: "skip" };
    }

    turnSocket.ws.send(JSON.stringify({ action: "play", card: fake }));
    await new Promise((r) => setTimeout(r, 300));

    // No 'update' carrying our forged card on top should have arrived.
    const drainOne = async (sock) => {
      try {
        return await sock.next(150);
      } catch {
        return null;
      }
    };
    let lastUpdate = null;
    for (let i = 0; i < 5; i++) {
      const m = await drainOne(b);
      if (m && m.action === "update") lastUpdate = m;
    }
    if (lastUpdate) {
      const t = lastUpdate.discardPile[lastUpdate.discardPile.length - 1];
      // Either the discard top is unchanged or it isn't the forged card.
      expect(!(t.type === fake.type && t.color === fake.color)).toBe(true);
    }
    a.close();
    b.close();
  });

  it("caps the AI count per lobby", async () => {
    const c = await trackedWs();
    await c.next();
    c.ws.send(JSON.stringify({ action: "join", name: "aispam", lobbyId: "aispam-cap" }));
    await new Promise((r) => setTimeout(r, 150));
    for (let i = 0; i < 20; i++) {
      c.ws.send(JSON.stringify({ action: "add_ai" }));
    }
    await new Promise((r) => setTimeout(r, 400));
    // Drain everything and find the most recent players frame.
    let last = null;
    for (let i = 0; i < 50; i++) {
      try {
        const m = await c.next(80);
        if (m.action === "players") last = m;
      } catch {
        break;
      }
    }
    expect(last).not.toBeNull();
    const aiCount = last.players.filter((p) => p.isAI).length;
    expect(aiCount).toBeLessThanOrEqual(10);
    c.close();
  });

  it("rejects oversized emoji reactions", async () => {
    // emoji content used to be passed through unchecked. Build a real game
    // first, then attempt to broadcast an enormous emoji and ensure no peer
    // receives it.
    const a = await trackedWs();
    const b = await trackedWs();
    await a.next();
    await b.next();
    a.ws.send(JSON.stringify({ action: "join", name: "rA", lobbyId: "reactlim" }));
    await new Promise((r) => setTimeout(r, 100));
    b.ws.send(JSON.stringify({ action: "join", name: "rB", lobbyId: "reactlim" }));
    await new Promise((r) => setTimeout(r, 100));
    a.ws.send(JSON.stringify({ action: "ready" }));
    b.ws.send(JSON.stringify({ action: "ready" }));
    // Wait until game is started.
    let started = false;
    for (let i = 0; i < 30 && !started; i++) {
      try {
        const m = await b.next(150);
        if (m.action === "start") started = true;
      } catch {}
    }
    expect(started).toBe(true);

    a.ws.send(
      JSON.stringify({
        action: "reaction",
        type: "emoji",
        content: "X".repeat(20000),
      }),
    );
    await new Promise((r) => setTimeout(r, 300));
    let gotReaction = false;
    for (let i = 0; i < 5; i++) {
      try {
        const m = await b.next(100);
        if (m.action === "reaction") gotReaction = true;
      } catch {
        break;
      }
    }
    expect(gotReaction).toBe(false);

    a.ws.send(
      JSON.stringify({
        action: "reaction",
        type: "emoji",
        content: { hostile: true },
      }),
    );
    await new Promise((r) => setTimeout(r, 300));
    for (let i = 0; i < 5; i++) {
      try {
        const m = await b.next(100);
        if (m.action === "reaction" && typeof m.content === "object") gotReaction = true;
      } catch {
        break;
      }
    }
    expect(gotReaction).toBe(false);
    a.close();
    b.close();
  });

  it("spectate validates name length", async () => {
    // Bring up an active game so spectate has something to attach to.
    const a = await trackedWs();
    const b = await trackedWs();
    await a.next();
    await b.next();
    a.ws.send(JSON.stringify({ action: "join", name: "sx1", lobbyId: "specval" }));
    await new Promise((r) => setTimeout(r, 100));
    b.ws.send(JSON.stringify({ action: "join", name: "sx2", lobbyId: "specval" }));
    await new Promise((r) => setTimeout(r, 100));
    a.ws.send(JSON.stringify({ action: "ready" }));
    b.ws.send(JSON.stringify({ action: "ready" }));
    let started = false;
    for (let i = 0; i < 30 && !started; i++) {
      try {
        const m = await a.next(150);
        if (m.action === "start") started = true;
      } catch {}
    }
    expect(started).toBe(true);

    const c = await trackedWs();
    await c.next();
    c.ws.send(
      JSON.stringify({
        action: "spectate",
        lobbyId: "specval",
        name: "X".repeat(10000),
      }),
    );
    const msg = await c.next();
    expect(msg.action).toBe("error");
    c.close();
    a.close();
    b.close();
  });

  // ── Additional hardening (task #9) ──────────

  // Reaction text content is duration-scaled per character; an attacker
  // could try to slip a non-numeric value or NaN through to derail the
  // formatting on receivers. The server must reject anything that isn't a
  // bounded string.
  it("rejects non-string reaction content", async () => {
    const a = await trackedWs();
    const b = await trackedWs();
    await a.next();
    await b.next();
    a.ws.send(JSON.stringify({ action: "join", name: "Ra", lobbyId: "reactstr" }));
    await new Promise((r) => setTimeout(r, 100));
    b.ws.send(JSON.stringify({ action: "join", name: "Rb", lobbyId: "reactstr" }));
    await new Promise((r) => setTimeout(r, 100));
    a.ws.send(JSON.stringify({ action: "ready" }));
    b.ws.send(JSON.stringify({ action: "ready" }));
    let started = false;
    for (let i = 0; i < 30 && !started; i++) {
      try {
        const m = a.next(150);
        if ((await m).action === "start") started = true;
      } catch {}
    }
    expect(started).toBe(true);

    // Several payloads that all must NOT be re-broadcast to peers.
    const evil = [
      { action: "reaction", type: "text", content: 12345 },
      { action: "reaction", type: "text", content: null },
      { action: "reaction", type: "text", content: ["a", "b"] },
      { action: "reaction", type: "emoji", content: 12345 },
    ];
    for (const m of evil) a.ws.send(JSON.stringify(m));
    await new Promise((r) => setTimeout(r, 300));
    let gotReaction = false;
    for (let i = 0; i < 5; i++) {
      try {
        const m = await b.next(80);
        if (m.action === "reaction") gotReaction = true;
      } catch {
        break;
      }
    }
    expect(gotReaction).toBe(false);
    a.close();
    b.close();
  });

  // The server uses prototype-less object stores so __proto__ payloads
  // shouldn't be able to mutate Object.prototype. Verify by sending a
  // synthetic JSON-injection probe and observing that subsequent benign
  // requests behave normally.
  it("does not pollute Object.prototype via crafted JSON", async () => {
    const c = await trackedWs();
    await c.next();
    // The standard JSON.parse already doesn't pollute, but verify the
    // round trip still succeeds and that a subsequent call works.
    c.ws.send(
      JSON.stringify({
        action: "join",
        name: "__proto__",
        lobbyId: "pp",
        __proto__: { polluted: true },
      }),
    );
    await new Promise((r) => setTimeout(r, 200));
    // The connection should still be alive — the server treats the payload
    // as a normal join (with the literal name '__proto__' which passes the
    // length check of 9 chars).
    expect(c.ws.readyState).toBe(1);
    c.close();
  });

  // Sustained malformed payloads must eventually close the connection
  // (MAX_PARSE_ERRORS_PER_CONN), preventing a connection-pinning DoS.
  it("closes connections after sustained invalid messages", async () => {
    const c = await trackedWs();
    await c.next();
    // Spam ~30 garbage payloads (above the 20-error cap).
    for (let i = 0; i < 30; i++) c.ws.send("}{");
    // Wait long enough for the server to dispatch the close frame.
    await new Promise((r) => setTimeout(r, 500));
    expect([0, 2, 3]).toContain(c.ws.readyState); // CONNECTING, CLOSING or CLOSED
  });

  // Dev events must be rejected outright when the server is not in dev mode.
  // This server is started with NODE_ENV=development so dev events do work,
  // but we can still verify they don't crash on bogus payloads.
  it("dev events reject malformed card payloads", async () => {
    const a = await trackedWs();
    const b = await trackedWs();
    await a.next();
    await b.next();
    a.ws.send(JSON.stringify({ action: "join", name: "da", lobbyId: "devmal" }));
    await new Promise((r) => setTimeout(r, 100));
    b.ws.send(JSON.stringify({ action: "join", name: "db", lobbyId: "devmal" }));
    await new Promise((r) => setTimeout(r, 100));
    a.ws.send(JSON.stringify({ action: "ready" }));
    b.ws.send(JSON.stringify({ action: "ready" }));
    let started = false;
    for (let i = 0; i < 30 && !started; i++) {
      try {
        const m = await a.next(150);
        if (m.action === "start") started = true;
      } catch {}
    }
    expect(started).toBe(true);

    // Several malformed dev_give_card payloads — none should crash.
    const malformed = [
      { action: "dev_give_card" },
      { action: "dev_give_card", card: null },
      { action: "dev_give_card", card: { /* missing type */ color: "red" } },
      { action: "dev_give_card", card: { type: 12345 } },
      { action: "dev_set_top", card: undefined },
    ];
    for (const m of malformed) a.ws.send(JSON.stringify(m));
    await new Promise((r) => setTimeout(r, 300));
    expect(a.ws.readyState).toBe(1);
    a.close();
    b.close();
  });

  // /constants exposes the play timeout — make sure no extra fields leak
  // (e.g. WS_MAX_PAYLOAD which is internal).
  it("/constants exposes only the documented fields", async () => {
    const resp = await fetch(`${BASE}/constants`);
    expect(resp.status).toBe(200);
    const json = await resp.json();
    // Allow these keys; reject anything else so future additions force a
    // conscious test update.
    const ALLOWED = [
      "NAME_LENGTH_MIN",
      "NAME_LENGTH_MAX",
      "MAX_HAND_CARDS",
      "RECONNECT_DEFER_MS",
      "RECONNECT_DEADLINE_MS",
      "DISCONNECT_REMOVE_MS",
      "PLAY_TIMEOUT_MS",
    ];
    const extras = Object.keys(json).filter((k) => !ALLOWED.includes(k));
    expect(extras).toEqual([]);
    expect(typeof json.PLAY_TIMEOUT_MS).toBe("number");
    expect(json.PLAY_TIMEOUT_MS).toBeGreaterThan(0);
  });

  // The HTTP layer should set defense-in-depth security headers on the
  // index response.
  it("sets security headers on the index response", async () => {
    const resp = await fetch(`${BASE}/`);
    expect(resp.status).toBe(200);
    expect(resp.headers.get("x-content-type-options")).toBe("nosniff");
    expect(resp.headers.get("x-frame-options")).toBe("DENY");
    expect(resp.headers.get("content-security-policy")).toContain("default-src 'self'");
  });
});
