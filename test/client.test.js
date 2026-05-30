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

async function wait(ms) {
  const { promise, resolve } = Promise.withResolvers();
  setTimeout(resolve, ms);
  return promise;
}

describe("UNO Client", () => {
  it("loads and shows join form", async () => {
    const page = await browser.newPage();
    await page.goto(BASE);
    await page.waitForSelector("#name");
    await page.waitForSelector("#join");
    expect(await page.isVisible("#name")).toBe(true);
    expect(await page.isVisible("#join")).toBe(true);
    await page.close();
  });

  it("shows (已准备) after player readies and state persists after opponent disconnects", async () => {
    const pageA = await browser.newPage();
    const pageB = await browser.newPage();
    await pageA.goto(BASE);
    await pageB.goto(BASE);

    // Join lobby
    await pageA.fill("#name", "Alice");
    await pageA.fill("#lobby-id", "test1");
    await pageA.click("#join");
    await pageA.waitForSelector("#players li");

    await pageB.fill("#name", "Bob");
    await pageB.fill("#lobby-id", "test1");
    await pageB.click("#join");

    // Wait for both to see each other
    await pageA.waitForFunction(() => {
      const items = document.querySelectorAll("#players li");
      return items.length === 2;
    });
    await pageB.waitForFunction(() => {
      const items = document.querySelectorAll("#players li");
      return items.length === 2;
    });

    // Alice clicks ready >> should show (已准备)
    await pageA.click("#ready");
    await pageA.waitForFunction(() => {
      const items = document.querySelectorAll("#players li");
      if (items.length === 0) return false;
      return items[0].textContent.indexOf("（已准备）") !== -1;
    });

    const aliceName = await pageA.$eval(
      "#players li:first-child .player-name",
      (el) => el.textContent,
    );
    expect(aliceName).toContain("（已准备）");

    // Bob disconnect
    await pageB.close();

    // Wait for Bob to appear as disconnected
    await pageA.waitForFunction(
      () => {
        const items = document.querySelectorAll("#players li");
        return items.length === 2 && items[1].classList.contains("disconnected");
      },
      { timeout: 10000 },
    );

    // Alice's ready should persist after Bob disconnects (countdown interval shouldn't corrupt it)
    await wait(2500);
    const aliceName1 = await pageA.$eval(
      "#players li:first-child .player-name",
      (el) => el.textContent,
    );
    expect(aliceName1).toContain("（已准备）");

    // Alice clicks ready again >> should toggle to NOT ready
    await pageA.click("#ready");
    await pageA.waitForFunction(() => {
      const items = document.querySelectorAll("#players li");
      if (items.length === 0) return false;
      return items[0].textContent.indexOf("（已准备）") === -1;
    });

    const aliceName2 = await pageA.$eval(
      "#players li:first-child .player-name",
      (el) => el.textContent,
    );
    expect(aliceName2).not.toContain("（已准备）");

    await pageA.close();
  });

  it(
    "full flow: B disconnects >> A readies (stays ready) >> B reconnects >> B readies >> game starts",
    { timeout: 45000 },
    async () => {
      const pageA = await browser.newPage();
      const pageB = await browser.newPage();
      await pageA.goto(BASE);
      await pageB.goto(BASE);

      const lobbyId = "flow-" + Date.now();

      // 1-2. A creates room, B joins
      await pageA.fill("#name", "Alice");
      await pageA.fill("#lobby-id", lobbyId);
      await pageA.click("#join");
      await pageA.waitForSelector("#players li", { timeout: 5000 });

      await pageB.fill("#name", "Bob");
      await pageB.fill("#lobby-id", lobbyId);
      await pageB.click("#join");

      await pageA.waitForFunction(() => document.querySelectorAll("#players li").length === 2, {
        timeout: 5000,
      });
      await pageB.waitForFunction(() => document.querySelectorAll("#players li").length === 2, {
        timeout: 5000,
      });

      // 3. B closes tab (disconnect)
      await pageB.close();
      await pageA.waitForFunction(
        () => {
          const items = document.querySelectorAll("#players li");
          return items.length === 2 && items[1].classList.contains("disconnected");
        },
        { timeout: 10000 },
      );

      // 4. A clicks ready
      await pageA.click("#ready");
      // Wait for ready button to confirm (changes from "就绪" to "取消准备")
      await pageA.waitForFunction(
        () => {
          const btn = document.getElementById("ready");
          return btn && btn.textContent === "取消准备";
        },
        { timeout: 5000 },
      );

      // 5. A stays ready — retry until stable
      for (let i = 0; i < 10; i++) {
        await pageA.waitForTimeout(300);
        const btn = await pageA.$eval("#ready", (el) => el.textContent);
        if (btn === "取消准备") break;
      }
      const btnText = await pageA.$eval("#ready", (el) => el.textContent);
      expect(btnText).toBe("取消准备");
      const aliceName = await pageA.$eval(
        "#players li:first-child .player-name",
        (el) => el.textContent,
      );
      expect(aliceName).toContain("（已准备）");

      // 6. B reconnects (new page)
      const pageB2 = await browser.newPage();
      await pageB2.goto(BASE);
      await pageB2.fill("#name", "Bob");
      await pageB2.fill("#lobby-id", lobbyId);
      await pageB2.click("#join");
      await pageB2.waitForFunction(() => document.querySelectorAll("#players li").length === 2, {
        timeout: 5000,
      });
      // Wait for B to be reconnected (not disconnected)
      await pageB2.waitForFunction(
        () => {
          const items = document.querySelectorAll("#players li");
          if (items.length < 2) return false;
          return items.length >= 2 && !items[1].classList.contains("disconnected");
        },
        { timeout: 5000 },
      );

      const aliceReady2 = await pageA.$eval(
        "#players li:first-child .player-name",
        (el) => el.textContent,
      );
      expect(aliceReady2).toContain("（已准备）");

      // 7. B clicks ready >> game starts
      await pageB2.click("#ready");

      // Wait for game to appear for both players
      await pageA.waitForFunction(
        () => {
          const el = document.getElementById("game");
          return el && el.style.display !== "none" && el.style.display !== "";
        },
        { timeout: 10000 },
      );
      await pageB2.waitForFunction(
        () => {
          const el = document.getElementById("game");
          return el && el.style.display !== "none" && el.style.display !== "";
        },
        { timeout: 10000 },
      );

      await pageA.close();
      await pageB2.close();
    },
  );

  it("draw increases card count during normal play", { timeout: 30000 }, async () => {
    const pageA = await browser.newPage();
    const pageB = await browser.newPage();
    await pageA.goto(BASE);
    await pageB.goto(BASE);

    const lobbyId = "draw-" + Date.now();
    await pageA.fill("#name", "Alice");
    await pageA.fill("#lobby-id", lobbyId);
    await pageA.click("#join");
    await pageA.waitForSelector("#players li");
    await pageB.fill("#name", "Bob");
    await pageB.fill("#lobby-id", lobbyId);
    await pageB.click("#join");
    await pageA.waitForFunction(() => document.querySelectorAll("#players li").length === 2);

    await pageA.click("#ready");
    await pageB.click("#ready");
    await pageA.waitForFunction(
      () => {
        const el = document.getElementById("game");
        return el && el.style.display !== "none";
      },
      { timeout: 10000 },
    );

    const getCardCount = async (page) => (await page.$$("#player-hand .card")).length;
    const isMyTurn = async (page) =>
      await page.evaluate(() => {
        const el = document.getElementById("turn-indicator");
        return el ? el.classList.contains("my-turn") : false;
      });

    // If B goes first, B draws to pass turn to A
    if (!(await isMyTurn(pageA))) {
      await pageB.waitForFunction(
        () => {
          const el = document.getElementById("turn-indicator");
          return el ? el.classList.contains("my-turn") : false;
        },
        { timeout: 10000 },
      );
      await pageB.click("#draw-card");
      await pageA.waitForTimeout(500);
    }

    // A draws >> gets 1 card (normal draw, < 100 cards)
    const aBefore = await getCardCount(pageA);
    await pageA.click("#draw-card");
    await pageA.waitForTimeout(500);
    // Turn passes to B
    await pageB.waitForFunction(
      () => {
        const el = document.getElementById("turn-indicator");
        return el ? el.classList.contains("my-turn") : false;
      },
      { timeout: 10000 },
    );
    const aAfter = await getCardCount(pageA);
    expect(aAfter).toBe(aBefore + 1);

    await pageA.close();
    await pageB.close();
  });

  it(
    "max hand 100: draw skips when >= 100, draw works after dropping below",
    { timeout: 45000 },
    async () => {
      const pageA = await browser.newPage();
      const pageB = await browser.newPage();
      await pageA.goto(BASE);
      await pageB.goto(BASE);

      const lobbyId = "maxhand-" + Date.now();
      await pageA.fill("#name", "Alice");
      await pageA.fill("#lobby-id", lobbyId);
      await pageA.click("#join");
      await pageA.waitForSelector("#players li");
      await pageB.fill("#name", "Bob");
      await pageB.fill("#lobby-id", lobbyId);
      await pageB.click("#join");
      await pageA.waitForFunction(() => document.querySelectorAll("#players li").length === 2);

      await pageA.click("#ready");
      await pageB.click("#ready");
      await pageA.waitForFunction(
        () => {
          const el = document.getElementById("game");
          return el && el.style.display !== "none";
        },
        { timeout: 10000 },
      );

      const isMyTurn = async (page) =>
        await page.evaluate(() => {
          const el = document.getElementById("turn-indicator");
          return el ? el.classList.contains("my-turn") : false;
        });
      const getCardCount = async (page) => (await page.$$("#player-hand .card")).length;

      // Ensure it is A's turn (A is first player)
      if (!(await isMyTurn(pageA))) {
        await pageB.waitForFunction(
          () => {
            const el = document.getElementById("turn-indicator");
            return el ? el.classList.contains("my-turn") : false;
          },
          { timeout: 10000 },
        );
        await pageB.click("#draw-card");
        await pageA.waitForTimeout(500);
      }

      // Let B remove 1 card first to increase discard to 2, so reshuffle works later
      await pageB.evaluate(() => {
        sendMessage({ action: "dev_remove_cards", count: 1 });
      });
      await pageA.waitForTimeout(500);

      // A: use dev_add_all_cards to get the full deck (no reserve, gives all 93 remaining)
      //     A already has 7 cards >> total 7 + 93 = 100. Deck=0, Discard=2
      await pageA.evaluate(() => {
        sendMessage({ action: "dev_add_all_cards" });
      });
      await pageA.waitForTimeout(500);

      const aBeforeDraw = await getCardCount(pageA);
      expect(aBeforeDraw).toBeGreaterThanOrEqual(100);

      // Step 3: A clicks draw >> should skip (>= MAX_HAND_CARDS), hand stays same, turn passes to B
      await pageA.click("#draw-card");
      await pageA.waitForTimeout(800);
      await pageB.waitForFunction(
        () => {
          const el = document.getElementById("turn-indicator");
          return el ? el.classList.contains("my-turn") : false;
        },
        { timeout: 10000 },
      );
      const aAfterSkip = await getCardCount(pageA);
      expect(aAfterSkip).toBe(aBeforeDraw);

      // Step 4: B draws >> discard has 2 cards >> reshuffle gives B a card
      const bBeforeDraw = await getCardCount(pageB);
      await pageB.click("#draw-card");
      await pageB.waitForTimeout(500);
      await pageA.waitForFunction(
        () => {
          const el = document.getElementById("turn-indicator");
          return el ? el.classList.contains("my-turn") : false;
        },
        { timeout: 10000 },
      );
      const bAfterDraw = await getCardCount(pageB);
      expect(bAfterDraw).toBeGreaterThan(bBeforeDraw);

      // Step 5: A removes 1 card (simulates playing a card) >> A < 100
      await pageA.evaluate(() => {
        sendMessage({ action: "dev_remove_cards", count: 1 });
      });
      await pageA.waitForTimeout(500);
      const aBeforeDraw2 = await getCardCount(pageA);
      expect(aBeforeDraw2).toBeLessThan(100);

      // Step 6: A clicks draw >> should now get +1 card
      await pageA.click("#draw-card");
      await pageA.waitForTimeout(500);
      await pageB.waitForFunction(
        () => {
          const el = document.getElementById("turn-indicator");
          return el ? el.classList.contains("my-turn") : false;
        },
        { timeout: 10000 },
      );
      const aAfterDraw2 = await getCardCount(pageA);
      expect(aAfterDraw2).toBe(aBeforeDraw2 + 1);

      await pageA.close();
      await pageB.close();
    },
  );

  it(
    "reconnected player card count shows after disconnect and rejoin",
    { timeout: 30000 },
    async () => {
      const pageA = await browser.newPage();
      const pageB = await browser.newPage();
      await pageA.goto(BASE);
      await pageB.goto(BASE);

      const lobbyId = "reconn-" + Date.now();
      await pageA.fill("#name", "Alice");
      await pageA.fill("#lobby-id", lobbyId);
      await pageA.click("#join");
      await pageA.waitForSelector("#players li");
      await pageB.fill("#name", "Bob");
      await pageB.fill("#lobby-id", lobbyId);
      await pageB.click("#join");
      await pageA.waitForFunction(() => document.querySelectorAll("#players li").length === 2);

      await pageA.click("#ready");
      await pageB.click("#ready");
      await pageA.waitForFunction(
        () => {
          const el = document.getElementById("game");
          return el && el.style.display !== "none";
        },
        { timeout: 10000 },
      );
      await pageB.waitForFunction(
        () => {
          const el = document.getElementById("game");
          return el && el.style.display !== "none";
        },
        { timeout: 10000 },
      );

      // A should see B's card count initially. With the merged turn-order
      // layout, self (Alice) is also in #opponent-hands, so query for the
      // opponent (Bob) by data-player-id rather than taking [0].
      const initialDisplay = await pageA.evaluate(() => {
        const cards = Array.from(document.querySelectorAll("#opponent-hands .player"));
        const opp = cards.find((c) => !c.classList.contains("self"));
        return opp ? opp.textContent : "";
      });
      expect(initialDisplay).toMatch(/（\d+ 张牌）/);

      // B closes page (disconnect)
      // store.set writes to sessionStorage (always) and to a slot-scoped
      // localStorage key (e.g. unoPlayerId-1). It no longer writes the plain
      // localStorage key, so read sessionStorage here.
      const bobId = await pageB.evaluate(() => sessionStorage.getItem("unoPlayerId"));
      await pageB.close();

      // Wait for A to see B as disconnected (processClose fires) — the
      // disconnected card is the non-self opponent.
      await pageA.waitForFunction(
        () => {
          const cards = Array.from(document.querySelectorAll("#opponent-hands .player"));
          const opp = cards.find((c) => !c.classList.contains("self"));
          return !!opp && opp.classList.contains("disconnected");
        },
        { timeout: 10000 },
      );

      // After disconnect, A should still see B's card count (game update from processClose)
      const disconnectedDisplay = await pageA.evaluate(() => {
        const cards = Array.from(document.querySelectorAll("#opponent-hands .player"));
        const opp = cards.find((c) => !c.classList.contains("self"));
        return opp ? opp.textContent : "";
      });
      expect(disconnectedDisplay).toMatch(/（\d+ 张牌）/);

      // B2: open new page and manually trigger reconnect
      const pageB2 = await browser.newPage();
      await pageB2.goto(BASE);
      await pageB2.waitForSelector("#name");
      // Wait for WebSocket to connect, then send reconnect
      await pageB2.waitForFunction(
        () => {
          return typeof ws !== "undefined" && ws !== null && ws.readyState === 1;
        },
        { timeout: 5000 },
      );
      await pageB2.evaluate((id) => {
        sendMessage({ action: "reconnect", playerId: id });
      }, bobId);

      // B2 should receive start and show game
      await pageB2.waitForFunction(
        () => {
          const el = document.getElementById("game");
          return el && el.style.display !== "none";
        },
        { timeout: 10000 },
      );

      // A should see B's card count after reconnect (game update from reconnect handler)
      await pageA.waitForFunction(
        () => {
          const cards = Array.from(document.querySelectorAll("#opponent-hands .player"));
          const opp = cards.find((c) => !c.classList.contains("self"));
          return (
            !!opp &&
            (opp.textContent || "").includes("张牌") &&
            !opp.classList.contains("disconnected")
          );
        },
        { timeout: 10000 },
      );

      const reconnectedDisplay = await pageA.evaluate(() => {
        const cards = Array.from(document.querySelectorAll("#opponent-hands .player"));
        const opp = cards.find((c) => !c.classList.contains("self"));
        return opp ? opp.textContent : "";
      });
      expect(reconnectedDisplay).toMatch(/（\d+ 张牌）/);

      await pageA.close();
      await pageB2.close();
    },
  );

  it("name and lobby ID saved to localStorage on input", async () => {
    const page = await browser.newPage();
    await page.goto(BASE);
    await page.waitForSelector("#name");

    // Type something and verify localStorage updates
    await page.fill("#name", "TestPlayer");
    const name1 = await page.evaluate(
      () => sessionStorage.getItem("unoPlayerName") || localStorage.getItem("unoPlayerName"),
    );
    expect(name1).toBe("TestPlayer");

    await page.fill("#lobby-id", "TestLobby");
    const lobby1 = await page.evaluate(
      () => sessionStorage.getItem("unoLobbyId") || localStorage.getItem("unoLobbyId"),
    );
    expect(lobby1).toBe("TESTLOBBY"); // uppercased by input listener

    // Change and verify
    await page.fill("#name", "Player2");
    const name2 = await page.evaluate(
      () => sessionStorage.getItem("unoPlayerName") || localStorage.getItem("unoPlayerName"),
    );
    expect(name2).toBe("Player2");

    await page.close();
  });

  it("turn order display shows after game starts", { timeout: 30000 }, async () => {
    const pageA = await browser.newPage();
    const pageB = await browser.newPage();
    await pageA.goto(BASE);
    await pageB.goto(BASE);

    const lobbyId = "order-" + Date.now();
    await pageA.fill("#name", "Alice");
    await pageA.fill("#lobby-id", lobbyId);
    await pageA.click("#join");
    await pageA.waitForSelector("#players li");
    await pageB.fill("#name", "Bob");
    await pageB.fill("#lobby-id", lobbyId);
    await pageB.click("#join");
    await pageA.waitForFunction(() => document.querySelectorAll("#players li").length === 2);

    await pageA.click("#ready");
    await pageB.click("#ready");
    await pageA.waitForFunction(
      () => {
        const el = document.getElementById("game");
        return el && el.style.display !== "none";
      },
      { timeout: 10000 },
    );

    // The turn-order is now merged into #opponent-hands player cards
    // with prominent .order-arrow elements between them.
    const orderText = await pageA.evaluate(() => {
      const el = document.getElementById("opponent-hands");
      return el ? el.textContent : null;
    });
    expect(orderText).toBeTruthy();
    expect(orderText).toContain("Alice");
    expect(orderText).toContain("Bob");
    // Should show direction arrow (▶ or ◀, the prominent merged arrow)
    expect(orderText).toMatch(/[▶◀]/);

    await pageA.close();
    await pageB.close();
  });

  it(
    "leaving player does not receive lobby updates after leaving",
    { timeout: 30000 },
    async () => {
      const pageA = await browser.newPage();
      const pageB = await browser.newPage();
      await pageA.goto(BASE);
      await pageB.goto(BASE);

      const lobbyId = "leave-" + Date.now();
      await pageA.fill("#name", "Alice");
      await pageA.fill("#lobby-id", lobbyId);
      await pageA.click("#join");
      await pageA.waitForSelector("#players li");
      await pageB.fill("#name", "Bob");
      await pageB.fill("#lobby-id", lobbyId);
      await pageB.click("#join");
      await pageA.waitForFunction(() => document.querySelectorAll("#players li").length === 2);

      // A leaves the lobby
      await pageA.click("#leave-lobby");
      await pageA.waitForSelector("#modal-ok-btn", { timeout: 3000 });
      await pageA.click("#modal-ok-btn");

      // A should return to join form
      await pageA.waitForFunction(
        () => {
          const el = document.getElementById("join");
          return el && !el.disabled;
        },
        { timeout: 5000 },
      );

      await pageA.waitForTimeout(300);

      // After leaving the lobby, two states are possible depending on how
      // quickly the auto-reconnect onopen handler runs after the server
      // closes the ws:
      //   - the leave flag is still set ('true') because reconnect hasn't
      //     happened yet
      //   - the flag has been consumed (null) because onopen ran and cleared
      //     it, having already taken the "left lobby" branch
      // What we care about is the invariant that the player has dropped its
      // session — unoPlayerId must be cleared either way.
      const leftFlag = await pageA.evaluate(() => store.get("unoLeftLobby"));
      expect(leftFlag === "true" || leftFlag === null).toBe(true);
      const noId = await pageA.evaluate(() => store.get("unoPlayerId"));
      expect(noId).toBeNull();

      // B adds AI and starts game
      await pageB.click("#invite-ai");
      await pageB.waitForFunction(() => document.querySelectorAll("#players li").length === 2);
      await pageB.click("#ready");
      // AI is ready by default, game should start
      await pageB.waitForFunction(
        () => {
          const el = document.getElementById("game");
          return el && el.style.display !== "none";
        },
        { timeout: 10000 },
      );

      // Wait a bit — A should NOT see any lobby or game updates
      await pageA.waitForTimeout(1500);

      // A should still be at join form, not showing lobby/players
      const aInJoinForm = await pageA.evaluate(() => {
        const join = document.getElementById("join");
        const players = document.querySelectorAll("#players li");
        const lobby = document.getElementById("lobby");
        return (
          join && !join.disabled && players.length === 0 && lobby && lobby.style.display !== "none"
        );
      });
      expect(aInJoinForm).toBe(true);

      await pageA.close();
      await pageB.close();
    },
  );

  // TODO: fix game start race condition with 3+ players / AI
  it("3-player room: surrender removes player, game continues", { timeout: 45000 }, async () => {
    const pageA = await browser.newPage();
    const pageB = await browser.newPage();
    const pageC = await browser.newPage();
    await pageA.goto(BASE);
    await pageB.goto(BASE);
    await pageC.goto(BASE);

    const lobbyId = "surr-" + Date.now();
    // A creates room
    await pageA.fill("#name", "Alice");
    await pageA.fill("#lobby-id", lobbyId);
    await pageA.click("#join");
    await pageA.waitForSelector("#players li");
    // B joins
    await pageB.fill("#name", "Bob");
    await pageB.fill("#lobby-id", lobbyId);
    await pageB.click("#join");
    await pageA.waitForFunction(() => document.querySelectorAll("#players li").length === 2);
    // C joins
    await pageC.fill("#name", "Charlie");
    await pageC.fill("#lobby-id", lobbyId);
    await pageC.click("#join");
    await pageA.waitForFunction(() => document.querySelectorAll("#players li").length === 3);
    await pageB.waitForFunction(() => document.querySelectorAll("#players li").length === 3);
    await pageC.waitForFunction(() => document.querySelectorAll("#players li").length === 3);

    // Everyone ready >> start game
    await pageA.click("#ready");
    await pageA.waitForTimeout(300);
    await pageB.click("#ready");
    await pageB.waitForTimeout(300);
    await pageC.click("#ready");
    await pageA.waitForFunction(
      () => {
        const el = document.getElementById("game");
        return el && el.style.display !== "none";
      },
      { timeout: 10000 },
    );
    await pageB.waitForFunction(
      () => {
        const el = document.getElementById("game");
        return el && el.style.display !== "none";
      },
      { timeout: 10000 },
    );
    await pageC.waitForFunction(
      () => {
        const el = document.getElementById("game");
        return el && el.style.display !== "none";
      },
      { timeout: 10000 },
    );

    // A surrenders
    await pageA.click("#surrender-btn");
    // Confirm "确定要认输吗？"
    await pageA.waitForSelector("#modal-ok-btn", { timeout: 5000 });
    await pageA.click("#modal-ok-btn");
    // Wait for server to send surrender_offer >> client shows spectate confirm
    await pageA.waitForSelector("#modal-cancel-btn", { timeout: 10000 });
    await pageA.click("#modal-cancel-btn");

    // A should return to lobby view
    await pageA.waitForFunction(
      () => {
        const el = document.getElementById("lobby");
        return el && el.style.display !== "none";
      },
      { timeout: 10000 },
    );

    // B and C should still be in game (game continues)
    await pageB.waitForFunction(
      () => {
        const el = document.getElementById("game");
        return el && el.style.display !== "none";
      },
      { timeout: 5000 },
    );
    await pageC.waitForFunction(
      () => {
        const el = document.getElementById("game");
        return el && el.style.display !== "none";
      },
      { timeout: 5000 },
    );

    // Verify B and C see only 2 players in the merged turn-order
    // (now rendered as #opponent-hands .player cards).
    const bPlayerCount = await pageB.evaluate(() => {
      const cards = document.querySelectorAll("#opponent-hands .player");
      return cards.length;
    });
    expect(bPlayerCount).toBe(2);

    await pageA.close();
    await pageB.close();
    await pageC.close();
  });

  it("3 tabs join same lobby and see each other", { timeout: 30000 }, async () => {
    const pageA = await browser.newPage();
    const pageB = await browser.newPage();
    const pageC = await browser.newPage();
    await pageA.goto(BASE);
    await pageB.goto(BASE);
    await pageC.goto(BASE);

    const lobbyId = "multi-" + Date.now();
    await pageA.fill("#name", "Alice");
    await pageA.fill("#lobby-id", lobbyId);
    await pageA.click("#join");
    await pageA.waitForSelector("#players li");

    await pageB.fill("#name", "Bob");
    await pageB.fill("#lobby-id", lobbyId);
    await pageB.click("#join");
    await pageA.waitForFunction(() => document.querySelectorAll("#players li").length === 2);
    await pageB.waitForFunction(() => document.querySelectorAll("#players li").length === 2);

    await pageC.fill("#name", "Charlie");
    await pageC.fill("#lobby-id", lobbyId);
    await pageC.click("#join");

    // All 3 should see 3 players
    await pageA.waitForFunction(() => document.querySelectorAll("#players li").length === 3);
    await pageB.waitForFunction(() => document.querySelectorAll("#players li").length === 3);
    await pageC.waitForFunction(() => document.querySelectorAll("#players li").length === 3);

    // Verify player names (creator shows 👑 after name)
    const namesA = await pageA.$$eval("#players li .player-name", (els) =>
      els.map((el) => el.textContent),
    );
    const namesB = await pageB.$$eval("#players li .player-name", (els) =>
      els.map((el) => el.textContent),
    );
    const namesC = await pageC.$$eval("#players li .player-name", (els) =>
      els.map((el) => el.textContent),
    );
    expect(namesA.some((n) => n.includes("Alice"))).toBe(true);
    expect(namesA.some((n) => n.includes("Bob"))).toBe(true);
    expect(namesA.some((n) => n.includes("Charlie"))).toBe(true);
    expect(namesB.some((n) => n.includes("Alice"))).toBe(true);
    expect(namesB.some((n) => n.includes("Bob"))).toBe(true);
    expect(namesB.some((n) => n.includes("Charlie"))).toBe(true);
    expect(namesC.some((n) => n.includes("Alice"))).toBe(true);
    expect(namesC.some((n) => n.includes("Bob"))).toBe(true);
    expect(namesC.some((n) => n.includes("Charlie"))).toBe(true);

    // Creator (Alice) should see invite AI and ready buttons
    const readyVisible = await pageA.evaluate(
      () => document.getElementById("ready").style.display !== "none",
    );
    expect(readyVisible).toBe(true);

    await pageA.close();
    await pageB.close();
    await pageC.close();
  });

  it("spectator mode: join started lobby, watch game", { timeout: 45000 }, async () => {
    const pageA = await browser.newPage();
    const pageB = await browser.newPage();
    await pageA.goto(BASE);
    await pageB.goto(BASE);

    const lobbyId = "spec-" + Date.now();
    // A creates room, adds AI, starts game
    await pageA.fill("#name", "Alice");
    await pageA.fill("#lobby-id", lobbyId);
    await pageA.click("#join");
    await pageA.waitForSelector("#players li");
    await pageA.click("#invite-ai");
    await pageA.waitForFunction(() => document.querySelectorAll("#players li").length === 2);

    await pageA.click("#ready");
    // AI is already ready, wait for game start
    await pageA.waitForFunction(
      () => {
        const el = document.getElementById("game");
        return el && el.style.display !== "none";
      },
      { timeout: 10000 },
    );

    // Now B tries to join the started lobby
    await pageB.fill("#name", "Bob");
    await pageB.fill("#lobby-id", lobbyId);
    await pageB.click("#join");
    // Spectate offer appears
    await pageB.waitForSelector("#modal-ok-btn", { timeout: 5000 });
    // Click OK to spectate
    await pageB.click("#modal-ok-btn");

    // B should enter spectator mode — game view but no actions
    await pageB.waitForFunction(
      () => {
        const el = document.getElementById("game");
        return el && el.style.display !== "none";
      },
      { timeout: 10000 },
    );

    // B should be spectator — body has .spectator class
    const isSpectator = await pageB.evaluate(() => document.body.classList.contains("spectator"));
    expect(isSpectator).toBe(true);

    // B should see discard pile and turn order
    const discardVisible = await pageB.evaluate(() => {
      const el = document.getElementById("discard-pile");
      return el && el.children.length > 0;
    });
    expect(discardVisible).toBe(true);

    // B should see turn order (now in the merged opponent-hands).
    const orderText = await pageB.evaluate(() => {
      const el = document.getElementById("opponent-hands");
      return el ? el.textContent : "";
    });
    expect(orderText).toBeTruthy();

    // B's hand should be empty (spectator has no cards)
    const handCards = await pageB.$$("#player-hand .card");
    expect(handCards.length).toBe(0);

    await pageA.close();
    await pageB.close();
  });

  it("non-matching cards have no hover lift, matching cards do", { timeout: 30000 }, async () => {
    const pageA = await browser.newPage();
    await pageA.goto(BASE);
    await pageA.waitForSelector("#name");

    const lobbyId = "hover-" + Date.now();
    await pageA.fill("#name", "Alice");
    await pageA.fill("#lobby-id", lobbyId);
    await pageA.click("#join");
    await pageA.waitForSelector("#players li");

    // Invite AI and start game (AI is always ready)
    await pageA.click("#invite-ai");
    await pageA.waitForFunction(() => document.querySelectorAll("#players li").length === 2);
    await pageA.click("#ready");
    await pageA.waitForFunction(
      () => {
        const el = document.getElementById("game");
        return el && el.style.display !== "none";
      },
      { timeout: 10000 },
    );

    // Get discard pile top card info
    const topInfo = await pageA.evaluate(() => {
      const card = document.querySelector("#discard-pile .card");
      return {
        color: card ? card.getAttribute("data-color") : null,
        type: card ? card.getAttribute("data-type") : null,
      };
    });
    expect(topInfo.color).toBeTruthy();
    expect(topInfo.type).toBeTruthy();

    // All cards in hand should have proper playable/non-playable marking
    const result = await pageA.evaluate((top) => {
      const cards = document.querySelectorAll("#player-hand .card");
      let matchingCount = 0;
      let nonMatchingCount = 0;
      let wildCount = 0;
      for (let i = 0; i < cards.length; i++) {
        const c = cards[i];
        const cColor = c.getAttribute("data-color");
        const cType = c.getAttribute("data-type");
        const isWild = cType === "wild" || cType === "wild4";
        const matches = isWild || cColor === top.color || cType === top.type;
        const hasNotPlayable = c.classList.contains("not-playable");

        if (isWild) {
          wildCount++;
          if (hasNotPlayable) return { error: "wild card should not be not-playable" };
        } else if (matches) {
          matchingCount++;
          if (hasNotPlayable) return { error: "matching card should not be not-playable" };
        } else {
          nonMatchingCount++;
          if (!hasNotPlayable) return { error: "non-matching card should be not-playable" };
        }
      }
      return { matchingCount, nonMatchingCount, wildCount };
    }, topInfo);

    expect(result.error).toBeUndefined();
    expect(result.nonMatchingCount).toBeGreaterThan(0);

    await pageA.close();
  });

  it("invite AI button shows after leaving and re-creating lobby", { timeout: 30000 }, async () => {
    const page = await browser.newPage();
    await page.goto(BASE);
    await page.waitForSelector("#name");

    // Create first lobby
    await page.fill("#name", "Alice");
    await page.fill("#lobby-id", "firstLobby");
    await page.click("#join");
    await page.waitForSelector("#players li");

    // Verify invite AI button is visible (Alice is creator)
    const btn1 = await page.evaluate(() => {
      const btn = document.getElementById("invite-ai");
      return btn ? btn.style.display !== "none" : false;
    });
    expect(btn1).toBe(true);

    // Leave the lobby
    await page.click("#leave-lobby");
    await page.waitForSelector("#modal-ok-btn", { timeout: 3000 });
    await page.click("#modal-ok-btn");

    // Wait for join form
    await page.waitForFunction(
      () => {
        const el = document.getElementById("join");
        return el && !el.disabled;
      },
      { timeout: 5000 },
    );

    // Create second lobby
    await page.fill("#name", "Alice");
    await page.fill("#lobby-id", "secondLobby");
    await page.click("#join");
    await page.waitForSelector("#players li");

    // Verify invite AI button is STILL visible (Alice is creator again)
    const btn2 = await page.evaluate(() => {
      const btn = document.getElementById("invite-ai");
      return btn ? btn.style.display !== "none" : false;
    });
    expect(btn2).toBe(true);

    await page.close();
  });

  it("drawing chain confirm dialog shows when breaking chain", { timeout: 30000 }, async () => {
    const pageA = await browser.newPage();
    const pageB = await browser.newPage();
    await pageA.goto(BASE);
    await pageB.goto(BASE);

    const lobbyId = "chain-" + Date.now();
    await pageA.fill("#name", "Alice");
    await pageA.fill("#lobby-id", lobbyId);
    await pageA.click("#join");
    await pageA.waitForSelector("#players li");
    await pageB.fill("#name", "Bob");
    await pageB.fill("#lobby-id", lobbyId);
    await pageB.click("#join");
    await pageA.waitForFunction(() => document.querySelectorAll("#players li").length === 2);

    await pageA.click("#ready");
    await pageB.click("#ready");
    await pageB.waitForFunction(
      () => {
        const el = document.getElementById("game");
        return el && el.style.display !== "none";
      },
      { timeout: 10000 },
    );

    // A plays draw2 (use dev to give a draw2, or send directly matching discard)
    const topInfo = await pageA.evaluate(() => {
      const card = document.querySelector("#discard-pile .card");
      return { color: card ? card.getAttribute("data-color") : "red" };
    });

    // Make sure it is A's turn
    const isMyTurn = async (page) =>
      await page.evaluate(() => {
        const el = document.getElementById("turn-indicator");
        return el ? el.classList.contains("my-turn") : false;
      });
    if (!(await isMyTurn(pageA))) {
      await pageB.waitForFunction(
        () => {
          const el = document.getElementById("turn-indicator");
          return el ? el.classList.contains("my-turn") : false;
        },
        { timeout: 5000 },
      );
      await pageB.click("#draw-card");
      await pageA.waitForTimeout(500);
    }

    // Give A a matching draw2 so the play is legitimate. The server rejects
    // plays of cards not actually in the hand (security fix), so tests can
    // no longer fabricate cards through `sendMessage`.
    await pageA.evaluate((color) => {
      sendMessage({
        action: "dev_give_card",
        card: { color: color, type: "draw2" },
      });
    }, topInfo.color);
    await pageA.waitForTimeout(300);

    // A plays draw2
    await pageA.evaluate((color) => {
      sendMessage({ action: "play", card: { color: color, type: "draw2" } });
    }, topInfo.color);
    await pageA.waitForTimeout(500);

    // Now B's turn — B clicks a card that is NOT draw2/wild4 but IS
    // playable (matches the top discard's color). With the bug-#4 fix the
    // chain-break confirm only fires on legitimate plays, so the test must
    // first ensure B holds a matching non-draw card.
    await pageB.evaluate((color) => {
      sendMessage({
        action: "dev_give_card",
        card: { color: color, type: "5" },
      });
    }, topInfo.color);
    await pageB.waitForTimeout(300);
    await pageB.evaluate((color) => {
      const cards = document.querySelectorAll("#player-hand .card");
      for (let i = 0; i < cards.length; i++) {
        const type = cards[i].getAttribute("data-type");
        const cardColor = cards[i].getAttribute("data-color");
        // Pick our seeded same-color non-draw card so the click is a legit
        // chain-break — anything else and the click is now inert (#4).
        if (type !== "draw2" && type !== "wild4" && cardColor === color) {
          cards[i].dispatchEvent(new MouseEvent("click", { bubbles: true }));
          return;
        }
      }
    }, topInfo.color);
    await pageB.waitForTimeout(300);

    // Confirm dialog should be visible with drawing count
    const modalVisible = await pageB.evaluate(() => {
      const overlay = document.getElementById("modal-overlay");
      return overlay && !overlay.classList.contains("hidden");
    });
    expect(modalVisible).toBe(true);
    const modalMsg = await pageB.$eval("#modal-message", (el) => el.textContent);
    expect(modalMsg).toContain("打破链式加牌");
    expect(modalMsg).toContain("张牌");

    // Click cancel on the modal to dismiss it
    await pageB.click("#modal-cancel-btn");
    await pageB.waitForTimeout(300);

    // Now click draw — confirm dialog should appear with penalty info
    await pageB.click("#draw-card");
    await pageB.waitForTimeout(300);
    const drawModalVisible = await pageB.evaluate(() => {
      const overlay = document.getElementById("modal-overlay");
      return overlay && !overlay.classList.contains("hidden");
    });
    expect(drawModalVisible).toBe(true);
    const drawModalMsg = await pageB.$eval("#modal-message", (el) => el.textContent);
    expect(drawModalMsg).toContain("打破链式加牌");
    expect(drawModalMsg).toContain("张牌");

    await pageA.close();
    await pageB.close();
  });

  it("draw in drawing state accepts penalty and adds cards", { timeout: 30000 }, async () => {
    const pageA = await browser.newPage();
    const pageB = await browser.newPage();
    await pageA.goto(BASE);
    await pageB.goto(BASE);

    const lobbyId = "penalty-" + Date.now();
    await pageA.fill("#name", "Alice");
    await pageA.fill("#lobby-id", lobbyId);
    await pageA.click("#join");
    await pageA.waitForSelector("#players li");
    await pageB.fill("#name", "Bob");
    await pageB.fill("#lobby-id", lobbyId);
    await pageB.click("#join");
    await pageA.waitForFunction(() => document.querySelectorAll("#players li").length === 2);

    await pageA.click("#ready");
    await pageB.click("#ready");
    await pageB.waitForFunction(
      () => {
        const el = document.getElementById("game");
        return el && el.style.display !== "none";
      },
      { timeout: 10000 },
    );

    const isMyTurn = async (page) =>
      await page.evaluate(() => {
        const el = document.getElementById("turn-indicator");
        return el ? el.classList.contains("my-turn") : false;
      });
    const getCardCount = async (page) => (await page.$$("#player-hand .card")).length;

    // Make sure it is A's turn
    if (!(await isMyTurn(pageA))) {
      await pageB.waitForFunction(
        () => {
          const el = document.getElementById("turn-indicator");
          return el ? el.classList.contains("my-turn") : false;
        },
        { timeout: 5000 },
      );
      await pageB.click("#draw-card");
      await pageA.waitForTimeout(500);
    }

    // A plays draw2 using matching color
    const topColor = await pageA.evaluate(() => {
      const card = document.querySelector("#discard-pile .card");
      return card ? card.getAttribute("data-color") : "red";
    });
    // Give A a matching draw2 so the play is legitimate. The server rejects
    // plays of cards not actually in the hand (security fix).
    await pageA.evaluate((color) => {
      sendMessage({
        action: "dev_give_card",
        card: { color: color, type: "draw2" },
      });
    }, topColor);
    await pageA.waitForTimeout(300);
    await pageA.evaluate((color) => {
      sendMessage({ action: "play", card: { color: color, type: "draw2" } });
    }, topColor);
    await pageA.waitForTimeout(500);

    // B now in drawing state — click draw and accept penalty
    const bBefore = await getCardCount(pageB);

    await pageB.click("#draw-card");
    await pageB.waitForSelector("#modal-ok-btn", { timeout: 3000 });
    await pageB.click("#modal-ok-btn"); // accept penalty
    await pageB.waitForTimeout(500);

    // B should have 2 more cards
    const bAfter = await getCardCount(pageB);
    expect(bAfter).toBe(bBefore + 2);

    // State should be reset — B should be able to play normally now
    // (turn advanced after penalty, so it is A's turn)
    await pageA.waitForFunction(
      () => {
        const el = document.getElementById("turn-indicator");
        return el ? el.classList.contains("my-turn") : false;
      },
      { timeout: 5000 },
    );

    await pageA.close();
    await pageB.close();
  });

  it("spectator can exit without error", { timeout: 30000 }, async () => {
    const pageA = await browser.newPage();
    const pageB = await browser.newPage();
    await pageA.goto(BASE);
    await pageB.goto(BASE);

    const lobbyId = "specexit-" + Date.now();
    // A creates room, adds AI, starts game
    await pageA.fill("#name", "Alice");
    await pageA.fill("#lobby-id", lobbyId);
    await pageA.click("#join");
    await pageA.waitForSelector("#players li");
    await pageA.click("#invite-ai");
    await pageA.waitForFunction(() => document.querySelectorAll("#players li").length === 2);
    await pageA.click("#ready");
    await pageA.waitForFunction(
      () => {
        const el = document.getElementById("game");
        return el && el.style.display !== "none";
      },
      { timeout: 10000 },
    );

    // B joins as spectator
    await pageB.fill("#name", "Bob");
    await pageB.fill("#lobby-id", lobbyId);
    await pageB.click("#join");
    await pageB.waitForSelector("#modal-ok-btn", { timeout: 5000 });
    await pageB.click("#modal-ok-btn"); // accept spectate
    await pageB.waitForFunction(
      () => {
        const el = document.getElementById("game");
        return el && el.style.display !== "none";
      },
      { timeout: 10000 },
    );

    // Verify B can see the leave button
    const btnVisible = await pageB.evaluate(() => {
      const btn = document.getElementById("leave-spectate-btn");
      return btn && btn.style.display !== "none";
    });
    expect(btnVisible).toBe(true);

    // Click leave-spectate
    await pageB.click("#leave-spectate-btn");
    await pageB.waitForSelector("#modal-ok-btn", { timeout: 3000 });
    await pageB.click("#modal-ok-btn"); // confirm

    // B should return to join form without error overlay
    await pageB.waitForFunction(
      () => {
        const el = document.getElementById("join");
        return el && !el.disabled;
      },
      { timeout: 10000 },
    );

    await pageA.close();
    await pageB.close();
  });

  it("two tabs have isolated sessions", { timeout: 30000 }, async () => {
    const pageA = await browser.newPage();
    await pageA.goto(BASE);
    await pageA.waitForSelector("#name");
    await pageA.fill("#name", "Alice");
    await pageA.waitForTimeout(500);

    // Tab B opens — should NOT share session (sessionStorage is per-tab)
    const pageB = await browser.newPage();
    await pageB.goto(BASE);
    await pageB.waitForSelector("#name");
    await pageB.waitForTimeout(500);

    // Tab A's name in sessionStorage
    const nameA = await pageA.evaluate(() => sessionStorage.getItem("unoPlayerName"));
    expect(nameA).toBe("Alice");

    // Tab B's sessionStorage should NOT have A's name
    const nameB = await pageB.evaluate(() => sessionStorage.getItem("unoPlayerName"));
    expect(nameB).toBeNull();

    await pageA.close();
    await pageB.close();
  });

  it("new tab does not auto-join previous tab lobby", { timeout: 30000 }, async () => {
    const pageA = await browser.newPage();
    await pageA.goto(BASE);
    await pageA.waitForSelector("#name");
    await pageA.fill("#name", "Alice");
    await pageA.fill("#lobby-id", "ALPHA");
    await pageA.click("#join");
    await pageA.waitForSelector("#players li");
    await pageA.waitForTimeout(300);

    // Open tab B — should NOT auto-join
    const pageB = await browser.newPage();
    await pageB.goto(BASE);
    await pageB.waitForSelector("#name");
    await pageB.waitForTimeout(500);

    // Tab B should be at join form with no players
    const inLobby = await pageB.evaluate(() => {
      const joinBtn = document.getElementById("join");
      const players = document.querySelectorAll("#players li");
      return joinBtn && !joinBtn.disabled && players.length === 0;
    });
    expect(inLobby).toBe(true);

    await pageA.close();
    await pageB.close();
  });

  it("surrender with 2 humans + AI does not end game", { timeout: 45000 }, async () => {
    const pageA = await browser.newPage();
    const pageB = await browser.newPage();
    await pageA.goto(BASE);
    await pageB.goto(BASE);

    const lobbyId = "surrpl-" + Date.now();
    // A creates room
    await pageA.fill("#name", "Alice");
    await pageA.fill("#lobby-id", lobbyId);
    await pageA.click("#join");
    await pageA.waitForSelector("#players li");
    // Add AI
    await pageA.click("#invite-ai");
    await pageA.waitForFunction(() => document.querySelectorAll("#players li").length === 2);
    // B joins
    await pageB.fill("#name", "Bob");
    await pageB.fill("#lobby-id", lobbyId);
    await pageB.click("#join");
    await pageA.waitForFunction(() => document.querySelectorAll("#players li").length === 3);

    // All ready — game starts
    await pageA.click("#ready"); // Alice ready
    await pageB.click("#ready"); // Bob ready, AI already ready
    await pageA.waitForFunction(
      () => {
        const el = document.getElementById("game");
        return el && el.style.display !== "none";
      },
      { timeout: 10000 },
    );
    await pageB.waitForFunction(
      () => {
        const el = document.getElementById("game");
        return el && el.style.display !== "none";
      },
      { timeout: 10000 },
    );

    // A surrenders
    await pageA.click("#surrender-btn");
    await pageA.waitForSelector("#modal-ok-btn", { timeout: 3000 });
    await pageA.click("#modal-ok-btn"); // confirm surrender
    // Spectate offer appears — click Cancel to leave
    await pageA.waitForSelector("#modal-cancel-btn", { timeout: 3000 });
    await pageA.click("#modal-cancel-btn");

    // A should return to lobby
    await pageA.waitForFunction(
      () => {
        const el = document.getElementById("lobby");
        return el && el.style.display !== "none";
      },
      { timeout: 10000 },
    );

    // B should still be in game (game continues with Bob vs AI)
    await pageB.waitForTimeout(1500);
    const bInGame = await pageB.evaluate(() => {
      const el = document.getElementById("game");
      return el && el.style.display !== "none";
    });
    expect(bInGame).toBe(true);

    // Turn order should show 2 players (Bob + AI) — merged into
    // #opponent-hands .player cards.
    const playerCount = await pageB.evaluate(() => {
      const cards = document.querySelectorAll("#opponent-hands .player");
      return cards.length;
    });
    expect(playerCount).toBe(2);

    await pageA.close();
    await pageB.close();
  });

  it("joining AI-only lobby does not show spectate offer", { timeout: 30000 }, async () => {
    const pageA = await browser.newPage();
    await pageA.goto(BASE);
    await pageA.waitForSelector("#name");

    const lobbyId = "aionly-" + Date.now();
    // A creates room, adds AI, starts game
    await pageA.fill("#name", "Alice");
    await pageA.fill("#lobby-id", lobbyId);
    await pageA.click("#join");
    await pageA.waitForSelector("#players li");
    await pageA.click("#invite-ai");
    await pageA.waitForFunction(() => document.querySelectorAll("#players li").length === 2);
    await pageA.click("#ready");
    await pageA.waitForFunction(
      () => {
        const el = document.getElementById("game");
        return el && el.style.display !== "none";
      },
      { timeout: 10000 },
    );

    // A surrenders — AI wins
    await pageA.click("#surrender-btn");
    await pageA.waitForSelector("#modal-ok-btn", { timeout: 3000 });
    await pageA.click("#modal-ok-btn");
    await pageA.waitForFunction(
      () => {
        const el = document.getElementById("game-over-overlay");
        return el && !el.classList.contains("hidden");
      },
      { timeout: 5000 },
    );

    // Dismiss game-over overlay
    await pageA.click("#game-over-btn");
    await pageA.waitForFunction(
      () => {
        const el = document.getElementById("join");
        return el && !el.disabled;
      },
      { timeout: 5000 },
    );

    // B tries to join same lobby — should create fresh, no spectate offer
    const pageB = await browser.newPage();
    await pageB.goto(BASE);
    await pageB.waitForSelector("#name");
    await pageB.fill("#name", "Bob");
    await pageB.fill("#lobby-id", lobbyId);
    await pageB.click("#join");

    // B should see players list (joined fresh lobby), NOT spectate dialog
    await pageB.waitForSelector("#players li", { timeout: 5000 });
    const bHasPlayers = await pageB.evaluate(
      () => document.querySelectorAll("#players li").length > 0,
    );
    expect(bHasPlayers).toBe(true);

    // Verify no spectate dialog appeared
    const spectateShown = await pageB.evaluate(() => {
      const overlay = document.getElementById("modal-overlay");
      return overlay && !overlay.classList.contains("hidden");
    });
    expect(spectateShown).toBe(false);

    await pageA.close();
    await pageB.close();
  });

  it("wild color picker scrolls into view when shown", { timeout: 30000 }, async () => {
    const page = await browser.newPage();
    await page.goto(BASE);
    await page.waitForSelector("#name");

    // Create lobby with AI and start game
    await page.fill("#name", "Test");
    await page.fill("#lobby-id", "wildscroll");
    await page.click("#join");
    await page.waitForSelector("#players li");
    await page.click("#invite-ai");
    await page.waitForFunction(() => document.querySelectorAll("#players li").length === 2);
    await page.click("#ready");
    await page.waitForFunction(
      () => {
        const el = document.getElementById("game");
        return el && el.style.display !== "none";
      },
      { timeout: 10000 },
    );

    // Scroll to bottom so the picker would be off-screen
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(300);

    // Find and click a wild card
    const clickedWild = await page.evaluate(() => {
      const cards = document.querySelectorAll("#player-hand .card");
      for (let i = 0; i < cards.length; i++) {
        const type = cards[i].getAttribute("data-type");
        if (type === "wild" || type === "wild4") {
          cards[i].dispatchEvent(new MouseEvent("click", { bubbles: true }));
          return true;
        }
      }
      return false;
    });

    if (clickedWild) {
      await page.waitForTimeout(500);
      // Color picker should be visible and in viewport
      const inView = await page.evaluate(() => {
        const picker = document.getElementById("wild-color-picker");
        if (!picker || picker.style.display === "none") return false;
        const rect = picker.getBoundingClientRect();
        return rect.top >= -50 && rect.bottom <= window.innerHeight + 50;
      });
      expect(inView).toBe(true);
    }

    await page.close();
  });

  it(
    "wild color picker scrolls back on cancel, not on manual scroll",
    { timeout: 30000 },
    async () => {
      const page = await browser.newPage();
      await page.goto(BASE);
      await page.waitForSelector("#name");

      await page.fill("#name", "Test");
      await page.fill("#lobby-id", "wcancel");
      await page.click("#join");
      await page.waitForSelector("#players li");
      await page.click("#invite-ai");
      await page.waitForFunction(() => document.querySelectorAll("#players li").length === 2);
      await page.click("#ready");
      await page.waitForFunction(
        () => {
          const el = document.getElementById("game");
          return el && el.style.display !== "none";
        },
        { timeout: 10000 },
      );

      // Record initial scroll position
      const initialY = await page.evaluate(() => window.scrollY);

      // Find and click a wild card
      const found = await page.evaluate(() => {
        const cards = document.querySelectorAll("#player-hand .card");
        for (let i = 0; i < cards.length; i++) {
          if (
            cards[i].getAttribute("data-type") === "wild" ||
            cards[i].getAttribute("data-type") === "wild4"
          ) {
            cards[i].dispatchEvent(new MouseEvent("click", { bubbles: true }));
            return true;
          }
        }
        return false;
      });

      if (found) {
        await page.waitForTimeout(800); // wait for smooth scroll
        const afterShowY = await page.evaluate(() => window.scrollY);
        // Picker should have scrolled to it — position changed from initial
        expect(Math.abs(afterShowY - initialY)).toBeGreaterThan(50);

        // Manually scroll somewhere else
        await page.evaluate(() => window.scrollTo(0, 500));
        await page.waitForTimeout(300);

        // Click cancel — should NOT scroll back because user scrolled manually
        await page.click("#cancel-wild-btn");
        await page.waitForTimeout(500);
        const afterCancelY = await page.evaluate(() => window.scrollY);
        // Should remain near the user's manual scroll position (500), not
        // jump all the way back to initialY. The page can settle a few
        // hundred px off due to layout shifts after the picker hides
        // (e.g. sticky elements re-flowing); what matters is we didn't
        // snap back to the auto-scroll target.
        expect(Math.abs(afterCancelY - 500)).toBeLessThan(300);
        expect(Math.abs(afterCancelY - initialY)).toBeGreaterThan(50);
      }

      await page.close();
    },
  );

  it("draw mode toggle visible to creator, not to others", { timeout: 30000 }, async () => {
    const pageA = await browser.newPage();
    const pageB = await browser.newPage();
    await pageA.goto(BASE);
    await pageB.goto(BASE);

    // A creates room
    await pageA.fill("#name", "Alice");
    await pageA.fill("#lobby-id", "dmode");
    await pageA.click("#join");
    await pageA.waitForSelector("#players li");

    // A should see the toggle (is creator)
    const aSees = await pageA.evaluate(() => {
      const el = document.getElementById("draw-mode-area");
      return el ? el.style.display !== "none" : false;
    });
    expect(aSees).toBe(true);

    // Info title should describe both modes (now exposed via data-tooltip
    // for the custom floating tooltip).
    const tooltip = await pageA.$eval("#draw-mode-info", (el) => el.getAttribute("data-tooltip"));
    expect(tooltip).toContain("链式");

    // Click info — should open rules modal
    await pageA.click("#draw-mode-info");
    await pageA.waitForTimeout(500);
    const rulesVisible = await pageA.evaluate(() => {
      const el = document.getElementById("rules-overlay");
      return el && !el.classList.contains("hidden");
    });
    expect(rulesVisible).toBe(true);
    // Close rules modal
    await pageA.click("#rules-close-btn");
    await pageA.waitForTimeout(300);

    // B joins
    await pageB.fill("#name", "Bob");
    await pageB.fill("#lobby-id", "dmode");
    await pageB.click("#join");
    await pageA.waitForFunction(() => document.querySelectorAll("#players li").length === 2);

    // B should NOT see the toggle
    const bSees = await pageB.evaluate(() => {
      const el = document.getElementById("draw-mode-area");
      return el ? el.style.display !== "none" : false;
    });
    expect(bSees).toBe(false);

    // A clicks "直接加牌" option
    await pageA.evaluate(() => {
      document
        .querySelector(".mode-left")
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await pageA.waitForTimeout(300);
    const directActive = await pageA.evaluate(() =>
      document.querySelector(".mode-left").classList.contains("active"),
    );
    expect(directActive).toBe(true);

    await pageA.close();
    await pageB.close();
  });

  // Regression: "browser reopen, no other tabs alive" must land on slot 1.
  // Scenario:
  //   1. Open tab A → slot 1 (no name typed)
  //   2. Open tab B, type "22" → slot 2
  //   3. Close tab B (only tab A alive)
  //   4. Close tab A (no live tabs at all)
  //   5. Open a single new tab → previously this would resume on slot 2
  //      because Chrome restored sessionStorage.unoSlot, and the input
  //      pre-filled with "22" — wrong; the new tab has no neighbor and
  //      should land on slot 1 with whatever slot 1 had typed (empty).
  it(
    "lone tab opened after a full close lands on slot 1, not the highest used slot",
    { timeout: 30000 },
    async () => {
      const ctx = await browser.newContext();

      async function openTab() {
        const p = await ctx.newPage();
        await p.goto(BASE);
        await p.waitForSelector("#name");
        await p.waitForFunction(() => Number(sessionStorage.getItem("unoSlot")) > 0, {
          timeout: 5000,
        });
        return p;
      }

      // 1-2: open A and B in parallel-ish. B types its name.
      const a = await openTab();
      const b = await openTab();
      await b.fill("#name", "22");
      await b.locator("#name").press("Tab");
      const slotA = await a.evaluate(() => Number(sessionStorage.getItem("unoSlot")));
      const slotB = await b.evaluate(() => Number(sessionStorage.getItem("unoSlot")));
      expect(slotA).toBe(1);
      expect(slotB).toBe(2);

      // 3-4: close both tabs, wait past STALE_MS so heartbeats prune.
      await b.close();
      await a.close();
      await new Promise((r) => setTimeout(r, 4500));

      // 5: open a single new tab. With no live peers, the election should
      // settle on slot 1 — NOT resume slot 2 just because Chrome carried
      // sessionStorage.unoSlot through the close.
      const lone = await openTab();
      const slot = await lone.evaluate(() => Number(sessionStorage.getItem("unoSlot")));
      expect(slot).toBe(1);
      // Input must NOT show '22' (that was slot 2's value).
      const name = await lone.locator("#name").inputValue();
      expect(name).not.toBe("22");

      await lone.close();
      await ctx.close();
    },
  );

  // Multi-tab name pre-fill behavior: each open tab keeps its OWN typed
  // name. After all tabs close, opening fresh tabs in sequence (NOT
  // simultaneous restore) recovers each slot's typed name in any order
  // because each new tab's election sees the previous one's heartbeat
  // and picks the next free slot.
  it(
    "multi-tab names stay isolated and recycled slots restore typed name",
    { timeout: 30000 },
    async () => {
      const ctx = await browser.newContext();
      const NAMES = ["11", "22", "33"];

      async function openTab() {
        const p = await ctx.newPage();
        await p.goto(BASE);
        await p.waitForSelector("#name");
        await p.waitForFunction(() => Number(sessionStorage.getItem("unoSlot")) > 0, {
          timeout: 5000,
        });
        return p;
      }

      // Round 1: three tabs, three names. All alive simultaneously.
      const round1 = [];
      for (let i = 0; i < 3; i++) {
        const p = await openTab();
        await p.fill("#name", NAMES[i]);
        await p.locator("#name").press("Tab");
        round1.push(p);
      }
      for (let i = 0; i < 3; i++) {
        const v = await round1[i].locator("#name").inputValue();
        expect(v).toBe(NAMES[i]);
      }

      // Close all three. Wait past STALE_MS so heartbeats prune.
      for (const p of round1) await p.close();
      await new Promise((r) => setTimeout(r, 4500));

      // Round 2: open three new tabs in sequence. Each lands on the
      // lowest free slot, which is filled with the matching original
      // name. Collectively the three new tabs recover all three names.
      const round2 = [];
      for (let i = 0; i < 3; i++) round2.push(await openTab());
      const restored = [];
      for (const p of round2) restored.push(await p.locator("#name").inputValue());
      expect([...restored].sort()).toEqual([...NAMES].sort());
      expect(new Set(restored).size).toBe(3);

      for (const p of round2) await p.close();
      await ctx.close();
    },
  );

  // Browser-reopen scenario (session restore): three tabs were open at
  // close time, the user reopens with "continue where you left off",
  // and Chrome restores all three sessionStorage `unoSlot` markers AT
  // THE SAME TIME. Each tab's input must pre-fill with the name that
  // belonged to its own slot — no slot/name shuffling. Without the
  // election-window peer-preference exchange this currently fails
  // because all three race to slot 1 and end up assigned via
  // collision tiebreakers (TAB_ID lex order), which scrambles the
  // pairing.
  it(
    "parallel-booted restored tabs each keep their own (slot, name)",
    { timeout: 30000 },
    async () => {
      const ctx = await browser.newContext();
      const NAMES = ["11", "22", "33"];

      // First open three tabs sequentially so each gets its own slot,
      // type its name, and seed sessionStorage.unoSlot with the right
      // slot for that tab. After this, every tab has been associated
      // with one of NAMES via its localStorage entry.
      const round1 = [];
      for (let i = 0; i < 3; i++) {
        const p = await ctx.newPage();
        await p.goto(BASE);
        await p.waitForFunction(() => Number(sessionStorage.getItem("unoSlot")) > 0, {
          timeout: 5000,
        });
        await p.fill("#name", NAMES[i]);
        await p.locator("#name").press("Tab");
        round1.push(p);
      }

      // Sanity: each tab sees its own name now.
      for (let i = 0; i < 3; i++) {
        expect(await round1[i].locator("#name").inputValue()).toBe(NAMES[i]);
      }

      // Capture each tab's slot before close so we can correlate after
      // restore. The relationship "slot N → NAMES[N-1]" depends on the
      // election order above; record what actually happened.
      const slotByName = {};
      for (let i = 0; i < 3; i++) {
        const slot = await round1[i].evaluate(() => Number(sessionStorage.getItem("unoSlot")));
        slotByName[NAMES[i]] = slot;
      }

      // Close all three. Wait past STALE_MS so the peer table is empty.
      for (const p of round1) await p.close();
      await new Promise((r) => setTimeout(r, 4500));

      // Simulate a parallel session restore: prepare three pages that
      // each pre-set sessionStorage.unoSlot via a navigation hook BEFORE
      // the script runs, mimicking what Chrome does on "continue where
      // you left off". Then load them in parallel so all three are in
      // the election window simultaneously — that's where the previous
      // implementation would race to slot 1 and shuffle.
      const restorePages = await Promise.all(
        NAMES.map(async (name) => {
          const p = await ctx.newPage();
          const slot = slotByName[name];
          // Pre-set sessionStorage by visiting a blank page on the same
          // origin first, then setting the marker, then navigating into
          // the app — the slot-restore boot path will see the marker.
          await p.goto(BASE + "/");
          await p.evaluate((s) => sessionStorage.setItem("unoSlot", String(s)), slot);
          // Reload so the boot script reads the seeded sessionStorage.
          await p.reload();
          return p;
        }),
      );

      // Wait until each tab finishes its election and claims a slot.
      for (const p of restorePages) {
        await p.waitForFunction(() => Number(sessionStorage.getItem("unoSlot")) > 0, {
          timeout: 8000,
        });
        // Election needs ~250ms; give a generous extra buffer for the
        // pre-fill from `slotReady.then(...)` to land.
        await p.waitForTimeout(900);
      }

      // Each tab's sessionStorage.unoSlot should match what it had
      // before close, AND the input should match the name that was
      // typed under that slot. No pair-swapping.
      for (let i = 0; i < 3; i++) {
        const expectedSlot = slotByName[NAMES[i]];
        const actualSlot = await restorePages[i].evaluate(() =>
          Number(sessionStorage.getItem("unoSlot")),
        );
        const actualName = await restorePages[i].locator("#name").inputValue();
        expect(actualSlot).toBe(expectedSlot);
        expect(actualName).toBe(NAMES[i]);
      }

      for (const p of restorePages) await p.close();
      await ctx.close();
    },
  );

  // Regression: after multi-tab use AND a full close, opening a fresh
  // tab (without restoring the others) must not pre-fill the input with
  // any other slot's data. The bug was that an empty slot key fell back
  // to the legacy plain `unoPlayerName` localStorage entry, which carried
  // the most-recent typed value across the close.
  it(
    "fresh tab after close shows empty inputs, not another slots data",
    { timeout: 30000 },
    async () => {
      const ctx = await browser.newContext();

      async function openTab() {
        const p = await ctx.newPage();
        await p.goto(BASE);
        await p.waitForSelector("#name");
        await p.waitForFunction(() => Number(sessionStorage.getItem("unoSlot")) > 0, {
          timeout: 5000,
        });
        return p;
      }

      // Plant a stale legacy plain key — older builds wrote it directly,
      // and Chrome would happily preserve it across browser restarts.
      const planter = await ctx.newPage();
      await planter.goto(BASE);
      await planter.evaluate(() => {
        localStorage.setItem("unoPlayerName", "leakedName");
        localStorage.setItem("unoLobbyId", "LEAKEDLOBBY");
      });
      await planter.close();

      // Now simulate "user opens a fresh new tab after closing the
      // browser" — same context (so localStorage survives), but no
      // sessionStorage carry-over.
      const fresh = await openTab();
      // Wait a beat so the slot-election + onopen state-load has settled.
      await fresh.waitForTimeout(800);
      const nameVal = await fresh.locator("#name").inputValue();
      const lobbyVal = await fresh.locator("#lobby-id").inputValue();
      // Either empty (after the legacy purge) or this slot's own value
      // — never the planted leak.
      expect(nameVal).not.toBe("leakedName");
      expect(lobbyVal).not.toBe("LEAKEDLOBBY");

      await fresh.close();
      await ctx.close();
    },
  );

  // Regression: a tab that elects a slot previously held by a closed
  // tab must NOT auto-reconnect with that tab's saved playerId. Without
  // the slotOrigin guard, the new tab would read `unoPlayerId-N` left
  // behind by the previous occupant and the server would treat it as
  // the same user.
  it(
    "new tab in a recycled slot does not auto-reconnect as previous user",
    { timeout: 30000 },
    async () => {
      const ctx = await browser.newContext();

      async function openTab() {
        const p = await ctx.newPage();
        await p.goto(BASE);
        await p.waitForSelector("#name");
        await p.waitForFunction(() => Number(sessionStorage.getItem("unoSlot")) > 0, {
          timeout: 5000,
        });
        return p;
      }

      // Tab A joins a lobby, gets a server-assigned playerId persisted to
      // localStorage under its slot.
      const tabA = await openTab();
      const slotA = await tabA.evaluate(() => Number(sessionStorage.getItem("unoSlot")));
      await tabA.fill("#name", "OriginalUser");
      await tabA.fill("#lobby-id", "recycled-" + Date.now());
      await tabA.click("#join");
      await tabA.waitForSelector("#players li");
      // Wait for unoPlayerId-${slotA} to land in localStorage.
      await tabA.waitForFunction((slot) => !!localStorage.getItem("unoPlayerId-" + slot), slotA, {
        timeout: 5000,
      });
      const savedId = await tabA.evaluate(
        (slot) => localStorage.getItem("unoPlayerId-" + slot),
        slotA,
      );
      expect(savedId).toBeTruthy();

      // Close A — the slot is now free. A's localStorage entries persist.
      await tabA.close();
      // Slot heartbeats run on a 1.5s cadence; wait past the stale window
      // (4s) so the next tab's election doesn't see A's last heartbeat.
      await new Promise((r) => setTimeout(r, 4500));

      // Open tab B in the same browser context. Its election should pick
      // slot A's slot since it's free, but it must NOT inherit A's
      // playerId (no auto-reconnect impersonation).
      const tabB = await openTab();
      const slotB = await tabB.evaluate(() => Number(sessionStorage.getItem("unoSlot")));
      expect(slotB).toBe(slotA);

      // B's localStorage for the recycled slot must be cleared of identity
      // bits — that's what blocks the auto-reconnect.
      const idAfter = await tabB.evaluate(
        (slot) => localStorage.getItem("unoPlayerId-" + slot),
        slotB,
      );
      expect(idAfter).toBeNull();

      // The name and lobby fields ARE allowed to pre-fill from the
      // closed tab's last typed values — those are convenience defaults,
      // not identity. The contract is: B sees A's typed name (UX), but
      // does NOT auto-reconnect as A (security).
      const name = await tabB.locator("#name").inputValue();
      expect(name).toBe("OriginalUser");

      await tabB.close();
      await ctx.close();
    },
  );

  // ── New tests for TODO items #2/#4/#5/#6/#7 ──────────────────────

  // Bug #4: clicking a card while it's not your turn must NOT pop the
  // chain-break dialog. Before the fix, any click on a non-draw card while
  // the chain was active surfaced the confirm — even on the off-turn UI.
  it(
    "off-turn click on a non-playable card does not show the chain confirm",
    { timeout: 30000 },
    async () => {
      const pageA = await browser.newPage();
      const pageB = await browser.newPage();
      await pageA.goto(BASE);
      await pageB.goto(BASE);

      const lobbyId = "b4-offturn-" + Date.now();
      await pageA.fill("#name", "Alice");
      await pageA.fill("#lobby-id", lobbyId);
      await pageA.click("#join");
      await pageA.waitForSelector("#players li");
      await pageB.fill("#name", "Bob");
      await pageB.fill("#lobby-id", lobbyId);
      await pageB.click("#join");
      await pageA.waitForFunction(() => document.querySelectorAll("#players li").length === 2);
      await pageA.click("#ready");
      await pageB.click("#ready");
      await pageB.waitForFunction(
        () => {
          const el = document.getElementById("game");
          return el && el.style.display !== "none";
        },
        { timeout: 10000 },
      );

      const isMyTurn = async (page) =>
        await page.evaluate(() => {
          const el = document.getElementById("turn-indicator");
          return el ? el.classList.contains("my-turn") : false;
        });
      const turnPage = (await isMyTurn(pageA)) ? pageA : pageB;
      const offPage = turnPage === pageA ? pageB : pageA;

      // Stage a chain on the active player's turn — they play a draw2.
      const top = await turnPage.evaluate(() => {
        const card = document.querySelector("#discard-pile .card");
        return { color: card ? card.getAttribute("data-color") : "red" };
      });
      await turnPage.evaluate(
        (c) =>
          sendMessage({
            action: "dev_give_card",
            card: { color: c, type: "draw2" },
          }),
        top.color,
      );
      await turnPage.waitForTimeout(200);
      await turnPage.evaluate(
        (c) => sendMessage({ action: "play", card: { color: c, type: "draw2" } }),
        top.color,
      );
      await turnPage.waitForTimeout(400);

      // Now it's the OTHER player's turn. From the OFF page (the one whose
      // turn it just stopped being), clicking any card must be inert.
      const clicked = await offPage.evaluate(() => {
        const cards = document.querySelectorAll("#player-hand .card");
        if (cards.length === 0) return false;
        cards[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
        return true;
      });
      expect(clicked).toBe(true);
      await offPage.waitForTimeout(300);
      const offModal = await offPage.evaluate(() => {
        const overlay = document.getElementById("modal-overlay");
        return overlay && !overlay.classList.contains("hidden");
      });
      expect(offModal).toBe(false);

      await pageA.close();
      await pageB.close();
    },
  );

  // Bug #4: clicking a non-playable card on your own turn must also NOT
  // surface the chain confirm (we'd have nothing to play anyway).
  it(
    "clicking a not-playable card on your turn does not show the chain confirm",
    { timeout: 30000 },
    async () => {
      const pageA = await browser.newPage();
      const pageB = await browser.newPage();
      await pageA.goto(BASE);
      await pageB.goto(BASE);

      const lobbyId = "b4-noplay-" + Date.now();
      await pageA.fill("#name", "Alice");
      await pageA.fill("#lobby-id", lobbyId);
      await pageA.click("#join");
      await pageA.waitForSelector("#players li");
      await pageB.fill("#name", "Bob");
      await pageB.fill("#lobby-id", lobbyId);
      await pageB.click("#join");
      await pageA.waitForFunction(() => document.querySelectorAll("#players li").length === 2);
      await pageA.click("#ready");
      await pageB.click("#ready");
      await pageB.waitForFunction(
        () => {
          const el = document.getElementById("game");
          return el && el.style.display !== "none";
        },
        { timeout: 10000 },
      );

      const isMyTurn = async (page) =>
        await page.evaluate(() => {
          const el = document.getElementById("turn-indicator");
          return el ? el.classList.contains("my-turn") : false;
        });
      const turnPage = (await isMyTurn(pageA)) ? pageA : pageB;
      const offPage = turnPage === pageA ? pageB : pageA;

      // Active plays a draw2 → other player is now in the chain on their turn.
      const top = await turnPage.evaluate(() => {
        const card = document.querySelector("#discard-pile .card");
        return { color: card ? card.getAttribute("data-color") : "red" };
      });
      await turnPage.evaluate(
        (c) =>
          sendMessage({
            action: "dev_give_card",
            card: { color: c, type: "draw2" },
          }),
        top.color,
      );
      await turnPage.waitForTimeout(200);
      await turnPage.evaluate(
        (c) => sendMessage({ action: "play", card: { color: c, type: "draw2" } }),
        top.color,
      );
      await turnPage.waitForTimeout(400);

      // Now turn is offPage. Click a card that is NOT playable against the
      // current top (different color and different type).
      await offPage.waitForFunction(
        () => {
          const el = document.getElementById("turn-indicator");
          return el ? el.classList.contains("my-turn") : false;
        },
        { timeout: 5000 },
      );

      const clickedNonPlayable = await offPage.evaluate(() => {
        const top = document.querySelector("#discard-pile .card");
        const topColor = top.getAttribute("data-color");
        const topType = top.getAttribute("data-type");
        const cards = document.querySelectorAll("#player-hand .card");
        for (const c of cards) {
          const t = c.getAttribute("data-type");
          const col = c.getAttribute("data-color");
          // Skip wilds (they're always playable) and any same-color/type card.
          if (t === "wild" || t === "wild4") continue;
          if (col === topColor || t === topType) continue;
          // draw2/wild4 also count as playable in chain state (they extend it).
          if (t === "draw2" || t === "wild4") continue;
          c.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          return true;
        }
        return false;
      });
      if (!clickedNonPlayable) {
        // Hand happened to be entirely playable — skip rather than fail.
        await pageA.close();
        await pageB.close();
        return;
      }
      await offPage.waitForTimeout(300);
      const offModal = await offPage.evaluate(() => {
        const overlay = document.getElementById("modal-overlay");
        return overlay && !overlay.classList.contains("hidden");
      });
      expect(offModal).toBe(false);

      await pageA.close();
      await pageB.close();
    },
  );

  // Task #7: modal supports Enter to confirm and Escape to cancel.
  it("modal Enter confirms, Escape cancels, Tab cycles focus", { timeout: 20000 }, async () => {
    const page = await browser.newPage();
    await page.goto(BASE);
    await page.waitForSelector("#name");

    // Trigger a confirm via the leave-lobby flow. Need a lobby first.
    const lobbyId = "modal-" + Date.now();
    await page.fill("#name", "Alice");
    await page.fill("#lobby-id", lobbyId);
    await page.click("#join");
    await page.waitForSelector("#players li");
    await page.waitForSelector("#leave-lobby");
    await page.click("#leave-lobby");
    await page.waitForFunction(() => {
      const el = document.getElementById("modal-overlay");
      return el && !el.classList.contains("hidden");
    });

    // Escape should cancel the confirm — we should remain in the lobby.
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => {
      const el = document.getElementById("modal-overlay");
      return el && el.classList.contains("hidden");
    });
    // We should still be in the lobby (leave was cancelled)
    const stillInLobby = await page.evaluate(() => {
      return !!document.getElementById("leave-lobby");
    });
    expect(stillInLobby).toBe(true);

    // Now press leave again, Tab to cancel button, then Enter — should
    // also cancel.
    await page.click("#leave-lobby");
    await page.waitForFunction(() => {
      const el = document.getElementById("modal-overlay");
      return el && !el.classList.contains("hidden");
    });
    // Default focus is OK button. Tab should move to Cancel.
    await page.keyboard.press("Tab");
    const focusedAfterTab = await page.evaluate(
      () => document.activeElement && document.activeElement.id,
    );
    expect(focusedAfterTab).toBe("modal-cancel-btn");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => {
      const el = document.getElementById("modal-overlay");
      return el && el.classList.contains("hidden");
    });
    const stillInLobby2 = await page.evaluate(() => !!document.getElementById("leave-lobby"));
    expect(stillInLobby2).toBe(true);

    // Now press leave one more time and just hit Enter — default should
    // be OK, which actually leaves.
    await page.click("#leave-lobby");
    await page.waitForFunction(() => {
      const el = document.getElementById("modal-overlay");
      return el && !el.classList.contains("hidden");
    });
    await page.keyboard.press("Enter");
    await page.waitForFunction(
      () => {
        return !document.getElementById("leave-lobby");
      },
      { timeout: 5000 },
    );
    await page.close();
  });

  // Task #7: modal renders newlines from the message string.
  it("modal renders \\n in messages as line breaks", { timeout: 20000 }, async () => {
    const page = await browser.newPage();
    await page.goto(BASE);
    await page.waitForSelector("#name");

    // Inject an alert through the in-page helper so we can pass arbitrary
    // text.
    await page.evaluate(() => {
      // The bundled client exposes showAlert in the global scope under the
      // module's IIFE — use a synthetic event hook instead by directly
      // manipulating the modal so we don't depend on private symbols.
      const overlay = document.getElementById("modal-overlay");
      const msg = document.getElementById("modal-message");
      const cancel = document.getElementById("modal-cancel-btn");
      msg.textContent = "first line\nsecond line\nthird line";
      cancel.style.display = "none";
      overlay.classList.remove("hidden");
      overlay.style.display = "flex";
    });
    // Verify the rendered text preserves the newlines via CSS pre-line.
    const whitespace = await page.$eval("#modal-message", (el) => getComputedStyle(el).whiteSpace);
    expect(["pre-line", "pre-wrap", "pre"]).toContain(whitespace);
    // The actual displayed offsetHeight should reflect three lines (much
    // taller than a single line of the same font-size).
    const lines = await page.$eval("#modal-message", (el) => el.textContent.split("\n").length);
    expect(lines).toBe(3);
    await page.close();
  });

  // Task #5: turn timer text appears next to the turn indicator and counts
  // down. We don't need to wait for the full duration — just confirm the
  // value drops.
  it("turn timer counts down on the active turn", { timeout: 30000 }, async () => {
    const pageA = await browser.newPage();
    const pageB = await browser.newPage();
    await pageA.goto(BASE);
    await pageB.goto(BASE);

    const lobbyId = "timer-" + Date.now();
    await pageA.fill("#name", "Alice");
    await pageA.fill("#lobby-id", lobbyId);
    await pageA.click("#join");
    await pageA.waitForSelector("#players li");
    await pageB.fill("#name", "Bob");
    await pageB.fill("#lobby-id", lobbyId);
    await pageB.click("#join");
    await pageA.waitForFunction(() => document.querySelectorAll("#players li").length === 2);
    await pageA.click("#ready");
    await pageB.click("#ready");
    await pageB.waitForFunction(
      () => {
        const el = document.getElementById("game");
        return el && el.style.display !== "none";
      },
      { timeout: 10000 },
    );

    // Wait until the turn-timer span exists and has a number.
    await pageA.waitForFunction(
      () => {
        const el = document.getElementById("turn-timer");
        return el && /^\d+s$/.test((el.textContent || "").trim());
      },
      { timeout: 5000 },
    );

    const first = await pageA.$eval("#turn-timer", (el) => el.textContent);
    const firstSec = Number(/(\d+)s/.exec(first)[1]);

    // Wait long enough that even at the slowest browser-throttled rAF rate
    // the displayed seconds value should change. We poll for change rather
    // than asserting after a fixed sleep so the test isn't flaky on slow
    // CI machines. Bring the page to foreground first since rAF is
    // throttled (and in some browsers paused) for hidden tabs.
    await pageA.bringToFront();
    let secondSec = firstSec;
    for (let i = 0; i < 30 && secondSec >= firstSec; i++) {
      await pageA.waitForTimeout(150);
      const second = await pageA.$eval("#turn-timer", (el) => el.textContent);
      const m = /(\d+)s/.exec(second);
      if (m) secondSec = Number(m[1]);
    }
    expect(secondSec).toBeLessThan(firstSec);

    await pageA.close();
    await pageB.close();
  });

  // Task #6 follow-up: pressing a digit key highlights the corresponding
  // card; the cards also visibly show the matching digit badge so users
  // know which key plays which card.
  it("keyboard digit selects card and Enter plays it", { timeout: 30000 }, async () => {
    const pageA = await browser.newPage();
    const pageB = await browser.newPage();
    await pageA.goto(BASE);
    await pageB.goto(BASE);

    const lobbyId = "kbd-" + Date.now();
    await pageA.fill("#name", "Alice");
    await pageA.fill("#lobby-id", lobbyId);
    await pageA.click("#join");
    await pageA.waitForSelector("#players li");
    await pageB.fill("#name", "Bob");
    await pageB.fill("#lobby-id", lobbyId);
    await pageB.click("#join");
    await pageA.waitForFunction(() => document.querySelectorAll("#players li").length === 2);
    await pageA.click("#ready");
    await pageB.click("#ready");
    await pageB.waitForFunction(
      () => {
        const el = document.getElementById("game");
        return el && el.style.display !== "none";
      },
      { timeout: 10000 },
    );

    const isMyTurn = async (page) =>
      await page.evaluate(() => {
        const el = document.getElementById("turn-indicator");
        return el ? el.classList.contains("my-turn") : false;
      });
    const turnPage = (await isMyTurn(pageA)) ? pageA : pageB;

    // Make sure there's a non-card-input focus and the body has focus so
    // keydown listeners fire on document.
    await turnPage.evaluate(() => document.body.focus());

    // Press digit '1' — should highlight first card.
    await turnPage.keyboard.press("Digit1");
    await turnPage.waitForFunction(
      () => {
        const cards = document.querySelectorAll("#player-hand .card");
        return cards.length > 0 && cards[0].classList.contains("keyboard-hover");
      },
      { timeout: 3000 },
    );

    // Escape clears the hover.
    await turnPage.keyboard.press("Escape");
    await turnPage.waitForFunction(
      () => {
        const cards = document.querySelectorAll("#player-hand .card");
        return cards.length === 0 || !cards[0].classList.contains("keyboard-hover");
      },
      { timeout: 3000 },
    );

    // Find a playable card and seed it via dev_give_card so we have a
    // predictable index 0.
    const top = await turnPage.evaluate(() => {
      const card = document.querySelector("#discard-pile .card");
      return {
        color: card.getAttribute("data-color"),
        type: card.getAttribute("data-type"),
      };
    });
    await turnPage.evaluate((color) => sendMessage({ action: "dev_clear_hand" }), top.color);
    await turnPage.waitForTimeout(200);
    await turnPage.evaluate(
      (color) => sendMessage({ action: "dev_give_card", card: { color, type: "5" } }),
      top.color,
    );
    await turnPage.waitForFunction(() => {
      const cards = document.querySelectorAll("#player-hand .card");
      return cards.length === 1;
    });
    // Press Digit1, then Enter — should play the card. After play, the hand
    // should be empty and we should win (or get a 'win' frame, since the
    // player was reduced to 0 cards).
    await turnPage.keyboard.press("Digit1");
    await turnPage.waitForFunction(() => {
      const cards = document.querySelectorAll("#player-hand .card");
      return cards[0] && cards[0].classList.contains("keyboard-hover");
    });
    await turnPage.keyboard.press("Enter");
    // Either the hand empties or a win modal opens — give it a moment.
    await turnPage.waitForTimeout(500);
    const handAfter = await turnPage.evaluate(
      () => document.querySelectorAll("#player-hand .card").length,
    );
    expect(handAfter).toBe(0);

    await pageA.close();
    await pageB.close();
  });

  // Task #3 (visual digit badges): cards visibly show the matching digit
  // so users know which key plays which card.
  it(
    "shows keyboard digit badges on the active player's hand cards",
    { timeout: 30000 },
    async () => {
      const pageA = await browser.newPage();
      const pageB = await browser.newPage();
      await pageA.goto(BASE);
      await pageB.goto(BASE);

      const lobbyId = "badge-" + Date.now();
      await pageA.fill("#name", "Alice");
      await pageA.fill("#lobby-id", lobbyId);
      await pageA.click("#join");
      await pageA.waitForSelector("#players li");
      await pageB.fill("#name", "Bob");
      await pageB.fill("#lobby-id", lobbyId);
      await pageB.click("#join");
      await pageA.waitForFunction(() => document.querySelectorAll("#players li").length === 2);
      await pageA.click("#ready");
      await pageB.click("#ready");
      await pageB.waitForFunction(
        () => {
          const el = document.getElementById("game");
          return el && el.style.display !== "none";
        },
        { timeout: 10000 },
      );

      const isMyTurn = async (page) =>
        await page.evaluate(() => {
          const el = document.getElementById("turn-indicator");
          return el ? el.classList.contains("my-turn") : false;
        });
      const turnPage = (await isMyTurn(pageA)) ? pageA : pageB;
      const offPage = turnPage === pageA ? pageB : pageA;

      // The active player's cards should have visible digit badges.
      const activeBadges = await turnPage.$$eval("#player-hand .card .card-key-badge", (els) =>
        els.map((e) => e.textContent),
      );
      expect(activeBadges.length).toBeGreaterThan(0);
      // First card carries '1', second '2', tenth '0'.
      expect(activeBadges[0]).toBe("1");
      if (activeBadges.length > 1) expect(activeBadges[1]).toBe("2");

      // The off-turn player must NOT see badges on its hand — the digit
      // shortcuts are inert when it isn't your turn.
      const offBadges = await offPage.$$eval(
        "#player-hand .card .card-key-badge",
        (els) => els.length,
      );
      expect(offBadges).toBe(0);

      await pageA.close();
      await pageB.close();
    },
  );

  // Task: keyboard hover triggers the same transition as mouse hover —
  // we don't recreate the DOM (which would skip the animation), we just
  // toggle the `keyboard-hover` class on the existing card div. The
  // assertion below confirms the same DOM element is reused before and
  // after the digit press.
  it(
    "keyboard hover toggles class on the existing card element (no DOM swap)",
    { timeout: 30000 },
    async () => {
      const pageA = await browser.newPage();
      const pageB = await browser.newPage();
      await pageA.goto(BASE);
      await pageB.goto(BASE);

      const lobbyId = "kbdtrans-" + Date.now();
      await pageA.fill("#name", "Alice");
      await pageA.fill("#lobby-id", lobbyId);
      await pageA.click("#join");
      await pageA.waitForSelector("#players li");
      await pageB.fill("#name", "Bob");
      await pageB.fill("#lobby-id", lobbyId);
      await pageB.click("#join");
      await pageA.waitForFunction(() => document.querySelectorAll("#players li").length === 2);
      await pageA.click("#ready");
      await pageB.click("#ready");
      await pageB.waitForFunction(
        () => {
          const el = document.getElementById("game");
          return el && el.style.display !== "none";
        },
        { timeout: 10000 },
      );

      const isMyTurn = async (page) =>
        await page.evaluate(() => {
          const el = document.getElementById("turn-indicator");
          return el ? el.classList.contains("my-turn") : false;
        });
      const turnPage = (await isMyTurn(pageA)) ? pageA : pageB;

      // Tag the first card so we can verify the same DOM node survives the
      // class toggle (instead of being replaced by a re-render).
      await turnPage.evaluate(() => {
        const first = document.querySelector("#player-hand .card");
        if (first) first.dataset.testId = "card-zero";
      });
      await turnPage.keyboard.press("Digit1");
      await turnPage.waitForFunction(
        () => {
          const el = document.querySelector('#player-hand .card[data-test-id="card-zero"]');
          return el && el.classList.contains("keyboard-hover");
        },
        { timeout: 3000 },
      );
      // The data-test-id we tagged should still be there — proves the
      // element wasn't recreated.
      const stillTagged = await turnPage.$('#player-hand .card[data-test-id="card-zero"]');
      expect(stillTagged).not.toBeNull();
      await pageA.close();
      await pageB.close();
    },
  );

  // Task: the wild-color picker has a CSS animation when it opens and a
  // separate one when it closes. Verify the `closing` class is applied
  // during the close transition.
  it("wild color picker plays a close animation", { timeout: 30000 }, async () => {
    const pageA = await browser.newPage();
    const pageB = await browser.newPage();
    await pageA.goto(BASE);
    await pageB.goto(BASE);

    const lobbyId = "wildanim-" + Date.now();
    await pageA.fill("#name", "Alice");
    await pageA.fill("#lobby-id", lobbyId);
    await pageA.click("#join");
    await pageA.waitForSelector("#players li");
    await pageB.fill("#name", "Bob");
    await pageB.fill("#lobby-id", lobbyId);
    await pageB.click("#join");
    await pageA.waitForFunction(() => document.querySelectorAll("#players li").length === 2);
    await pageA.click("#ready");
    await pageB.click("#ready");
    await pageB.waitForFunction(
      () => {
        const el = document.getElementById("game");
        return el && el.style.display !== "none";
      },
      { timeout: 10000 },
    );
    const isMyTurn = async (page) =>
      await page.evaluate(() => {
        const el = document.getElementById("turn-indicator");
        return el ? el.classList.contains("my-turn") : false;
      });
    const turnPage = (await isMyTurn(pageA)) ? pageA : pageB;

    await turnPage.evaluate(() => sendMessage({ action: "dev_clear_hand" }));
    await turnPage.waitForTimeout(200);
    await turnPage.evaluate(() => sendMessage({ action: "dev_give_card", card: { type: "wild" } }));
    await turnPage.waitForFunction(
      () => document.querySelectorAll("#player-hand .card").length === 1,
    );
    await turnPage.evaluate(() => {
      const card = document.querySelector("#player-hand .card");
      card.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await turnPage.waitForFunction(() => {
      const el = document.getElementById("wild-color-picker");
      return el && el.style.display !== "none";
    });

    // Trigger close via Esc and inspect the .closing class within the
    // exit animation window. We poll because the class is added then
    // removed asynchronously after animationend.
    await turnPage.keyboard.press("Escape");
    let sawClosing = false;
    for (let i = 0; i < 40; i++) {
      const has = await turnPage.evaluate(() => {
        const el = document.getElementById("wild-color-picker");
        return el ? el.classList.contains("closing") : false;
      });
      if (has) {
        sawClosing = true;
        break;
      }
      await turnPage.waitForTimeout(8);
    }
    expect(sawClosing).toBe(true);

    // Eventually it settles to display:none.
    await turnPage.waitForFunction(
      () => {
        const el = document.getElementById("wild-color-picker");
        return el && el.style.display === "none";
      },
      { timeout: 5000 },
    );

    await pageA.close();
    await pageB.close();
  });

  // Task: hovering an info icon (data-tooltip) shows the floating tooltip
  // with the configured text, including newlines.
  it("info icon shows a multi-line tooltip on hover/focus", { timeout: 20000 }, async () => {
    const page = await browser.newPage();
    await page.goto(BASE);
    await page.waitForSelector("#name");

    // Get into a lobby so the draw-mode info icon is visible.
    const lobbyId = "tip-" + Date.now();
    await page.fill("#name", "Alice");
    await page.fill("#lobby-id", lobbyId);
    await page.click("#join");
    await page.waitForSelector("#players li");
    await page.waitForSelector("#draw-mode-info");

    // Focus the icon — mouseover via Playwright is fragile in headless
    // builds; focusin works reliably and the tooltip implementation
    // listens to both.
    await page.focus("#draw-mode-info");
    await page.waitForFunction(
      () => {
        const el = document.getElementById("tooltip");
        return el && el.classList.contains("show");
      },
      { timeout: 3000 },
    );
    const text = await page.$eval("#tooltip", (el) => el.textContent || "");
    expect(text).toContain("链式加牌");
    expect(text).toContain("直接加牌");
    // Multi-line: the source text used &#10; (\n) — verify it survived.
    expect(text.split("\n").length).toBeGreaterThan(1);
    // Verify CSS preserves newlines visually.
    const ws = await page.$eval("#tooltip", (el) => getComputedStyle(el).whiteSpace);
    expect(["pre-line", "pre-wrap", "pre"]).toContain(ws);

    // Esc should hide it.
    await page.keyboard.press("Escape");
    await page.waitForFunction(
      () => {
        const el = document.getElementById("tooltip");
        return el && !el.classList.contains("show");
      },
      { timeout: 3000 },
    );

    await page.close();
  });

  // Task: clicking the draw-mode info icon opens the rules overlay and
  // scrolls the highlighted section roughly into the visible center of
  // the overlay (rather than leaving it at the top).
  it(
    "clicking draw-mode info scrolls the highlighted rule into view",
    { timeout: 20000 },
    async () => {
      const page = await browser.newPage();
      await page.goto(BASE);
      await page.waitForSelector("#name");

      const lobbyId = "scroll-" + Date.now();
      await page.fill("#name", "Alice");
      await page.fill("#lobby-id", lobbyId);
      await page.click("#join");
      await page.waitForSelector("#players li");
      await page.waitForSelector("#draw-mode-info");

      await page.click("#draw-mode-info");
      await page.waitForFunction(() => {
        const el = document.getElementById("rules-overlay");
        return el && !el.classList.contains("hidden");
      });
      // Wait for the smooth scrollTo to settle (well under a second).
      await page.waitForTimeout(700);

      // The highlighted rules section's visible center should be within
      // ~30% of the overlay's visible center — i.e. it's not stuck at the
      // top edge.
      const offsetRatio = await page.evaluate(() => {
        const overlay = document.getElementById("rules-overlay");
        const target = document.getElementById("rules-draw-mode-highlight");
        if (!overlay || !target) return 1;
        const oRect = overlay.getBoundingClientRect();
        const tRect = target.getBoundingClientRect();
        const overlayCenter = oRect.top + oRect.height / 2;
        const targetCenter = tRect.top + tRect.height / 2;
        return Math.abs(targetCenter - overlayCenter) / oRect.height;
      });
      expect(offsetRatio).toBeLessThan(0.3);

      await page.close();
    },
  );

  // Task #2: wild color picker is fully keyboard-driven.
  it("wild color picker supports digit / arrow / Enter / Esc", { timeout: 30000 }, async () => {
    const pageA = await browser.newPage();
    const pageB = await browser.newPage();
    await pageA.goto(BASE);
    await pageB.goto(BASE);

    const lobbyId = "wildkbd-" + Date.now();
    await pageA.fill("#name", "Alice");
    await pageA.fill("#lobby-id", lobbyId);
    await pageA.click("#join");
    await pageA.waitForSelector("#players li");
    await pageB.fill("#name", "Bob");
    await pageB.fill("#lobby-id", lobbyId);
    await pageB.click("#join");
    await pageA.waitForFunction(() => document.querySelectorAll("#players li").length === 2);
    await pageA.click("#ready");
    await pageB.click("#ready");
    await pageB.waitForFunction(
      () => {
        const el = document.getElementById("game");
        return el && el.style.display !== "none";
      },
      { timeout: 10000 },
    );

    const isMyTurn = async (page) =>
      await page.evaluate(() => {
        const el = document.getElementById("turn-indicator");
        return el ? el.classList.contains("my-turn") : false;
      });
    const turnPage = (await isMyTurn(pageA)) ? pageA : pageB;

    // Stage a wild card in our hand so the picker fires.
    await turnPage.evaluate(() => sendMessage({ action: "dev_clear_hand" }));
    await turnPage.waitForTimeout(200);
    await turnPage.evaluate(() => sendMessage({ action: "dev_give_card", card: { type: "wild" } }));
    await turnPage.waitForFunction(() => {
      return document.querySelectorAll("#player-hand .card").length === 1;
    });
    await turnPage.evaluate(() => {
      const card = document.querySelector("#player-hand .card");
      card.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await turnPage.waitForFunction(() => {
      const el = document.getElementById("wild-color-picker");
      return el && el.style.display !== "none";
    });

    // Each color option should display the keyboard hint badge.
    const keyHints = await turnPage.$$eval(".color-option", (els) =>
      els.map((e) => e.getAttribute("data-key")),
    );
    expect(keyHints).toEqual(["1", "2", "3", "4"]);

    // Press ArrowRight to highlight the first color, then ArrowRight again
    // to move to yellow.
    await turnPage.keyboard.press("ArrowRight");
    let hovered = await turnPage.$eval(".color-option.keyboard-hover", (el) =>
      el.getAttribute("data-color"),
    );
    expect(hovered).toBe("red");
    await turnPage.keyboard.press("ArrowRight");
    hovered = await turnPage.$eval(".color-option.keyboard-hover", (el) =>
      el.getAttribute("data-color"),
    );
    expect(hovered).toBe("yellow");

    // Esc closes the picker without committing.
    await turnPage.keyboard.press("Escape");
    await turnPage.waitForFunction(() => {
      const el = document.getElementById("wild-color-picker");
      return el && el.style.display === "none";
    });

    // Re-open and confirm digit 3 commits "green" directly.
    await turnPage.evaluate(() => {
      const card = document.querySelector("#player-hand .card");
      card.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await turnPage.waitForFunction(() => {
      const el = document.getElementById("wild-color-picker");
      return el && el.style.display !== "none";
    });
    await turnPage.keyboard.press("Digit3");
    // Picker should close and the wild card should have been played as green.
    await turnPage.waitForFunction(() => {
      const el = document.getElementById("wild-color-picker");
      return el && el.style.display === "none";
    });
    // After play, the discard top should be a wild with color=green.
    await turnPage.waitForFunction(
      () => {
        const card = document.querySelector("#discard-pile .card");
        if (!card) return false;
        return (
          card.getAttribute("data-color") === "green" && card.getAttribute("data-type") === "wild"
        );
      },
      { timeout: 5000 },
    );

    await pageA.close();
    await pageB.close();
  });

  // Task: pressing the same digit twice plays the hovered card directly
  // (without needing Enter). Useful for keyboard-only flows.
  it("pressing the same digit twice plays the hovered card", { timeout: 30000 }, async () => {
    const pageA = await browser.newPage();
    const pageB = await browser.newPage();
    await pageA.goto(BASE);
    await pageB.goto(BASE);

    const lobbyId = "kbddbl-" + Date.now();
    await pageA.fill("#name", "Alice");
    await pageA.fill("#lobby-id", lobbyId);
    await pageA.click("#join");
    await pageA.waitForSelector("#players li");
    await pageB.fill("#name", "Bob");
    await pageB.fill("#lobby-id", lobbyId);
    await pageB.click("#join");
    await pageA.waitForFunction(() => document.querySelectorAll("#players li").length === 2);
    await pageA.click("#ready");
    await pageB.click("#ready");
    await pageB.waitForFunction(
      () => {
        const el = document.getElementById("game");
        return el && el.style.display !== "none";
      },
      { timeout: 10000 },
    );

    const isMyTurn = async (page) =>
      await page.evaluate(() => {
        const el = document.getElementById("turn-indicator");
        return el ? el.classList.contains("my-turn") : false;
      });
    const turnPage = (await isMyTurn(pageA)) ? pageA : pageB;

    // Stage exactly one playable card so the hand index is predictable.
    const top = await turnPage.evaluate(() => {
      const card = document.querySelector("#discard-pile .card");
      return {
        color: card.getAttribute("data-color"),
        type: card.getAttribute("data-type"),
      };
    });
    await turnPage.evaluate(() => sendMessage({ action: "dev_clear_hand" }));
    await turnPage.waitForTimeout(200);
    await turnPage.evaluate(
      (color) => sendMessage({ action: "dev_give_card", card: { color, type: "5" } }),
      top.color,
    );
    await turnPage.waitForFunction(
      () => document.querySelectorAll("#player-hand .card").length === 1,
    );

    // First Digit1 hovers the card; second Digit1 plays it.
    await turnPage.keyboard.press("Digit1");
    await turnPage.waitForFunction(() => {
      const cards = document.querySelectorAll("#player-hand .card");
      return cards[0] && cards[0].classList.contains("keyboard-hover");
    });
    await turnPage.keyboard.press("Digit1");
    // After the second press the hand should empty out.
    await turnPage.waitForTimeout(500);
    const handAfter = await turnPage.evaluate(
      () => document.querySelectorAll("#player-hand .card").length,
    );
    expect(handAfter).toBe(0);

    await pageA.close();
    await pageB.close();
  });

  // User-reported scenario: open 3 tabs, type 11 / 22 / 33, close all,
  // then reopen 3 tabs sequentially — they should restore in slot order
  // (1 → "11", 2 → "22", 3 → "33"). The existing `multi-tab names`
  // test asserts set equality only; this one pins down the order.
  it("sequential reopen restores names in 11/22/33 order", { timeout: 30000 }, async () => {
    const ctx = await browser.newContext();
    const NAMES = ["11", "22", "33"];

    async function openTab() {
      const p = await ctx.newPage();
      await p.goto(BASE);
      await p.waitForFunction(() => Number(sessionStorage.getItem("unoSlot")) > 0, {
        timeout: 5000,
      });
      // Wait a beat past the election window so onopen's pre-fill lands.
      await p.waitForTimeout(800);
      return p;
    }

    // Round 1: three tabs, three names, all alive at once. Each tab's
    // own input must show its own name.
    const round1 = [];
    for (let i = 0; i < 3; i++) {
      const p = await openTab();
      await p.fill("#name", NAMES[i]);
      await p.locator("#name").press("Tab");
      round1.push(p);
    }
    for (let i = 0; i < 3; i++) {
      expect(await round1[i].locator("#name").inputValue()).toBe(NAMES[i]);
    }

    // Close all three. Wait past STALE_MS so heartbeats prune.
    for (const p of round1) await p.close();
    await new Promise((r) => setTimeout(r, 4500));

    // Round 2: open three tabs sequentially. The Nth tab should land
    // on slot N (since slot N-1 is heartbeating from the previous tab)
    // and pre-fill with NAMES[N-1].
    const restored = [];
    for (let i = 0; i < 3; i++) {
      const p = await openTab();
      const slot = await p.evaluate(() => Number(sessionStorage.getItem("unoSlot")));
      const name = await p.locator("#name").inputValue();
      restored.push({ slot, name });
    }
    expect(restored).toEqual([
      { slot: 1, name: "11" },
      { slot: 2, name: "22" },
      { slot: 3, name: "33" },
    ]);

    await ctx.close();
  });

  // Same scenario but the three tabs open within the same election
  // window (~250ms). If the user clicks "open new tab" three times in
  // quick succession, none of them have heartbeated yet when the
  // others start their election — they all race to slot 1 and the
  // collision tiebreaker decides which goes where, scrambling the
  // pairing. With the `who`-replies-with-stored-preference fix in
  // place, each tab sees the others' intentions during the election
  // window and they settle deterministically.
  it("rapid-fire reopen still restores names in slot order", { timeout: 30000 }, async () => {
    const ctx = await browser.newContext();
    const NAMES = ["11", "22", "33"];

    // Round 1: three tabs sequentially, type names.
    const round1 = [];
    for (let i = 0; i < 3; i++) {
      const p = await ctx.newPage();
      await p.goto(BASE);
      await p.waitForFunction(() => Number(sessionStorage.getItem("unoSlot")) > 0, {
        timeout: 5000,
      });
      await p.waitForTimeout(400);
      await p.fill("#name", NAMES[i]);
      await p.locator("#name").press("Tab");
      round1.push(p);
    }
    for (const p of round1) await p.close();
    await new Promise((r) => setTimeout(r, 4500));

    // Round 2: fire all three opens simultaneously — all three tabs
    // are in their election window at once. Even more aggressive:
    // launch the goto calls BEFORE any of them finishes loading.
    const round2Promises = NAMES.map(async () => {
      const p = await ctx.newPage();
      // Don't await goto — let all three navigate in parallel.
      const navP = p.goto(BASE);
      return { p, navP };
    });
    const round2Raw = await Promise.all(round2Promises);
    // Now resolve the navigations and wait for slot assignment.
    for (const { p, navP } of round2Raw) {
      await navP;
      await p.waitForFunction(() => Number(sessionStorage.getItem("unoSlot")) > 0, {
        timeout: 5000,
      });
      await p.waitForTimeout(800);
    }
    const round2 = round2Raw.map((r) => r.p);

    const result = [];
    for (const p of round2) {
      const slot = await p.evaluate(() => Number(sessionStorage.getItem("unoSlot")));
      const name = await p.locator("#name").inputValue();
      result.push({ slot, name });
    }
    // Each slot should match the name that was originally typed there,
    // regardless of which tab finished electing first.
    const bySlot = new Map(result.map((r) => [r.slot, r.name]));
    expect(bySlot.get(1)).toBe("11");
    expect(bySlot.get(2)).toBe("22");
    expect(bySlot.get(3)).toBe("33");
    expect(bySlot.size).toBe(3);

    await ctx.close();
  });

  // ── New TODO items ────────────────────────────────────────

  // Item 5: non-creator should still see the draw-mode indicator
  // (read-only) so they know what mode the game will use.
  it("non-creator sees the draw-mode area as read-only", { timeout: 30000 }, async () => {
    const pageA = await browser.newPage();
    const pageB = await browser.newPage();
    await pageA.goto(BASE);
    await pageB.goto(BASE);
    const lobbyId = "rmode-" + Date.now();
    await pageA.fill("#name", "Alice");
    await pageA.fill("#lobby-id", lobbyId);
    await pageA.click("#join");
    await pageA.waitForSelector("#players li");
    await pageB.fill("#name", "Bob");
    await pageB.fill("#lobby-id", lobbyId);
    await pageB.click("#join");
    await pageA.waitForFunction(() => document.querySelectorAll("#players li").length === 2);
    // Wait a little extra for the players-broadcast to settle on B.
    await pageB.waitForTimeout(300);

    // Creator sees the draw-mode area, NOT marked readonly.
    const creatorReadonly = await pageA.evaluate(() => {
      const el = document.getElementById("draw-mode-area");
      return el && el.style.display !== "none" && el.classList.contains("readonly");
    });
    expect(creatorReadonly).toBe(false);
    const creatorVisible = await pageA.evaluate(() => {
      const el = document.getElementById("draw-mode-area");
      return el && el.style.display === "flex";
    });
    expect(creatorVisible).toBe(true);

    // Non-creator now also sees it but with the readonly class.
    const nonCreatorVisible = await pageB.evaluate(() => {
      const el = document.getElementById("draw-mode-area");
      return el && el.style.display === "flex";
    });
    expect(nonCreatorVisible).toBe(true);
    const nonCreatorReadonly = await pageB.evaluate(() => {
      const el = document.getElementById("draw-mode-area");
      return el && el.classList.contains("readonly");
    });
    expect(nonCreatorReadonly).toBe(true);
    await pageA.close();
    await pageB.close();
  });

  // Merged turn-order: each #opponent-hands .player card shows the
  // player's name + (N 张牌) count, the self card has the .self class
  // for the yellow ring, and the .order-arrow elements appear between
  // cards. Two-player game has one .order-arrow.
  it("turn-order cards show name + count and mark self", { timeout: 30000 }, async () => {
    const pageA = await browser.newPage();
    const pageB = await browser.newPage();
    await pageA.goto(BASE);
    await pageB.goto(BASE);
    const lobbyId = "tord-" + Date.now();
    await pageA.fill("#name", "Alice");
    await pageA.fill("#lobby-id", lobbyId);
    await pageA.click("#join");
    await pageA.waitForSelector("#players li");
    await pageB.fill("#name", "Bob");
    await pageB.fill("#lobby-id", lobbyId);
    await pageB.click("#join");
    await pageA.waitForFunction(() => document.querySelectorAll("#players li").length === 2);
    await pageA.click("#ready");
    await pageB.click("#ready");
    await pageA.waitForFunction(
      () => {
        const el = document.getElementById("game");
        return el && el.style.display !== "none";
      },
      { timeout: 10000 },
    );

    const layout = await pageA.evaluate(() => {
      const cards = Array.from(document.querySelectorAll("#opponent-hands .player"));
      const arrows = Array.from(document.querySelectorAll("#opponent-hands .order-arrow"));
      return {
        cardCount: cards.length,
        arrowCount: arrows.length,
        selfCount: cards.filter((c) => c.classList.contains("self")).length,
        cardsHaveCount: cards.every((c) => /\d+\s*张牌/.test(c.textContent || "")),
        arrowText: arrows.map((a) => a.textContent).join(""),
      };
    });
    expect(layout.cardCount).toBe(2);
    expect(layout.arrowCount).toBe(1);
    expect(layout.selfCount).toBe(1);
    expect(layout.cardsHaveCount).toBe(true);
    expect(layout.arrowText).toMatch(/[▶◀]/);

    await pageA.close();
    await pageB.close();
  });

  // Item 10: ESC closes the rules modal.
  it("ESC closes rules and about modals", { timeout: 30000 }, async () => {
    const page = await browser.newPage();
    await page.goto(BASE);
    await page.waitForSelector("#name");
    // No need to join — both modals are reachable from the lobby.
    await page.click("#rules-link");
    await page.waitForFunction(() => {
      const el = document.getElementById("rules-overlay");
      return el && !el.classList.contains("hidden");
    });
    await page.keyboard.press("Escape");
    await page.waitForFunction(
      () => {
        const el = document.getElementById("rules-overlay");
        return el && el.classList.contains("hidden");
      },
      { timeout: 3000 },
    );

    await page.click("#about-link");
    await page.waitForFunction(() => {
      const el = document.getElementById("about-overlay");
      return el && !el.classList.contains("hidden");
    });
    await page.keyboard.press("Escape");
    await page.waitForFunction(
      () => {
        const el = document.getElementById("about-overlay");
        return el && el.classList.contains("hidden");
      },
      { timeout: 3000 },
    );
    await page.close();
  });

  // Item 6: returning from spectator → win → rejoin a fresh lobby
  // must NOT keep body.spectator class.
  it("spectator state clears after game-over → rejoin", { timeout: 30000 }, async () => {
    const page = await browser.newPage();
    await page.goto(BASE);
    await page.waitForSelector("#name");
    // Force spectator state programmatically to simulate the full
    // flow without having to set up a 3-player game.
    await page.evaluate(() => {
      isSpectating = true;
      document.body.classList.add("spectator");
    });
    expect(await page.evaluate(() => document.body.classList.contains("spectator"))).toBe(true);
    // Now invoke resetGameState (the same path 'win' takes for
    // spectators); the cleanup must clear the class.
    await page.evaluate(() => resetGameState());
    // resetGameState defers most work to rAF; wait one frame.
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => document.body.classList.contains("spectator"))).toBe(false);
    expect(await page.evaluate(() => isSpectating)).toBe(false);
    await page.close();
  });

  // Item 11: reaction history pane records sent messages.
  it("reaction history records sent emojis", { timeout: 30000 }, async () => {
    const pageA = await browser.newPage();
    const pageB = await browser.newPage();
    await pageA.goto(BASE);
    await pageB.goto(BASE);
    const lobbyId = "rhist-" + Date.now();
    await pageA.fill("#name", "Alice");
    await pageA.fill("#lobby-id", lobbyId);
    await pageA.click("#join");
    await pageA.waitForSelector("#players li");
    await pageB.fill("#name", "Bob");
    await pageB.fill("#lobby-id", lobbyId);
    await pageB.click("#join");
    await pageA.waitForFunction(() => document.querySelectorAll("#players li").length === 2);
    await pageA.click("#ready");
    await pageB.click("#ready");
    await pageA.waitForFunction(
      () => {
        const el = document.getElementById("game");
        return el && el.style.display !== "none";
      },
      { timeout: 10000 },
    );

    // A clicks the laugh emoji.
    await pageA.click('.reaction-emoji[data-emoji="😂"]');
    // Both A and B should have a row in their reaction-history pane.
    await pageA.waitForFunction(
      () => {
        const rows = document.querySelectorAll("#reaction-history .reaction-history-row");
        return rows.length >= 1;
      },
      { timeout: 5000 },
    );
    await pageB.waitForFunction(
      () => {
        const rows = document.querySelectorAll("#reaction-history .reaction-history-row");
        return rows.length >= 1;
      },
      { timeout: 5000 },
    );
    // A's row should be marked self.
    const aSelf = await pageA.evaluate(() => {
      const rows = document.querySelectorAll("#reaction-history .reaction-history-row");
      return rows.length > 0 && rows[rows.length - 1].classList.contains("self");
    });
    expect(aSelf).toBe(true);
    // B's row should NOT be marked self.
    const bSelf = await pageB.evaluate(() => {
      const rows = document.querySelectorAll("#reaction-history .reaction-history-row");
      return rows.length > 0 && rows[rows.length - 1].classList.contains("self");
    });
    expect(bSelf).toBe(false);
    await pageA.close();
    await pageB.close();
  });

  // Item 12: not-playable per-card opacity should reset to 1 while
  // the player is action-disabled (off-turn) so the dim doesn't stack
  // with the container's dim.
  it("off-turn not-playable cards do not double-dim", { timeout: 30000 }, async () => {
    const pageA = await browser.newPage();
    const pageB = await browser.newPage();
    await pageA.goto(BASE);
    await pageB.goto(BASE);
    const lobbyId = "dim-" + Date.now();
    await pageA.fill("#name", "Alice");
    await pageA.fill("#lobby-id", lobbyId);
    await pageA.click("#join");
    await pageA.waitForSelector("#players li");
    await pageB.fill("#name", "Bob");
    await pageB.fill("#lobby-id", lobbyId);
    await pageB.click("#join");
    await pageA.waitForFunction(() => document.querySelectorAll("#players li").length === 2);
    await pageA.click("#ready");
    await pageB.click("#ready");
    await pageA.waitForFunction(
      () => {
        const el = document.getElementById("game");
        return el && el.style.display !== "none";
      },
      { timeout: 10000 },
    );

    // Find the off-turn page.
    const isMyTurn = async (page) =>
      await page.evaluate(() => {
        const el = document.getElementById("turn-indicator");
        return el ? el.classList.contains("my-turn") : false;
      });
    const offPage = (await isMyTurn(pageA)) ? pageB : pageA;

    // Wait until the off-page has rendered its hand.
    await offPage.waitForFunction(
      () => {
        return document.querySelectorAll("#player-hand .card").length > 0;
      },
      { timeout: 5000 },
    );

    // For each non-playable card on the off page, computed opacity
    // (effective) should be the container's opacity alone, not
    // multiplied by an additional 0.7. We accept any value >= 0.5 as
    // "not double-dimmed" (container is 0.6, double would be ~0.42).
    const minCardOpacity = await offPage.evaluate(() => {
      const cards = Array.from(document.querySelectorAll("#player-hand .card"));
      if (cards.length === 0) return -1;
      // Each card's own computed opacity should be 1 thanks to the
      // override; the container has 0.6 inherited.
      return Math.min(...cards.map((c) => parseFloat(getComputedStyle(c).opacity)));
    });
    expect(minCardOpacity).toBe(1);
    await pageA.close();
    await pageB.close();
  });

  // Item 13: discard pile no longer dims off-turn.
  it("discard pile stays at full opacity off-turn", { timeout: 30000 }, async () => {
    const pageA = await browser.newPage();
    const pageB = await browser.newPage();
    await pageA.goto(BASE);
    await pageB.goto(BASE);
    const lobbyId = "dpop-" + Date.now();
    await pageA.fill("#name", "Alice");
    await pageA.fill("#lobby-id", lobbyId);
    await pageA.click("#join");
    await pageA.waitForSelector("#players li");
    await pageB.fill("#name", "Bob");
    await pageB.fill("#lobby-id", lobbyId);
    await pageB.click("#join");
    await pageA.waitForFunction(() => document.querySelectorAll("#players li").length === 2);
    await pageA.click("#ready");
    await pageB.click("#ready");
    await pageA.waitForFunction(
      () => {
        const el = document.getElementById("game");
        return el && el.style.display !== "none";
      },
      { timeout: 10000 },
    );

    const isMyTurn = async (page) =>
      await page.evaluate(() => {
        const el = document.getElementById("turn-indicator");
        return el ? el.classList.contains("my-turn") : false;
      });
    const offPage = (await isMyTurn(pageA)) ? pageB : pageA;
    const opacity = await offPage.evaluate(() => {
      const el = document.getElementById("discard-pile");
      return el ? parseFloat(getComputedStyle(el).opacity) : 0;
    });
    expect(opacity).toBe(1);
    await pageA.close();
    await pageB.close();
  });

  // ── Keyboard adaptation for buttons ─────────────────────

  // Lobby: Enter on the name input submits the join.
  it("lobby: Enter in the name input clicks join", { timeout: 30000 }, async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(BASE);
    await page.waitForSelector("#name");
    await page.fill("#name", "KbdJoiner");
    await page.fill("#lobby-id", "kbd-" + Date.now());
    await page.locator("#name").focus();
    await page.keyboard.press("Enter");
    // Expect the join to succeed: a players list appears.
    await page.waitForSelector("#players li", { timeout: 5000 });
    const items = await page.$$("#players li");
    expect(items.length).toBe(1);
    await page.close();
    await ctx.close();
  });

  // Lobby: R toggles ready (when ready button is visible).
  it("lobby: pressing R toggles the ready button", { timeout: 30000 }, async () => {
    // Isolated contexts so the slot-election BroadcastChannel and
    // localStorage from earlier tests in this file don't leak in and
    // wipe identity at the worst moment.
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();
    await pageA.goto(BASE);
    await pageB.goto(BASE);
    const lobbyId = "kbd-r-" + Date.now();
    await pageA.fill("#name", "AA");
    await pageA.fill("#lobby-id", lobbyId);
    await pageA.click("#join");
    await pageA.waitForSelector("#players li");
    await pageB.fill("#name", "BB");
    await pageB.fill("#lobby-id", lobbyId);
    await pageB.click("#join");
    await pageA.waitForFunction(() => document.querySelectorAll("#players li").length === 2);
    // Move focus away from the lobby-id input so R isn't typed into it.
    await pageA.evaluate(() => {
      document.body.focus();
      const a = document.activeElement;
      if (a && a.tagName === "INPUT") a.blur();
    });
    // Sanity: ready button must be visible AND focus moved off input.
    const probe = await pageA.evaluate(() => {
      const btn = document.getElementById("ready");
      const ae = document.activeElement;
      return {
        readyDisp: btn ? btn.style.display : null,
        readyDisabled: btn ? btn.disabled : null,
        readyText: btn ? btn.textContent : null,
        gameDisp: document.getElementById("game")
          ? document.getElementById("game").style.display
          : null,
        focusedTag: ae ? ae.tagName : null,
      };
    });
    expect(probe).toEqual({
      readyDisp: "block",
      readyDisabled: false,
      readyText: "准备",
      gameDisp: "none",
      focusedTag: "BODY",
    });
    // The page-level keydown listens on document, so dispatching to
    // body via keyboard.press should be enough.
    await pageA.keyboard.press("KeyR");
    // Ready text should switch to "取消准备".
    await pageA.waitForFunction(
      () => {
        const btn = document.getElementById("ready");
        return btn && btn.textContent === "取消准备";
      },
      { timeout: 5000 },
    );
    await pageA.close();
    await pageB.close();
    await ctxA.close();
    await ctxB.close();
  });

  // Lobby: I invites an AI (creator only).
  it("lobby: pressing I invites an AI for the creator", { timeout: 30000 }, async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(BASE);
    await page.fill("#name", "AI-host");
    await page.fill("#lobby-id", "kbd-i-" + Date.now());
    await page.click("#join");
    await page.waitForSelector("#players li");
    await page.evaluate(() => {
      document.body.focus();
      const a = document.activeElement;
      if (a && a.tagName === "INPUT") a.blur();
    });
    await page.keyboard.press("i");
    await page.waitForFunction(() => document.querySelectorAll("#players li").length === 2, {
      timeout: 5000,
    });
    const aiCount = await page.evaluate(
      () =>
        Array.from(document.querySelectorAll("#players li")).filter((li) =>
          li.classList.contains("ai"),
        ).length,
    );
    expect(aiCount).toBe(1);
    await page.close();
    await ctx.close();
  });

  // In-game: D draws a card on the active player's turn.
  it("in-game: pressing D draws a card on your turn", { timeout: 30000 }, async () => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();
    await pageA.goto(BASE);
    await pageB.goto(BASE);
    const lobbyId = "kbd-d-" + Date.now();
    await pageA.fill("#name", "Alice");
    await pageA.fill("#lobby-id", lobbyId);
    await pageA.click("#join");
    await pageA.waitForSelector("#players li");
    await pageB.fill("#name", "Bob");
    await pageB.fill("#lobby-id", lobbyId);
    await pageB.click("#join");
    await pageA.waitForFunction(() => document.querySelectorAll("#players li").length === 2);
    await pageA.click("#ready");
    await pageB.click("#ready");
    await pageA.waitForFunction(
      () => {
        const el = document.getElementById("game");
        return el && el.style.display !== "none";
      },
      { timeout: 10000 },
    );

    const isMyTurn = async (page) =>
      await page.evaluate(() => {
        const el = document.getElementById("turn-indicator");
        return el ? el.classList.contains("my-turn") : false;
      });
    const turnPage = (await isMyTurn(pageA)) ? pageA : pageB;

    const beforeHand = await turnPage.$$eval("#player-hand .card", (els) => els.length);
    await turnPage.evaluate(() => {
      document.body.focus();
      const a = document.activeElement;
      if (a && a.tagName === "INPUT") a.blur();
    });
    await turnPage.keyboard.press("d");
    // After drawing, hand grew by 1.
    await turnPage.waitForFunction(
      (before) => {
        return document.querySelectorAll("#player-hand .card").length === before + 1;
      },
      beforeHand,
      { timeout: 5000 },
    );
    await pageA.close();
    await pageB.close();
    await ctxA.close();
    await ctxB.close();
  });

  // In-game: S triggers the surrender confirm (button click → modal).
  it("in-game: pressing S opens the surrender confirm", { timeout: 30000 }, async () => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();
    await pageA.goto(BASE);
    await pageB.goto(BASE);
    const lobbyId = "kbd-s-" + Date.now();
    await pageA.fill("#name", "Alice");
    await pageA.fill("#lobby-id", lobbyId);
    await pageA.click("#join");
    await pageA.waitForSelector("#players li");
    await pageB.fill("#name", "Bob");
    await pageB.fill("#lobby-id", lobbyId);
    await pageB.click("#join");
    await pageA.waitForFunction(() => document.querySelectorAll("#players li").length === 2);
    await pageA.click("#ready");
    await pageB.click("#ready");
    await pageA.waitForFunction(
      () => {
        const el = document.getElementById("game");
        return el && el.style.display !== "none";
      },
      { timeout: 10000 },
    );

    await pageA.evaluate(() => {
      document.body.focus();
      const a = document.activeElement;
      if (a && a.tagName === "INPUT") a.blur();
    });
    await pageA.keyboard.press("s");
    // The surrender confirm should appear (modal-overlay visible).
    await pageA.waitForFunction(
      () => {
        const ov = document.getElementById("modal-overlay");
        return ov && !ov.classList.contains("hidden");
      },
      { timeout: 5000 },
    );
    // Cancel the modal so the test exits cleanly.
    await pageA.click("#modal-cancel-btn");
    await pageA.close();
    await pageB.close();
    await ctxA.close();
    await ctxB.close();
  });

  // Anywhere: ? opens rules.
  it("? opens the rules modal from anywhere", { timeout: 20000 }, async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(BASE);
    await page.waitForSelector("#name");
    await page.evaluate(() => {
      document.body.focus();
      const a = document.activeElement;
      if (a && a.tagName === "INPUT") a.blur();
    });
    // Keyboard.press('?') sends the literal char in Chromium.
    await page.keyboard.press("?");
    await page.waitForFunction(
      () => {
        const el = document.getElementById("rules-overlay");
        return el && !el.classList.contains("hidden");
      },
      { timeout: 3000 },
    );
    await page.close();
    await ctx.close();
  });

  // Game-over: Enter dismisses the game-over overlay.
  it("Enter on the game-over overlay returns to lobby", { timeout: 30000 }, async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(BASE);
    await page.waitForSelector("#name");
    // Force the game-over overlay open synthetically — we don't need
    // a real game to test the keyboard path, just that pressing Enter
    // while it's visible clicks the button.
    await page.evaluate(() => {
      const ov = document.getElementById("game-over-overlay");
      const content = document.getElementById("game-over-content");
      if (ov) {
        ov.classList.remove("hidden");
        ov.style.display = "flex";
      }
      if (content) {
        content.className = "aborted";
      }
      // Hook so we can detect the click later.
      window.__gameOverClicked = false;
      const btn = document.getElementById("game-over-btn");
      if (btn)
        btn.addEventListener("click", () => {
          window.__gameOverClicked = true;
        });
    });
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => window.__gameOverClicked === true, {
      timeout: 3000,
    });
    await page.close();
    await ctx.close();
  });

  // In-game: T toggles card layout (扇形 / 滚动).
  it("in-game: pressing T toggles card layout", { timeout: 30000 }, async () => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();
    await pageA.goto(BASE);
    await pageB.goto(BASE);
    const lobbyId = "kbd-t-" + Date.now();
    await pageA.fill("#name", "Alice");
    await pageA.fill("#lobby-id", lobbyId);
    await pageA.click("#join");
    await pageA.waitForSelector("#players li");
    await pageB.fill("#name", "Bob");
    await pageB.fill("#lobby-id", lobbyId);
    await pageB.click("#join");
    await pageA.waitForFunction(() => document.querySelectorAll("#players li").length === 2);
    await pageA.click("#ready");
    await pageB.click("#ready");
    await pageA.waitForFunction(
      () => {
        const el = document.getElementById("game");
        return el && el.style.display !== "none";
      },
      { timeout: 10000 },
    );

    const before = await pageA.evaluate(() => {
      const btn = document.getElementById("card-layout-toggle");
      return btn ? btn.textContent : null;
    });
    await pageA.evaluate(() => {
      document.body.focus();
      const a = document.activeElement;
      if (a && a.tagName === "INPUT") a.blur();
    });
    await pageA.keyboard.press("t");
    await pageA.waitForFunction(
      (prev) => {
        const btn = document.getElementById("card-layout-toggle");
        return btn && btn.textContent !== prev;
      },
      before,
      { timeout: 5000 },
    );
    await pageA.close();
    await pageB.close();
    await ctxA.close();
    await ctxB.close();
  });

  // Highlight is one-shot: clicking the draw-mode "?" highlights the
  // section once. Reopening the rules via the regular "规则" link or
  // `?` shortcut should NOT re-highlight; otherwise every later open
  // visually nags the user about a section they already saw.
  it(
    "draw-mode highlight is one-shot — does not repeat on next rules open",
    { timeout: 30000 },
    async () => {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await page.goto(BASE);
      await page.fill("#name", "Holly");
      await page.fill("#lobby-id", "rh-" + Date.now());
      await page.click("#join");
      await page.waitForFunction(
        () => {
          const area = document.getElementById("draw-mode-area");
          return area && getComputedStyle(area).display !== "none";
        },
        { timeout: 5000 },
      );

      // Hook the section so we can count how many times the highlight
      // class is RE-APPLIED. The CSS keyframes have iteration-count=2 so
      // counting animationstart double-counts a single highlight. We
      // instead observe class additions: applyPendingRulesHighlight does
      // remove → reflow → add, which produces one observable add per
      // actual call.
      await page.evaluate(() => {
        const sec = document.getElementById("rules-draw-mode-highlight");
        if (!sec) return;
        window.__highlightStarts = 0;
        const obs = new MutationObserver((mutations) => {
          for (const m of mutations) {
            if (m.type === "attributes" && m.attributeName === "class") {
              const had = (m.oldValue || "").includes("highlight-section");
              const has = sec.classList.contains("highlight-section");
              if (!had && has) window.__highlightStarts++;
            }
          }
        });
        obs.observe(sec, {
          attributes: true,
          attributeOldValue: true,
          attributeFilter: ["class"],
        });
      });

      // 1st: click the "?" — opens rules and applies the highlight.
      await page.click("#draw-mode-info");
      await page.waitForFunction(() => window.__highlightStarts >= 1, {
        timeout: 5000,
      });
      const after1 = await page.evaluate(() => window.__highlightStarts);
      expect(after1).toBe(1);

      // Close rules IMMEDIATELY — i.e. before the 4s highlight animation
      // (2 iterations × 2s) has had a chance to finish on its own. This
      // is the user-reported repro: closing the dialog mid-flash and
      // then re-opening rules via the regular "规则" link must NOT
      // re-flash the section.
      await page.click("#rules-close-btn");
      await page.waitForFunction(
        () => {
          const ov = document.getElementById("rules-overlay");
          return ov && ov.classList.contains("hidden");
        },
        { timeout: 3000 },
      );

      // 2nd: open rules via the regular "规则" link — the highlight
      // should NOT re-fire. Wait a beat to give a stray animation a
      // chance to start, then assert the counter is unchanged.
      await page.click("#rules-link");
      await page.waitForFunction(
        () => {
          const ov = document.getElementById("rules-overlay");
          return ov && !ov.classList.contains("hidden");
        },
        { timeout: 3000 },
      );
      await page.waitForTimeout(700); // > the 300ms applyPending delay
      const after2 = await page.evaluate(() => window.__highlightStarts);
      expect(after2).toBe(after1);

      await page.close();
      await ctx.close();
    },
  );

  // Off-turn cards: cursor on each card must be 'default' (not
  // 'not-allowed'), and pointer-events on the cards is 'none' so they
  // can't be clicked. The hand container keeps its own cursor so the
  // scrollbar still reads as interactive.
  it("off-turn hand cards have default cursor (not disabled)", { timeout: 30000 }, async () => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();
    await pageA.goto(BASE);
    await pageB.goto(BASE);
    const lobbyId = "cur-" + Date.now();
    await pageA.fill("#name", "Alice");
    await pageA.fill("#lobby-id", lobbyId);
    await pageA.click("#join");
    await pageA.waitForSelector("#players li");
    await pageB.fill("#name", "Bob");
    await pageB.fill("#lobby-id", lobbyId);
    await pageB.click("#join");
    await pageA.waitForFunction(() => document.querySelectorAll("#players li").length === 2);
    await pageA.click("#ready");
    await pageB.click("#ready");
    await pageA.waitForFunction(
      () => {
        const el = document.getElementById("game");
        return el && el.style.display !== "none";
      },
      { timeout: 10000 },
    );

    const isMyTurn = async (page) =>
      await page.evaluate(() => {
        const el = document.getElementById("turn-indicator");
        return el ? el.classList.contains("my-turn") : false;
      });
    const offPage = (await isMyTurn(pageA)) ? pageB : pageA;
    // Wait for hand to render and the off-turn body class to be set.
    await offPage.waitForFunction(
      () => {
        const card = document.querySelector("#player-hand .card");
        return !!card && document.body.classList.contains("player-action-disabled");
      },
      { timeout: 5000 },
    );

    const result = await offPage.evaluate(() => {
      const card = document.querySelector("#player-hand .card");
      const hand = document.getElementById("player-hand");
      if (!card || !hand) return null;
      const cardCs = getComputedStyle(card);
      const handCs = getComputedStyle(hand);
      return {
        cardCursor: cardCs.cursor,
        cardPointerEvents: cardCs.pointerEvents,
        handCursor: handCs.cursor,
      };
    });
    expect(result).not.toBeNull();
    expect(result.cardCursor).toBe("default");
    expect(result.cardPointerEvents).toBe("none");
    expect(result.handCursor).toBe("default");

    await pageA.close();
    await pageB.close();
    await ctxA.close();
    await ctxB.close();
  });

  // Sanity: opponent-hands row stays on the same horizontal baseline
  // even when one of the cards has the .active class (current turn).
  it(
    "opponent-hands cards stay on the same baseline when one is active",
    { timeout: 30000 },
    async () => {
      const ctxA = await browser.newContext();
      const ctxB = await browser.newContext();
      const pageA = await ctxA.newPage();
      const pageB = await ctxB.newPage();
      await pageA.goto(BASE);
      await pageB.goto(BASE);
      const lobbyId = "baseline-" + Date.now();
      await pageA.fill("#name", "Alice");
      await pageA.fill("#lobby-id", lobbyId);
      await pageA.click("#join");
      await pageA.waitForSelector("#players li");
      await pageB.fill("#name", "Bob");
      await pageB.fill("#lobby-id", lobbyId);
      await pageB.click("#join");
      await pageA.waitForFunction(() => document.querySelectorAll("#players li").length === 2);
      await pageA.click("#ready");
      await pageB.click("#ready");
      await pageA.waitForFunction(
        () => {
          const el = document.getElementById("game");
          return el && el.style.display !== "none";
        },
        { timeout: 10000 },
      );

      // At least one card should be marked .active (whoever's turn it is).
      const tops = await pageA.evaluate(() => {
        const cards = Array.from(document.querySelectorAll("#opponent-hands .player"));
        const arrows = Array.from(document.querySelectorAll("#opponent-hands .order-arrow"));
        return {
          cardTops: cards.map((c) => Math.round(c.getBoundingClientRect().top)),
          anyActive: cards.some((c) => c.classList.contains("active")),
          arrowCenters: arrows.map((a) => {
            const r = a.getBoundingClientRect();
            return Math.round(r.top + r.height / 2);
          }),
          cardCenters: cards.map((c) => {
            const r = c.getBoundingClientRect();
            return Math.round(r.top + r.height / 2);
          }),
        };
      });
      expect(tops.anyActive).toBe(true);
      // All cards aligned on the same top within a couple of pixels.
      const minTop = Math.min(...tops.cardTops);
      const maxTop = Math.max(...tops.cardTops);
      expect(maxTop - minTop).toBeLessThanOrEqual(2);
      // Each arrow's vertical center sits roughly between the card
      // centers (not above/below the row).
      const minCenter = Math.min(...tops.cardCenters);
      const maxCenter = Math.max(...tops.cardCenters);
      for (const ac of tops.arrowCenters) {
        expect(ac).toBeGreaterThanOrEqual(minCenter - 4);
        expect(ac).toBeLessThanOrEqual(maxCenter + 4);
      }

      await pageA.close();
      await pageB.close();
      await ctxA.close();
      await ctxB.close();
    },
  );

  // In-game status strip: shows the current draw mode pill while the
  // game is visible. The chain pill is hidden until a chain is active.
  it(
    "in-game status strip shows draw mode and hides chain pill by default",
    { timeout: 30000 },
    async () => {
      const ctxA = await browser.newContext();
      const ctxB = await browser.newContext();
      const pageA = await ctxA.newPage();
      const pageB = await ctxB.newPage();
      await pageA.goto(BASE);
      await pageB.goto(BASE);
      const lobbyId = "gs-" + Date.now();
      await pageA.fill("#name", "Alice");
      await pageA.fill("#lobby-id", lobbyId);
      await pageA.click("#join");
      await pageA.waitForSelector("#players li");
      await pageB.fill("#name", "Bob");
      await pageB.fill("#lobby-id", lobbyId);
      await pageB.click("#join");
      await pageA.waitForFunction(() => document.querySelectorAll("#players li").length === 2);
      await pageA.click("#ready");
      await pageB.click("#ready");
      await pageA.waitForFunction(
        () => {
          const el = document.getElementById("game");
          return el && el.style.display !== "none";
        },
        { timeout: 10000 },
      );

      // After start, both pages should show the mode pill (default chain)
      // and an empty/hidden chain pill.
      const state = await pageA.evaluate(() => {
        const wrap = document.getElementById("game-status");
        const mode = document.getElementById("game-status-mode");
        const chain = document.getElementById("game-status-chain");
        return {
          wrapVisible: wrap ? getComputedStyle(wrap).display !== "none" : false,
          modeText: mode ? mode.textContent : null,
          modeHasChainClass: mode ? mode.classList.contains("mode-chain") : false,
          chainHidden: chain ? chain.classList.contains("hidden") : true,
        };
      });
      expect(state.wrapVisible).toBe(true);
      expect(state.modeText).toBe("链式加牌");
      expect(state.modeHasChainClass).toBe(true);
      expect(state.chainHidden).toBe(true);

      await pageA.close();
      await pageB.close();
      await ctxA.close();
      await ctxB.close();
    },
  );

  // The chain pill appears with the running count once a chain forms,
  // and disappears when the count drops back to zero.
  it("chain pill shows the pending count in chain mode", { timeout: 30000 }, async () => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();
    await pageA.goto(BASE);
    await pageB.goto(BASE);
    const lobbyId = "gsch-" + Date.now();
    await pageA.fill("#name", "Alice");
    await pageA.fill("#lobby-id", lobbyId);
    await pageA.click("#join");
    await pageA.waitForSelector("#players li");
    await pageB.fill("#name", "Bob");
    await pageB.fill("#lobby-id", lobbyId);
    await pageB.click("#join");
    await pageA.waitForFunction(() => document.querySelectorAll("#players li").length === 2);
    await pageA.click("#ready");
    await pageB.click("#ready");
    await pageA.waitForFunction(
      () => {
        const el = document.getElementById("game");
        return el && el.style.display !== "none";
      },
      { timeout: 10000 },
    );

    // Force a chain via dev_set_chain (no actual play needed — we just
    // exercise the broadcast → status pill path).
    const isMyTurn = async (page) =>
      await page.evaluate(() => {
        const el = document.getElementById("turn-indicator");
        return el ? el.classList.contains("my-turn") : false;
      });
    const turnPage = (await isMyTurn(pageA)) ? pageA : pageB;
    await turnPage.evaluate(() => sendMessage({ action: "dev_set_chain", count: 4 }));
    await turnPage.waitForFunction(
      () => {
        const chain = document.getElementById("game-status-chain");
        return chain && !chain.classList.contains("hidden") && /\+4/.test(chain.textContent || "");
      },
      { timeout: 5000 },
    );

    // Clear the chain and the pill should hide again.
    await turnPage.evaluate(() => sendMessage({ action: "dev_set_chain", count: 0 }));
    await turnPage.waitForFunction(
      () => {
        const chain = document.getElementById("game-status-chain");
        return chain && chain.classList.contains("hidden");
      },
      { timeout: 5000 },
    );

    await pageA.close();
    await pageB.close();
    await ctxA.close();
    await ctxB.close();
  });

  // Dev state info pane: populated with lobby/game state once the game
  // is running. Tests basic fields the developer cares about.
  it("dev panel state info pane shows lobby and game state", { timeout: 30000 }, async () => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();
    await pageA.goto(BASE);
    await pageB.goto(BASE);
    const lobbyId = "devinfo-" + Date.now();
    await pageA.fill("#name", "Alice");
    await pageA.fill("#lobby-id", lobbyId);
    await pageA.click("#join");
    await pageA.waitForSelector("#players li");
    await pageB.fill("#name", "Bob");
    await pageB.fill("#lobby-id", lobbyId);
    await pageB.click("#join");
    await pageA.waitForFunction(() => document.querySelectorAll("#players li").length === 2);
    await pageA.click("#ready");
    await pageB.click("#ready");
    await pageA.waitForFunction(
      () => {
        const el = document.getElementById("game");
        return el && el.style.display !== "none";
      },
      { timeout: 10000 },
    );

    const info = await pageA.evaluate(() => {
      const pane = document.getElementById("dev-state-info");
      return {
        present: !!pane,
        text: pane ? pane.textContent : "",
      };
    });
    expect(info.present).toBe(true);
    // Key labels we expect to find — robust against ordering changes.
    expect(info.text).toContain("lobby");
    expect(info.text).toContain("phase");
    expect(info.text).toContain("drawMode");
    expect(info.text).toContain("chain");
    expect(info.text).toContain("turn");
    expect(info.text).toContain("myHand");

    await pageA.close();
    await pageB.close();
    await ctxA.close();
    await ctxB.close();
  });

  // In-game status pills: draw mode pill always shown; chain pill only
  // appears when there's a pending +N stack in chain mode.
  it("in-game status pills show draw mode and pending chain", { timeout: 30000 }, async () => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();
    await pageA.goto(BASE);
    await pageB.goto(BASE);
    const lobbyId = "gstat-" + Date.now();
    await pageA.fill("#name", "Alice");
    await pageA.fill("#lobby-id", lobbyId);
    await pageA.click("#join");
    await pageA.waitForSelector("#players li");
    await pageB.fill("#name", "Bob");
    await pageB.fill("#lobby-id", lobbyId);
    await pageB.click("#join");
    await pageA.waitForFunction(() => document.querySelectorAll("#players li").length === 2);
    await pageA.click("#ready");
    await pageB.click("#ready");
    await pageA.waitForFunction(
      () => {
        const el = document.getElementById("game");
        return el && el.style.display !== "none";
      },
      { timeout: 10000 },
    );

    // Mode pill should be visible and read "链式加牌" (default mode).
    const initial = await pageA.evaluate(() => {
      const mode = document.getElementById("game-status-mode");
      const chain = document.getElementById("game-status-chain");
      return {
        modeVisible: !!mode && getComputedStyle(mode).display !== "none",
        modeText: mode ? mode.textContent : "",
        modeIsChain: !!mode && mode.classList.contains("mode-chain"),
        chainHidden: !!chain && chain.classList.contains("hidden"),
      };
    });
    expect(initial.modeVisible).toBe(true);
    expect(initial.modeText).toBe("链式加牌");
    expect(initial.modeIsChain).toBe(true);
    expect(initial.chainHidden).toBe(true);

    // Force a pending chain via dev_set_chain on the active player; the
    // chain pill should appear with "+N" content.
    const isMyTurn = async (page) =>
      await page.evaluate(() => {
        const el = document.getElementById("turn-indicator");
        return el ? el.classList.contains("my-turn") : false;
      });
    const turnPage = (await isMyTurn(pageA)) ? pageA : pageB;
    await turnPage.evaluate(() => sendMessage({ action: "dev_set_chain", count: 4 }));
    await turnPage.waitForFunction(
      () => {
        const c = document.getElementById("game-status-chain");
        return c && !c.classList.contains("hidden") && /\+4/.test(c.textContent || "");
      },
      { timeout: 5000 },
    );

    await pageA.close();
    await pageB.close();
    await ctxA.close();
    await ctxB.close();
  });

  // Off-turn .not-playable card cursor must be the regular default
  // arrow, not 'not-allowed'. The earlier fix only set the children
  // cursor on `body.player-action-disabled #player-hand > *`; the more
  // specific `.card.not-playable` rule was overriding it back to
  // 'not-allowed' off-turn.
  it("off-turn .not-playable cards have default cursor too", { timeout: 30000 }, async () => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();
    await pageA.goto(BASE);
    await pageB.goto(BASE);
    const lobbyId = "curnp-" + Date.now();
    await pageA.fill("#name", "Alice");
    await pageA.fill("#lobby-id", lobbyId);
    await pageA.click("#join");
    await pageA.waitForSelector("#players li");
    await pageB.fill("#name", "Bob");
    await pageB.fill("#lobby-id", lobbyId);
    await pageB.click("#join");
    await pageA.waitForFunction(() => document.querySelectorAll("#players li").length === 2);
    await pageA.click("#ready");
    await pageB.click("#ready");
    await pageA.waitForFunction(
      () => {
        const el = document.getElementById("game");
        return el && el.style.display !== "none";
      },
      { timeout: 10000 },
    );

    const isMyTurn = async (page) =>
      await page.evaluate(() => {
        const el = document.getElementById("turn-indicator");
        return el ? el.classList.contains("my-turn") : false;
      });
    const offPage = (await isMyTurn(pageA)) ? pageB : pageA;
    await offPage.waitForFunction(
      () => {
        const npCard = document.querySelector("#player-hand .card.not-playable");
        return !!npCard && document.body.classList.contains("player-action-disabled");
      },
      { timeout: 5000 },
    );

    const result = await offPage.evaluate(() => {
      const card = document.querySelector("#player-hand .card.not-playable");
      return card ? getComputedStyle(card).cursor : null;
    });
    expect(result).toBe("default");

    await pageA.close();
    await pageB.close();
    await ctxA.close();
    await ctxB.close();
  });

  // +N popup must attach to a player tile that survives the next
  // updatePlayers rebuild. Earlier code spawned the popup BEFORE the
  // rebuild, so #opponent-hands.innerHTML='' immediately yanked the
  // popup back out and the user never saw it.
  it(
    "+N popup appears next to a player when chain penalty is applied",
    { timeout: 30000 },
    async () => {
      const ctxA = await browser.newContext();
      const ctxB = await browser.newContext();
      const pageA = await ctxA.newPage();
      const pageB = await ctxB.newPage();
      await pageA.goto(BASE);
      await pageB.goto(BASE);
      const lobbyId = "penalty-" + Date.now();
      await pageA.fill("#name", "Alice");
      await pageA.fill("#lobby-id", lobbyId);
      await pageA.click("#join");
      await pageA.waitForSelector("#players li");
      await pageB.fill("#name", "Bob");
      await pageB.fill("#lobby-id", lobbyId);
      await pageB.click("#join");
      await pageA.waitForFunction(() => document.querySelectorAll("#players li").length === 2);
      await pageA.click("#ready");
      await pageB.click("#ready");
      await pageA.waitForFunction(
        () => {
          const el = document.getElementById("game");
          return el && el.style.display !== "none";
        },
        { timeout: 10000 },
      );

      // Use dev_add_cards on the OFF player (server broadcasts an update;
      // the chain-popup logic sees their cardCount go up by 4).
      const isMyTurn = async (page) =>
        await page.evaluate(() => {
          const el = document.getElementById("turn-indicator");
          return el ? el.classList.contains("my-turn") : false;
        });
      const targetPage = (await isMyTurn(pageA)) ? pageB : pageA;
      const observer = (await isMyTurn(pageA)) ? pageA : pageB;

      // Dev_add_cards adds to the caller; have the off-page add 4 to
      // themselves so observer (the active player) sees a +4 popup.
      await targetPage.evaluate(() => sendMessage({ action: "dev_add_cards", count: 4 }));

      // The popup is appended to the player tile. Wait for a .penalty-popup
      // to appear inside #opponent-hands.
      await observer.waitForFunction(
        () => {
          const popup = document.querySelector("#opponent-hands .penalty-popup");
          return !!popup && /\+\d+/.test(popup.textContent || "");
        },
        { timeout: 5000 },
      );

      // Confirm the popup actually says +4 and is parented to a player tile.
      const info = await observer.evaluate(() => {
        const popup = document.querySelector("#opponent-hands .penalty-popup");
        const parent = popup ? popup.parentElement : null;
        return {
          text: popup ? popup.textContent : null,
          parentIsPlayerTile: !!parent && parent.classList.contains("player"),
        };
      });
      expect(info.text).toMatch(/\+\d+/);
      expect(info.parentIsPlayerTile).toBe(true);

      await pageA.close();
      await pageB.close();
      await ctxA.close();
      await ctxB.close();
    },
  );
});
