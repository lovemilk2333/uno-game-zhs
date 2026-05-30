// Slot-allocation regression suite. The single-context tests in
// client.test.js cover the happy path; this file zeroes in on edge
// cases the user keeps hitting (wrong order on reopen, two tabs on
// the same slot, parallel restore).
//
// Each test runs against the same forked server but uses its own
// BrowserContext so localStorage / sessionStorage / BroadcastChannel
// are isolated from any prior test.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium } from "playwright";
import { fork } from "child_process";
import path from "path";

const BASE = "http://127.0.0.1:3000";

let browser, serverProcess;

beforeAll(async () => {
  serverProcess = fork(path.resolve("./dist/server.cjs"), [], {
    env: { ...process.env, NODE_ENV: "development" },
    silent: true,
  });
  serverProcess.stdout.on("data", (d) => process.stdout.write(`[server] ${d}`));
  serverProcess.stderr.on("data", (d) => process.stderr.write(`[server-err] ${d}`));
  await new Promise((r) => setTimeout(r, 1500));
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  if (browser) await browser.close();
  if (serverProcess) serverProcess.kill();
});

// Open a tab, wait until its boot has either claimed a slot OR finished
// the election timeout (whichever is first), then return a small probe
// helper. We deliberately do NOT auto-close — tests close pages
// themselves so the lifecycle stays explicit.
async function openTab(ctx) {
  const p = await ctx.newPage();
  await p.goto(BASE);
  await p.waitForFunction(() => Number(sessionStorage.getItem("unoSlot")) > 0, {
    timeout: 5000,
  });
  // Give the slotReady-driven onopen prefill a moment to land.
  await p.waitForTimeout(800);
  return p;
}

async function getSlot(p) {
  return p.evaluate(() => Number(sessionStorage.getItem("unoSlot")));
}

async function getName(p) {
  return p.locator("#name").inputValue();
}

async function typeName(p, name) {
  await p.fill("#name", name);
  await p.locator("#name").press("Tab");
}

// Wait until each tab has finished claiming a slot AND seen the others'
// heartbeats. Helpful before assertions in tests where the timing
// across many tabs matters.
async function waitForStableSlots(pages) {
  for (const p of pages) {
    await p.waitForFunction(() => Number(sessionStorage.getItem("unoSlot")) > 0, { timeout: 5000 });
  }
  // 2x heartbeat cadence so every tab has at least one heartbeat-round
  // worth of peer visibility.
  await new Promise((r) => setTimeout(r, 3500));
}

describe("Slot allocation", () => {
  // ── Baseline: typing & reading is per-tab ─────────────────

  it("three tabs each get a distinct slot", { timeout: 15000 }, async () => {
    const ctx = await browser.newContext();
    const tabs = [];
    for (let i = 0; i < 3; i++) tabs.push(await openTab(ctx));
    const slots = await Promise.all(tabs.map(getSlot));
    expect(new Set(slots).size).toBe(3);
    expect(slots.sort()).toEqual([1, 2, 3]);
    for (const p of tabs) await p.close();
    await ctx.close();
  });

  it("typed names are isolated between concurrent tabs", { timeout: 15000 }, async () => {
    const ctx = await browser.newContext();
    const a = await openTab(ctx);
    const b = await openTab(ctx);
    const c = await openTab(ctx);
    await typeName(a, "11");
    await typeName(b, "22");
    await typeName(c, "33");
    expect(await getName(a)).toBe("11");
    expect(await getName(b)).toBe("22");
    expect(await getName(c)).toBe("33");
    await a.close();
    await b.close();
    await c.close();
    await ctx.close();
  });

  // ── Sequential reopen ─────────────────────────────────────

  it("sequential close-reopen: 11/22/33 in slot order", { timeout: 30000 }, async () => {
    const ctx = await browser.newContext();
    // Round 1
    const r1 = [];
    for (const n of ["11", "22", "33"]) {
      const p = await openTab(ctx);
      await typeName(p, n);
      r1.push(p);
    }
    for (const p of r1) await p.close();
    await new Promise((r) => setTimeout(r, 4500));

    // Round 2 — sequential opens
    const r2 = [];
    for (let i = 0; i < 3; i++) r2.push(await openTab(ctx));
    const result = await Promise.all(
      r2.map(async (p) => ({
        slot: await getSlot(p),
        name: await getName(p),
      })),
    );
    expect(result).toEqual([
      { slot: 1, name: "11" },
      { slot: 2, name: "22" },
      { slot: 3, name: "33" },
    ]);
    for (const p of r2) await p.close();
    await ctx.close();
  });

  // ── Parallel reopen ───────────────────────────────────────

  it("parallel close-reopen: each slot keeps its own name", { timeout: 30000 }, async () => {
    const ctx = await browser.newContext();
    const NAMES = ["11", "22", "33"];

    // Round 1
    const r1 = [];
    for (const n of NAMES) {
      const p = await openTab(ctx);
      await typeName(p, n);
      r1.push(p);
    }
    for (const p of r1) await p.close();
    await new Promise((r) => setTimeout(r, 4500));

    // Round 2 — all three tabs navigate at the same time.
    const r2 = await Promise.all(
      NAMES.map(async () => {
        const p = await ctx.newPage();
        const navP = p.goto(BASE);
        return { p, navP };
      }),
    );
    for (const { p, navP } of r2) {
      await navP;
      await p.waitForFunction(() => Number(sessionStorage.getItem("unoSlot")) > 0, {
        timeout: 5000,
      });
    }
    await waitForStableSlots(r2.map((x) => x.p));

    const result = await Promise.all(
      r2.map(async ({ p }) => ({
        slot: await getSlot(p),
        name: await getName(p),
      })),
    );
    const bySlot = new Map(result.map((r) => [r.slot, r.name]));
    expect(bySlot.size).toBe(3);
    expect(bySlot.get(1)).toBe("11");
    expect(bySlot.get(2)).toBe("22");
    expect(bySlot.get(3)).toBe("33");
    for (const { p } of r2) await p.close();
    await ctx.close();
  });

  // ── Same-slot collision regressions ───────────────────────

  it("after the dust settles, no two tabs hold the same slot", { timeout: 60000 }, async () => {
    // Open 4 tabs in parallel many times; each round must end with 4
    // distinct slots. Without proper collision detection / preference
    // exchange the parallel boot can result in two tabs both claiming
    // slot 1.
    const ctx = await browser.newContext();
    for (let round = 0; round < 3; round++) {
      const tabs = await Promise.all(
        [0, 1, 2, 3].map(async () => {
          const p = await ctx.newPage();
          const navP = p.goto(BASE);
          return { p, navP };
        }),
      );
      for (const { p, navP } of tabs) {
        await navP;
        await p.waitForFunction(() => Number(sessionStorage.getItem("unoSlot")) > 0, {
          timeout: 5000,
        });
      }
      await waitForStableSlots(tabs.map((x) => x.p));
      const slots = await Promise.all(tabs.map(({ p }) => getSlot(p)));
      expect(new Set(slots).size).toBe(slots.length);
      for (const { p } of tabs) await p.close();
      await new Promise((r) => setTimeout(r, 4500));
    }
    await ctx.close();
  });

  it(
    "collision is resolved within a few heartbeats even in restored state",
    { timeout: 30000 },
    async () => {
      // Simulate Chrome session restore: pre-seed sessionStorage.unoSlot
      // for two pages with the same slot, then load both. The collision
      // detector must kick one of them off and re-elect, so we end up
      // with two distinct slots.
      const ctx = await browser.newContext();
      // Plant by opening a single tab first to set up localStorage and
      // figure out the expected slot 1 → name pairing, then close it.
      const seed = await openTab(ctx);
      await typeName(seed, "seed");
      await seed.close();
      await new Promise((r) => setTimeout(r, 4500));

      // Two pages, both pre-seeded to claim slot 1.
      async function makeRestoredPage(slot) {
        const p = await ctx.newPage();
        // Set sessionStorage on the origin via about:blank navigation
        // first, then navigate into the app — pre-set marker is what
        // a real session restore looks like.
        await p.goto(BASE + "/");
        await p.evaluate((s) => sessionStorage.setItem("unoSlot", String(s)), slot);
        await p.reload();
        return p;
      }

      const [a, b] = await Promise.all([1, 1].map(makeRestoredPage));
      await waitForStableSlots([a, b]);
      const slots = [await getSlot(a), await getSlot(b)];
      expect(new Set(slots).size).toBe(2);
      expect(slots).toContain(1);
      await a.close();
      await b.close();
      await ctx.close();
    },
  );

  // ── Lone-tab fallback to slot 1 ───────────────────────────

  it(
    "after closing all tabs and reopening one, it lands on slot 1",
    { timeout: 30000 },
    async () => {
      const ctx = await browser.newContext();
      const r1 = [];
      for (const n of ["", "22"]) {
        const p = await openTab(ctx);
        if (n) await typeName(p, n);
        r1.push(p);
      }
      for (const p of r1) await p.close();
      await new Promise((r) => setTimeout(r, 4500));

      const lone = await openTab(ctx);
      expect(await getSlot(lone)).toBe(1);
      expect(await getName(lone)).not.toBe("22");
      await lone.close();
      await ctx.close();
    },
  );

  // ── Open-mid-game (real F5) ───────────────────────────────

  it(
    "F5 within an active session keeps the same slot via stored identity",
    { timeout: 15000 },
    async () => {
      const ctx = await browser.newContext();
      const p = await openTab(ctx);
      await typeName(p, "F5User");
      // Plant an unoPlayerId for the slot — emulates "joined a lobby".
      const slot = await getSlot(p);
      await p.evaluate((s) => localStorage.setItem("unoPlayerId-" + s, "fake-id-1"), slot);
      // Reload — sessionStorage.unoSlot survives, unoPlayerId survives,
      // boot path should keep the slot.
      await p.reload();
      await p.waitForFunction(() => Number(sessionStorage.getItem("unoSlot")) > 0, {
        timeout: 5000,
      });
      expect(await getSlot(p)).toBe(slot);
      await p.close();
      await ctx.close();
    },
  );

  // ── Recycled-slot identity wipe ───────────────────────────

  it(
    "opening a fresh tab in a recycled slot does not inherit a saved playerId",
    { timeout: 30000 },
    async () => {
      const ctx = await browser.newContext();
      const p = await openTab(ctx);
      const s = await getSlot(p);
      // Plant a stale identity at this slot to simulate "previous tab
      // joined a lobby and crashed".
      await p.evaluate((slot) => localStorage.setItem("unoPlayerId-" + slot, "leaked-id"), s);
      await p.close();
      await new Promise((r) => setTimeout(r, 4500));

      const fresh = await openTab(ctx);
      const freshSlot = await getSlot(fresh);
      const idAt = await fresh.evaluate(
        (slot) => localStorage.getItem("unoPlayerId-" + slot),
        freshSlot,
      );
      // The new tab landed on the same slot — its election was 'elected'
      // (no peer was alive), and `claimSlot('elected')` wiped the leaked
      // id so we don't impersonate the previous occupant.
      expect(idAt).toBeNull();
      await fresh.close();
      await ctx.close();
    },
  );

  // ── Adversarial tie-breaking ──────────────────────────────

  it(
    "two parallel fresh tabs (no sessionStorage) end up on distinct slots",
    { timeout: 30000 },
    async () => {
      // The narrow race: two tabs with empty sessionStorage navigate at
      // the same time, both run `pickFreeSlot()` against an empty
      // knownSlots and both claim slot 1. The collision detector must
      // resolve this so the post-condition is "two distinct slots".
      const ctx = await browser.newContext();
      const a = await ctx.newPage();
      const b = await ctx.newPage();
      // Fire both gotos in parallel; don't await one before the other.
      await Promise.all([a.goto(BASE), b.goto(BASE)]);
      await Promise.all([
        a.waitForFunction(() => Number(sessionStorage.getItem("unoSlot")) > 0, {
          timeout: 5000,
        }),
        b.waitForFunction(() => Number(sessionStorage.getItem("unoSlot")) > 0, {
          timeout: 5000,
        }),
      ]);
      await waitForStableSlots([a, b]);
      const slots = [await getSlot(a), await getSlot(b)];
      expect(new Set(slots).size).toBe(2);
      expect(slots.includes(1)).toBe(true);
      expect(slots.includes(2)).toBe(true);
      await a.close();
      await b.close();
      await ctx.close();
    },
  );

  it("three parallel fresh tabs end up on slots 1, 2, 3", { timeout: 30000 }, async () => {
    const ctx = await browser.newContext();
    const pages = await Promise.all(
      [0, 1, 2].map(async () => {
        const p = await ctx.newPage();
        const navP = p.goto(BASE);
        return { p, navP };
      }),
    );
    for (const { p, navP } of pages) {
      await navP;
      await p.waitForFunction(() => Number(sessionStorage.getItem("unoSlot")) > 0, {
        timeout: 5000,
      });
    }
    await waitForStableSlots(pages.map((x) => x.p));
    const slots = (await Promise.all(pages.map(({ p }) => getSlot(p)))).sort();
    expect(slots).toEqual([1, 2, 3]);
    for (const { p } of pages) await p.close();
    await ctx.close();
  });

  it(
    "two parallel restored tabs with the SAME stored slot end on distinct slots",
    { timeout: 30000 },
    async () => {
      // Simulates a corrupted state: two tabs both have unoSlot=2 in
      // sessionStorage. They both think they own slot 2; without a
      // proper tiebreaker they'd both fall back to slot 1 after seeing
      // each other's `who`-reply, then collide on slot 1 too.
      const ctx = await browser.newContext();
      async function makeRestoredPage(slot) {
        const p = await ctx.newPage();
        await p.goto(BASE + "/");
        await p.evaluate((s) => sessionStorage.setItem("unoSlot", String(s)), slot);
        await p.reload();
        return p;
      }
      const [a, b] = await Promise.all([2, 2].map(makeRestoredPage));
      await Promise.all([
        a.waitForFunction(() => Number(sessionStorage.getItem("unoSlot")) > 0, {
          timeout: 5000,
        }),
        b.waitForFunction(() => Number(sessionStorage.getItem("unoSlot")) > 0, {
          timeout: 5000,
        }),
      ]);
      await waitForStableSlots([a, b]);
      const slots = [await getSlot(a), await getSlot(b)];
      expect(new Set(slots).size).toBe(2);
      await a.close();
      await b.close();
      await ctx.close();
    },
  );

  it("after STALE_MS no peer heartbeat is mistakenly kept", { timeout: 60000 }, async () => {
    // Open two tabs, close one, wait long enough that the surviving
    // tab's pruneStaleSlots evicts the closed tab. Open a fresh
    // tab — it should land on the freed slot, NOT step over the
    // surviving tab.
    const ctx = await browser.newContext();
    const a = await openTab(ctx);
    const b = await openTab(ctx);
    expect(await getSlot(a)).toBe(1);
    expect(await getSlot(b)).toBe(2);
    // Close A (slot 1). Wait past STALE_MS so b prunes the entry.
    await a.close();
    await new Promise((r) => setTimeout(r, 4500));
    const c = await openTab(ctx);
    // c picks lowest free; b is still at slot 2, so c gets slot 1.
    expect(await getSlot(c)).toBe(1);
    expect(await getSlot(b)).toBe(2);
    await b.close();
    await c.close();
    await ctx.close();
  });

  it("rapid open-close cycles do not leak slots", { timeout: 30000 }, async () => {
    // Simulate the user spamming Cmd+T / Cmd+W. After enough churn,
    // a fresh tab should still land on slot 1 — no zombie entries.
    const ctx = await browser.newContext();
    for (let i = 0; i < 5; i++) {
      const p = await openTab(ctx);
      await p.close();
      await new Promise((r) => setTimeout(r, 200));
    }
    await new Promise((r) => setTimeout(r, 4500));
    const fresh = await openTab(ctx);
    expect(await getSlot(fresh)).toBe(1);
    await fresh.close();
    await ctx.close();
  });

  // ── Reserved-slot semantics ───────────────────────────────

  // Closed-tab leftover identity in localStorage doesn't reserve the
  // slot. Once the tab is closed, its sessionStorage is gone, so it
  // can't F5 back to reclaim its slot — the identity is dead. A fresh
  // tab is allowed to take that slot, and `claimSlot('elected')`
  // correctly wipes the dead identity so the new tab doesn't
  // accidentally inherit a server-side reconnect path.
  it(
    "a closed tab with leftover unoPlayerId does not reserve the slot",
    { timeout: 30000 },
    async () => {
      const ctx = await browser.newContext();
      const a = await openTab(ctx);
      expect(await getSlot(a)).toBe(1);

      const b = await openTab(ctx);
      expect(await getSlot(b)).toBe(2);
      await b.evaluate(() => localStorage.setItem("unoPlayerId-2", "fake-active-id"));
      await b.close();
      // Wait past STALE_MS so b's heartbeat is pruned from a's table.
      await new Promise((r) => setTimeout(r, 4500));

      // Open C — should take the freed slot 2 (a is heartbeating slot 1).
      const c = await openTab(ctx);
      expect(await getSlot(c)).toBe(2);
      // The leftover identity is wiped because origin='elected' for C —
      // otherwise C would auto-reconnect as the closed tab's user.
      const idAfter = await c.evaluate(() => localStorage.getItem("unoPlayerId-2"));
      expect(idAfter).toBeNull();

      await a.close();
      await c.close();
      await ctx.close();
    },
  );

  // The original tab can still come back to its slot via F5 — that
  // path uses sessionStorage.unoSlot (=2) plus the active identity to
  // claim slot 2 with origin='restored', preserving the playerId.
  it(
    "original tab can F5-restore into its slot keeping its identity",
    { timeout: 30000 },
    async () => {
      const ctx = await browser.newContext();
      const a = await openTab(ctx);
      const b = await openTab(ctx);
      expect(await getSlot(b)).toBe(2);
      // Plant an identity for slot 2 to mark it as game-joined.
      await b.evaluate(() => localStorage.setItem("unoPlayerId-2", "real-id"));

      // Reload b (preserves sessionStorage.unoSlot=2). Should keep slot 2
      // and NOT wipe the playerId.
      await b.reload();
      await b.waitForFunction(() => Number(sessionStorage.getItem("unoSlot")) > 0, {
        timeout: 5000,
      });
      expect(await getSlot(b)).toBe(2);
      const id = await b.evaluate(() => localStorage.getItem("unoPlayerId-2"));
      expect(id).toBe("real-id");

      await a.close();
      await b.close();
      await ctx.close();
    },
  );
});
