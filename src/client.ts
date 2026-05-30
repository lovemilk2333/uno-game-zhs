const nameInput = document.getElementById("name") as HTMLInputElement;
const lobbyIdInput = document.getElementById("lobby-id") as HTMLInputElement;
const joinButton = document.getElementById("join") as HTMLButtonElement;
const playersList = document.getElementById("players") as HTMLUListElement;
const readyButton = document.getElementById("ready") as HTMLButtonElement;
const lobbyDiv = document.getElementById("lobby") as HTMLDivElement;
const gameDiv = document.getElementById("game") as HTMLDivElement;
const opponentHandsDiv = document.getElementById("opponent-hands") as HTMLDivElement;
const playerHandDiv = document.getElementById("player-hand") as HTMLDivElement;
const discardPileDiv = document.getElementById("discard-pile") as HTMLDivElement;
const drawCardButton = document.getElementById("draw-card") as HTMLButtonElement;
const turnIndicator = document.getElementById("turn-indicator") as HTMLDivElement;
const turnText = document.getElementById("turn-text") as HTMLHeadingElement;
const wildColorPicker = document.getElementById("wild-color-picker") as HTMLDivElement;
const colorOptions = document.getElementById("color-options") as HTMLDivElement;
const lobbyInfo = document.getElementById("lobby-info") as HTMLDivElement;
const currentLobbyId = document.getElementById("current-lobby-id") as HTMLSpanElement;
const inviteAIBtn = document.getElementById("invite-ai") as HTMLButtonElement;
const reactionTextInput = document.getElementById("reaction-text-input") as HTMLInputElement;
const reactionSendBtn = document.getElementById("reaction-send-btn") as HTMLButtonElement;
const reactionEmojis = document.getElementById("reaction-emojis") as HTMLDivElement;
const cardLayoutToggle = document.getElementById("card-layout-toggle") as HTMLButtonElement;

let storageCleared = false;

interface Card {
  color?: string;
  type: string;
}

interface Player {
  id: string;
  name: string;
  ready: boolean;
  isCreator: boolean;
  isAI?: boolean;
  disconnected?: boolean;
  reconnectDeadline?: number | null;
  cardCount?: number;
  uno?: boolean;
}

interface SavedSelection {
  card: Card;
  index: number;
}

interface ServerMessage {
  action: string;
  id?: string;
  dev?: boolean;
  reconnectLost?: boolean;
  players?: Player[];
  turn?: number;
  direction?: number;
  lobbyId?: string;
  hand?: Card[];
  discardPile?: Card[];
  winner?: string;
  message?: string;
  errorKey?: string;
  spectator?: boolean;
  gameState?: number;
  drawingCount?: number;
  drawMode?: string;
  playerId?: string;
  playerName?: string;
  type?: string;
  content?: string;
  log?: object[];
  turnDeadline?: number | null;
  turnTimerPaused?: boolean;
}

let NAME_LENGTH_MIN = 2;
let NAME_LENGTH_MAX = 32;
const CH_NAME = "uno-game";
let tabSlot = 0;
// Stable per-tab identifier used to resolve same-slot conflicts deterministically.
const TAB_ID = Math.random().toString(36).slice(2) + Date.now().toString(36);

// Hoisted log helpers so the slot-election code (runs immediately on
// script load) can use them. The full clientLog/clientWarn definitions
// later in the file just rebind to these.
const _CLIENT_PREFIX = "[client]";
function _clientLog(msg: string, ...args: unknown[]): void {
  console.log(`${_CLIENT_PREFIX} ${msg}`, ...args);
}
function _clientWarn(msg: string, ...args: unknown[]): void {
  console.warn(`${_CLIENT_PREFIX} ${msg}`, ...args);
}

// Snapshot of currently-known peer slots (for log lines). The actual map
// is defined further down; we expose a reader that's safe to call before
// it's initialized — it just returns an empty array.
function knownSlotsSnapshot(): number[] {
  // `knownSlots` is hoisted as a `const` initialised below; reading it
  // before that line would throw a TDZ. The slot code only logs AFTER
  // the map is set up, so this guard is defensive belt-and-suspenders.
  try {
    return [...knownSlots.keys()].sort((a, b) => a - b);
  } catch {
    return [];
  }
}

function slotKey(k: string): string {
  return `${k}-${tabSlot || 1}`;
}

// Resolves once this tab knows its slot. Code that loads UI state from
// `store` must await this; otherwise it falls back to the legacy plain
// localStorage key, which is shared across tabs and gets overwritten by
// whichever tab wrote last (so all tabs would read the same value).
let resolveSlotReady: () => void = () => {};
const slotReady: Promise<void> = new Promise((r) => {
  resolveSlotReady = r;
});

// Writes that arrived before the slot was assigned. Replayed once the slot
// is known so they land in the slot-scoped localStorage key (and survive
// the tab being closed).
const pendingWrites = new Map<string, string | null>();

const store = {
  get(k: string): string | null {
    // Slot-scoped reads only. The legacy plain-key fallback we used to
    // do here was a footgun: a tab whose own slot key was empty would
    // surface whatever the most-recent tab had typed (because Chrome
    // never cleans up the now-stale plain key). After closing the
    // browser and opening a fresh tab the user would see *some other
    // slot's* name pre-filled, which is the bug we're fixing.
    return sessionStorage.getItem(k) ?? (tabSlot ? localStorage.getItem(slotKey(k)) : null);
  },
  set(k: string, v: string): void {
    sessionStorage.setItem(k, v);
    if (tabSlot) localStorage.setItem(slotKey(k), v);
    else pendingWrites.set(k, v);
  },
  remove(k: string): void {
    if (tabSlot) localStorage.removeItem(slotKey(k));
    else pendingWrites.set(k, null);
    // Strip the legacy plain key too — older builds wrote it directly
    // and we want any leftover data gone for good.
    localStorage.removeItem(k);
    sessionStorage.removeItem(k);
  },
};

// One-shot migration on script boot: nuke any leftover unscoped uno* keys
// that pre-slot-aware builds wrote, so they can't bleed back through the
// legacy fallback removed above. After this runs once per origin, every
// per-tab slot gets a clean state.
(function purgeLegacyPlainKeys() {
  const LEGACY_KEYS = [
    "unoPlayerName",
    "unoLobbyId",
    "unoPlayerId",
    "unoInLobby",
    "unoInGame",
    "unoLeftLobby",
    "unoCardLayout",
  ];
  for (const k of LEGACY_KEYS) {
    // localStorage.removeItem is a no-op if the key isn't present, so
    // unconditional cleanup costs nothing measurable.
    localStorage.removeItem(k);
  }
})();

// ── BroadcastChannel slot negotiation ────────────────────
// Distributed (no central host): every tab heartbeats its own slot and listens
// for peers. A tab picks the smallest unclaimed positive integer based on what
// it has heard. Closing any tab — including whichever tab opened first — never
// strands the rest, because no single host owns the allocation table.
// Same-slot collisions (e.g. after a stale entry was reused, or two new tabs
// racing) are resolved by letting the tab with the larger TAB_ID drop and
// re-elect.
const ch = new BroadcastChannel(CH_NAME);
const HEARTBEAT_MS = 1500;
const STALE_MS = 4000;
const ELECTION_MS = 250;
interface SlotInfo {
  tabId: string;
  lastSeen: number;
}
const knownSlots = new Map<number, SlotInfo>();
// Set to true when we hear ANY `intent` from another (not-yet-claimed)
// tab during the election window. Used to disambiguate "I'm a lone tab,
// fall back to slot 1" from "I'm part of a parallel-restore wave, keep
// my stored slot". Reset is unnecessary — the boot IIFE only runs once
// per page load.
let peerIntentSeen = false;
let electionTimer: ReturnType<typeof setTimeout> | null = null;

function pruneStaleSlots(): void {
  const now = Date.now();
  const dropped: number[] = [];
  for (const [s, info] of knownSlots) {
    if (info.tabId === TAB_ID) continue;
    if (now - info.lastSeen > STALE_MS) {
      knownSlots.delete(s);
      dropped.push(s);
    }
  }
  if (dropped.length) {
    _clientLog(
      `pruneStaleSlots dropped=[${dropped.join(",")}] remaining=[${knownSlotsSnapshot().join(",")}]`,
    );
  }
}

// Pick the lowest-numbered slot not currently held by a live peer. Always
// starts the search at 1 so a freshly-opened tab with no neighbors lands
// at slot 1 even if `sessionStorage.unoSlot` carried a higher number from
// a previous browser session. The previous "session-restore shortcut"
// went straight to the stored slot and pre-filled with that slot's last
// typed name/lobby — confusing on a clean browser reopen.
//
// Note: leftover `unoPlayerId-N` in localStorage from a closed tab does
// NOT reserve the slot. The closed tab's sessionStorage is gone, so it
// can't F5 back into "its" slot — the identity is dead. A new tab
// claiming the slot via `'elected'` correctly wipes it (see claimSlot)
// so the new tab doesn't impersonate the old user. The only case where
// we want to keep the slot+identity is F5 within the same tab, which
// goes through the `'restored'` path and isn't gated by pickFreeSlot.
function pickFreeSlot(): number {
  pruneStaleSlots();
  let s = 1;
  while (knownSlots.has(s)) s++;
  _clientLog(`pickFreeSlot known=[${knownSlotsSnapshot().join(",")}] picked=${s}`);
  return s;
}

// Track how this tab acquired its slot. `restored` means same-tab session
// continuation (sessionStorage survived a refresh), so any leftover state
// in `unoXxx-${slot}` localStorage belongs to *us*. `elected` means we
// negotiated for a free slot via the BroadcastChannel — that slot was
// either always free or freed by another tab closing, and any leftover
// state under that slot belongs to whoever was there before us, NOT to
// this new tab. We must NOT auto-reconnect with a stranger's identity.
type SlotOrigin = "restored" | "elected";
let slotOrigin: SlotOrigin = "elected";

// True once the first claimSlot has fired, meaning slotReady was
// already resolved and any re-elect after this point needs to actively
// re-pull the slot's stored values into the inputs.
let hasClaimedOnce = false;

function claimSlot(slot: number, origin: SlotOrigin): void {
  _clientLog(
    `claimSlot slot=${slot} origin=${origin} tabId=${TAB_ID.slice(0, 6)} known=[${knownSlotsSnapshot().join(",")}]`,
  );
  const isReclaim = hasClaimedOnce;
  tabSlot = slot;
  slotOrigin = origin;
  sessionStorage.setItem("unoSlot", String(slot));
  knownSlots.set(slot, { tabId: TAB_ID, lastSeen: Date.now() });
  ch.postMessage({ type: "heartbeat", slot, tabId: TAB_ID });

  // Brand-new tab in a recycled slot — wipe the previous occupant's
  // SERVER-SIDE identity so we don't impersonate them on the next WS
  // connect. The user's typed name and lobby id are intentionally kept:
  // they're convenience defaults, not identity, so a fresh tab pre-fills
  // with whatever the closed tab last typed (matching the user's mental
  // model of "this slot picked up where the last tab left off"). Auto-
  // reconnect is gated on `unoPlayerId` alone; clearing that is enough
  // to force a clean new-client handshake.
  if (origin === "elected") {
    const drop = ["unoPlayerId", "unoInLobby", "unoInGame", "unoLeftLobby"];
    for (const k of drop) localStorage.removeItem(slotKey(k));
  }

  // Flush any writes that happened during the election window.
  for (const [k, v] of pendingWrites) {
    if (v === null) localStorage.removeItem(slotKey(k));
    else localStorage.setItem(slotKey(k), v);
  }
  pendingWrites.clear();
  resolveSlotReady();
  hasClaimedOnce = true;

  // Re-run the slot-bound prefill on EVERY claim AFTER the first one.
  // The first claim is handled by connect()'s onopen → slotReady.then
  // path. Subsequent re-claims (after a same-slot collision causes us
  // to drop and re-elect to a different slot) need to pull the new
  // slot's stored values into the inputs — slotReady is already
  // resolved so .then(...) won't fire again. `applySlotPrefill` is
  // idempotent and safe to call multiple times; it skips writes when
  // the input already matches the stored value.
  if (isReclaim) {
    applySlotPrefill();
  }
}

// Pull the stored name / lobby for the current slot back into the input
// fields. Used both from the connect() onopen path (for the initial
// claim) and from claimSlot itself when we re-elect after a collision.
function applySlotPrefill(): void {
  if (typeof nameInput === "undefined" || !nameInput) return;
  // Don't overwrite if the user has already typed something during
  // the election window — their keystrokes shouldn't be clobbered.
  // We detect "user typed" via pendingWrites (if there's a pending
  // unoPlayerName write, the user typed something). After claimSlot
  // flushes pendingWrites the entry is gone, so we instead compare
  // against the slot's stored value.
  const storedName = store.get("unoPlayerName") || "";
  const storedLobby = store.get("unoLobbyId") || "";
  if (storedName && nameInput.value !== storedName) nameInput.value = storedName;
  if (storedLobby && lobbyIdInput.value !== storedLobby) lobbyIdInput.value = storedLobby;
}

function runElection(): void {
  if (electionTimer !== null) return;
  ch.postMessage({ type: "who", tabId: TAB_ID });
  electionTimer = setTimeout(() => {
    electionTimer = null;
    if (tabSlot !== 0) return; // already claimed during the wait window
    claimSlot(pickFreeSlot(), "elected");
  }, ELECTION_MS);
}

ch.onmessage = (e: MessageEvent) => {
  const d = e.data;
  if (!d || typeof d !== "object") return;
  if (d.type === "heartbeat" && typeof d.slot === "number" && typeof d.tabId === "string") {
    const wasKnown = knownSlots.has(d.slot);
    const prev = knownSlots.get(d.slot);
    // Only overwrite if this is a fresher signal — guards against an
    // older heartbeat from a closed tab arriving after a `bye` that
    // freed the slot. Otherwise we'd "resurrect" a stale entry.
    if (!prev || prev.tabId === d.tabId || prev.lastSeen < Date.now()) {
      knownSlots.set(d.slot, { tabId: d.tabId, lastSeen: Date.now() });
    }
    if (!wasKnown) {
      _clientLog(
        `peer-up slot=${d.slot} tabId=${String(d.tabId).slice(0, 6)} known=[${knownSlotsSnapshot().join(",")}]`,
      );
    }
    // Same-slot collision: keep the tab with the lexicographically smaller id.
    if (d.slot === tabSlot && d.tabId !== TAB_ID && d.tabId < TAB_ID) {
      _clientLog(
        `collision on slot=${tabSlot}, peer wins (peerTabId=${String(d.tabId).slice(0, 6)} < ours=${TAB_ID.slice(0, 6)}) — re-electing`,
      );
      tabSlot = 0;
      // Drop this slot's session marker so the upcoming election doesn't
      // think it's a restore. The collision means a peer was already
      // claiming our slot — we're effectively a fresh tab from this
      // point on, identity-wise.
      sessionStorage.removeItem("unoSlot");
      runElection();
    }
  } else if (d.type === "who") {
    // Reply with our claimed slot if we have one. While our election is
    // still in flight (tabSlot=0), reply with our STORED preference so
    // simultaneously-booting peers can see each other's intentions and
    // each settle on their own previous slot rather than racing to
    // slot 1 and shuffling via collision detection. This is what makes
    // a multi-tab browser-reopen restore the original (slot, name)
    // pairing instead of randomly swapping them.
    if (tabSlot) {
      ch.postMessage({ type: "heartbeat", slot: tabSlot, tabId: TAB_ID });
    } else {
      const pending = Number(sessionStorage.getItem("unoSlot"));
      if (Number.isFinite(pending) && pending > 0) {
        // Tag the gossip with `intent: true` so a same-slot conflict
        // between two not-yet-claimed tabs can be resolved by TAB_ID
        // tiebreak in the election handler below.
        ch.postMessage({ type: "intent", slot: pending, tabId: TAB_ID });
      }
    }
  } else if (d.type === "intent" && typeof d.slot === "number" && typeof d.tabId === "string") {
    // Another tab is in its election window and wants this slot. Use it
    // for tiebreak only — DO NOT add to `knownSlots`. If we did, the
    // surviving tab would think the slot is taken by an unclaimed peer
    // and fall back, leaving slot 1 unused. The peer's actual claim
    // (heartbeat after their election fires) will land in knownSlots
    // through the heartbeat handler.
    //
    // We also separately track `peerIntentSeen` so the boot decision
    // can tell "I'm not alone" from "I'm alone, fall back to slot 1".
    // Without this, three tabs restored in parallel each see only
    // each other's `intent` (not heartbeats), so each one's election
    // believes it's a lone tab and falls back to slot 1 — collisions
    // resolve to a single slot 1 winner with the others scrambled.
    if (d.tabId !== TAB_ID) {
      peerIntentSeen = true;
    }
    const ourIntent = Number(sessionStorage.getItem("unoSlot"));
    if (
      tabSlot === 0 &&
      Number.isFinite(ourIntent) &&
      ourIntent > 0 &&
      ourIntent === d.slot &&
      d.tabId !== TAB_ID &&
      d.tabId < TAB_ID
    ) {
      _clientLog(
        `yielding stored slot=${ourIntent} to peer tabId=${String(d.tabId).slice(0, 6)} (< ours=${TAB_ID.slice(0, 6)})`,
      );
      sessionStorage.removeItem("unoSlot");
    }
  } else if (d.type === "bye" && typeof d.slot === "number" && typeof d.tabId === "string") {
    const cur = knownSlots.get(d.slot);
    if (cur && cur.tabId === d.tabId) {
      knownSlots.delete(d.slot);
      _clientLog(`peer-bye slot=${d.slot} known=[${knownSlotsSnapshot().join(",")}]`);
    }
  }
};

ch.onmessageerror = () => {
  /* ignore */
};

// Boot: always negotiate via the BroadcastChannel. We don't take the
// "session-restore shortcut" of grabbing the stored slot directly,
// because Chrome restores `sessionStorage.unoSlot` for ALL recovered
// tabs — including ones where the user just wants a clean start after
// a full browser reopen. Instead we listen for `who` responses for
// ELECTION_MS and decide based on what we hear:
//   * If we have a stored slot AND no live peer claims it during the
//     election window, keep that slot (deterministic restore — multi-
//     tab browser reopen lands each restored tab back on its own slot
//     with its own typed name). The same rule covers F5: a tab
//     mid-game has both sessionStorage.unoSlot and unoPlayerId-N
//     under that slot, and it just stays put.
//   * Otherwise pick the lowest free slot starting at 1. A lone tab
//     opened after every other tab is gone lands on slot 1 (no peer
//     responses, the stored slot may not be 1, but the rule "lowest
//     free wins" trumps the stored preference when there's nobody
//     else around) — except: if the stored slot itself is 1, that's
//     identical to the fresh-start slot anyway. The override only
//     kicks in for stored slots > 1 with no peers visible.
(() => {
  const stored = Number(sessionStorage.getItem("unoSlot"));
  const haveStored = Number.isFinite(stored) && stored > 0;
  const hasIdentityForStored = haveStored && !!localStorage.getItem(`unoPlayerId-${stored}`);

  _clientLog(
    `boot tabId=${TAB_ID.slice(0, 6)} stored=${haveStored ? stored : "none"} hasIdentity=${hasIdentityForStored}`,
  );

  // Probe for live peers and announce our intent in the same go.
  // Posting `intent` upfront lets simultaneously-booting peers spot a
  // same-slot collision before either has claimed, and the smaller-
  // TAB_ID tab wins the tiebreak (see the `intent` handler).
  ch.postMessage({ type: "who", tabId: TAB_ID });
  if (haveStored) {
    ch.postMessage({ type: "intent", slot: stored, tabId: TAB_ID });
  }
  if (electionTimer !== null) return;
  electionTimer = setTimeout(() => {
    electionTimer = null;
    if (tabSlot !== 0) return; // somebody claimed during the wait window

    pruneStaleSlots();
    const heardAnyPeer = knownSlots.size > 0 || peerIntentSeen;
    // Re-read sessionStorage — `intent` handler may have wiped it if
    // we lost a tiebreak.
    const storedNow = Number(sessionStorage.getItem("unoSlot"));
    const haveStoredNow = Number.isFinite(storedNow) && storedNow > 0;
    _clientLog(
      `election-decide stored=${haveStoredNow ? storedNow : "none"} heardPeers=[${knownSlotsSnapshot().join(",")}] intentSeen=${peerIntentSeen} hasIdentity=${hasIdentityForStored}`,
    );

    if (haveStoredNow) {
      const peerOnStored = knownSlots.has(storedNow);
      if (!peerOnStored) {
        if (heardAnyPeer || hasIdentityForStored || storedNow === 1) {
          _clientLog(`election-decide -> keep stored slot=${storedNow}`);
          claimSlot(storedNow, "restored");
          return;
        }
      } else {
        _clientLog(`election-decide stored slot=${storedNow} held by peer, falling back`);
      }
    }

    // Fallback: no usable stored slot, or the stored slot is held by a
    // peer, or no peers responded (lone-tab reopen). Always elect from
    // slot 1.
    sessionStorage.removeItem("unoSlot");
    claimSlot(pickFreeSlot(), "elected");
  }, ELECTION_MS);
})();

setInterval(() => {
  pruneStaleSlots();
  if (tabSlot) ch.postMessage({ type: "heartbeat", slot: tabSlot, tabId: TAB_ID });
}, HEARTBEAT_MS);

// Be aggressive about announcing our exit — without it the surviving
// peer takes up to STALE_MS (4s) to evict our entry, during which a
// brand-new tab might land on a slot it shouldn't.
//
// `beforeunload` is the obvious choice but Chrome / Firefox both skip
// it for some "close" paths (page navigation, multi-tab close from a
// menu, mobile background-kill). `pagehide` fires more reliably as the
// modern equivalent. Using both, plus `visibilitychange` on hidden, gives
// the best coverage. The guard prevents double-bye spam if multiple
// events fire in quick succession.
let byeSent = false;
function announceBye(): void {
  if (byeSent || !tabSlot) return;
  byeSent = true;
  try {
    ch.postMessage({ type: "bye", slot: tabSlot, tabId: TAB_ID });
  } catch {
    // Channel may be closing already; ignore.
  }
}
window.addEventListener("beforeunload", () => {
  announceBye();
  try {
    ch.close();
  } catch {}
});
window.addEventListener("pagehide", () => {
  announceBye();
});
const CLIENT_PREFIX = _CLIENT_PREFIX;
function clientLog(msg: string, ...args: unknown[]): void {
  _clientLog(msg, ...args);
}
function clientWarn(msg: string, ...args: unknown[]): void {
  _clientWarn(msg, ...args);
}

// ── Error definitions (fetched from /errors) ─────────────
interface ErrorDef {
  message: string;
  needRefresh: boolean;
}
let errorDefs: Record<string, ErrorDef> | null = null;

async function loadErrorDefs(): Promise<void> {
  if (errorDefs) return;
  try {
    const resp = await fetch("/errors");
    if (resp.ok) {
      errorDefs = await resp.json();
      clientLog("loaded error definitions");
    }
  } catch (_e) {
    clientWarn("failed to load error definitions");
  }
}

function getErrorDef(key: string): ErrorDef | undefined {
  return errorDefs ? errorDefs[key] : undefined;
}

let myId: string | null = null;
let ws: WebSocket | null = null;
let currentTurn = -1;
let gameDirection = 1;
let players: Player[] = [];
let pendingWildCard: Card | Card[] | null = null;
let selectedCards: SavedSelection[] = [];
let isSelectingMultiple = false;
let myHand: Card[] = [];
let myLobbyId: string | null = null;
let isSpectating = false;
let gameState = 0;
let drawingChain = 0;
// Absolute epoch-ms deadline for the current turn — broadcast by the server
// and used purely for client-side display. Browsers throttle setTimeout in
// background tabs, so we never use a relative timer; the visible countdown
// is computed from `Date.now()` against this deadline. `null` means "no
// active timeout" (e.g. AI turn, lobby state, game over).
let turnDeadline: number | null = null;

// Mirrors the server-side dev pause flag. While true, the countdown UI
// freezes and shows a "暂停" badge instead of seconds, so users / dev
// can tell the auto-draw timer is intentionally on hold.
let turnTimerPaused: boolean = false;
// Constant fetched from /constants. Falls back to a reasonable default so
// the UI degrades gracefully if the fetch hasn't completed yet.
let PLAY_TIMEOUT_MS = 30000;
// requestAnimationFrame handle for the turn countdown ticker. We use rAF
// instead of setInterval because a once-per-second interval looks janky in
// the foreground but more importantly because rAF is paused (rather than
// throttled to 1 tick/min) when the tab backgrounds — that's actually fine
// here since the server is the source of truth. When the tab returns to
// the foreground, the next paint snaps the displayed value back to the
// real Date.now() diff with no drift.
let turnTimerRaf: number | null = null;
// Backup ticker that keeps the seconds-display fresh even if rAF gets
// stalled. Some user reports show the timer stuck on "30s" — most
// likely an rAF starvation caused by a different page being focused
// or DevTools being open. setInterval has its own throttling story
// for hidden tabs but it survives more edge cases than rAF alone.
let turnTimerInterval: number | null = null;

// Hovered-via-keyboard card index. -1 = none. The visual treatment matches
// the .hovered CSS class (added below) so the hover animation is identical
// whether triggered by the mouse or by the keyboard. Enter plays the
// hovered card; ESC / click-on-empty-area / a different digit replaces it;
// playing the card or running into a hand-update naturally clears it.
let keyboardHoverIndex = -1;
function setKeyboardHover(idx: number): void {
  if (keyboardHoverIndex === idx) return;
  // In-place class toggle so the existing .card transition kicks in,
  // giving the same lift/outline animation as the mouse hover. Recreating
  // the DOM (as we used to do via updateHand) skipped the transition
  // because the element was brand new.
  const cards = playerHandDiv.querySelectorAll(".card");
  if (keyboardHoverIndex >= 0 && keyboardHoverIndex < cards.length) {
    cards[keyboardHoverIndex].classList.remove("keyboard-hover");
  }
  keyboardHoverIndex = idx;
  if (idx >= 0 && idx < cards.length) {
    cards[idx].classList.add("keyboard-hover");
  }
}
function clearKeyboardHover(): void {
  if (keyboardHoverIndex === -1) return;
  setKeyboardHover(-1);
}
// Map a keyboard digit (top-row or numpad) to a hand index using the
// "1 → first card, 0 → tenth" convention. Returns -1 if the key isn't
// a digit. Top-row digits use `e.code` (Digit1...) and numpad uses
// (Numpad1...) — handle both so users with either layout work.
function digitFromKeyEvent(e: KeyboardEvent): number {
  // Ignore digit input while focus is in a text field — otherwise typing
  // a chat message would highlight cards.
  const tag = (document.activeElement && (document.activeElement as HTMLElement).tagName) || "";
  if (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    (document.activeElement as HTMLElement | null)?.isContentEditable
  ) {
    return -1;
  }
  let digit = -1;
  if (/^Digit[0-9]$/.test(e.code)) digit = Number(e.code.slice(5));
  else if (/^Numpad[0-9]$/.test(e.code)) digit = Number(e.code.slice(6));
  if (digit < 0) return -1;
  if (digit === 0) return 9;
  return digit - 1;
}
function getLeaveSpectateBtn(): HTMLButtonElement | null {
  return document.getElementById("leave-spectate-btn") as HTMLButtonElement | null;
}

// ── Turn countdown helpers ─────────────────────────────
// rAF-driven so backgrounded tabs don't stutter — the visible value is
// always Date.now() vs. the server-supplied absolute deadline. The label
// is appended INSIDE the turn-indicator H3 (not as a sibling) so it
// inherits centering and sits inline with the "YOU" / "<name>'s turn"
// text instead of dropping to its own off-center line.
function getTurnTimerEl(): HTMLSpanElement {
  let el = document.getElementById("turn-timer") as HTMLSpanElement | null;
  if (!el) {
    el = document.createElement("span");
    el.id = "turn-timer";
    // Inline child of the H3 so it stays on the same baseline.
    turnText.appendChild(el);
  }
  return el;
}
function setTurnTimerText(text: string): void {
  const el = getTurnTimerEl();
  if (el.textContent !== text) el.textContent = text;
}
function tickTurnCountdown(): void {
  if (turnDeadline === null) {
    setTurnTimerText("");
    getTurnTimerEl().classList.remove("low", "critical", "paused");
    if (turnTimerRaf !== null) {
      window.cancelAnimationFrame(turnTimerRaf);
      turnTimerRaf = null;
    }
    if (turnTimerInterval !== null) {
      window.clearInterval(turnTimerInterval);
      turnTimerInterval = null;
    }
    return;
  }
  // Dev pause: server clamped the timer; freeze the displayed value so
  // it doesn't tick towards 0 while paused. We still keep the timer-el
  // mounted so the badge swap (paused → live) is smooth on resume.
  if (turnTimerPaused) {
    setTurnTimerText("暂停");
    const el = getTurnTimerEl();
    el.classList.remove("low", "critical");
    el.classList.add("paused");
    // No further rAF tick while paused — resume will re-arm via update.
    if (turnTimerRaf !== null) {
      window.cancelAnimationFrame(turnTimerRaf);
      turnTimerRaf = null;
    }
    return;
  }
  const remaining = Math.max(0, turnDeadline - Date.now());
  // The visible window is PLAY_TIMEOUT_MS — the server adds a small grace
  // beyond it. Cap the displayed value at the configured timeout so the
  // user doesn't see a number larger than the documented limit.
  const display = Math.min(remaining, PLAY_TIMEOUT_MS);
  const seconds = Math.ceil(display / 1000);
  setTurnTimerText(`${seconds}s`);
  // Visual urgency tiers — keep the legacy `(Ns)` regex test happy by
  // mirroring the value into a parenthesized fallback only when no
  // .low/.critical class is active. (The new CSS uses ::before to render
  // the parens around the value so the textContent stays just `Ns`.)
  const el = getTurnTimerEl();
  el.classList.remove("paused");
  el.classList.toggle("critical", seconds <= 5);
  el.classList.toggle("low", seconds > 5 && seconds <= 10);
  turnTimerRaf = window.requestAnimationFrame(tickTurnCountdown);
}
function startTurnCountdown(): void {
  if (turnTimerRaf !== null) return;
  turnTimerRaf = window.requestAnimationFrame(tickTurnCountdown);
  // Belt-and-suspenders: a 1s interval guarantees the display ticks
  // even if rAF gets stalled (some Chromium states let rAF pause for
  // hidden / inactive tabs OR throttle to extreme rates). The
  // interval is cheap — it just calls tick which short-circuits if
  // turnDeadline is null.
  if (turnTimerInterval === null) {
    turnTimerInterval = window.setInterval(() => {
      if (turnDeadline !== null) tickTurnCountdown();
    }, 250);
  }
}
function stopTurnCountdown(): void {
  if (turnTimerRaf !== null) {
    window.cancelAnimationFrame(turnTimerRaf);
    turnTimerRaf = null;
  }
  if (turnTimerInterval !== null) {
    window.clearInterval(turnTimerInterval);
    turnTimerInterval = null;
  }
}

// Add these elements to the existing DOM references
const joinFormContainer = document.createElement("div");
joinFormContainer.id = "join-form-container";

let isDisconnected = false;
let disconnectToastTimeout: ReturnType<typeof setTimeout> | null = null;
// Reconnect-deadline countdown is rAF-driven (rather than setInterval) so
// browser tabs don't desync the displayed value when backgrounded. The
// authoritative deadline is the absolute epoch ms in
// `Player.reconnectDeadline`; we just diff it against Date.now() each frame.
let reconnectCountdownRaf: number | null = null;
let reconnectCountdownLastSec: Map<string, number> = new Map();
let actionQueue: object[] = [];
let refreshErrorCount = 0;
let refreshErrorTime = 0;
let justReconnected = false;

function encodeUGC(content: string): string {
  const tempEl = document.createElement("div");
  tempEl.textContent = content;
  return tempEl.innerHTML;
}

// Modal dialog helpers — replaces native alert/confirm
const modalOverlay = document.getElementById("modal-overlay") as HTMLDivElement;
const modalMessage = document.getElementById("modal-message") as HTMLParagraphElement;
const modalOkBtn = document.getElementById("modal-ok-btn") as HTMLButtonElement;
const modalCancelBtn = document.getElementById("modal-cancel-btn") as HTMLButtonElement;

// CSS handles the multi-line whitespace; preserve newlines and tabs in
// modal messages by setting the textContent directly. The CSS rule for
// #modal-message uses `white-space: pre-line` so '\n' renders as a break.
function setModalMessage(text: string): void {
  modalMessage.textContent = text;
}

// Wires up keyboard navigation for the modal. The OK button is the default
// (auto-focused, Enter submits); Tab and arrow keys cycle between OK and
// Cancel; Escape resolves like Cancel (or OK when there is no Cancel).
type ModalKeyHandler = (action: "ok" | "cancel") => void;
function attachModalKeyboard(hasCancel: boolean, onAction: ModalKeyHandler): () => void {
  const buttons: HTMLButtonElement[] = hasCancel ? [modalCancelBtn, modalOkBtn] : [modalOkBtn];
  // Focus the primary action so Enter Just Works on first paint.
  setTimeout(() => modalOkBtn.focus(), 0);

  function focusNext(delta: number): void {
    const active = document.activeElement as HTMLElement | null;
    let idx = buttons.findIndex((b) => b === active);
    if (idx === -1) idx = buttons.length - 1; // default to primary
    const next = buttons[(idx + delta + buttons.length) % buttons.length];
    next.focus();
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      onAction(hasCancel ? "cancel" : "ok");
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const target = document.activeElement;
      if (target === modalCancelBtn) onAction("cancel");
      else onAction("ok");
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      focusNext(e.shiftKey ? -1 : 1);
      return;
    }
    if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      focusNext(-1);
      return;
    }
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      focusNext(1);
    }
  }
  document.addEventListener("keydown", onKey, true);
  return () => document.removeEventListener("keydown", onKey, true);
}

function showAlert(msg: string): Promise<void> {
  return new Promise((resolve) => {
    modalCancelBtn.style.display = "none";
    setModalMessage(msg);
    modalOkBtn.textContent = "确定";
    modalOverlay.classList.remove("hidden");
    modalOverlay.style.display = "flex";

    let detachKeys: () => void = () => {};
    function cleanup() {
      modalOverlay.classList.add("hidden");
      modalOverlay.style.display = "";
      modalOkBtn.removeEventListener("click", onOk);
      detachKeys();
      resolve();
    }
    function onOk() {
      cleanup();
    }
    modalOkBtn.addEventListener("click", onOk);
    detachKeys = attachModalKeyboard(false, () => onOk());
  });
}

function showConfirm(msg: string): Promise<boolean> {
  return new Promise((resolve) => {
    modalCancelBtn.style.display = "";
    setModalMessage(msg);
    modalOkBtn.textContent = "确定";
    modalOverlay.classList.remove("hidden");
    modalOverlay.style.display = "flex";

    let detachKeys: () => void = () => {};
    function cleanup(result: boolean) {
      modalOverlay.classList.add("hidden");
      modalOverlay.style.display = "";
      modalOkBtn.removeEventListener("click", onOk);
      modalCancelBtn.removeEventListener("click", onCancel);
      detachKeys();
      resolve(result);
    }
    function onOk() {
      cleanup(true);
    }
    function onCancel() {
      cleanup(false);
    }
    modalOkBtn.addEventListener("click", onOk);
    modalCancelBtn.addEventListener("click", onCancel);
    detachKeys = attachModalKeyboard(true, (action) => {
      cleanup(action === "ok");
    });
  });
}

let connecting = false;
let currentWs: WebSocket | null = null;
function connect(): void {
  if (connecting && ws && ws.readyState !== WebSocket.CLOSED) return;
  connecting = true;
  joinButton.disabled = true;
  const wsUrl = new URL("/ws", location.href);
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
  const newWs = new WebSocket(wsUrl.toString());
  currentWs = newWs;
  ws = newWs;

  newWs.onopen = () => {
    if (newWs !== currentWs) return;
    connecting = false;
    clientLog("Connected to server");
    isDisconnected = false;
    joinButton.disabled = false;
    lobbyIdInput.disabled = false;
    nameInput.disabled = false;
    loadErrorDefs();
    // Sync constants from server
    fetch("/constants")
      .then((r) => r.json())
      .then((c) => {
        if (c.NAME_LENGTH_MIN) NAME_LENGTH_MIN = c.NAME_LENGTH_MIN;
        if (c.NAME_LENGTH_MAX) NAME_LENGTH_MAX = c.NAME_LENGTH_MAX;
        if (c.PLAY_TIMEOUT_MS) {
          PLAY_TIMEOUT_MS = c.PLAY_TIMEOUT_MS;
          // Reflect the live constant in the rules dialog so server & UI stay
          // in sync if the operator tweaks PLAY_TIMEOUT_MS in constants.ts.
          const rulesEl = document.getElementById("rules-play-timeout");
          if (rulesEl) rulesEl.textContent = String(Math.round(c.PLAY_TIMEOUT_MS / 1000));
        }
      })
      .catch(() => {});
    const btn = document.getElementById("dev-disconnect-btn");
    if (btn) btn.textContent = "断开";
    // Wait for the slot to be assigned before reading per-tab state, otherwise
    // store.get falls back to the legacy plain localStorage key (shared across
    // tabs) and every tab would see the value written by whichever tab wrote
    // last.
    slotReady.then(() => {
      if (newWs !== currentWs) return;
      const savedId = store.get("unoPlayerId");
      clientLog(
        `onopen savedId=${savedId ? savedId.slice(0, 8) : null} actionQueue=${actionQueue.length}`,
      );
      // Always pre-fill name/lobby from storage
      nameInput.value = store.get("unoPlayerName") || "";
      lobbyIdInput.value = store.get("unoLobbyId") || "";
      if (savedId) {
        justReconnected = true;
        sendMessage({ action: "reconnect", playerId: savedId });
      } else if (!store.get("unoLeftLobby")) {
        const savedName = store.get("unoPlayerName");
        const savedLobbyId = "";
        if (savedName && savedLobbyId) {
          const msg: Record<string, string> = {
            action: "join",
            name: savedName,
            lobbyId: savedLobbyId,
          };
          if (savedId) msg.playerId = savedId;
          clientLog(`onopen fallback join name=${savedName}`);
          sendMessage(msg);
        }
        hideDisconnectedToast();
      } else {
        store.remove("unoLeftLobby");
        hideDisconnectedToast();
      }
    });
  };

  newWs.onmessage = async (event: MessageEvent) => {
    const message: ServerMessage = JSON.parse(event.data);

    switch (message.action) {
      case "init":
        myId = message.id!;
        clientLog("[init] myId =", myId);
        if (message.reconnectLost) {
          clientLog("[init] reconnect lost, showing join form");
          store.remove("unoPlayerId");
          store.remove("unoInLobby");
          store.remove("unoInGame");
          store.set("unoLeftLobby", "true");
          myLobbyId = null;
          resetGameState();
        } else if (!store.get("unoPlayerId")) {
          store.set("unoPlayerId", myId);
        }
        if (message.dev) setupDevPanel();
        hideDisconnectedToast();
        return;

      case "error": {
        const key = message.errorKey;
        const def = key ? getErrorDef(key) : undefined;
        const msg = def ? def.message : message.message || "未知错误";
        const needRefresh = def
          ? def.needRefresh
          : !!message.message && message.message.includes("刷新页面");
        if (needRefresh) {
          const now = Date.now();
          if (now - refreshErrorTime > 10000) refreshErrorCount = 0;
          refreshErrorTime = now;
          refreshErrorCount++;
          if (refreshErrorCount >= 3) {
            const reset = await showConfirm(
              "多次重连失败，是否重置连接状态？（重置不会清除玩家名称和大厅 ID）",
            );
            if (reset) {
              store.remove("unoInLobby");
              store.remove("unoInGame");
              store.remove("unoPlayerId");
            }
            refreshErrorCount = 0;
            nameInput.disabled = false;
            lobbyIdInput.disabled = false;
            joinButton.disabled = false;
            return;
          }
        }
        showAlert(msg).then(() => {
          if (needRefresh) {
            store.remove("unoInLobby");
            store.remove("unoInGame");
            store.remove("unoPlayerId");
          }
          nameInput.disabled = false;
          lobbyIdInput.disabled = false;
          joinButton.disabled = false;
        });
        return;
      }

      case "players":
        clientLog(`players received, flushing actionQueue (was ${actionQueue.length})`);
        hideDisconnectedToast();
        players = message.players || [];
        currentTurn = message.turn || 0;
        gameDirection = message.direction || 1;
        gameState = message.gameState || 0;
        drawingChain = message.drawingCount || 0;
        turnDeadline = typeof message.turnDeadline === "number" ? message.turnDeadline : null;
        turnTimerPaused = !!message.turnTimerPaused;
        myLobbyId = message.lobbyId || null;
        store.set("unoPlayerId", myId!);
        store.set("unoInLobby", "1");
        flushQueue();
        clientLog(
          "[players] myId =",
          myId,
          "players =",
          players.map((p) => ({ id: p.id, name: p.name })),
        );
        updatePlayers(players, currentTurn);
        updateTurnIndicator();
        showLobbyInfo(message.lobbyId || "");
        // Sync draw mode toggle + the in-game status pill source.
        if (message.drawMode) {
          const mode = message.drawMode;
          currentDrawMode = mode === "direct" ? "direct" : "chain";
          document.querySelectorAll("#draw-mode-toggle-box .mode-option").forEach((el) => {
            el.classList.toggle("active", el.getAttribute("data-mode") === mode);
          });
          updateGameStatusPills();
          updateDevStateInfo();
        }
        break;

      case "start":
        clientLog(`start received, flushing actionQueue (was ${actionQueue.length})`);
        hideDisconnectedToast();
        flushQueue();
        myId = message.id!;
        store.set("unoPlayerId", myId);
        isSpectating = message.spectator || false;
        clientLog(
          "[start] myId =",
          myId,
          "players =",
          (message.players || []).map((p) => ({ id: p.id, name: p.name })),
          "turn =",
          message.turn,
        );
        // Was the game UI hidden before this message? Only a real
        // lobby→game transition should reset the scroll position; a
        // re-broadcast `start` (reconnect, late echo, spectator swap)
        // arriving while the user is already mid-game must NOT yank
        // their scroll back to the top.
        const enteringGameFromLobby = gameDiv.style.display === "none";
        lobbyDiv.style.display = "none";
        gameDiv.style.display = "block";
        document.getElementById("about-clear-btn")!.style.display = "none";
        document.getElementById("about-storage-title")!.style.display = "none";
        players = message.players || [];
        currentTurn = message.turn || 0;
        gameDirection = message.direction || 1;
        gameState = message.gameState || 0;
        drawingChain = message.drawingCount || 0;
        turnDeadline = typeof message.turnDeadline === "number" ? message.turnDeadline : null;
        turnTimerPaused = !!message.turnTimerPaused;
        myHand = message.hand || [];
        updatePlayers(players, currentTurn);
        updateDiscardPile(message.discardPile || []);
        updateHand(myHand);
        applyCardLayout();
        updateTurnIndicator();
        const _btn0 = getLeaveSpectateBtn();
        if (_btn0) _btn0.style.display = isSpectating ? "" : "none";
        document.body.classList.toggle("spectator", isSpectating);
        // Entering the game swaps out the (short) lobby DOM for the
        // (taller) game DOM. The browser's scroll-anchoring can leave the
        // viewport pinned to the bottom of the new layout, hiding the
        // turn indicator and discard pile until the user manually scrolls
        // up. Reset to the top once layout settles so the game always
        // opens at the natural starting position — but ONLY on the real
        // lobby→game transition, never on a re-broadcast start that lands
        // while the user is already playing (that would yank their scroll).
        if (enteringGameFromLobby) {
          requestAnimationFrame(() => {
            window.scrollTo(0, 0);
            // We just reset to the top, so the header is in its expanded
            // (un-pinned) state. The watcher will re-collapse on scroll.
            document.body.classList.remove("header-collapsed");
          });
        }
        // Start watching scroll so the sticky header collapses into the
        // compact docked bar once the user scrolls down into their hand.
        ensureStickyHeaderWatcher();
        break;

      case "update":
        clientLog(`update received, flushing actionQueue (was ${actionQueue.length})`);
        hideDisconnectedToast();
        flushQueue();
        if (message.spectator !== undefined) {
          isSpectating = message.spectator;
          const _btn = getLeaveSpectateBtn();
          if (_btn) _btn.style.display = isSpectating ? "" : "none";
          document.body.classList.toggle("spectator", isSpectating);
        }
        clientLog(
          "[update] myId =",
          myId,
          "turn =",
          message.turn,
          "players =",
          (message.players || []).map((p) => ({ id: p.id, name: p.name })),
          "current =",
          (message.players || [])[message.turn || 0]
            ? (message.players || [])[message.turn || 0].id
            : null,
        );
        // Capture the per-player card-count deltas BEFORE replacing
        // `players`. We can't spawn the popup yet — `updatePlayers`
        // below clears and rebuilds #opponent-hands, which would
        // immediately yank the popup out of the DOM. Save the deltas
        // and re-attach after the rebuild.
        const penaltyDeltas = computePenaltyDeltas(players, message.players || []);
        players = message.players || [];
        currentTurn = message.turn || 0;
        gameDirection = message.direction || 1;
        gameState = message.gameState || 0;
        drawingChain = message.drawingCount || 0;
        turnDeadline = typeof message.turnDeadline === "number" ? message.turnDeadline : null;
        turnTimerPaused = !!message.turnTimerPaused;
        myHand = message.hand || [];
        updatePlayers(players, currentTurn);
        // Now that the new player tiles exist, spawn the +N popups so
        // they actually have a parent that survives the rebuild.
        for (const [pid, delta] of penaltyDeltas) spawnPenaltyPopup(pid, delta);
        updateDiscardPile(message.discardPile || []);
        updateHand(myHand);
        applyCardLayout();
        updateTurnIndicator();
        break;

      case "win":
        if (isSpectating) {
          const winnerMessage = message.winner?.length
            ? `${message.winner} 赢得了游戏！`
            : "没有人赢得了游戏, 所有真人玩家已离开对局";

          showAlert(winnerMessage).then(() => {
            resetGameState();
          });
        } else {
          showGameOver(message.winner || "");
        }
        break;

      case "surrender_offer": {
        const spectate = await showConfirm("是否进入观战模式？\n确定=观战  取消=离开");
        if (spectate) {
          sendMessage({ action: "spectate_accept" });
        } else {
          sendMessage({ action: "leave" });
          store.remove("unoPlayerId");
          store.remove("unoInLobby");
          store.remove("unoInGame");
          resetGameState();
        }
        return;
      }

      case "surrendered":
        localStorage.removeItem("unoInLobby");
        localStorage.removeItem("unoInGame");
        document.getElementById("about-clear-btn")!.style.display = "";
        document.getElementById("about-storage-title")!.style.display = "";
        resetGameState();
        break;

      case "spectate_offer": {
        const want = await showConfirm("该大厅对局已开始，是否进入观战模式？");
        if (want) {
          sendMessage({ action: "spectate", lobbyId: message.lobbyId, name: nameInput.value });
        } else {
          nameInput.disabled = false;
          lobbyIdInput.disabled = false;
          joinButton.disabled = false;
        }
        return;
      }

      case "game_aborted":
        if (isSpectating) {
          store.remove("unoInLobby");
          store.remove("unoInGame");
          resetGameState();
        } else {
          showGameAborted();
        }
        break;

      case "dev_state_export":
        clientLog("[dev_state_export]", JSON.stringify(message.log, null, 2));
        showAlert("状态日志已输出到控制台");
        break;

      case "reaction":
        showReaction(message.playerId || "", message.type || "", message.content || "");
        break;

      case "turn_timeout": {
        // Server auto-drew because the player let the timer expire. Show a
        // brief toast to everyone — the server will follow up with an
        // 'update' that advances the turn so we don't need to mutate
        // state here.
        const name = message.playerName || "玩家";
        const isMe = message.playerId === myId;
        showTurnTimeoutToast(isMe ? "你超时未操作，自动抽牌" : `${name} 超时未操作，自动抽牌`);
        break;
      }
    }
  };

  newWs.onclose = (event: CloseEvent) => {
    if (newWs !== currentWs) return;
    connecting = false;
    clientLog(`ws.onclose code=${event.code} reason=${event.reason}`);
    isDisconnected = true;
    joinButton.disabled = true;
    showDisconnectedToast("connecting");
    if (event.code !== 1000) {
      setTimeout(connect, 1300);
    }
  };

  newWs.onerror = (err: Event) => {
    if (newWs !== currentWs) return;
    clientWarn("WebSocket error:", err);
  };
}

function canSendMessage(): boolean {
  return !!ws && ws.readyState === WebSocket.OPEN;
}

function flushQueue(): void {
  if (justReconnected) {
    justReconnected = false;
    clientLog(`flushQueue sending ${actionQueue.length} queued actions`);
  }
  while (actionQueue.length > 0) {
    const msg = actionQueue.shift()!;
    const action = (msg as Record<string, string>).action;
    // Skip ready on reconnect: server state is already current,
    // sending a stale ready would toggle the state incorrectly
    if (action === "ready") {
      clientLog(`flush SKIPPING stale ready`);
      continue;
    }
    // Skip join if we are already in a lobby (reconnected successfully)
    if (action === "join" && myLobbyId) {
      clientLog(`flush SKIPPING stale join (already in lobby ${myLobbyId})`);
      continue;
    }
    clientLog(`flush sending action=${action}`);
    if (canSendMessage()) {
      ws!.send(JSON.stringify(msg));
    }
  }
}

function sendMessage(message: object): boolean {
  if (canSendMessage()) {
    ws!.send(JSON.stringify(message));
    return true;
  }
  clientLog(`QUEUE action=${(message as Record<string, string>).action}`);
  actionQueue.push(message);
  isDisconnected = true;
  showDisconnectedToast("action");
  return false;
}

let lastReadyText = "";
function updateReadyButton(): void {
  if (!readyButton) return;
  readyButton.disabled = false;
  const me = players.find((p) => p.id === myId);
  const text = me && me.ready ? "取消准备" : "准备";
  if (text === lastReadyText) return;
  lastReadyText = text;
  clientLog(
    `updateReadyButton myId=${myId ? myId.slice(0, 8) : null} found=${!!me} ready=${me ? me.ready : null} text=${text}`,
  );
  readyButton.textContent = text;
}

function getTurnLabelEl(): HTMLSpanElement {
  let el = document.getElementById("turn-label") as HTMLSpanElement | null;
  if (!el) {
    el = document.createElement("span");
    el.id = "turn-label";
    // Prepend so the label sits before the timer badge.
    turnText.insertBefore(el, turnText.firstChild);
  }
  return el;
}
// Set the turn label text WITHOUT clobbering the inline #turn-timer span
// (a direct `turnText.textContent = …` would delete the timer child and
// force a recreate every turn). Keeping them as separate spans also lets
// the collapsed sticky-header CSS hide just the label and keep the timer.
function setTurnLabelText(text: string): void {
  const el = getTurnLabelEl();
  if (el.textContent !== text) el.textContent = text;
}

function updateTurnIndicator(): void {
  if (currentTurn === -1 || !players.length) {
    setTurnLabelText("等待游戏开始...");
    turnIndicator.classList.remove("my-turn");
    document.body.classList.remove("my-turn");
    document.body.classList.add("player-action-disabled");
    stopTurnCountdown();
    setTurnTimerText("");
    return;
  }

  const currentPlayer = players[currentTurn];
  const isMyTurn = currentPlayer && currentPlayer.id === myId;

  clientLog(
    "[turn] myId =",
    myId,
    "currentPlayer.id =",
    currentPlayer ? currentPlayer.id : null,
    "isMyTurn =",
    isMyTurn,
  );

  if (isMyTurn) {
    setTurnLabelText("YOU");
    turnIndicator.classList.add("my-turn");
    document.body.classList.add("my-turn");
    document.body.classList.remove("player-action-disabled");
  } else {
    setTurnLabelText(`${currentPlayer ? currentPlayer.name : "-"}的回合`);
    turnIndicator.classList.remove("my-turn");
    document.body.classList.remove("my-turn");
    document.body.classList.add("player-action-disabled");
  }

  // Drive the countdown display. The visible text is computed from
  // Date.now() vs. the absolute deadline broadcast by the server, NOT from
  // a relative setInterval — this is intentional: when the tab moves to
  // the background the browser may stop firing intervals, but the next
  // animation frame after the tab refocuses will show the correct value.
  if (
    turnDeadline !== null &&
    currentPlayer &&
    !currentPlayer.isAI &&
    !currentPlayer.disconnected
  ) {
    startTurnCountdown();
    // Force one tick immediately so the paused/live UI flips on the
    // next state change without waiting for the rAF tick (which won't
    // happen at all while paused).
    tickTurnCountdown();
  } else {
    stopTurnCountdown();
    setTurnTimerText("");
  }
  // Sync the dev panel toggle text with the server-known pause state.
  // Players who don't have dev mode never see the button; for those
  // who do, this keeps the label in sync with reality even after
  // reconnects/spectator transitions.
  const devToggleBtn = document.getElementById("dev-toggle-timer-btn");
  if (devToggleBtn) {
    devToggleBtn.textContent = turnTimerPaused ? "继续计时" : "暂停计时";
  }

  // Build turn order display
  // The merged design (see updatePlayers) renders the turn order as
  // big player cards in #opponent-hands with prominent arrows between
  // them. The legacy compact #turn-order pill strip used to live here;
  // we keep the element around (hidden) so any leftover sticky-scroll
  // or testing hook that looks it up still finds something, but no
  // pills are emitted into it.
  let orderEl = document.getElementById("turn-order");
  if (orderEl) {
    orderEl.innerHTML = "";
    orderEl.style.display = "none";
  }

  updateGameStatusPills();
  updateDevStateInfo();
  // The indicator's height can change with its content (label/timer),
  // so re-measure where the tiles row should pin flush beneath it.
  updateTilesStickyTop();
}

// Source-of-truth for the current draw mode the lobby is using. Tracked
// alongside players state so the in-game status pill can show "链式加牌"
// or "直接加牌" without re-reading the lobby toggle UI.
let currentDrawMode: "chain" | "direct" = "chain";

// In-game status strip: shows current draw mode (chain/direct) and the
// pending chain count when there's an active +N stack. Hidden when the
// game div isn't visible.
function updateGameStatusPills(): void {
  const wrap = document.getElementById("game-status");
  const modeEl = document.getElementById("game-status-mode") as HTMLSpanElement | null;
  const chainEl = document.getElementById("game-status-chain") as HTMLSpanElement | null;
  if (!wrap || !modeEl || !chainEl) return;
  // Only show the strip while the game UI is visible.
  if (gameDiv.style.display === "none") {
    wrap.style.display = "none";
    return;
  }
  wrap.style.display = "";

  // Mode pill — always rendered while in-game.
  modeEl.classList.remove("mode-chain", "mode-direct");
  if (currentDrawMode === "chain") {
    modeEl.classList.add("mode-chain");
    modeEl.textContent = "链式加牌";
  } else {
    modeEl.classList.add("mode-direct");
    modeEl.textContent = "直接加牌";
  }

  // Chain pill — only shown when chain mode is active AND there's a
  // pending penalty count (gameState===1 = drawing-chain state in
  // server.ts). In direct mode the +N is applied immediately so there's
  // no chain to show.
  if (currentDrawMode === "chain" && gameState === 1 && drawingChain > 0) {
    chainEl.classList.remove("hidden");
    chainEl.textContent = `链式累计 +${drawingChain}`;
  } else {
    chainEl.classList.add("hidden");
  }
}

// When the page is scrolled far enough that the turn-indicator and the
// player-tiles row (#opponent-hands) have both pinned to the top of the
// viewport, collapse them into a compact docked header:
//   - the turn-indicator shrinks to a thin full-viewport-width colored
//     bar (green on our turn, red/orange otherwise — a loading-bar look)
//   - the player-tiles row docks flush beneath that bar and shares a
//     single unified background so the two read as one piece.
// We drive this purely with a body-level class toggled on scroll; the
// CSS in style.css does the visual collapsing.
const TURN_INDICATOR_STICKY_TOP = 8; // keep in sync with #turn-indicator { top }

// The collapsed header is full-viewport-width. Using `100vw` would
// include the vertical scrollbar gutter and produce a phantom
// horizontal scrollbar; instead we publish the true content width
// (documentElement.clientWidth) as a CSS var and the full-bleed rules
// size against it.
function setViewportWidthVar(): void {
  const w = document.documentElement.clientWidth;
  document.documentElement.style.setProperty("--vw100", `${w}px`);
}

// The turn-indicator and the player-tiles row are both sticky but pin at
// different top offsets (indicator at top:8, tiles below it). If the
// tiles' sticky `top` is larger than the indicator's pinned bottom, the
// page content scrolls through the gap between the two — a visible seam
// when scrolled partway. Measure the indicator's actual pinned footprint
// (height + its 8px top offset) and publish it so the tiles pin flush.
const TILES_FALLBACK_TOP = 80;
function updateTilesStickyTop(): void {
  if (gameDiv.style.display === "none") return;
  // offsetHeight is the laid-out height regardless of the indicator's
  // current scroll position (sticky doesn't change it). Add the 8px
  // sticky-top anchor; no extra gap so the tiles butt right against it.
  const h = turnIndicator.offsetHeight;
  const top = h > 0 ? TURN_INDICATOR_STICKY_TOP + h : TILES_FALLBACK_TOP;
  document.documentElement.style.setProperty("--tiles-sticky-top", `${top}px`);
}

// We decide collapse/expand from a zero-height SENTINEL placed in normal
// flow just above the player-tiles row (#opponent-hands) — NOT from the
// tiles' own geometry. The sentinel sits ABOVE the sticky tiles, so its
// position is a pure function of scroll and is unaffected by the collapse
// (which is purely visual and preserves in-flow height). Triggering off
// the tiles' natural top means the collapse fires exactly when the tiles
// reach their pinned spot — the bar (drawn on the tiles) and the docked
// layout appear together, with no in-between range where a tall bar or a
// floating countdown could show.
let stickyHeaderSentinel: HTMLDivElement | null = null;

function ensureStickyHeaderSentinel(): HTMLDivElement {
  if (stickyHeaderSentinel && stickyHeaderSentinel.isConnected) return stickyHeaderSentinel;
  const s = document.createElement("div");
  s.id = "sticky-header-sentinel";
  s.setAttribute("aria-hidden", "true");
  // Zero-height marker inserted right before #opponent-hands (the player
  // tiles row), which is the element that actually docks when collapsed.
  // It marks the tiles' natural (un-pinned) top, so the collapse fires at
  // the exact scroll position where the tiles reach their pinned spot —
  // no gap where the bar/tiles haven't caught up to the docked layout.
  opponentHandsDiv.parentNode!.insertBefore(s, opponentHandsDiv);
  stickyHeaderSentinel = s;
  return s;
}

let stickyHeaderScrollBound = false;
let stickyHeaderRafPending = false;

// Hysteresis band (px): collapse once the sentinel is at/above the
// sticky anchor, but only expand again after it has dropped a clear
// margin below it. Two separated thresholds mean there is no single
// point where a 1px jitter (or a sub-pixel reflow) can flip the state
// back and forth — killing the flicker at the trigger point.
const STICKY_COLLAPSE_AT = TURN_INDICATOR_STICKY_TOP; // collapse when top <= 8
const STICKY_EXPAND_AT = TURN_INDICATOR_STICKY_TOP + 28; // expand when top >= 36

function evalStickyHeaderCollapse(): void {
  stickyHeaderRafPending = false;
  if (gameDiv.style.display === "none") {
    document.body.classList.remove("header-collapsed");
    restoreTimerToHeader();
    return;
  }
  const sentinel = ensureStickyHeaderSentinel();
  // The sentinel sits ABOVE every sticky element, so its viewport top is
  // a pure function of scroll position — it does NOT move when the header
  // collapses (the collapse is purely visual and preserves in-flow
  // height; see the CSS). That, plus the hysteresis band below, keeps the
  // toggle perfectly stable with no flicker.
  const top = sentinel.getBoundingClientRect().top;
  const collapsed = document.body.classList.contains("header-collapsed");
  if (!collapsed && top <= STICKY_COLLAPSE_AT) {
    document.body.classList.add("header-collapsed");
    relocateTimerToBody();
  } else if (collapsed && top >= STICKY_EXPAND_AT) {
    document.body.classList.remove("header-collapsed");
    restoreTimerToHeader();
  }
}

// The countdown badge normally lives inline inside #turn-text, which is
// inside #turn-indicator. When collapsed, the indicator forms its own
// stacking context (z-index:50) and the tiles card (z-index:51) paints
// over the indicator's lower region — which would bury the fixed badge
// no matter how high its own z-index is (z-index only ranks within the
// same stacking context). To dock the badge into the tiles area in
// front of everything, we lift it OUT to document.body while collapsed,
// then put it back inline when expanded.
function relocateTimerToBody(): void {
  const el = document.getElementById("turn-timer");
  if (el && el.parentElement !== document.body) {
    document.body.appendChild(el);
  }
}
function restoreTimerToHeader(): void {
  const el = document.getElementById("turn-timer");
  if (el && el.parentElement !== turnText) {
    turnText.appendChild(el);
  }
}

function scheduleStickyHeaderCollapse(): void {
  if (stickyHeaderRafPending) return;
  stickyHeaderRafPending = true;
  requestAnimationFrame(evalStickyHeaderCollapse);
}

function ensureStickyHeaderWatcher(): void {
  setViewportWidthVar();
  updateTilesStickyTop();
  ensureStickyHeaderSentinel();
  // Evaluate once now in case we're already scrolled.
  scheduleStickyHeaderCollapse();
  if (stickyHeaderScrollBound) return;
  stickyHeaderScrollBound = true;
  // Passive scroll listener, coalesced to one rAF per frame.
  window.addEventListener("scroll", scheduleStickyHeaderCollapse, { passive: true });
  window.addEventListener(
    "resize",
    () => {
      setViewportWidthVar();
      updateTilesStickyTop();
      scheduleStickyHeaderCollapse();
    },
    { passive: true },
  );
}

// Dev panel state info pane — populated only when the dev panel is
// active (i.e. the server told us we're in dev mode via the init
// message's `dev:true` flag). For everyone else this is a no-op.
function updateDevStateInfo(): void {
  const pane = document.getElementById("dev-state-info");
  if (!pane) return;
  // Skip when dev panel is hidden (production builds, or before the
  // init handshake fired). Cheap early-return so the per-update cost
  // for normal users is one display lookup.
  const panel = document.getElementById("dev-panel");
  if (!panel || panel.style.display === "none") {
    pane.textContent = "";
    return;
  }
  const me = players.find((p) => p.id === myId);
  const cur = players[currentTurn];
  const rows: Array<[string, string]> = [
    ["lobby", myLobbyId || "—"],
    ["phase", gameDiv.style.display !== "none" ? "game" : "lobby"],
    ["players", String(players.length)],
    ["turn", cur ? `${cur.name}${cur.isAI ? " (AI)" : ""}` : "—"],
    ["direction", gameDirection === 1 ? "→" : "←"],
    ["drawMode", currentDrawMode],
    ["gameState", String(gameState)],
    ["chain", drawingChain > 0 ? `+${drawingChain}` : "—"],
    [
      "turnDeadline",
      turnDeadline ? `${Math.max(0, Math.ceil((turnDeadline - Date.now()) / 1000))}s` : "—",
    ],
    ["timerPaused", turnTimerPaused ? "true" : "false"],
    ["myId", myId ? myId.slice(0, 8) : "—"],
    ["myHand", String(myHand.length)],
    ["isCreator", me && me.isCreator ? "true" : "false"],
    ["isSpectator", isSpectating ? "true" : "false"],
  ];
  pane.innerHTML = rows
    .map(
      ([k, v]) =>
        `<div class="dev-state-row"><span class="dev-state-key">${k}</span><span class="dev-state-val">${escapeHtml(v)}</span></div>`,
    )
    .join("");
}

// Minimal HTML escape for the dev info pane only — keeps colon-laden
// player names and lobby ids from accidentally injecting markup.
function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}

function showLobbyInfo(lobbyId: string): void {
  if (lobbyId) {
    currentLobbyId.textContent = lobbyId;
    readyButton.style.display = "block";

    // Find the creator and update the lobby info
    const creator = players.find((p) => p.isCreator);
    const lobbyInfoTitle = document.querySelector("#lobby-info h3");
    if (creator) {
      lobbyInfoTitle!.innerHTML = `大厅：<span id="current-lobby-id">${encodeUGC(lobbyId)}</span><br><small style="font-size: 0.8em; opacity: 0.8;">由 ${encodeUGC(creator.name)} 创建 <img src="/icons/crown.svg" style="width:1.2em;height:1.2em;vertical-align:text-bottom;"></small>`;
      // Re-add the click functionality to the new span
      const newLobbyIdSpan = document.getElementById("current-lobby-id")!;
      newLobbyIdSpan.style.cursor = "pointer";
      newLobbyIdSpan.title = "Click to copy lobby ID";
      newLobbyIdSpan.addEventListener("click", copyLobbyId);
    } else {
      lobbyInfoTitle!.innerHTML = `大厅：<span id="current-lobby-id">${encodeUGC(lobbyId)}</span>`;
    }

    lobbyInfo.style.display = "block";
    hideJoinForm();

    store.set("unoPlayerName", nameInput.value);
    if (lobbyId) store.set("unoLobbyId", lobbyId);
  }
}

function attemptRejoin(): void {
  // Per-tab state may not be readable yet during the slot election window.
  slotReady.then(() => {
    const savedLobbyId = "";
    const savedPlayerName = store.get("unoPlayerName");

    if (savedLobbyId && savedPlayerName) {
      lobbyIdInput.value = savedLobbyId;
      nameInput.value = savedPlayerName;
    }
  });
}

function resetGameState(): void {
  localStorage.removeItem("unoInLobby");
  localStorage.removeItem("unoInGame");
  document.getElementById("about-clear-btn")!.style.display = "";
  document.getElementById("about-storage-title")!.style.display = "";
  stopReconnectCountdown();
  stopTurnCountdown();
  setTurnTimerText("");
  turnDeadline = null;
  // Reset spectator state — without this a former spectator coming
  // back to the lobby would still have body.spectator and the
  // start-handler's `if (isSpectating)` branch would hide the hand.
  isSpectating = false;
  document.body.classList.remove("spectator");
  const _btnSpec = getLeaveSpectateBtn();
  if (_btnSpec) _btnSpec.style.display = "none";
  // Reset to lobby
  lobbyDiv.style.display = "block";
  gameDiv.style.display = "none";
  // Drop the collapsed-header state so the lobby never inherits the
  // docked-bar styling.
  document.body.classList.remove("header-collapsed");

  requestAnimationFrame(() => {
    nameInput.value = (store.get("unoPlayerName") || "").trim();
    nameInput.disabled = false;
    joinButton.disabled = false;
    lobbyIdInput.disabled = false;

    // Clear game state (keep myId — persists across lobby sessions)
    currentTurn = -1;
    players = [];
    pendingWildCard = null;
    selectedCards = [];
    isSelectingMultiple = false;
    myHand = [];
    myLobbyId = null;

    // Hide wild color picker and lobby info
    wildColorPicker.style.display = "none";
    hideLobbyInfo();
    readyButton.style.display = "none";
    if (inviteAIBtn) inviteAIBtn.style.display = "none";
    document.getElementById("draw-mode-area")!.style.display = "none";

    // Clear players list
    playersList.innerHTML = "";

    // Reset turn indicator
    setTurnLabelText("Waiting for game to start...");
    turnIndicator.classList.remove("my-turn");
  });
}

function updatePlayers(newPlayers: Player[], turn: number): void {
  opponentHandsDiv.innerHTML = "";
  playersList.innerHTML = "";
  // Track whether to render the merged turn-order layout. We only do
  // this once the game is actually visible (gameDiv shown) so the in-
  // lobby player list isn't affected.
  const renderInOrder = newPlayers.length >= 2;
  for (let i = 0; i < newPlayers.length; i++) {
    const player = newPlayers[i];
    const playerDiv = document.createElement("div");
    playerDiv.classList.add("player");
    if (i === turn) {
      playerDiv.classList.add("active");
    }

    if (player.uno) {
      playerDiv.classList.add("uno");
    }

    // Add creator styling to opponent display too
    if (player.isCreator) {
      playerDiv.classList.add("creator");
    }

    if (player.isAI) {
      playerDiv.classList.add("ai");
    }

    if (player.disconnected) {
      playerDiv.classList.add("disconnected");
    }

    if (player.id === myId) {
      playerDiv.classList.add("self");
    }

    let iconHtml = "";
    if (player.isCreator) {
      iconHtml +=
        '<img src="/icons/crown.svg" style="width:1.2em;height:1.2em;vertical-align:text-bottom;margin-left:2px;">';
    }
    if (player.isAI) {
      iconHtml +=
        '<img src="/icons/robot.svg" style="width:1.2em;height:1.2em;vertical-align:text-bottom;margin-left:2px;">';
    }

    let displayText = player.name;
    if (player.disconnected && player.reconnectDeadline) {
      const remaining = Math.max(0, Math.ceil((player.reconnectDeadline - Date.now()) / 1000));
      displayText += ` · 重连中 ${remaining}s`;
    }

    // For self, prefer the eagerly-known myHand.length so the count
    // updates immediately on play (mirrors what the old turn-order
    // pill did). For everyone else use the server-side cardCount.
    const cardCount = player.id === myId ? myHand.length : (player.cardCount ?? undefined);
    if (cardCount !== undefined) {
      playerDiv.innerHTML = `${encodeUGC(displayText)}${iconHtml}（${cardCount} 张牌）`;
    } else {
      playerDiv.innerHTML = `${encodeUGC(displayText)}${iconHtml}`;
    }

    playerDiv.dataset.playerId = player.id;
    // Render every player (including self) inside opponent-hands when we
    // have a real game in progress. This is the merged turn-order display:
    // self appears in the row in their actual seat, with prominent arrows
    // between cards. The bottom hand area still owns the actual cards;
    // this row is purely the order indicator + name + count.
    if (renderInOrder || player.id !== myId) {
      opponentHandsDiv.appendChild(playerDiv);
      // Insert a big direction arrow between cards (skip after the last).
      if (i < newPlayers.length - 1) {
        const arrow = document.createElement("span");
        arrow.classList.add("order-arrow");
        arrow.textContent = gameDirection === 1 ? "▶" : "◀";
        opponentHandsDiv.appendChild(arrow);
      }
    }

    const li = document.createElement("li");
    li.classList.add("player-row");
    if (player.isCreator) li.classList.add("creator");
    if (player.isAI) li.classList.add("ai");
    if (player.disconnected) li.classList.add("disconnected");

    const nameSpan = document.createElement("span");
    nameSpan.classList.add("player-name");
    let nameText = player.name;
    if (player.ready) nameText += "（已准备）";
    if (player.disconnected && player.reconnectDeadline) {
      const remaining = Math.max(0, Math.ceil((player.reconnectDeadline - Date.now()) / 1000));
      nameText += ` · 重连中 ${remaining}s`;
    }
    nameSpan.innerHTML = `${encodeUGC(nameText)}${iconHtml}`;
    if (i === turn) nameSpan.style.fontWeight = "bold";
    li.appendChild(nameSpan);

    // Ready button for unready AI players (only visible to creator)
    const me = newPlayers.find((p) => p.id === myId);
    if (player.isAI && me && me.isCreator) {
      const actionsDiv = document.createElement("span");
      actionsDiv.classList.add("ai-actions");

      const readyAiBtn = document.createElement("button");
      readyAiBtn.textContent = player.ready ? "取消准备" : "准备";
      readyAiBtn.classList.add("ready-ai-btn");
      readyAiBtn.addEventListener("click", () => {
        sendMessage({ action: "ai_ready", playerId: player.id });
      });
      actionsDiv.appendChild(readyAiBtn);

      const kickAiBtn = document.createElement("button");
      kickAiBtn.textContent = "踢出";
      kickAiBtn.classList.add("kick-ai-btn");
      kickAiBtn.addEventListener("click", () => {
        sendMessage({ action: "remove_ai", playerId: player.id });
      });
      actionsDiv.appendChild(kickAiBtn);

      li.appendChild(actionsDiv);
    }

    // Transfer creator button for non-AI non-creator players (visible to creator)
    if (
      me &&
      me.isCreator &&
      !player.isAI &&
      !player.isCreator &&
      !player.disconnected &&
      player.id !== myId
    ) {
      const transferBtn = document.createElement("button");
      transferBtn.textContent = "转让房主";
      transferBtn.classList.add("transfer-creator-btn");
      transferBtn.addEventListener("click", () => {
        sendMessage({ action: "transfer_creator", playerId: player.id });
      });
      li.appendChild(transferBtn);
    }

    playersList.appendChild(li);
  }

  // Show/hide invite AI button
  const me = newPlayers.find((p) => p.id === myId);
  if (inviteAIBtn) {
    inviteAIBtn.style.display = me && me.isCreator ? "" : "none";
  }
  // Show the draw-mode indicator to everyone in the lobby — non-creators
  // get a read-only view (so they can see what mode the game will use)
  // while the creator gets the interactive toggle. CSS handles the
  // disabled appearance via the `.readonly` class.
  const drawModeArea = document.getElementById("draw-mode-area")!;
  drawModeArea.style.display = "flex";
  drawModeArea.classList.toggle("readonly", !(me && me.isCreator));
  updateReadyButton();

  // Drive the reconnect-countdown text via rAF instead of setInterval. The
  // setInterval approach is throttled to once per minute when the tab is
  // backgrounded, so the displayed seconds-remaining could lag wildly. rAF
  // is paused when the tab is hidden but resumes on focus and the next
  // frame snaps to the correct Date.now() diff with no drift.
  const hasDeadline = newPlayers.some((p) => p.disconnected && !!p.reconnectDeadline);
  if (hasDeadline) {
    startReconnectCountdown();
  } else {
    stopReconnectCountdown();
  }
}

// Reconnect-countdown helpers — only re-renders when the displayed seconds
// value would actually change, so we don't thrash the DOM at 60fps.
function tickReconnectCountdown(): void {
  let needsRender = false;
  for (const p of players) {
    if (p.disconnected && p.reconnectDeadline) {
      const sec = Math.max(0, Math.ceil((p.reconnectDeadline - Date.now()) / 1000));
      if (reconnectCountdownLastSec.get(p.id) !== sec) {
        reconnectCountdownLastSec.set(p.id, sec);
        needsRender = true;
      }
    }
  }
  if (needsRender) {
    updatePlayers(players, currentTurn);
  }
  if (players.some((p) => p.disconnected && !!p.reconnectDeadline)) {
    reconnectCountdownRaf = window.requestAnimationFrame(tickReconnectCountdown);
  } else {
    reconnectCountdownRaf = null;
  }
}
function startReconnectCountdown(): void {
  if (reconnectCountdownRaf !== null) return;
  reconnectCountdownRaf = window.requestAnimationFrame(tickReconnectCountdown);
}
function stopReconnectCountdown(): void {
  if (reconnectCountdownRaf !== null) {
    window.cancelAnimationFrame(reconnectCountdownRaf);
    reconnectCountdownRaf = null;
  }
  reconnectCountdownLastSec.clear();
}

function updateHand(hand: Card[]): void {
  playerHandDiv.innerHTML = "";

  // Determine which cards are playable against the top discard
  const discardCard = discardPileDiv.querySelector(".card");
  const topColor = discardCard ? discardCard.getAttribute("data-color") : null;
  const topType = discardCard ? discardCard.getAttribute("data-type") : null;

  // Auto-clear out-of-bounds keyboard hover (e.g. after we played the
  // hovered card our hand shrank and the index now points past the end).
  if (keyboardHoverIndex >= hand.length) keyboardHoverIndex = -1;

  for (let i = 0; i < hand.length; i++) {
    const card = hand[i];
    const cardDiv = createCard(card);

    cardDiv.dataset.cardIndex = String(i);

    if (selectedCards.some((selected) => selected.index === i)) {
      cardDiv.classList.add("selected");
    }

    // Keyboard-driven hover (Task 6) — mirror the cursor-hover treatment
    // for the active digit-key target so the user gets visual confirmation
    // before pressing Enter to play.
    if (i === keyboardHoverIndex) {
      cardDiv.classList.add("keyboard-hover");
    }

    // Add a small digit badge to the first 10 cards so the user can see
    // which keyboard digit selects each one. Only drawn for the active
    // player so spectators / off-turn players don't get a misleading
    // shortcut hint.
    if (i < 10) {
      const meIsTurn = !!players[currentTurn] && players[currentTurn].id === myId && !isSpectating;
      if (meIsTurn) {
        const badge = document.createElement("span");
        badge.classList.add("card-key-badge");
        // 0-indexed → display as 1..9, 0 for the tenth slot.
        badge.textContent = String((i + 1) % 10);
        cardDiv.appendChild(badge);
      }
    }

    // Mark non-playable cards (no hover lift)
    if (topColor && topType) {
      const isNCard = (t: string) => t === "draw2" || t === "wild4";
      const playable =
        card.type === "wild" ||
        card.type === "wild4" ||
        card.color === topColor ||
        card.type === topType ||
        (isNCard(card.type) && isNCard(topType));
      if (!playable) cardDiv.classList.add("not-playable");
    }

    cardDiv.addEventListener("click", () => handleCardClick(card, i, hand));
    playerHandDiv.appendChild(cardDiv);
  }

  // Add play selected cards button if multiple cards are selected (below the hand)
  if (selectedCards.length > 1) {
    const playButton = document.createElement("button");
    playButton.textContent = `出 ${selectedCards.length} 张牌`;
    playButton.classList.add("play-multiple-btn");
    playButton.addEventListener("click", playSelectedCards);
    playerHandDiv.appendChild(playButton);

    const cancelButton = document.createElement("button");
    cancelButton.textContent = "取消选择";
    cancelButton.classList.add("cancel-selection-btn");
    cancelButton.addEventListener("click", clearSelection);
    playerHandDiv.appendChild(cancelButton);
  }
}

async function handleCardClick(card: Card, cardIndex: number, hand: Card[]): Promise<void> {
  // If wild color picker is open and this card is not wild, dismiss picker
  if (wildColorPicker.style.display !== "none" && card.type !== "wild" && card.type !== "wild4") {
    hideWildColorPicker();
  }

  // Bug #4: a click should only matter if it is actually our turn AND the
  // card can legally be played. Otherwise a click on a disabled card used
  // to surface the "break chain" confirm even when nothing was going to
  // happen — a confusing UX and a vector for accidental forfeits.
  const me = players.find((p) => p.id === myId);
  const isMyTurn = !!me && players[currentTurn] && players[currentTurn].id === myId;
  if (!isMyTurn || isSpectating) {
    // Off-turn clicks are inert — leave selection state alone (so the user
    // can preview, but no dialog and no message goes to the server).
    return;
  }
  if (!isCardPlayable(card)) {
    // Card visually has the .not-playable lift suppressed; we additionally
    // bail early so the chain-break dialog doesn't appear for a card we
    // would have rejected anyway.
    return;
  }

  // Check if we're selecting multiple cards
  if (isSelectingMultiple) {
    toggleCardSelection(card, cardIndex, hand);
  } else {
    // Single card play
    if (card.type === "wild" || card.type === "wild4") {
      // Bug #2: wild (no number) and wild4 also break the chain in chain
      // mode — confirm before the player commits the penalty. wild4 is
      // itself a draw card so it's chain-extending in chain mode and never
      // hits this branch's confirm; wild is the regular non-draw wild card
      // and absolutely should warn.
      if (gameState === 1 && card.type === "wild" && drawingChain > 0) {
        const ok = await showConfirm(`确定要打破链式加牌吗？\n你将抽 ${drawingChain} 张牌`);
        if (!ok) return;
      }
      showWildColorPicker(card);
    } else {
      // In drawing chain state, confirm before breaking with non-draw2/wild4
      if (gameState === 1 && card.type !== "draw2" && card.type !== "wild4" && drawingChain > 0) {
        const ok = await showConfirm(`确定要打破链式加牌吗？\n你将抽 ${drawingChain} 张牌`);
        if (!ok) return;
      }
      sendMessage({ action: "play", card: card });
    }
  }
}

// True iff `card` is legal against the current discard top. Mirrors the
// server-side isValidMove logic (kept in sync manually since the client
// does not import server modules).
function isCardPlayable(card: Card): boolean {
  const discardCard = discardPileDiv.querySelector(".card");
  if (!discardCard) return true;
  const topColor = discardCard.getAttribute("data-color");
  const topType = discardCard.getAttribute("data-type");
  if (!topColor || !topType) return true;
  if (card.type === "wild" || card.type === "wild4") return true;
  if (card.color === topColor) return true;
  if (card.type === topType) return true;
  const isNCard = (t: string) => t === "draw2" || t === "wild4";
  if (isNCard(card.type) && isNCard(topType)) return true;
  return false;
}

function startMultipleSelection(card: Card, cardIndex: number): void {
  isSelectingMultiple = true;
  selectedCards = [{ card, index: cardIndex }];
  updateHand(getCurrentHand());
}

function toggleCardSelection(card: Card, cardIndex: number, hand: Card[]): void {
  const existingIndex = selectedCards.findIndex((selected) => selected.index === cardIndex);

  if (existingIndex >= 0) {
    // Remove from selection
    selectedCards.splice(existingIndex, 1);
  } else {
    // Add to selection if same type as first selected card
    if (selectedCards.length === 0 || selectedCards[0].card.type === card.type) {
      selectedCards.push({ card, index: cardIndex });
    } else {
      showAlert("只能选择相同类型的牌！");
      return;
    }
  }

  // If no cards selected, exit multiple selection mode
  if (selectedCards.length === 0) {
    isSelectingMultiple = false;
  }

  updateHand(hand);
}

function playSelectedCards(): void {
  if (selectedCards.length === 0) return;

  const firstCard = selectedCards[0].card;
  if (firstCard.type === "wild" || firstCard.type === "wild4") {
    // For wild cards, we need to pick a color first
    pendingWildCard = selectedCards.map((s) => s.card);
    wildColorPicker.style.display = "block";
  } else {
    // Send multiple cards to server
    sendMessage({
      action: "play_multiple",
      cards: selectedCards.map((s) => s.card),
      indices: selectedCards.map((s) => s.index),
    });
    clearSelection();
  }
}

function clearSelection(): void {
  selectedCards = [];
  isSelectingMultiple = false;
  hideWildColorPicker();
  updateHand(getCurrentHand());
}

function getCurrentHand(): Card[] {
  return myHand;
}

let wildPickerScrollY = 0;
let onWildPickerScroll: (() => void) | null = null;

// ── Wild color-picker keyboard support ──────────────────
// The picker is fully keyboard-driven (Task 2): digit 1-4 picks the
// matching color, ←/→ cycles the keyboard-hover ring, Enter commits the
// hovered color, Esc cancels. Mirrors the pattern used by the modal so
// users don't have to learn two different shortcut sets.
const WILD_COLORS = ["red", "yellow", "green", "blue"] as const;
let wildKeyboardIndex = -1;
let detachWildKeyboard: (() => void) | null = null;
function setWildKeyboardHover(idx: number): void {
  wildKeyboardIndex = idx;
  for (const opt of Array.from(colorOptions.querySelectorAll(".color-option")) as HTMLElement[]) {
    opt.classList.remove("keyboard-hover");
  }
  if (idx >= 0 && idx < WILD_COLORS.length) {
    const target = colorOptions.querySelector(
      `.color-option[data-color="${WILD_COLORS[idx]}"]`,
    ) as HTMLElement | null;
    if (target) target.classList.add("keyboard-hover");
  }
}
function commitWildPick(color: string): void {
  if (!pendingWildCard) return;
  if (Array.isArray(pendingWildCard)) {
    sendMessage({
      action: "play_multiple",
      cards: pendingWildCard.map((card) => ({ ...card, color })),
      indices: selectedCards.map((s) => s.index),
    });
    clearSelection();
  } else {
    sendMessage({ action: "play", card: { ...pendingWildCard, color } });
  }
  wildPickerScrollY = 0;
  hideWildColorPicker();
}

function showWildColorPicker(card: Card): void {
  pendingWildCard = card;
  wildPickerScrollY = window.scrollY;
  // Reset any in-flight closing animation so the entry animation re-runs
  // cleanly when the picker is opened back-to-back.
  wildColorPicker.classList.remove("closing");
  // Forcing a reflow by reading offsetWidth lets the browser pick up the
  // class change before we set display, otherwise the entry animation
  // sometimes plays in the wrong direction during fast reopen sequences.
  // eslint-disable-next-line no-unused-expressions
  void wildColorPicker.offsetWidth;
  wildColorPicker.style.display = "block";
  // Default to no keyboard hover — first digit / arrow press picks one.
  setWildKeyboardHover(-1);
  // Attach the keyboard handler for this open instance.
  detachWildKeyboard = attachWildKeyboard();
  requestAnimationFrame(() => {
    wildColorPicker.scrollIntoView({ behavior: "smooth", block: "center" });
    // Attach manual scroll listener after auto-scroll settles
    setTimeout(() => {
      onWildPickerScroll = () => {
        wildPickerScrollY = 0;
      };
      window.addEventListener("scroll", onWildPickerScroll, { once: true });
    }, 600);
  });
}

function hideWildColorPicker(): void {
  // Already hidden — nothing to do (and avoids a duplicate animation cycle
  // when both Esc and the click handler race).
  if (wildColorPicker.style.display === "none") return;
  pendingWildCard = null;
  setWildKeyboardHover(-1);
  if (detachWildKeyboard) {
    detachWildKeyboard();
    detachWildKeyboard = null;
  }
  if (onWildPickerScroll) {
    window.removeEventListener("scroll", onWildPickerScroll);
    onWildPickerScroll = null;
  }
  // Trigger the exit animation; only after it finishes do we set
  // display:none. animationend fires reliably for our keyframe and we
  // also use a fallback timeout in case the user navigates away.
  wildColorPicker.classList.add("closing");
  const finish = () => {
    wildColorPicker.classList.remove("closing");
    wildColorPicker.style.display = "none";
    if (wildPickerScrollY) {
      window.scrollTo({ top: wildPickerScrollY, behavior: "smooth" });
      wildPickerScrollY = 0;
    }
  };
  let done = false;
  const onEnd = () => {
    if (done) return;
    done = true;
    wildColorPicker.removeEventListener("animationend", onEnd);
    finish();
  };
  wildColorPicker.addEventListener("animationend", onEnd, { once: true });
  // Safety net — if animationend doesn't fire (e.g. element was hidden by
  // a parent transition) make sure we still settle the state.
  setTimeout(onEnd, 250);
}

function attachWildKeyboard(): () => void {
  function onKey(e: KeyboardEvent): void {
    // Don't hijack keys when focus is in a text input — chat would break.
    const tag = (document.activeElement && (document.activeElement as HTMLElement).tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA") return;

    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      hideWildColorPicker();
      return;
    }
    if (e.key === "Enter") {
      if (wildKeyboardIndex < 0) return;
      e.preventDefault();
      e.stopPropagation();
      commitWildPick(WILD_COLORS[wildKeyboardIndex]);
      return;
    }
    if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      const next =
        wildKeyboardIndex < 0
          ? WILD_COLORS.length - 1
          : (wildKeyboardIndex - 1 + WILD_COLORS.length) % WILD_COLORS.length;
      setWildKeyboardHover(next);
      return;
    }
    if (e.key === "ArrowRight" || e.key === "ArrowDown" || e.key === "Tab") {
      e.preventDefault();
      const next = wildKeyboardIndex < 0 ? 0 : (wildKeyboardIndex + 1) % WILD_COLORS.length;
      setWildKeyboardHover(next);
      return;
    }
    // Digit 1-4 directly commits the corresponding color.
    let digit = -1;
    if (/^Digit[1-4]$/.test(e.code)) digit = Number(e.code.slice(5));
    else if (/^Numpad[1-4]$/.test(e.code)) digit = Number(e.code.slice(6));
    if (digit >= 1 && digit <= 4) {
      e.preventDefault();
      e.stopPropagation();
      commitWildPick(WILD_COLORS[digit - 1]);
    }
  }
  document.addEventListener("keydown", onKey, true);
  return () => document.removeEventListener("keydown", onKey, true);
}

function updateDiscardPile(discardPile: Card[]): void {
  discardPileDiv.innerHTML = "";
  const card = discardPile[discardPile.length - 1];
  const cardDiv = createCard(card);
  discardPileDiv.appendChild(cardDiv);
}

function createCard(card: Card): HTMLDivElement {
  const cardDiv = document.createElement("div");
  cardDiv.classList.add("card");

  // Set data attributes for CSS styling
  cardDiv.setAttribute("data-color", card.color || "black");
  cardDiv.setAttribute("data-type", card.type);

  // Create card content structure
  const cardContent = document.createElement("div");
  cardContent.classList.add("card-content");

  // Determine card display values
  let cornerNumber: string, cornerSymbol: string, centerContent: string;

  if (card.type === "wild") {
    cornerNumber = "W";
    cornerSymbol = "★";
    centerContent = "W";
  } else if (card.type === "wild4") {
    cornerNumber = "+4";
    cornerSymbol = "★";
    centerContent = "+4";
  } else if (card.type === "draw2") {
    cornerNumber = "+2";
    cornerSymbol = "2";
    centerContent = "+2";
  } else if (card.type === "skip") {
    cornerNumber = "Ø";
    cornerSymbol = "Ø";
    centerContent = "Ø";
  } else if (card.type === "reverse") {
    cornerNumber = "⇄";
    cornerSymbol = "⇄";
    centerContent = "⇄";
  } else {
    cornerNumber = card.type.toUpperCase();
    cornerSymbol = card.type.toUpperCase();
    centerContent = card.type.toUpperCase();
  }

  // Create top-left corner
  const topLeftCorner = document.createElement("div");
  topLeftCorner.classList.add("card-corner", "top-left");

  const topLeftNumber = document.createElement("div");
  topLeftNumber.classList.add("card-corner-number");
  topLeftNumber.textContent = cornerNumber;

  topLeftCorner.appendChild(topLeftNumber);

  // Create bottom-right corner
  const bottomRightCorner = document.createElement("div");
  bottomRightCorner.classList.add("card-corner", "bottom-right");

  const bottomRightNumber = document.createElement("div");
  bottomRightNumber.classList.add("card-corner-number");
  bottomRightNumber.textContent = cornerNumber;

  bottomRightCorner.appendChild(bottomRightNumber);

  // Create center ellipse
  const cardCenter = document.createElement("div");
  cardCenter.classList.add("card-center");

  const cardCenterContent = document.createElement("div");
  cardCenterContent.classList.add("card-center-content");

  const centerElement = document.createElement("div");
  centerElement.classList.add("card-center-number");
  centerElement.textContent = centerContent;

  cardCenterContent.appendChild(centerElement);
  cardCenter.appendChild(cardCenterContent);

  // Assemble the card
  cardContent.appendChild(topLeftCorner);
  cardContent.appendChild(bottomRightCorner);
  cardContent.appendChild(cardCenter);
  cardDiv.appendChild(cardContent);

  return cardDiv;
}

// Update the color picker to handle multiple wild cards
colorOptions.addEventListener("click", (e: Event) => {
  const target = e.target as HTMLElement;
  if (target.classList.contains("color-option")) {
    const color = target.dataset.color!;
    if (pendingWildCard) {
      if (Array.isArray(pendingWildCard)) {
        sendMessage({
          action: "play_multiple",
          cards: pendingWildCard.map((card) => ({ ...card, color: color })),
          indices: selectedCards.map((s) => s.index),
        });
        clearSelection();
      } else {
        sendMessage({ action: "play", card: { ...pendingWildCard, color: color } });
      }
    }
    wildPickerScrollY = 0;
    hideWildColorPicker();
  }
});

document.getElementById("cancel-wild-btn")!.addEventListener("click", hideWildColorPicker);

joinButton.addEventListener("click", async () => {
  const name = nameInput.value.trim();
  const lobbyId = lobbyIdInput.value.trim().toUpperCase();

  if (!name) {
    await showAlert("请输入你的名称");
    return;
  }

  if (name.length < NAME_LENGTH_MIN) {
    await showAlert("名称至少需要 2 个字符");
    return;
  }

  if (name.length > NAME_LENGTH_MAX) {
    await showAlert(`名称不能超过 ${NAME_LENGTH_MAX} 个字符`);
    return;
  }

  // Disable form to prevent multiple submissions
  nameInput.disabled = true;
  lobbyIdInput.disabled = true;
  joinButton.disabled = true;

  const savedId = store.get("unoPlayerId");
  const message: Record<string, string> = { action: "join", name: name };
  if (lobbyId) message.lobbyId = lobbyId;
  if (savedId) message.playerId = savedId;
  // Save immediately so auto-reconnect can find these even if WS closes
  // before the first players/start message arrives
  store.set("unoPlayerName", name);
  if (lobbyId) store.set("unoLobbyId", lobbyId);
  sendMessage(message);
});

if (inviteAIBtn) {
  inviteAIBtn.addEventListener("click", () => {
    sendMessage({ action: "add_ai" });
  });
}

readyButton.addEventListener("click", () => {
  if (readyButton.disabled) {
    clientLog(`ready click ignored (disabled)`);
    return;
  }
  readyButton.disabled = true;
  // readyButton.textContent = '...';
  clientLog(`ready click, sending, isDisconnected=${isDisconnected}`);
  if (sendMessage({ action: "ready" })) {
    updateReadyButton();
  }
});

drawCardButton.addEventListener("click", async () => {
  if (gameState === 1 && drawingChain > 0) {
    const ok = await showConfirm(`确定要打破链式加牌吗？\n你将抽 ${drawingChain} 张牌`);
    if (!ok) return;
  }
  sendMessage({ action: "draw" });
});

const surrenderBtn = document.getElementById("surrender-btn") as HTMLButtonElement;
if (surrenderBtn) {
  surrenderBtn.addEventListener("click", async () => {
    const confirmed = await showConfirm("确定要认输吗？");
    if (confirmed) {
      sendMessage({ action: "surrender" });
    }
  });
}

document.addEventListener("DOMContentLoaded", () => {
  connect();
  attemptRejoin();
  installTooltipSystem();

  // Create form container and move elements
  const nameDiv = nameInput.parentNode!;
  const lobbyParentDiv = lobbyIdInput.parentNode!;

  joinFormContainer.appendChild(nameDiv);
  joinFormContainer.appendChild(lobbyParentDiv);
  joinFormContainer.appendChild(joinButton);

  // Insert before players list
  const playersUl = document.getElementById("players")!;
  playersUl.parentNode!.insertBefore(joinFormContainer, playersUl);

  // Add click-to-copy functionality to lobby ID
  const lobbyIdSpan = document.getElementById("current-lobby-id");
  if (lobbyIdSpan) {
    lobbyIdSpan.style.cursor = "pointer";
    lobbyIdSpan.title = "Click to copy lobby ID";
    lobbyIdSpan.addEventListener("click", copyLobbyId);
  }

  // Reaction bar event listeners
  reactionEmojis.addEventListener("click", (e: Event) => {
    const target = e.target as HTMLElement;
    const btn = target.closest(".reaction-emoji");
    if (!btn) return;
    const el = btn as HTMLElement;
    sendMessage({ action: "reaction", type: "emoji", content: el.dataset.emoji });
  });

  reactionSendBtn.addEventListener("click", sendReactionText);
  reactionTextInput.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter") sendReactionText();
  });

  // Save name/lobby ID to localStorage on each keystroke
  nameInput.addEventListener("input", () => {
    store.set("unoPlayerName", nameInput.value);
  });
  lobbyIdInput.addEventListener("input", () => {
    store.set("unoLobbyId", lobbyIdInput.value.toUpperCase());
  });

  // Pressing Enter while the name or lobby-id input is focused submits
  // the join — natural shortcut even though we don't use a <form>.
  // The button itself remains the canonical click target.
  function maybeSubmitJoinOnEnter(e: KeyboardEvent): void {
    if (e.key !== "Enter") return;
    if (joinButton.disabled) return;
    e.preventDefault();
    joinButton.click();
  }
  nameInput.addEventListener("keydown", maybeSubmitJoinOnEnter);
  lobbyIdInput.addEventListener("keydown", maybeSubmitJoinOnEnter);

  getLeaveSpectateBtn()?.addEventListener("click", async () => {
    const ok = await showConfirm("确定要退出观战吗？");
    if (!ok) return;
    sendMessage({ action: "leave" });
  });

  // About modal
  const aboutOverlay = document.getElementById("about-overlay")!;
  const aboutBox = document.getElementById("about-box")!;
  document.getElementById("about-link")!.addEventListener("click", (e) => {
    e.preventDefault();
    aboutOverlay.classList.remove("hidden");
    aboutOverlay.style.display = "flex";
    aboutBox.style.animation = "modalIn 0.2s ease";
  });
  function closeAbout() {
    aboutBox.style.animation = "modalOut 0.15s ease forwards";
    aboutBox.addEventListener("animationend", function h() {
      aboutBox.removeEventListener("animationend", h);
      aboutOverlay.classList.add("hidden");
      aboutOverlay.style.display = "";
      if (storageCleared) {
        location.reload();
      }
    });
  }
  document.getElementById("about-close-btn")!.addEventListener("click", closeAbout);
  document.getElementById("about-clear-btn")!.addEventListener("click", async () => {
    const ok = await showConfirm("确定要清除当前标签页的存储状态吗？此操作不可撤销。");
    if (!ok) return;
    // Clear all known keys for current slot and plain keys
    const s = tabSlot || 1;
    [
      "unoPlayerName",
      "unoLobbyId",
      "unoPlayerId",
      "unoInLobby",
      "unoInGame",
      "unoLeftLobby",
      "unoCardLayout",
    ].forEach((k) => {
      [`${k}-${s}`, k].forEach((sk) => {
        sessionStorage.removeItem(sk);
        localStorage.removeItem(sk);
      });
    });
    sessionStorage.removeItem("unoSlot");
    if (tabSlot) {
      ch.postMessage({ type: "bye", slot: tabSlot, tabId: TAB_ID });
      knownSlots.delete(tabSlot);
    }
    tabSlot = 0;
    storageCleared = true;
    const msg = document.getElementById("about-clear-msg")!;
    msg.style.display = "block";
    setTimeout(() => {
      msg.style.display = "none";
    }, 2000);
  });

  // Rules modal
  const rulesOverlay = document.getElementById("rules-overlay")!;
  const rulesBox = document.getElementById("rules-box")!;
  // Holds the section id to highlight on the NEXT open of the rules
  // dialog. Set by the draw-mode info icon's click handler. Cleared
  // immediately after that one open so subsequent opens via "规则" /
  // `?` show the dialog clean (the user's complaint: "clicking 规则
  // shouldn't keep flashing the draw-mode section every time").
  let pendingRulesHighlightId: string | null = null;
  function applyPendingRulesHighlight(): void {
    if (!pendingRulesHighlightId) return;
    const id = pendingRulesHighlightId;
    pendingRulesHighlightId = null;
    setTimeout(() => {
      const el = document.getElementById(id);
      if (!el) return;
      el.classList.remove("highlight-section");
      void el.offsetWidth; // force reflow to restart animation
      el.classList.add("highlight-section");
      scrollHighlightedSectionIntoView(el);
    }, 300);
  }
  document.getElementById("rules-link")!.addEventListener("click", (e) => {
    e.preventDefault();
    rulesOverlay.classList.remove("hidden");
    rulesOverlay.style.display = "flex";
    rulesBox.style.animation = "modalIn 0.2s ease";
    applyPendingRulesHighlight();
  });
  function closeRules() {
    rulesBox.style.animation = "modalOut 0.15s ease forwards";
    rulesBox.addEventListener("animationend", function h() {
      rulesBox.removeEventListener("animationend", h);
      rulesOverlay.classList.add("hidden");
      rulesOverlay.style.display = "";
      // Strip any in-flight highlight class so the next rules open is
      // clean. Without this, closing the dialog before the 4s
      // highlight animation finishes leaves `.highlight-section` on
      // the element, and the next open of the rules dialog would
      // visually flash the section all over again.
      document.querySelectorAll(".highlight-section").forEach((el) => {
        el.classList.remove("highlight-section");
      });
    });
  }
  document.getElementById("rules-close-btn")!.addEventListener("click", closeRules);

  // Global ESC handler — closes the topmost open auxiliary overlay
  // (rules / about). The modal-overlay (showAlert/showConfirm) and the
  // wild-color picker have their own ESC handlers attached during
  // their lifecycle, so we explicitly skip them here. game-over-overlay
  // also stays — it requires the user to click the button to acknowledge.
  document.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    // Don't hijack ESC if focus is in a text input where the user
    // probably wants to clear typed text or close native autocomplete.
    const tag = (document.activeElement && (document.activeElement as HTMLElement).tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    // Already-handled overlays (showAlert/showConfirm modal owns its
    // own keyboard handler in attachModalKeyboard).
    if (modalOverlay.style.display === "flex") return;
    if (wildColorPicker.style.display === "block") return;
    // Close rules first (likely opened most recently when both are open).
    if (!rulesOverlay.classList.contains("hidden")) {
      e.preventDefault();
      closeRules();
      return;
    }
    if (!aboutOverlay.classList.contains("hidden")) {
      e.preventDefault();
      closeAbout();
      return;
    }
  });

  // Draw mode toggle. Non-creators see the area in read-only mode
  // (`.readonly` class on #draw-mode-area is applied in updatePlayers
  // when the local player isn't the creator). The CSS dims it but
  // doesn't disable clicks; gate the click here so a stray click
  // doesn't fire a server request that just bounces back as an error.
  document.querySelectorAll("#draw-mode-toggle-box .mode-option").forEach((el) => {
    el.addEventListener("click", () => {
      const drawModeArea = document.getElementById("draw-mode-area");
      if (drawModeArea && drawModeArea.classList.contains("readonly")) return;
      const mode = el.getAttribute("data-mode")!;
      document
        .querySelectorAll("#draw-mode-toggle-box .mode-option")
        .forEach((e) => e.classList.remove("active"));
      el.classList.add("active");
      // Update local state immediately so the in-game status pill
      // reflects the change before the server's broadcast roundtrips.
      currentDrawMode = mode === "direct" ? "direct" : "chain";
      updateGameStatusPills();
      updateDevStateInfo();
      sendMessage({ action: "set_draw_mode", mode });
    });
  });

  // Draw mode info → opens rules and highlights the section. Also
  // remembers the user's intent so that future opens of the rules
  // dialog (via the "规则" link or `?` shortcut) re-run the highlight.
  document.getElementById("draw-mode-info")!.addEventListener("click", () => {
    pendingRulesHighlightId = "rules-draw-mode-highlight";
    rulesOverlay.classList.remove("hidden");
    rulesOverlay.style.display = "flex";
    rulesBox.style.animation = "modalIn 0.2s ease";
    applyPendingRulesHighlight();
  });

  // Task 6 — keyboard digit selection. 1-9 (and Numpad1-9) hover the
  // corresponding hand card; 0 / Numpad0 hovers the tenth card. Enter
  // plays the hovered card; pressing the same digit again also plays it
  // (a quick "double-tap to confirm" shortcut for keyboard-only users).
  // ESC or a click on empty space cancels.
  function playHoveredCard(): void {
    if (keyboardHoverIndex < 0 || keyboardHoverIndex >= myHand.length) return;
    const card = myHand[keyboardHoverIndex];
    const idx = keyboardHoverIndex;
    // Clear hover first so the next render isn't out of sync if the play
    // is rejected (e.g. not our turn).
    clearKeyboardHover();
    // Reuse handleCardClick so all the same chain-break/wild-picker
    // checks fire. handleCardClick already ignores off-turn / unplayable
    // clicks (Bug #4 fix), so we don't need to gate again here.
    handleCardClick(card, idx, myHand);
  }

  // Helper: ignore keyboard shortcuts while a text input is focused so
  // typing in chat doesn't trigger game actions.
  function isTypingInTextField(): boolean {
    const ae = document.activeElement as HTMLElement | null;
    if (!ae) return false;
    const tag = ae.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return true;
    return !!ae.isContentEditable;
  }

  // Lobby & game-action keyboard shortcuts. Single-letter keys mapped
  // to the most-clicked buttons. The implementation is deliberately
  // narrow: each action validates its own preconditions (button
  // disabled / hidden / not-our-turn) so a stray keypress never causes
  // a stale request.
  document.addEventListener("keydown", (e: KeyboardEvent) => {
    // Don't fire while a modifier is held — those are reserved for
    // browser shortcuts (Ctrl+R reload, etc.).
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    // Don't fire while typing in chat/lobby inputs.
    if (isTypingInTextField()) return;
    // Don't fire while any modal is open — they have their own keys.
    if (modalOverlay.style.display === "flex") return;
    if (wildColorPicker.style.display === "block") return;
    // Don't fire while rules / about overlays are open (they have ESC
    // handler for closing; other keys would be confusing).
    const rulesOverlay = document.getElementById("rules-overlay");
    const aboutOverlay = document.getElementById("about-overlay");
    if (rulesOverlay && !rulesOverlay.classList.contains("hidden")) return;
    if (aboutOverlay && !aboutOverlay.classList.contains("hidden")) return;
    // Don't fire while game-over overlay is showing.
    if (gameOverOverlay && !gameOverOverlay.classList.contains("hidden")) {
      // But Enter on the game-over screen acknowledges and returns to
      // lobby — match what clicking the button does.
      if (e.key === "Enter") {
        e.preventDefault();
        gameOverBtn.click();
      }
      return;
    }

    const k = e.key.toLowerCase();

    // ── Universal: ? opens rules from anywhere ─────────────
    // The literal '?' character requires Shift on most layouts;
    // cleanest way is to check e.key directly without lowercasing.
    if (e.key === "?") {
      e.preventDefault();
      const link = document.getElementById("rules-link") as HTMLAnchorElement | null;
      if (link) link.click();
      return;
    }

    // ── In-lobby (game div hidden) ─────────────────────────
    if (gameDiv.style.display === "none") {
      // Enter or R readies up (Enter reads as "start the game" — the
      // game begins once everyone is ready). Only when the ready button
      // is actually available to us. Enter while focus is still in the
      // name/lobby-id input is handled separately (it submits the join);
      // by the time we're in the lobby those inputs are disabled, so
      // isTypingInTextField() is false and this fires as expected.
      if (
        (e.key === "Enter" || k === "r") &&
        readyButton &&
        readyButton.style.display !== "none" &&
        !readyButton.disabled
      ) {
        e.preventDefault();
        readyButton.click();
        return;
      }
      // I invites an AI (creator only — button is hidden otherwise).
      if (k === "i" && inviteAIBtn && inviteAIBtn.style.display !== "none") {
        e.preventDefault();
        inviteAIBtn.click();
        return;
      }
      return;
    }

    // ── In-game ───────────────────────────────────────────
    // Whether it's actually our turn determines if D/S even apply.
    const me = players.find((p) => p.id === myId);
    const isMyTurn = !!me && players[currentTurn] && players[currentTurn].id === myId;

    // D or Space: draw a card. Space is the natural "do the thing"
    // key in many games; D is an explicit alternative for users who
    // want to leave Space for something else later.
    if ((k === "d" || e.key === " ") && isMyTurn && !isSpectating) {
      e.preventDefault();
      drawCardButton.click();
      return;
    }
    // S: surrender. Only fires the click; the existing confirm dialog
    // takes over from there.
    if (k === "s" && !isSpectating) {
      const surrenderBtn = document.getElementById("surrender-btn") as HTMLButtonElement | null;
      if (surrenderBtn && surrenderBtn.style.display !== "none") {
        e.preventDefault();
        surrenderBtn.click();
        return;
      }
    }
    // L: leave (spectator-only — for active players surrender is the
    // proper exit). The button is only visible while spectating.
    if (k === "l" && isSpectating) {
      const leaveBtn = getLeaveSpectateBtn();
      if (leaveBtn && leaveBtn.style.display !== "none") {
        e.preventDefault();
        leaveBtn.click();
        return;
      }
    }
    // T: toggle card layout (扇形 / 滚动). Available in-game only.
    if (k === "t") {
      const layoutBtn = document.getElementById("card-layout-toggle") as HTMLButtonElement | null;
      if (layoutBtn && layoutBtn.offsetParent !== null) {
        e.preventDefault();
        layoutBtn.click();
        return;
      }
    }
  });

  document.addEventListener("keydown", (e: KeyboardEvent) => {
    // The wild-color picker / modal capture their own keys; bail so we
    // don't double-handle.
    if (modalOverlay.style.display === "flex") return;
    if (wildColorPicker.style.display === "block") return;
    // Only hover/play during the live game UI and only on our turn.
    if (gameDiv.style.display === "none" || isSpectating) return;

    if (e.key === "Escape") {
      if (keyboardHoverIndex !== -1) {
        e.preventDefault();
        clearKeyboardHover();
      }
      return;
    }
    if (e.key === "Enter") {
      // Don't hijack Enter when focus is in a text input (chat) — that's
      // already handled by the input's own listener.
      const tag = (document.activeElement && (document.activeElement as HTMLElement).tagName) || "";
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (keyboardHoverIndex < 0 || keyboardHoverIndex >= myHand.length) return;
      e.preventDefault();
      playHoveredCard();
      return;
    }
    const idx = digitFromKeyEvent(e);
    if (idx === -1) return;
    if (idx >= myHand.length) {
      // Pressing a digit higher than hand size is a clear cancel.
      clearKeyboardHover();
      return;
    }
    e.preventDefault();
    // Pressing the same digit twice in a row plays the already-hovered
    // card — a "double-tap to confirm" shortcut so users don't have to
    // shift their hand from the digit row to Enter every time.
    if (idx === keyboardHoverIndex) {
      playHoveredCard();
      return;
    }
    setKeyboardHover(idx);
  });

  // Click on empty area cancels the keyboard hover. We listen on document
  // and skip clicks that originated inside the player hand, action area or
  // any modal — those have their own click handlers.
  document.addEventListener("click", (e: Event) => {
    if (keyboardHoverIndex === -1) return;
    const target = e.target as HTMLElement | null;
    if (!target) return;
    if (
      target.closest("#player-hand") ||
      target.closest("#action-buttons") ||
      target.closest("#wild-color-picker") ||
      target.closest("#modal-overlay") ||
      target.closest("#dev-panel") ||
      target.closest("#reaction-bar")
    ) {
      return;
    }
    clearKeyboardHover();
  });
});

// Center a highlighted rules-section in the rules-overlay scroll container.
// The dialog is `position: fixed; overflow-y: auto`, so plain
// scrollIntoView({block: 'center'}) on the inner element scrolls the page
// behind the modal instead. We compute the offset against the overlay's
// own scroll origin and animate via scrollTo.
function scrollHighlightedSectionIntoView(target: HTMLElement): void {
  const overlay = document.getElementById("rules-overlay");
  if (!overlay) return;
  // Wait one frame so the overlay's height is settled after the modalIn
  // animation; otherwise getBoundingClientRect returns the pre-animated
  // height and our top calculation lands a few px off.
  requestAnimationFrame(() => {
    const overlayRect = overlay.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    // Desired scrollTop puts the target's vertical center at the
    // overlay's vertical center. Clamp to the legal range.
    const desired =
      overlay.scrollTop +
      (targetRect.top - overlayRect.top) -
      (overlayRect.height - targetRect.height) / 2;
    const max = overlay.scrollHeight - overlay.clientHeight;
    overlay.scrollTo({ top: Math.max(0, Math.min(desired, max)), behavior: "smooth" });
  });
}

// Floating tooltip system. Any element with `data-tooltip` shows a
// single shared tooltip element on mouseenter / focusin. We use a shared
// node (rather than per-element ::after pseudo-elements) so:
//   1. Newlines render correctly via white-space:pre-line on the actual
//      element (CSS pseudo-elements only see the attribute string and
//      treat \n as whitespace).
//   2. The tooltip is `position: fixed` and never clipped by ancestor
//      `overflow: hidden`.
//   3. Keyboard focus support is uniform across icons.
function installTooltipSystem(): void {
  let tip = document.getElementById("tooltip") as HTMLDivElement | null;
  if (!tip) {
    tip = document.createElement("div");
    tip.id = "tooltip";
    tip.setAttribute("role", "tooltip");
    document.body.appendChild(tip);
  }

  let hideTimer: ReturnType<typeof setTimeout> | null = null;
  let activeTarget: HTMLElement | null = null;

  function show(target: HTMLElement): void {
    const text = target.getAttribute("data-tooltip");
    if (!text) return;
    activeTarget = target;
    tip!.textContent = text;
    tip!.classList.add("show");
    positionTooltip(target, tip!);
  }

  function hide(): void {
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = null;
    activeTarget = null;
    tip!.classList.remove("show");
  }

  // Use bubbling so the listener catches dynamically added elements (no
  // need to re-attach when fragments mount). `mouseover` re-fires as the
  // user moves between siblings, but the resolved target is checked
  // against the previous active so we don't churn the DOM.
  document.addEventListener("mouseover", (e) => {
    const target = (e.target as HTMLElement | null)?.closest?.(
      "[data-tooltip]",
    ) as HTMLElement | null;
    if (!target) return;
    if (target === activeTarget) return;
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
    show(target);
  });
  document.addEventListener("mouseout", (e) => {
    const target = (e.target as HTMLElement | null)?.closest?.(
      "[data-tooltip]",
    ) as HTMLElement | null;
    if (!target || target !== activeTarget) return;
    // Brief grace so moving between adjacent annotated icons doesn't blink.
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, 80);
  });
  document.addEventListener("focusin", (e) => {
    const target = (e.target as HTMLElement | null)?.closest?.(
      "[data-tooltip]",
    ) as HTMLElement | null;
    if (!target) return;
    show(target);
  });
  document.addEventListener("focusout", (e) => {
    const target = (e.target as HTMLElement | null)?.closest?.(
      "[data-tooltip]",
    ) as HTMLElement | null;
    if (!target || target !== activeTarget) return;
    hide();
  });
  // Hide on scroll (positions go stale) and on Escape.
  window.addEventListener("scroll", hide, true);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && activeTarget) hide();
  });
}

// Place the tooltip below the target by default, flipping above when the
// page bottom would clip it. Horizontally centered on the target, clamped
// to the viewport with an 8px gutter.
function positionTooltip(target: HTMLElement, tip: HTMLDivElement): void {
  const targetRect = target.getBoundingClientRect();
  // Force a layout pass so we read the post-text size, not the previous
  // tooltip's dimensions.
  tip.style.left = "0px";
  tip.style.top = "0px";
  const tipRect = tip.getBoundingClientRect();

  const gap = 8;
  const margin = 8;

  let left = targetRect.left + targetRect.width / 2 - tipRect.width / 2;
  left = Math.max(margin, Math.min(left, window.innerWidth - tipRect.width - margin));

  let top = targetRect.bottom + gap;
  if (top + tipRect.height + margin > window.innerHeight) {
    // Flip above the target.
    top = targetRect.top - tipRect.height - gap;
    // If even the top doesn't fit (target is huge), pin to the viewport.
    if (top < margin) top = margin;
  }

  tip.style.left = left + "px";
  tip.style.top = top + "px";
}

function copyLobbyId(): void {
  const lobbyIdSpan = document.getElementById("current-lobby-id")!;
  const lobbyId = lobbyIdSpan.textContent || "";

  // Use the modern clipboard API
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard
      .writeText(lobbyId)
      .then(() => {
        showCopyFeedback(lobbyIdSpan);
      })
      .catch(() => {
        // Fallback for older browsers
        fallbackCopyToClipboard(lobbyId, lobbyIdSpan);
      });
  } else {
    // Fallback for older browsers
    fallbackCopyToClipboard(lobbyId, lobbyIdSpan);
  }
}

function applyCardLayout(): void {
  if (store.get("unoCardLayout") !== "wrap") {
    playerHandDiv.classList.add("scroll-mode");
    cardLayoutToggle.textContent = "切换到换行排列";
  } else {
    playerHandDiv.classList.remove("scroll-mode");
    cardLayoutToggle.textContent = "切换到滚动排列";
  }
  updateScrollAlignment();
}

function updateScrollAlignment(): void {
  const isScroll = playerHandDiv.classList.contains("scroll-mode");
  if (!isScroll) {
    playerHandDiv.style.justifyContent = "";
    return;
  }
  playerHandDiv.style.justifyContent =
    playerHandDiv.scrollWidth > playerHandDiv.clientWidth ? "flex-start" : "center";
}

cardLayoutToggle.addEventListener("click", () => {
  playerHandDiv.classList.toggle("scroll-mode");
  const isScroll = playerHandDiv.classList.contains("scroll-mode");
  store.set("unoCardLayout", isScroll ? "scroll" : "wrap");
  cardLayoutToggle.textContent = isScroll ? "切换到换行排列" : "切换到滚动排列";
  updateScrollAlignment();
});

function sendReactionText(): void {
  const text = reactionTextInput.value.trim();
  if (!text) return;
  let width = 0;
  for (const ch of text) {
    if (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch)) width += 1;
    else width += 0.3;
  }
  if (width > 64) {
    showAlert("消息过长！");
    return;
  }
  sendMessage({ action: "reaction", type: "text", content: text });
  reactionTextInput.value = "";
}

function fallbackCopyToClipboard(text: string, element: HTMLElement): void {
  const textArea = document.createElement("textarea");
  textArea.value = text;
  textArea.style.position = "fixed";
  textArea.style.left = "-999999px";
  textArea.style.top = "-999999px";
  document.body.appendChild(textArea);
  textArea.focus();
  textArea.select();

  try {
    document.execCommand("copy");
    showCopyFeedback(element);
  } catch (err) {
    clientWarn("Failed to copy lobby ID:", err);
  }

  document.body.removeChild(textArea);
}

function showCopyFeedback(element: HTMLElement): void {
  const originalText = element.textContent || "";
  element.textContent = "已复制！";
  element.style.background = "rgba(72, 187, 120, 0.3)";

  setTimeout(() => {
    element.textContent = originalText;
    element.style.background = "rgba(255,255,255,0.2)";
  }, 1000);
}

function showDisconnectedToast(_reason: string): void {
  const toast = document.getElementById("disconnected-toast") || createDisconnectedToast();
  toast.textContent = "连接已断开，正在重连... 如持续失败请刷新页面";
  toast.classList.add("visible");
  clearTimeout(disconnectToastTimeout!);
}

function hideDisconnectedToast(): void {
  const toast = document.getElementById("disconnected-toast");
  if (toast) {
    toast.classList.remove("visible");
  }
  if (disconnectToastTimeout) clearTimeout(disconnectToastTimeout);
}

function createDisconnectedToast(): HTMLDivElement {
  const toast = document.createElement("div");
  toast.id = "disconnected-toast";
  document.body.appendChild(toast);
  return toast;
}

// Transient message about the server having auto-drawn for a player. Uses
// a separate DOM node from the disconnected toast so the two can coexist.
let turnTimeoutToastTimer: ReturnType<typeof setTimeout> | null = null;
function showTurnTimeoutToast(text: string): void {
  let toast = document.getElementById("turn-timeout-toast") as HTMLDivElement | null;
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "turn-timeout-toast";
    document.body.appendChild(toast);
  }
  toast.textContent = text;
  toast.classList.add("visible");
  if (turnTimeoutToastTimer) clearTimeout(turnTimeoutToastTimer);
  turnTimeoutToastTimer = setTimeout(() => {
    toast!.classList.remove("visible");
  }, 3500);
}

function createLeaveLobbyButton(): HTMLButtonElement {
  const leaveLobbyBtn = document.createElement("button");
  leaveLobbyBtn.id = "leave-lobby";
  leaveLobbyBtn.textContent = "离开大厅";
  leaveLobbyBtn.classList.add("leave-lobby-btn");
  leaveLobbyBtn.addEventListener("click", leaveLobby);
  return leaveLobbyBtn;
}

async function leaveLobby(): Promise<void> {
  const confirmed = await showConfirm("确定要离开大厅吗？");
  if (!confirmed) return;

  sendMessage({ action: "leave" });
  store.remove("unoPlayerId");
  store.remove("unoInLobby");
  store.remove("unoInGame");
  store.set("unoLeftLobby", "true");
  requestAnimationFrame(() => resetGameState());
}

function showJoinForm(): void {
  joinFormContainer.style.display = "block";

  // Remove leave lobby button if it exists
  const existingLeaveBtn = document.getElementById("leave-lobby");
  if (existingLeaveBtn) {
    existingLeaveBtn.remove();
  }
}

function hideJoinForm(): void {
  joinFormContainer.style.display = "none";

  // Add leave lobby button if it doesn't exist
  let leaveLobbyBtn = document.getElementById("leave-lobby");
  if (!leaveLobbyBtn) {
    leaveLobbyBtn = createLeaveLobbyButton();
    // Insert after lobby info
    const lobbyInfoEl = document.getElementById("lobby-info")!;
    lobbyInfoEl.parentNode!.insertBefore(leaveLobbyBtn, lobbyInfoEl.nextSibling);
  }
}

function hideLobbyInfo(): void {
  lobbyInfo.style.display = "none";
  showJoinForm();
}

const gameOverOverlay = document.getElementById("game-over-overlay") as HTMLDivElement;
const gameOverTitle = document.getElementById("game-over-title") as HTMLHeadingElement;
const gameOverMessage = document.getElementById("game-over-message") as HTMLParagraphElement;
const gameOverIcon = document.getElementById("game-over-icon") as HTMLDivElement;
const gameOverContent = document.getElementById("game-over-content") as HTMLDivElement;
const gameOverBtn = document.getElementById("game-over-btn") as HTMLButtonElement;

let isGameOverShowing = false;

function showGameOver(winnerName: string): void {
  if (isGameOverShowing) return;
  isGameOverShowing = true;
  store.remove("unoInLobby");
  store.remove("unoInGame");

  // No human players left (AI-only game)
  if (!winnerName) {
    gameOverIcon.innerHTML = '<img src="/icons/bolt.svg" style="width:64px;height:64px;">';
    gameOverTitle.textContent = "没有人赢了";
    gameOverMessage.textContent = "所有真人玩家已离开对局";
    gameOverContent.className = "aborted";
    gameOverOverlay.classList.remove("hidden");
    gameOverOverlay.style.display = "flex";
    return;
  }

  const myPlayer = players.find((p) => p.id === myId);
  const isWinner = winnerName === (myPlayer ? myPlayer.name : "");
  const myName = store.get("unoPlayerName") || "";

  if (isWinner) {
    gameOverIcon.innerHTML = '<img src="/icons/trophy.svg" style="width:64px;height:64px;">';
    gameOverTitle.textContent = "你赢了！";
    gameOverMessage.innerHTML = `<img src="/icons/party.svg" style="width:1em;height:1em;vertical-align:middle;"> ${encodeUGC(winnerName)} 赢得了游戏！干得漂亮！`;
    gameOverContent.className = "win";
    spawnConfetti();
  } else {
    gameOverIcon.innerHTML = '<img src="/icons/heartbreak.svg" style="width:64px;height:64px;">';
    gameOverTitle.textContent = "游戏结束";
    gameOverMessage.textContent = `${encodeUGC(winnerName)} 赢得了游戏！\n下次加油，${encodeUGC(myName)}！`;
    gameOverContent.className = "lose";
  }

  gameOverOverlay.classList.remove("hidden");
  gameOverOverlay.style.display = "flex";
}

function showGameAborted(): void {
  if (isGameOverShowing) return;
  isGameOverShowing = true;
  store.remove("unoInLobby");
  store.remove("unoInGame");

  gameOverIcon.innerHTML = '<img src="/icons/bolt.svg" style="width:64px;height:64px;">';
  gameOverTitle.textContent = "对局中止";
  gameOverMessage.textContent = "其他玩家离开了对局，游戏已结束";
  gameOverContent.className = "aborted";

  gameOverOverlay.classList.remove("hidden");
  gameOverOverlay.style.display = "flex";
}

// Diff two consecutive `players` snapshots (cardCount field) and float
// a "+N" popup over each tile whose count went up — visualizes draw2 /
// wild4 penalties so the targeted player sees what just happened. We
// only fire on a positive delta because losing cards is the normal
// flow (the playing player's count goes -1 every turn) and showing a
// "-1" popup would be noisy.
//
// We skip the popup for `myId` because the user's own hand is rendered
// in detail elsewhere, but the +N over the opponents' tiles is the
// useful feedback. Caller must invoke BEFORE replacing `players` with
// the new snapshot — we read the previous `players` array from outer
// scope.
// Compute the per-player card-count deltas between two snapshots and
// return only the entries that should result in a +N popup. Pulled out
// of the receive handler so the caller can spawn the popups AFTER
// rebuilding #opponent-hands — without that ordering, updatePlayers'
// `innerHTML = ''` would yank the just-spawned popups out of the DOM
// before they could animate.
//
// We skip the popup for delta < 2 to avoid noise from the normal -1
// each turn and the +1 the active player gets when manually drawing.
function computePenaltyDeltas(prev: Player[], next: Player[]): Array<[string, number]> {
  if (!prev || !next) return [];
  const prevById = new Map(prev.map((p) => [p.id, p]));
  const out: Array<[string, number]> = [];
  for (const np of next) {
    const op = prevById.get(np.id);
    if (!op) continue;
    const before = op.cardCount ?? 0;
    const after = np.cardCount ?? 0;
    const delta = after - before;
    if (delta >= 2) out.push([np.id, delta]);
  }
  return out;
}

// Legacy wrapper kept so existing callers (and tests that mock the
// client) still work without changes — equivalent to "compute then
// spawn". New code inside the update path uses computePenaltyDeltas
// directly so the spawn can be ordered after updatePlayers.
function diffCardCountsForPenaltyPopup(prev: Player[], next: Player[]): void {
  for (const [pid, delta] of computePenaltyDeltas(prev, next)) {
    spawnPenaltyPopup(pid, delta);
  }
}

function spawnPenaltyPopup(playerId: string, delta: number): void {
  // After the merged turn-order layout, every player (including self)
  // has a tile in #opponent-hands, so there's exactly one place to
  // anchor the popup. We still fall back to the turn-indicator if
  // the tile happens not to exist (e.g. spectator-only edge cases).
  const playerDiv = opponentHandsDiv.querySelector(
    `[data-player-id="${playerId}"]`,
  ) as HTMLDivElement | null;
  const popup = document.createElement("div");
  popup.classList.add("penalty-popup");
  popup.textContent = `+${delta}`;
  if (playerDiv) {
    playerDiv.appendChild(popup);
  } else {
    const target = document.getElementById("turn-indicator");
    if (target) target.appendChild(popup);
    else return;
  }
  // 5s total animation = 0.4s rise + 4.2s linger + 0.4s fade.
  setTimeout(() => popup.remove(), 5200);
}

function showReaction(playerId: string, type: string, content: string): void {
  const playerDiv = opponentHandsDiv.querySelector(
    `[data-player-id="${playerId}"]`,
  ) as HTMLDivElement;
  if (!playerDiv && playerId !== myId) return;

  const popup = document.createElement("div");
  popup.classList.add("reaction-popup");
  if (type === "text") {
    popup.classList.add("reaction-popup-text");
    popup.textContent = content;
  } else {
    const iconMap: Record<string, string> = {
      "😂": "laugh",
      "😡": "angry",
      "😱": "shock",
      "👍": "like",
      "👎": "dislike",
      "🎉": "party",
      "😭": "cry",
      "🔥": "fire",
    };

    // ── Logging ──────────────────────────────────────────────
    const CLIENT_PREFIX = "[client]";
    const icon = iconMap[content] || "laugh";
    popup.innerHTML = `<img src="/icons/${icon}.svg" style="width:32px;height:32px;">`;
  }

  // Reaction-popup readability budget. Average human read speed lands
  // around 5 char/sec for English running text and ~3 char/sec for
  // Chinese (each glyph carries more meaning). The reaction is also
  // floating across the screen and competing with game UI for
  // attention, so we deliberately bias toward "linger longer". Each
  // character contributes a fraction of a second; CJK glyphs count for
  // more time-per-glyph than ASCII because there are typically fewer
  // of them per equivalent thought.
  let chars = 0;
  for (const ch of content) {
    if (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch)) chars += 0.55;
    else chars += 0.18;
  }
  // Floor of ~3s lets even a single emoji breathe; ceiling of ~9s
  // caps the longest messages so they don't loiter forever.
  const duration = Math.max(3, Math.min(9, 2 + chars));
  popup.style.animationDuration = duration + "s";

  if (playerDiv) {
    playerDiv.appendChild(popup);
  } else {
    // Self reaction: show above reaction bar
    const reactionBar = document.getElementById("reaction-bar");
    if (reactionBar) {
      popup.style.position = "absolute";
      popup.style.bottom = "100%";
      popup.style.left = "50%";
      popup.style.transform = "translateX(-50%)";
      reactionBar.appendChild(popup);
    }
  }

  popup.addEventListener("animationend", () => popup.remove(), { once: true });

  // Append to persistent chat history. Cap at 30 entries so the box
  // doesn't grow without bound; auto-scroll to bottom so the latest
  // message is always visible.
  appendReactionHistory(playerId, type, content);
}

const REACTION_HISTORY_MAX = 30;
function appendReactionHistory(playerId: string, type: string, content: string): void {
  const box = document.getElementById("reaction-history");
  if (!box) return;
  const sender = players.find((p) => p.id === playerId);
  const senderName = sender ? sender.name : playerId === myId ? "你" : "?";
  const isSelf = playerId === myId;

  const row = document.createElement("div");
  row.classList.add("reaction-history-row");
  if (isSelf) row.classList.add("self");

  const nameEl = document.createElement("span");
  nameEl.classList.add("reaction-history-name");
  nameEl.textContent = senderName;

  const contentEl = document.createElement("span");
  contentEl.classList.add("reaction-history-content");
  if (type === "emoji") {
    const iconMap: Record<string, string> = {
      "😂": "laugh",
      "😡": "angry",
      "😱": "shock",
      "👍": "like",
      "👎": "dislike",
      "🎉": "party",
      "😭": "cry",
      "🔥": "fire",
    };
    const icon = iconMap[content] || "laugh";
    const img = document.createElement("img");
    img.src = `/icons/${icon}.svg`;
    img.width = 18;
    img.height = 18;
    img.alt = content;
    contentEl.appendChild(img);
  } else {
    // Use textContent (not innerHTML) so user-typed strings can't
    // inject HTML. This mirrors the encodeUGC pattern used elsewhere.
    contentEl.textContent = content;
  }

  row.appendChild(nameEl);
  row.appendChild(contentEl);
  box.appendChild(row);

  // Trim to cap.
  while (box.children.length > REACTION_HISTORY_MAX) {
    box.removeChild(box.firstChild!);
  }

  // Auto-scroll, but only if the user is already near the bottom — if
  // they scrolled up to read backlog we shouldn't yank them down.
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  if (nearBottom) box.scrollTop = box.scrollHeight;
}

gameOverBtn.addEventListener("click", () => {
  gameOverOverlay.classList.add("hidden");
  gameOverOverlay.style.display = "";
  isGameOverShowing = false;
  requestAnimationFrame(() => resetGameState());
});

function spawnConfetti(): void {
  const colors = [
    "#ff6b6b",
    "#ffd700",
    "#48bb78",
    "#667eea",
    "#ff8a5c",
    "#f1c40f",
    "#e74c3c",
    "#3498db",
    "#2ecc71",
  ];
  const container = document.body;

  for (let i = 0; i < 80; i++) {
    const el = document.createElement("div");
    el.classList.add("confetti");
    el.style.left = Math.random() * 100 + "vw";
    el.style.background = colors[Math.floor(Math.random() * colors.length)];
    el.style.width = Math.random() * 8 + 4 + "px";
    el.style.height = Math.random() * 8 + 4 + "px";
    el.style.borderRadius = Math.random() > 0.5 ? "50%" : "2px";
    el.style.animationDuration = Math.random() * 2 + 2 + "s";
    el.style.animationDelay = Math.random() * 2 + "s";
    container.appendChild(el);

    setTimeout(() => el.remove(), 5000);
  }
}

function __callWin__(): void {
  sendMessage({ action: "dev_call_win" });
}

// Dev Panel — press Ctrl+Shift+D to toggle; auto-shown when server is in dev mode
let devPanelSetup = false;
function setupDevPanel(): void {
  if (devPanelSetup) return;
  devPanelSetup = true;

  const panel = document.getElementById("dev-panel");
  if (!panel) return;

  panel.style.display = "";

  document.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.ctrlKey && e.shiftKey && e.code === "KeyD") {
      e.preventDefault();
      runDevPanelCollapseAnimation(panel);
    }
  });

  // Toggle collapse on header click — but NOT when the click was
  // part of a drag (mousedown→mousemove→mouseup with movement). The
  // drag handler below sets a flag we check here.
  const header = document.getElementById("dev-panel-header");
  if (header) {
    header.addEventListener("click", (e) => {
      if (devPanelDragJustEnded) {
        // Suppress this click — the user was dragging, not toggling.
        devPanelDragJustEnded = false;
        return;
      }
      runDevPanelCollapseAnimation(panel);
    });
    installDevPanelDrag(panel, header);
  }

  // Dev button click handlers
  panel.addEventListener("click", (e: Event) => {
    const target = e.target as HTMLElement;
    const btn = target.closest(".dev-btn");
    if (!btn) return;
    const el = btn as HTMLElement;

    const action = el.dataset.action!;
    if (action === "dev_disconnect") {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.close(4001, "dev disconnect");
        el.textContent = "重连";
      } else if (ws && ws.readyState === WebSocket.CLOSED) {
        el.textContent = "断开";
        connect();
      }
      return;
    }

    const countStr = el.dataset.count;
    const count = countStr ? parseInt(countStr) : undefined;

    const msg: Record<string, unknown> = { action };
    if (count !== undefined) msg.count = count;
    sendMessage(msg);
  });
}

(function initDevPanel() {
  // Prepare panel hidden; setupDevPanel will be called when 'init' message confirms dev mode
  const panel = document.getElementById("dev-panel");
  if (panel) panel.style.display = "none";
})();

// Track whether the most recent header mouseup was the end of a drag
// (vs. a regular click). Set by the drag-end handler below; consumed
// by the header click listener so a drag doesn't accidentally toggle
// the collapse state when the user releases the mouse.
let devPanelDragJustEnded = false;

// Toggle the panel's collapsed state with the .animating helper class
// applied during the transition. While .animating is on, the body's
// overflow is hidden via CSS so a scrollbar doesn't flash through the
// expand/collapse animation. The class is removed on transitionend
// (or after a safety timeout in case the event is missed).
let devPanelAnimTimer: ReturnType<typeof setTimeout> | null = null;
function runDevPanelCollapseAnimation(panel: HTMLElement): void {
  const body = panel.querySelector("#dev-panel-body") as HTMLElement | null;
  panel.classList.add("animating");
  panel.classList.toggle("collapsed");
  if (devPanelAnimTimer) clearTimeout(devPanelAnimTimer);
  const cleanup = () => {
    panel.classList.remove("animating");
    if (devPanelAnimTimer) {
      clearTimeout(devPanelAnimTimer);
      devPanelAnimTimer = null;
    }
    if (body) body.removeEventListener("transitionend", onEnd);
  };
  function onEnd(e: TransitionEvent): void {
    // Only react to the max-height transition — we don't want one of the
    // shorter transitions (opacity/padding) to clear .animating early.
    if (e.target !== body) return;
    if (e.propertyName !== "max-height") return;
    cleanup();
  }
  if (body) body.addEventListener("transitionend", onEnd);
  // Safety: if the transition somehow doesn't fire (display:none parent,
  // user prefers-reduced-motion, etc.) clear the class anyway.
  devPanelAnimTimer = setTimeout(cleanup, 600);
}

// Install drag-by-header on the dev panel. The panel is `position: fixed;
// bottom/right` by default; once dragged we switch to `top/left` so the
// pointer's offset stays consistent. Position survives reloads via
// sessionStorage (per-tab — slot dance also lives in sessionStorage so
// the dev panel position naturally sticks to a single tab).
function installDevPanelDrag(panel: HTMLElement, header: HTMLElement): void {
  // Restore previously-dragged position so a reload keeps the panel
  // where the user put it.
  try {
    const saved = sessionStorage.getItem("unoDevPanelPos");
    if (saved) {
      const { left, top } = JSON.parse(saved);
      if (typeof left === "number" && typeof top === "number") {
        applyDevPanelPosition(panel, left, top);
      }
    }
  } catch {
    /* corrupt JSON — ignore, fall back to default position */
  }

  let dragging = false;
  let pointerId = -1;
  let startX = 0;
  let startY = 0;
  let originLeft = 0;
  let originTop = 0;
  // Distance threshold — small movements should still register as a
  // click. The header click listener uses devPanelDragJustEnded only
  // when this threshold is exceeded.
  const DRAG_THRESHOLD = 4;

  header.style.cursor = "grab";
  header.style.touchAction = "none";

  header.addEventListener("pointerdown", (e: PointerEvent) => {
    // Left mouse / primary touch only — right-click is for context menu.
    if (e.button !== 0 && e.pointerType === "mouse") return;
    dragging = true;
    pointerId = e.pointerId;
    startX = e.clientX;
    startY = e.clientY;
    const rect = panel.getBoundingClientRect();
    originLeft = rect.left;
    originTop = rect.top;
    // Capture so we keep getting events even if the pointer leaves the
    // header while the user is dragging.
    try {
      header.setPointerCapture(pointerId);
    } catch {
      /* some browsers reject in synthetic events */
    }
    header.style.cursor = "grabbing";
  });

  header.addEventListener("pointermove", (e: PointerEvent) => {
    if (!dragging || e.pointerId !== pointerId) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    devPanelDragJustEnded = true;
    // Constrain to viewport so the user can't park the panel offscreen.
    const margin = 4;
    const w = panel.offsetWidth;
    const h = panel.offsetHeight;
    const maxLeft = Math.max(0, window.innerWidth - w - margin);
    const maxTop = Math.max(0, window.innerHeight - h - margin);
    const newLeft = Math.max(margin, Math.min(originLeft + dx, maxLeft));
    const newTop = Math.max(margin, Math.min(originTop + dy, maxTop));
    applyDevPanelPosition(panel, newLeft, newTop);
  });

  function endDrag(e: PointerEvent): void {
    if (!dragging || e.pointerId !== pointerId) return;
    dragging = false;
    pointerId = -1;
    header.style.cursor = "grab";
    try {
      header.releasePointerCapture(e.pointerId);
    } catch {
      /* idempotent */
    }
    // Persist final position. We only write on drag-end, not on every
    // pointermove, to keep storage churn low.
    if (devPanelDragJustEnded) {
      const rect = panel.getBoundingClientRect();
      try {
        sessionStorage.setItem(
          "unoDevPanelPos",
          JSON.stringify({ left: rect.left, top: rect.top }),
        );
      } catch {
        /* storage full / private mode — silently ignore */
      }
    }
  }
  header.addEventListener("pointerup", endDrag);
  header.addEventListener("pointercancel", endDrag);

  // Keep the panel inside the viewport on resize. Without this, a
  // panel parked near the right edge of a wide window would end up
  // off-screen on a narrow window and be unreachable.
  window.addEventListener("resize", () => {
    if (!panel.style.left && !panel.style.top) return; // never been dragged
    const rect = panel.getBoundingClientRect();
    const margin = 4;
    const maxLeft = Math.max(0, window.innerWidth - rect.width - margin);
    const maxTop = Math.max(0, window.innerHeight - rect.height - margin);
    const left = Math.max(margin, Math.min(rect.left, maxLeft));
    const top = Math.max(margin, Math.min(rect.top, maxTop));
    applyDevPanelPosition(panel, left, top);
  });
}

function applyDevPanelPosition(panel: HTMLElement, left: number, top: number): void {
  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;
  panel.style.right = "auto";
  panel.style.bottom = "auto";
}
