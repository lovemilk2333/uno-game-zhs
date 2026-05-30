import { WebSocketServer, WebSocket } from "ws";
import { Server, IncomingMessage, ServerResponse } from "http";
import { readFileSync, existsSync } from "fs";
import { randomBytes } from "crypto";
import path from "path";
import { decideMove } from "./aiplayer";
import { ERR, errorResponse, ErrorCode } from "./errors";
import {
  RECONNECT_DEFER_MS,
  RECONNECT_DEADLINE_MS,
  DISCONNECT_REMOVE_MS,
  MAX_HAND_CARDS,
  NAME_LENGTH_MIN,
  NAME_LENGTH_MAX,
  LOBBY_ID_LENGTH_MIN,
  LOBBY_ID_LENGTH_MAX,
  MAX_AI_PER_LOBBY,
  REACTION_CONTENT_MAX,
  WS_MAX_PAYLOAD,
  MAX_PARSE_ERRORS_PER_CONN,
  PLAY_TIMEOUT_MS,
  PLAY_TIMEOUT_GRACE_MS,
} from "./constants";

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
  hand?: Card[];
  uno?: boolean;
}

enum LobbyGameState {
  normal,
  drawing, // 连续出加牌中...
}

interface Lobby {
  id: string;
  players: Player[];
  game: {
    deck: Card[];
    discardPile: Card[];
    turn: number;
    direction: number;
    started: boolean;
    state: LobbyGameState;
    drawingCount: number;
    drawMode: "chain" | "direct";
  };
}

interface ClientMetadata {
  id: string;
  name?: string;
  lobbyId?: string | null;
  isSpectator?: boolean;
}

interface SessionData {
  name: string;
  lobbyId: string;
  pendingReady?: boolean;
}

interface StateLogEntry {
  t: number;
  event: string;
  playerId?: string;
  lobbyId?: string;
  name?: string;
  [key: string]: unknown;
}

interface ClientMessage {
  action: string;
  name?: string;
  lobbyId?: string;
  playerId?: string;
  card?: Card;
  cards?: Card[];
  indices?: number[];
  count?: number;
  type?: string;
  mode?: string;
  content?: string;
}

type StaticFile = [string, string];

const allowFiles: StaticFile[] = [
  ["index.html", "text/html"],
  ["client.cjs", "text/javascript"],
  ["style.css", "text/css"],
];
// Use a null-prototype object so the `in` operator never matches Object.prototype
// keys like __proto__, constructor, toString. Without this, GET /__proto__ falls
// into the static-file branch with a destructured `type` of `undefined`, which
// then crashes the server via res.setHeader('Content-Type', undefined).
const files: Record<string, { content: Buffer; type: string }> = Object.create(null);

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");

function safeResolve(...segments: string[]): string | null {
  const resolved = path.resolve(...segments);
  const cwd = path.resolve(process.cwd());
  const root = PROJECT_ROOT;
  if (resolved.startsWith(cwd + path.sep) || resolved === cwd) return resolved;
  if (resolved.startsWith(root + path.sep) || resolved === root) return resolved;
  return null;
}

// ── Input validation ────────────────────────────────────
// Lobby IDs are used as Map keys and broadcast to clients; restrict the
// character set so they can't be abused for memory growth, log injection or
// UI breakage.
const LOBBY_ID_REGEX = /^[\u0020-\u007E\u4e00-\u9fff]+$/; // printable ASCII or CJK
function isValidLobbyId(v: unknown): v is string {
  return (
    typeof v === "string" &&
    v.length >= LOBBY_ID_LENGTH_MIN &&
    v.length <= LOBBY_ID_LENGTH_MAX &&
    LOBBY_ID_REGEX.test(v)
  );
}

// Canonical form of a lobby id: trimmed of surrounding whitespace and
// upper-cased so case-insensitive matches on the same room are routed to
// the same Map entry. The browser client already uppercases its input but
// other clients (curl, scripts, an out-of-date frontend) may not — without
// normalization "ROOM" and "Room" produce two separate lobbies and the
// user can't join their friend's game.
function normalizeLobbyId(v: string): string {
  return v.trim().toUpperCase();
}

function isValidPlayerName(v: unknown): v is string {
  return typeof v === "string" && v.length >= NAME_LENGTH_MIN && v.length <= NAME_LENGTH_MAX;
}

// Origin allowlist for WebSocket upgrades. Defaults to "same host" — i.e. the
// browser's origin must match a Host header the server itself listens on. The
// operator can override via ALLOWED_ORIGINS=https://a.example,https://b.example
// (comma separated). Empty / non-browser clients (no Origin header) are still
// allowed because they are not subject to the cross-site abuse this guards
// against.
const EXTRA_ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
function isAllowedOrigin(origin: string | undefined, hostHeader: string | undefined): boolean {
  if (!origin) return true; // non-browser client
  if (EXTRA_ALLOWED_ORIGINS.includes(origin)) return true;
  if (!hostHeader) return false;
  try {
    const u = new URL(origin);
    return u.host === hostHeader;
  } catch {
    return false;
  }
}

const PKG = JSON.parse(readFileSync(safeResolve(PROJECT_ROOT, "package.json")!, "utf-8"));
const VERSION = PKG.version || "1.0.0";

function loadStaticFiles(): void {
  for (const [file, type] of allowFiles) {
    let fullPath = safeResolve(import.meta.dirname, file);
    if (!fullPath || !existsSync(fullPath)) {
      if (file === "client.cjs") {
        fullPath = safeResolve(PROJECT_ROOT, "dist", file);
      } else {
        fullPath = safeResolve(PROJECT_ROOT, "public", file);
      }
    }
    if (!fullPath) continue;
    files[file] = { content: readFileSync(fullPath), type };
  }
  // Preload icon SVGs from manifest
  let manifestPath = safeResolve(import.meta.dirname, "icons", "manifest.json");
  if (!manifestPath || !existsSync(manifestPath)) {
    manifestPath = safeResolve(PROJECT_ROOT, "public", "icons", "manifest.json");
  }
  if (manifestPath) {
    const iconFiles: string[] = JSON.parse(readFileSync(manifestPath, "utf-8"));
    for (const f of iconFiles) {
      const key = `icons/${f.toLowerCase()}`;
      let iconPath = safeResolve(import.meta.dirname, "icons", f);
      if (!iconPath || !existsSync(iconPath)) {
        iconPath = safeResolve(PROJECT_ROOT, "public", "icons", f);
      }
      if (!iconPath) continue;
      files[key] = { content: readFileSync(iconPath), type: "image/svg+xml" };
    }
  }
}

// Load static files at startup
loadStaticFiles();

const httpServer = new Server((req: IncomingMessage, res: ServerResponse) => {
  const url = (req.url || "").toLowerCase();
  const filename = url.slice(1);

  // Defense-in-depth security headers. Even though our client renders all
  // user content via textContent / encodeUGC, CSP and the others limit the
  // blast radius of any future regression.
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
      "connect-src 'self' ws: wss:; base-uri 'none'; frame-ancestors 'none'",
  );

  if (url === "/") {
    const { content, type } = files[allowFiles[0][0]];
    res.setHeader("Content-Type", type);
    return res.end(content);
  }

  if (url === "/errors") {
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify(ERR));
  }

  if (url === "/constants") {
    res.setHeader("Content-Type", "application/json");
    return res.end(
      JSON.stringify({
        NAME_LENGTH_MIN,
        NAME_LENGTH_MAX,
        MAX_HAND_CARDS,
        RECONNECT_DEFER_MS,
        RECONNECT_DEADLINE_MS,
        DISCONNECT_REMOVE_MS,
        PLAY_TIMEOUT_MS,
      }),
    );
  }

  // Serve icon SVGs from cache
  if (url.startsWith("/icons/") && filename in files) {
    const { content, type } = files[filename];
    res.setHeader("Content-Type", type);
    res.setHeader("Cache-Control", "public, max-age=86400");
    return res.end(content);
  }

  if (!!filename && filename in files) {
    const { content, type } = files[filename];
    res.setHeader("Content-Type", type);
    return res.end(content);
  }

  res.statusCode = 404;
  return res.end();
});

httpServer.on("upgrade", (request: IncomingMessage, socket: import("net").Socket, head: Buffer) => {
  const { pathname } = new URL(request.url!, `http://${request.headers.host}`);

  if (pathname !== "/ws") {
    socket.destroy();
    return;
  }

  // Origin check — reject cross-site WebSocket hijacking attempts. The
  // browser enforces same-origin for fetch/XHR but NOT for WebSockets, so
  // the server has to do it. Non-browser clients omit Origin and are allowed
  // through (they're not subject to CSWSH).
  const origin = request.headers.origin as string | undefined;
  if (!isAllowedOrigin(origin, request.headers.host)) {
    serverWarn("rejected ws upgrade from cross-origin", {
      origin,
      host: request.headers.host,
    });
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws, request);
  });
});

const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD });
// Catch-all for any error bubbled to the WebSocketServer itself; without this
// rare server-level errors (e.g. bad upgrade frames) would crash the process.
wss.on("error", (err: Error) => {
  console.warn("[server] wss error", err.message);
});

const clients = new Map<WebSocket, ClientMetadata>();
const lobbies = new Map<string, Lobby>();
const startedLobbies = new Set<string>();
const aiTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
const disconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
const reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
const sessions = new Map<string, SessionData>();
const deferTimers = new Map<string, ReturnType<typeof setTimeout>>();
// Per-lobby short-grace timer that aborts an AI-only game when its last
// human disconnected and didn't return within ALL_HUMANS_GONE_GRACE_MS.
// Keyed by lobby id so a disconnect/reconnect cycle on the SAME human
// just clears+reschedules; multiple humans disconnecting in sequence
// each just refresh this single timer.
const allHumansGoneTimers = new Map<string, ReturnType<typeof setTimeout>>();

// Per-lobby turn-timeout state. The authoritative timer lives on the server
// (Node.js timers are not throttled) — clients only display the countdown
// using Date.now() diffs against the broadcast deadline. The deadline is the
// absolute epoch ms by which the player must have acted (drawn or played).
// Auto-draw mode is paused while no real-player has any time to act, e.g.
// during AI turns or while the only human is reconnecting.
//
// The deadline is locked to the *turn*, not the active socket — otherwise a
// player could refresh on their own turn to reset the 30-second window
// indefinitely. We track which (player ID, turn-direction-stamp) the active
// deadline belongs to and only mint a fresh deadline when the turn truly
// changes; reconnects within the same turn re-arm the timer to the
// REMAINING window only.
interface TurnTimer {
  timer: ReturnType<typeof setTimeout>;
  deadline: number;
  // Token bumped on every reschedule; pending fires whose token mismatches
  // the current one are no-ops, preventing stale timers from firing after a
  // legitimate turn change beat them to it.
  token: number;
  // Identity of the turn the deadline was minted for. While this matches
  // the current state, scheduleTurnTimeout will REUSE the existing
  // deadline instead of resetting the countdown.
  turnPlayerId: string;
  turnSerial: number;
  // Dev-only pause: when true, `timer` is null/cleared and `remainingMs`
  // captures how much wall-clock time was left at pause. Resuming
  // re-mints `deadline = Date.now() + remainingMs` and reschedules.
  // Production code never sets this — the dev pause action is only
  // exposed when isDev() is true.
  paused?: boolean;
  remainingMs?: number;
}
const turnTimers = new Map<string, TurnTimer>();
const turnTokens = new Map<string, number>();
// Per-lobby snapshot of the turn instance the active deadline was minted
// against. Used to detect "the turn changed" (player rotated, or same
// player came around again after a full cycle) so we know whether a fresh
// scheduleTurnTimeout call should mint a new deadline or reuse the
// existing one. We capture both the player id AND the turn index — if a
// game has 4 players and it cycles back to player 0, the index is the
// same but the deadline must reset.
interface TurnSnapshot {
  playerId: string;
  turnIndex: number;
  // Direction is part of the snapshot so a reverse-card-only turn change
  // (which keeps both index and player but inverts direction) is treated
  // as a fresh turn even though no other field changed.
  direction: number;
}
const lobbyTurnSnapshots = new Map<string, TurnSnapshot>();

// ── Logging ──────────────────────────────────────────────
const LOG_PREFIX = "[server]";

function serverLog(msg: string, ...args: unknown[]): void {
  console.log(`${LOG_PREFIX} ${msg}`, ...args);
}

function serverWarn(msg: string, detail?: unknown): void {
  console.warn(`${LOG_PREFIX} ${msg}`, detail ?? "");
}

let stateLog: StateLogEntry[] = [];
function logState(
  event: string,
  metadata?: ClientMetadata,
  details: Record<string, unknown> = {},
): void {
  if (!isDev()) return;
  stateLog.push({
    t: Date.now(),
    event,
    playerId: metadata?.id?.slice(0, 8),
    lobbyId: metadata?.lobbyId?.slice(0, 8),
    name: metadata?.name,
    ...details,
  });
  if (stateLog.length > 10000) stateLog.splice(0, 1000);
}

function validateState(
  playerId: string,
  _name: string | undefined,
  lobbyId: string | null | undefined,
): string {
  if (!lobbyId) return "disconnected";
  const lobby = lobbies.get(lobbyId);
  if (!lobby) return "disconnected";
  const player = lobby.players.find((p) => p.id === playerId);
  if (!player) return "disconnected";
  if (player.disconnected) return "reconnecting";
  if (lobby.game.started) return "in_game";
  return "in_lobby";
}

function createLobby(lobbyId: string): Lobby {
  return {
    id: lobbyId,
    players: [],
    game: {
      deck: [],
      discardPile: [],
      turn: 0,
      direction: 1,
      started: false,
      state: LobbyGameState.normal,
      drawingCount: 0,
      drawMode: "chain",
    },
  };
}

function findOrCreateLobby(lobbyId: string): Lobby {
  if (!lobbies.has(lobbyId)) {
    lobbies.set(lobbyId, createLobby(lobbyId));
  }
  return lobbies.get(lobbyId)!;
}

function broadcastToLobby(
  lobbyId: string,
  message: object,
  excludeClientId: string | null = null,
): void {
  [...clients.keys()].forEach((client) => {
    const metadata = clients.get(client);
    if (metadata && metadata.lobbyId === lobbyId && metadata.id !== excludeClientId) {
      client.send(JSON.stringify(message));
    }
  });
}

function broadcastPlayers(lobbyId: string): void {
  const lobby = lobbies.get(lobbyId);
  if (!lobby) return;

  const message = {
    action: "players",
    players: lobby.players,
    turn: lobby.game.turn,
    lobbyId: lobbyId,
    drawMode: lobby.game.drawMode,
    turnDeadline: lobby.game.started ? getTurnDeadline(lobbyId) : null,
    turnTimerPaused: lobby.game.started ? isTurnTimerPaused(lobbyId) : false,
  };
  broadcastToLobby(lobbyId, message);
}

function checkStartGame(lobbyId: string): void {
  const lobby = lobbies.get(lobbyId);
  if (!lobby) return;
  const activePlayers = lobby.players.filter((p) => !p.disconnected);
  serverLog(
    `checkStartGame lobby=${lobbyId?.slice(0, 8)} total=${lobby.players.length} active=${activePlayers.length} activeReady=${activePlayers.filter((p) => p.ready).length}`,
  );
  if (
    lobby.players.length >= 2 &&
    activePlayers.length >= 2 &&
    activePlayers.every((p) => p.ready)
  ) {
    startGame(lobbyId);
  }
}

function createDeck(lobbyId: string): void {
  const lobby = lobbies.get(lobbyId);
  if (!lobby) return;

  const colors = ["red", "yellow", "green", "blue"];
  const types = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "skip", "reverse", "draw2"];
  const wildTypes = ["wild", "wild4"];

  for (const color of colors) {
    for (const type of types) {
      lobby.game.deck.push({ color, type });
      if (type !== "0") {
        lobby.game.deck.push({ color, type });
      }
    }
  }

  for (let i = 0; i < 4; i++) {
    for (const type of wildTypes) {
      lobby.game.deck.push({ type });
    }
  }
}

function shuffleDeck(lobbyId: string): void {
  const lobby = lobbies.get(lobbyId);
  if (!lobby) return;

  for (let i = lobby.game.deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [lobby.game.deck[i], lobby.game.deck[j]] = [lobby.game.deck[j], lobby.game.deck[i]];
  }
}

function generateRandomCard(): Card {
  const colors = ["red", "yellow", "green", "blue"];
  const types = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "skip", "reverse", "draw2"];
  const r = Math.random();
  if (r < 0.05) return { type: "wild4" };
  if (r < 0.1) return { type: "wild" };
  return {
    color: colors[Math.floor(Math.random() * colors.length)],
    type: types[Math.floor(Math.random() * types.length)],
  };
}

function drawCardsFromDeck(lobby: Lobby, lobbyId: string, count: number): Card[] {
  const drawn: Card[] = [];
  while (drawn.length < count) {
    let card: Card;

    if (false && lobby.game.deck.length > 1) {
      // disabled
      card = lobby.game.deck.pop()!;
      if (!card) {
        if (lobby.game.discardPile.length >= 2) {
          const topCard = lobby.game.discardPile.pop()!;
          lobby.game.deck = lobby.game.discardPile;
          lobby.game.discardPile = [topCard];
          shuffleDeck(lobbyId);
          card = lobby.game.deck.pop()!;
        }
      }
    } else {
      card = generateRandomCard();
    }
    if (card) drawn.push(card);
  }

  return drawn;
}

function dealCards(lobbyId: string): void {
  const lobby = lobbies.get(lobbyId);
  if (!lobby) return;

  for (const player of lobby.players) {
    player.hand = lobby.game.deck.splice(0, 7);
    player.uno = false;
  }
}

function startGame(lobbyId: string): void {
  const lobby = lobbies.get(lobbyId);
  if (!lobby) return;
  const activePlayers = lobby.players.filter((p) => !p.disconnected);
  if (activePlayers.length < 2) return;

  lobby.game.started = true;
  startedLobbies.add(lobbyId);
  createDeck(lobbyId);
  shuffleDeck(lobbyId);
  dealCards(lobbyId);

  let firstCardIndex = lobby.game.deck.findIndex(
    (card) => card.type !== "wild" && card.type !== "wild4",
  );
  if (firstCardIndex === -1) {
    shuffleDeck(lobbyId);
    firstCardIndex = lobby.game.deck.findIndex(
      (card) => card.type !== "wild" && card.type !== "wild4",
    );
  }
  lobby.game.discardPile.push(lobby.game.deck.splice(firstCardIndex, 1)[0]);

  // Start the turn-timeout for the first player before broadcasting so the
  // absolute deadline ships in the same start frame.
  scheduleTurnTimeout(lobbyId);
  const turnDeadline = getTurnDeadline(lobbyId);

  [...clients.keys()].forEach((client) => {
    const metadata = clients.get(client);
    if (metadata && metadata.lobbyId === lobbyId) {
      const player = lobby.players.find((p) => p.id === metadata.id);
      if (!player) return;
      const message = {
        action: "start",
        players: sanitizePlayersForClient(lobby.players),
        discardPile: lobby.game.discardPile,
        turn: lobby.game.turn,
        direction: lobby.game.direction,
        gameState: lobby.game.state,
        drawingCount: lobby.game.drawingCount,
        hand: player.hand,
        id: metadata.id,
        turnDeadline,
      };
      client.send(JSON.stringify(message));
    }
  });

  scheduleAIMove(lobbyId);
}

function broadcastWin(lobbyId: string, winnerName: string): void {
  const lobby = lobbies.get(lobbyId);
  if (!lobby) return;

  resetTurnTimerState(lobbyId);
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
    state: LobbyGameState.normal,
    drawingCount: 0,
    drawMode: "chain",
  };
  startedLobbies.delete(lobbyId);
}

function broadcastGameAborted(lobbyId: string, excludePlayerId: string): void {
  const lobby = lobbies.get(lobbyId);
  if (!lobby) return;

  resetTurnTimerState(lobbyId);
  const ahg = allHumansGoneTimers.get(lobbyId);
  if (ahg) {
    clearTimeout(ahg);
    allHumansGoneTimers.delete(lobbyId);
  }
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
    state: LobbyGameState.normal,
    drawingCount: 0,
    drawMode: "chain",
  };
  startedLobbies.delete(lobbyId);
}

function checkGameAborted(lobbyId: string, excludePlayerId: string): void {
  const lobby = lobbies.get(lobbyId);
  if (!lobby || !lobby.game.started) return;
  const realPlayers = lobby.players.filter((p) => !p.isAI);
  if (realPlayers.length === 0) {
    broadcastGameAborted(lobbyId, excludePlayerId);
  }
}

function generateAIName(lobby: Lobby): string {
  let index = 1;
  while (lobby.players.some((p) => p.name === `AI-${index}`)) {
    index++;
  }
  return `AI-${index}`;
}

function clearAITimeout(playerId: string): void {
  if (aiTimeouts.has(playerId)) {
    clearTimeout(aiTimeouts.get(playerId));
    aiTimeouts.delete(playerId);
  }
}

function clearAllAITimeouts(lobbyId: string): void {
  const lobby = lobbies.get(lobbyId);
  if (!lobby) return;
  for (const player of lobby.players) {
    if (player.isAI) {
      clearAITimeout(player.id);
    }
  }
}

function clearTurnTimer(lobbyId: string): void {
  const t = turnTimers.get(lobbyId);
  if (t) {
    clearTimeout(t.timer);
    turnTimers.delete(lobbyId);
  }
}

// Wipe everything tied to a lobby's turn-timer state — used at game-end
// boundaries so the next game starts with a clean slate.
function resetTurnTimerState(lobbyId: string): void {
  clearTurnTimer(lobbyId);
  lobbyTurnSnapshots.delete(lobbyId);
  turnTokens.delete(lobbyId);
}

// Schedule (or reset) the per-turn timeout for the lobby. AI turns are not
// timed (they act on their own setTimeout), and rounds with only AI players
// remaining never auto-fire. The current real player has PLAY_TIMEOUT_MS to
// act; otherwise the server auto-draws on their behalf.
//
// Reconnect-safe: the deadline is locked to the *current turn* (player
// + turn-index + direction). If scheduleTurnTimeout is called while the
// turn snapshot is unchanged (e.g. a refresh / reconnect re-broadcast)
// we re-arm the underlying setTimeout to the REMAINING window instead of
// minting a new full window. Without that, a player could refresh just
// before the deadline to reset the 30-second budget indefinitely.
function scheduleTurnTimeout(lobbyId: string): void {
  const lobby = lobbies.get(lobbyId);
  if (!lobby || !lobby.game.started) {
    clearTurnTimer(lobbyId);
    lobbyTurnSnapshots.delete(lobbyId);
    return;
  }

  const currentPlayer = lobby.players[lobby.game.turn];
  // Skip timeout for AI turns (AI has its own scheduler) and for disconnected
  // players (their reconnect/disconnect timers cover them; if those expire
  // the player is removed and turn advances).
  if (!currentPlayer || currentPlayer.isAI || currentPlayer.disconnected) {
    clearTurnTimer(lobbyId);
    // Don't drop the snapshot — when the disconnected player reconnects we
    // want to resume their existing budget instead of granting a fresh one.
    return;
  }

  const snap = lobbyTurnSnapshots.get(lobbyId);
  const sameTurn =
    !!snap &&
    snap.playerId === currentPlayer.id &&
    snap.turnIndex === lobby.game.turn &&
    snap.direction === lobby.game.direction;

  const existing = turnTimers.get(lobbyId);
  // Dev pause: if the existing timer is paused for the same turn, leave
  // it alone — broadcastGameUpdate calls scheduleTurnTimeout on every
  // state change and we don't want that to silently revive a paused
  // timer or mint a new deadline. The dev_toggle_turn_timer handler is
  // the only thing that should resume.
  if (sameTurn && existing && existing.paused) {
    return;
  }
  if (sameTurn && existing) {
    // Re-arm the timer against the existing absolute deadline — preserves
    // the wall-clock budget across reconnect / state-resync cycles.
    const remaining = existing.deadline - Date.now();
    const newToken = (turnTokens.get(lobbyId) || 0) + 1;
    turnTokens.set(lobbyId, newToken);
    clearTimeout(existing.timer);
    const playerId = currentPlayer.id;
    const fireDelay = Math.max(0, remaining);
    const timer = setTimeout(() => {
      if (turnTokens.get(lobbyId) !== newToken) return;
      turnTimers.delete(lobbyId);
      onTurnTimeout(lobbyId, playerId);
    }, fireDelay);
    turnTimers.set(lobbyId, {
      timer,
      deadline: existing.deadline,
      token: newToken,
      turnPlayerId: playerId,
      turnSerial: existing.turnSerial,
    });
    return;
  }

  // Fresh turn → mint a brand-new deadline AND record the snapshot.
  const newToken = (turnTokens.get(lobbyId) || 0) + 1;
  turnTokens.set(lobbyId, newToken);
  clearTurnTimer(lobbyId);

  const deadline = Date.now() + PLAY_TIMEOUT_MS + PLAY_TIMEOUT_GRACE_MS;
  const playerId = currentPlayer.id;
  const serial = (existing ? existing.turnSerial : 0) + 1;
  const timer = setTimeout(() => {
    if (turnTokens.get(lobbyId) !== newToken) return;
    turnTimers.delete(lobbyId);
    onTurnTimeout(lobbyId, playerId);
  }, PLAY_TIMEOUT_MS + PLAY_TIMEOUT_GRACE_MS);
  turnTimers.set(lobbyId, {
    timer,
    deadline,
    token: newToken,
    turnPlayerId: playerId,
    turnSerial: serial,
  });
  lobbyTurnSnapshots.set(lobbyId, {
    playerId: currentPlayer.id,
    turnIndex: lobby.game.turn,
    direction: lobby.game.direction,
  });
}

function getTurnDeadline(lobbyId: string): number | null {
  const t = turnTimers.get(lobbyId);
  return t ? t.deadline : null;
}

// Returns true when the active turn timer is paused (dev_toggle_turn_timer).
// Clients use this to render a "暂停" badge instead of a live countdown so
// the user can tell the auto-draw is intentionally on hold.
function isTurnTimerPaused(lobbyId: string): boolean {
  const t = turnTimers.get(lobbyId);
  return !!(t && t.paused);
}

function onTurnTimeout(lobbyId: string, expectedPlayerId: string): void {
  const lobby = lobbies.get(lobbyId);
  if (!lobby || !lobby.game.started) return;
  const currentPlayer = lobby.players[lobby.game.turn];
  // Whoever is currently up may differ from when the timer was scheduled
  // (race against handlePlay/handleDraw). If so, just bail — the new turn
  // already has its own timer.
  if (!currentPlayer || currentPlayer.id !== expectedPlayerId) return;
  if (currentPlayer.isAI || currentPlayer.disconnected) return;

  serverLog(`turn timeout in ${lobbyId.slice(0, 8)} — auto-drawing for ${currentPlayer.name}`);
  // Notify everyone in the lobby so the client can flash a status line.
  // We send before auto-draw so the message lands in the same render frame
  // as the resulting update.
  broadcastToLobby(lobbyId, {
    action: "turn_timeout",
    playerId: currentPlayer.id,
    playerName: currentPlayer.name,
  });
  // Auto-draw treats the turn the same as a manual draw: in chain state the
  // penalty is accepted; otherwise a single card is drawn. Turn advances.
  handleDraw(lobbyId, currentPlayer.id);
}

function performAIMove(lobbyId: string): void {
  const lobby = lobbies.get(lobbyId);
  if (!lobby || !lobby.game.started) return;

  const currentPlayer = lobby.players[lobby.game.turn];
  if (!currentPlayer || !currentPlayer.isAI) return;

  const decision = decideMove(lobby);

  if (decision.type === "play") {
    handlePlay(lobbyId, currentPlayer.id, decision.card);
  } else if (decision.type === "play_multiple") {
    handlePlayMultiple(lobbyId, currentPlayer.id, decision.cards);
  } else if (decision.type === "draw") {
    handleDraw(lobbyId, currentPlayer.id);
  }
}

function scheduleAIMove(lobbyId: string): void {
  const lobby = lobbies.get(lobbyId);
  if (!lobby || !lobby.game.started) return;

  const currentPlayer = lobby.players[lobby.game.turn];
  if (currentPlayer && currentPlayer.isAI) {
    clearAITimeout(currentPlayer.id);
    const delay = 500 + Math.random() * 300;
    const timeout = setTimeout(() => performAIMove(lobbyId), delay);
    aiTimeouts.set(currentPlayer.id, timeout);
  }
}

function handlePlayMultiple(lobbyId: string, playerId: string, cards: Card[]): void {
  const lobby = lobbies.get(lobbyId);
  if (!lobby) return;

  const player = lobby.players.find((p) => p.id === playerId);
  const playerIndex = lobby.players.findIndex((p) => p.id === playerId);

  if (!player || lobby.game.turn !== playerIndex) {
    return;
  }

  const firstCard = cards[0];
  if (!cards.every((card) => card.type === firstCard.type)) {
    return;
  }

  if (!isValidMove(lobbyId, firstCard)) {
    return;
  }

  // Verify every card is actually in the hand before mutating game state.
  // Otherwise a client could submit forged cards and pollute the discard pile
  // / inflict penalties on opponents while keeping its own hand intact.
  // Build a working copy of the hand so duplicate cards in `cards` consume
  // distinct hand slots (we can't reuse the same hand index twice).
  const handCopy = player.hand!.slice();
  const indicesToRemove: number[] = [];
  for (const card of cards) {
    let cardIndex: number;
    if (card.type === "wild" || card.type === "wild4") {
      cardIndex = handCopy.findIndex((c) => c && c.type === card.type);
    } else {
      cardIndex = handCopy.findIndex((c) => c && c.color === card.color && c.type === card.type);
    }
    if (cardIndex < 0) {
      return;
    }
    indicesToRemove.push(cardIndex);
    // Mark slot as consumed so the next iteration can't reuse it.
    (handCopy as (Card | null)[])[cardIndex] = null;
  }

  // All cards confirmed in hand — apply the removals to the real hand.
  // Sort descending so splice() doesn't shift remaining indices.
  for (const i of indicesToRemove.slice().sort((a, b) => b - a)) {
    player.hand!.splice(i, 1);
  }

  const lastCard = cards[cards.length - 1];
  lobby.game.discardPile.push(lastCard);

  const cardCount = cards.length;

  if (lastCard.type === "skip") {
    // In chain mode, breaking the chain with skip/reverse must still apply
    // the accumulated penalty to the player who broke it. Without this the
    // chain effect is silently dropped (TODO #3 — "普通牌在部分情况下会使
    // 得链式加牌的加牌效果被跳过").
    if (lobby.game.drawMode !== "direct" && lobby.game.state === LobbyGameState.drawing) {
      const penalty = lobby.game.drawingCount;
      if (penalty > 0 && player) {
        player.hand!.push(...drawCardsFromDeck(lobby, lobbyId, penalty));
      }
    }
    lobby.game.turn =
      (lobby.game.turn + (cardCount + 1) * lobby.game.direction + lobby.players.length) %
      lobby.players.length;
    lobby.game.state = LobbyGameState.normal;
    lobby.game.drawingCount = 0;
  } else if (lastCard.type === "reverse") {
    if (lobby.game.drawMode !== "direct" && lobby.game.state === LobbyGameState.drawing) {
      const penalty = lobby.game.drawingCount;
      if (penalty > 0 && player) {
        player.hand!.push(...drawCardsFromDeck(lobby, lobbyId, penalty));
      }
    }
    if (cardCount % 2 === 1) {
      lobby.game.direction *= -1;
    }
    lobby.game.turn =
      (lobby.game.turn + lobby.game.direction + lobby.players.length) % lobby.players.length;
    lobby.game.state = LobbyGameState.normal;
    lobby.game.drawingCount = 0;
  } else if (lastCard.type === "draw2" || lastCard.type === "wild4") {
    const n = (lastCard.type === "draw2" ? 2 : 4) * cardCount;
    if (lobby.game.drawMode === "direct") {
      const nextPlayerIndex =
        (lobby.game.turn + lobby.game.direction + lobby.players.length) % lobby.players.length;
      const nextPlayer = lobby.players[nextPlayerIndex];
      nextPlayer.hand!.push(...drawCardsFromDeck(lobby, lobbyId, n));
      lobby.game.turn =
        (lobby.game.turn + lobby.game.direction + lobby.players.length) % lobby.players.length;
      lobby.game.state = LobbyGameState.normal;
      lobby.game.drawingCount = 0;
    } else if (lobby.game.state === LobbyGameState.normal) {
      lobby.game.state = LobbyGameState.drawing;
      lobby.game.drawingCount = n;
      lobby.game.turn =
        (lobby.game.turn + lobby.game.direction + lobby.players.length) % lobby.players.length;
    } else {
      lobby.game.drawingCount += n;
      lobby.game.turn =
        (lobby.game.turn + lobby.game.direction + lobby.players.length) % lobby.players.length;
    }
  } else {
    // Non-draw card: break chain (chain mode only)
    if (lobby.game.drawMode !== "direct" && lobby.game.state === LobbyGameState.drawing) {
      const penalty = lobby.game.drawingCount;
      lobby.game.state = LobbyGameState.normal;
      lobby.game.drawingCount = 0;
      if (penalty > 0 && player) {
        player.hand!.push(...drawCardsFromDeck(lobby, lobbyId, penalty));
      }
    }
    lobby.game.turn =
      (lobby.game.turn + lobby.game.direction + lobby.players.length) % lobby.players.length;
  }

  broadcastGameUpdate(lobbyId);

  if (player && player.hand && player.hand.length === 0) {
    broadcastWin(lobbyId, player.name);
  }
}

function handlePlay(lobbyId: string, playerId: string, card: Card): void {
  const lobby = lobbies.get(lobbyId);
  if (!lobby) return;

  const player = lobby.players.find((p) => p.id === playerId);
  const playerIndex = lobby.players.findIndex((p) => p.id === playerId);

  if (lobby.game.turn !== playerIndex) {
    return;
  }

  if (isValidMove(lobbyId, card)) {
    let cardIndex: number;
    if (card.type === "wild" || card.type === "wild4") {
      cardIndex = player!.hand!.findIndex((c) => c.type === card.type);
    } else {
      cardIndex = player!.hand!.findIndex((c) => c.color === card.color && c.type === card.type);
    }

    // Reject plays of cards that are not actually in the player's hand:
    // without this check, a malicious client could push arbitrary cards onto
    // the discard pile (e.g. a forged wild4) and trigger penalties on opponents
    // without ever consuming their own hand.
    if (cardIndex < 0) {
      return;
    }

    player!.hand!.splice(cardIndex, 1);

    lobby.game.discardPile.push(card);

    if (card.type === "skip") {
      // Chain-breaking via skip/reverse must still apply the penalty in
      // chain mode (TODO #3). Without this, the player breaks the chain
      // for free.
      if (lobby.game.drawMode !== "direct" && lobby.game.state === LobbyGameState.drawing) {
        const penalty = lobby.game.drawingCount;
        if (penalty > 0) {
          player!.hand!.push(...drawCardsFromDeck(lobby, lobbyId, penalty));
        }
      }
      lobby.game.turn =
        (lobby.game.turn + 2 * lobby.game.direction + lobby.players.length) % lobby.players.length;
      lobby.game.state = LobbyGameState.normal;
      lobby.game.drawingCount = 0;
    } else if (card.type === "reverse") {
      if (lobby.game.drawMode !== "direct" && lobby.game.state === LobbyGameState.drawing) {
        const penalty = lobby.game.drawingCount;
        if (penalty > 0) {
          player!.hand!.push(...drawCardsFromDeck(lobby, lobbyId, penalty));
        }
      }
      lobby.game.direction *= -1;
      lobby.game.turn =
        (lobby.game.turn + lobby.game.direction + lobby.players.length) % lobby.players.length;
      lobby.game.state = LobbyGameState.normal;
      lobby.game.drawingCount = 0;
    } else if (card.type === "draw2" || card.type === "wild4") {
      const n = card.type === "draw2" ? 2 : 4;
      if (lobby.game.drawMode === "direct") {
        const nextPlayerIndex =
          (lobby.game.turn + lobby.game.direction + lobby.players.length) % lobby.players.length;
        const nextPlayer = lobby.players[nextPlayerIndex];
        nextPlayer.hand!.push(...drawCardsFromDeck(lobby, lobbyId, n));
        lobby.game.turn =
          (lobby.game.turn + lobby.game.direction + lobby.players.length) % lobby.players.length;
        lobby.game.state = LobbyGameState.normal;
        lobby.game.drawingCount = 0;
      } else if (lobby.game.state === LobbyGameState.normal) {
        lobby.game.state = LobbyGameState.drawing;
        lobby.game.drawingCount = n;
        lobby.game.turn =
          (lobby.game.turn + lobby.game.direction + lobby.players.length) % lobby.players.length;
      } else {
        lobby.game.drawingCount += n;
        lobby.game.turn =
          (lobby.game.turn + lobby.game.direction + lobby.players.length) % lobby.players.length;
      }
    } else {
      // Non-draw card: break chain (chain mode only)
      if (lobby.game.drawMode !== "direct" && lobby.game.state === LobbyGameState.drawing) {
        const penalty = lobby.game.drawingCount;
        lobby.game.state = LobbyGameState.normal;
        lobby.game.drawingCount = 0;
        if (penalty > 0) {
          player!.hand!.push(...drawCardsFromDeck(lobby, lobbyId, penalty));
        }
      }
      lobby.game.turn =
        (lobby.game.turn + lobby.game.direction + lobby.players.length) % lobby.players.length;
    }

    broadcastGameUpdate(lobbyId);

    if (player && player.hand && player.hand.length === 0) {
      broadcastWin(lobbyId, player.name);
    }
  }
}

function handleDraw(lobbyId: string, playerId: string): void {
  const lobby = lobbies.get(lobbyId);
  if (!lobby || !lobby.game.started) return;

  const playerIndex = lobby.players.findIndex((p) => p.id === playerId);

  if (lobby.game.turn !== playerIndex) {
    return;
  }

  const player = lobby.players[playerIndex];

  // In drawing state, draw = accept penalty
  if (lobby.game.state === LobbyGameState.drawing) {
    const penalty = lobby.game.drawingCount;
    lobby.game.state = LobbyGameState.normal;
    lobby.game.drawingCount = 0;
    if (penalty > 0) {
      player.hand!.push(...drawCardsFromDeck(lobby, lobbyId, penalty));
    } else {
      player.hand!.push(...drawCardsFromDeck(lobby, lobbyId, 1));
    }
    lobby.game.turn =
      (lobby.game.turn + lobby.game.direction + lobby.players.length) % lobby.players.length;
    broadcastGameUpdate(lobbyId);
    return;
  }

  if (player.hand!.length >= MAX_HAND_CARDS) {
    lobby.game.turn =
      (lobby.game.turn + lobby.game.direction + lobby.players.length) % lobby.players.length;
    broadcastGameUpdate(lobbyId);
    return;
  }

  const drawn = drawCardsFromDeck(lobby, lobbyId, 1);
  if (drawn.length > 0) {
    player.hand!.push(drawn[0]);
  }
  lobby.game.turn =
    (lobby.game.turn + lobby.game.direction + lobby.players.length) % lobby.players.length;
  broadcastGameUpdate(lobbyId);
}

function isValidMove(lobbyId: string, card: Card): boolean {
  const lobby = lobbies.get(lobbyId);
  if (!lobby) return false;

  if (lobby.game.discardPile.length === 0) return true;
  const topCard = lobby.game.discardPile[lobby.game.discardPile.length - 1];
  const isNCard = (t: string) => t === "draw2" || t === "wild4";
  return (
    card.color === topCard.color ||
    card.type === topCard.type ||
    (isNCard(card.type) && isNCard(topCard.type)) ||
    card.type === "wild" ||
    card.type === "wild4"
  );
}

function checkAutoUno(_lobbyId: string, player: Player): boolean {
  if (player.hand && player.hand.length === 1) {
    player.uno = true;
    return true;
  }

  if (player.hand && player.hand.length > 1) {
    const firstCard = player.hand[0];
    if (firstCard.type !== "wild" && firstCard.type !== "wild4") {
      const allSameType = player.hand.every((card) => card.type === firstCard.type);
      if (allSameType) {
        player.uno = true;
        return true;
      }
    }
  }

  player.uno = false;
  return false;
}

function sanitizePlayersForClient(players: Player[]): object[] {
  return players.map((p) => {
    const { hand, ...rest } = p;
    return { ...rest, cardCount: hand ? hand.length : 0 };
  });
}

function broadcastGameUpdate(lobbyId: string): void {
  const lobby = lobbies.get(lobbyId);
  if (!lobby) return;

  lobby.players.forEach((player) => {
    if (player.hand) {
      checkAutoUno(lobbyId, player);
    }
  });

  // Reset the turn timer for the new active player. Done before broadcasting
  // so the absolute deadline goes out in the same message and clients can
  // begin their countdown immediately.
  scheduleTurnTimeout(lobbyId);
  const turnDeadline = getTurnDeadline(lobbyId);
  const turnTimerPaused = isTurnTimerPaused(lobbyId);

  [...clients.keys()].forEach((client) => {
    const metadata = clients.get(client);
    if (metadata && metadata.lobbyId === lobbyId) {
      const player = lobby.players.find((p) => p.id === metadata.id);
      const message: Record<string, unknown> = {
        action: "update",
        players: sanitizePlayersForClient(lobby.players),
        discardPile: lobby.game.discardPile,
        turn: lobby.game.turn,
        direction: lobby.game.direction,
        gameState: lobby.game.state,
        drawingCount: lobby.game.drawingCount,
        spectator: metadata.isSpectator || false,
        hand: player ? player.hand : [],
        turnDeadline,
        turnTimerPaused,
      };

      client.send(JSON.stringify(message));
    }
  });

  scheduleAIMove(lobbyId);
}

function handleUno(lobbyId: string, playerId: string): void {
  const lobby = lobbies.get(lobbyId);
  if (!lobby) return;

  const player = lobby.players.find((p) => p.id === playerId);
  if (player && player.hand && player.hand.length === 1) {
    player.uno = true;
    broadcastPlayers(lobbyId);
  }
}

function uuidv4(): string {
  // crypto.randomBytes is CSPRNG-backed and available since Node 0.10, so
  // this works under Node 12 (the minimum target for the pkg-built binary)
  // while still avoiding Math.random's predictable output. Node's own
  // crypto.randomUUID would be cleaner but only landed in 14.17.
  const bytes = randomBytes(16);
  // Per RFC 4122 §4.4: set version (4) and variant (10).
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return (
    hex.slice(0, 8) +
    "-" +
    hex.slice(8, 12) +
    "-" +
    hex.slice(12, 16) +
    "-" +
    hex.slice(16, 20) +
    "-" +
    hex.slice(20, 32)
  );
}

wss.on("connection", (ws: WebSocket, _req: IncomingMessage) => {
  const id = uuidv4();
  const metadata: ClientMetadata = { id };
  clients.set(ws, metadata);

  // Bound the damage from a noisy / malicious client. After repeated invalid
  // payloads we simply drop the connection rather than silently absorbing
  // them forever.
  let parseErrorCount = 0;

  ws.send(JSON.stringify({ action: "init", dev: isDev(), id }));
  serverLog(`client connected ${id}`);

  // The ws library raises an 'error' event on the WebSocket instance for
  // protocol-level violations (oversized payload, malformed frame, etc).
  // Without a listener Node treats it as an unhandled error and kills the
  // whole process — i.e. any client could crash the server with a single
  // bad frame. Just log it; the socket is closed automatically afterwards.
  ws.on("error", (err: Error) => {
    serverWarn("ws error", {
      id,
      message: err.message,
      code: (err as { code?: string }).code,
    });
  });

  ws.on("message", (messageAsString: Buffer | string) => {
    let message: ClientMessage;
    try {
      message = JSON.parse(messageAsString.toString());
    } catch (_e) {
      parseErrorCount++;
      if (parseErrorCount >= MAX_PARSE_ERRORS_PER_CONN) {
        serverWarn("closing ws after too many invalid messages", {
          id,
          parseErrorCount,
        });
        try {
          ws.close(1008, "invalid messages");
        } catch {}
      }
      return;
    }
    // Reject anything that isn't a plain object — the rest of the dispatcher
    // assumes `message.action` is a string and accesses other named fields.
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      parseErrorCount++;
      if (parseErrorCount >= MAX_PARSE_ERRORS_PER_CONN) {
        try {
          ws.close(1008, "invalid messages");
        } catch {}
      }
      return;
    }

    const metadata = clients.get(ws)!;
    logState("msg", metadata, { action: message.action });
    if (
      metadata &&
      metadata.lobbyId &&
      message.action !== "reconnect" &&
      message.action !== "join"
    ) {
      const state = validateState(metadata.id, metadata.name, metadata.lobbyId);
      if (state === "disconnected") {
        serverLog(
          `state mismatch: player ${metadata.id?.slice(0, 8)} is ${state}, resetting lobbyId`,
        );
        metadata.lobbyId = null;
      }
    }

    if (!(message.action || "").startsWith("dev_")) {
      switch (message.action) {
        case "join": {
          if (!isValidPlayerName(message.name)) {
            ws.send(JSON.stringify(errorResponse("INVALID_PLAYER_NAME")));
            return;
          }
          metadata.name = message.name;
          if (!isValidLobbyId(message.lobbyId)) {
            ws.send(JSON.stringify(errorResponse("NEED_LOBBY_NAME")));
            return;
          }
          // Normalize lobby ID so case differences route to the same room.
          // Without this, a non-browser client (or the frontend before it
          // gained the toUpperCase guard) could send "Room" and end up in
          // a fresh lobby distinct from the existing "ROOM".
          message.lobbyId = normalizeLobbyId(message.lobbyId);
          let lobby = findOrCreateLobby(message.lobbyId);

          if (startedLobbies.has(lobby.id)) {
            const disconnectedPlayer = lobby.players.find(
              (p) =>
                p.id === message.playerId &&
                p.disconnected &&
                p.name.toLowerCase() === (message.name || "").toLowerCase(),
            );
            if (disconnectedPlayer) {
              const oldTimer = disconnectTimers.get(disconnectedPlayer.id);
              if (oldTimer) clearTimeout(oldTimer);
              disconnectTimers.delete(disconnectedPlayer.id);
              const retryTimer = reconnectTimers.get(disconnectedPlayer.id);
              if (retryTimer) clearTimeout(retryTimer);
              reconnectTimers.delete(disconnectedPlayer.id);
              disconnectedPlayer.reconnectDeadline = null;
              disconnectedPlayer.disconnected = false;
              metadata.name = disconnectedPlayer.name;
              metadata.lobbyId = message.lobbyId;
              metadata.id = disconnectedPlayer.id;
              ws.send(
                JSON.stringify({
                  action: "init",
                  id: disconnectedPlayer.id,
                  dev: isDev(),
                }),
              );
              broadcastPlayers(message.lobbyId);
              ws.send(
                JSON.stringify({
                  action: "start",
                  id: disconnectedPlayer.id,
                  players: sanitizePlayersForClient(lobby.players),
                  discardPile: lobby.game.discardPile,
                  turn: lobby.game.turn,
                  direction: lobby.game.direction,
                  hand: disconnectedPlayer.hand,
                }),
              );
              return;
            }
            // No real players left — abort and let them create a fresh lobby
            if (!lobby.players.some((p) => !p.isAI)) {
              broadcastGameAborted(lobby.id, "");
            } else {
              ws.send(JSON.stringify({ action: "spectate_offer", lobbyId: lobby.id }));
            }
            return;
          }

          const existingPlayer = lobby.players.find(
            (p) => p.name.toLowerCase() === (message.name || "").toLowerCase(),
          );
          if (existingPlayer) {
            if (existingPlayer.id === message.playerId || existingPlayer.disconnected) {
              const oldTimer = disconnectTimers.get(existingPlayer.id);
              if (oldTimer) clearTimeout(oldTimer);
              disconnectTimers.delete(existingPlayer.id);
              const retryTimer = reconnectTimers.get(existingPlayer.id);
              if (retryTimer) clearTimeout(retryTimer);
              reconnectTimers.delete(existingPlayer.id);
              existingPlayer.reconnectDeadline = null;
              existingPlayer.disconnected = false;
              const dfk = existingPlayer.id;
              const dft = deferTimers.get(dfk);
              if (dft) {
                clearTimeout(dft);
                deferTimers.delete(dfk);
              }
              metadata.name = existingPlayer.name;
              metadata.lobbyId = message.lobbyId;
              metadata.id = existingPlayer.id;
              ws.send(
                JSON.stringify({
                  action: "init",
                  id: existingPlayer.id,
                  dev: isDev(),
                }),
              );
              broadcastPlayers(message.lobbyId);
              return;
            }
            ws.send(JSON.stringify(errorResponse("NAME_DUPLICATE")));
            return;
          }

          metadata.lobbyId = message.lobbyId;

          const isCreator = lobby.players.length === 0;
          const player: Player = {
            id: metadata.id,
            name: metadata.name!,
            ready: false,
            isCreator: isCreator,
          };
          lobby.players.push(player);
          sessions.set(metadata.id, {
            name: metadata.name!,
            lobbyId: metadata.lobbyId!,
          });
          broadcastPlayers(metadata.lobbyId!);
          serverLog(`player jointed to ${lobby.id} :`, player);
          return;
        }

        case "add_ai": {
          const lobby = findOrCreateLobby(metadata.lobbyId!);
          const creator = lobby.players.find((p) => p.id === metadata.id);
          if (!creator || !creator.isCreator) {
            ws.send(JSON.stringify(errorResponse("CREATOR_ONLY")));
            return;
          }
          if (startedLobbies.has(lobby.id)) {
            ws.send(JSON.stringify(errorResponse("GAME_ALREADY_STARTED")));
            return;
          }
          // Cap AI count: each AI runs setTimeout/decideMove and bloats every
          // players broadcast, so an unbounded count is a CPU + bandwidth DoS.
          const aiCount = lobby.players.filter((p) => p.isAI).length;
          if (aiCount >= MAX_AI_PER_LOBBY) {
            ws.send(JSON.stringify(errorResponse("AI_LIMIT_REACHED")));
            return;
          }
          const aiId = uuidv4();
          const aiName = generateAIName(lobby);
          const aiPlayer: Player = {
            id: aiId,
            name: aiName,
            ready: true,
            isCreator: false,
            isAI: true,
          };
          lobby.players.push(aiPlayer);
          broadcastPlayers(metadata.lobbyId!);
          return;
        }

        case "ai_ready": {
          const lobby = findOrCreateLobby(metadata.lobbyId!);
          const creator = lobby.players.find((p) => p.id === metadata.id);
          if (!creator || !creator.isCreator) {
            ws.send(JSON.stringify(errorResponse("CREATOR_ONLY_AI_READY")));
            return;
          }
          const aiPlayer = lobby.players.find((p) => p.id === message.playerId && p.isAI);
          if (!aiPlayer) {
            ws.send(JSON.stringify(errorResponse("AI_NOT_FOUND")));
            return;
          }
          aiPlayer.ready = !aiPlayer.ready;
          broadcastPlayers(metadata.lobbyId!);
          checkStartGame(metadata.lobbyId!);
          return;
        }

        case "remove_ai": {
          const lobby = findOrCreateLobby(metadata.lobbyId!);
          const creator = lobby.players.find((p) => p.id === metadata.id);
          if (!creator || !creator.isCreator) {
            ws.send(JSON.stringify(errorResponse("CREATOR_ONLY_KICK_AI")));
            return;
          }
          if (startedLobbies.has(lobby.id)) {
            ws.send(JSON.stringify(errorResponse("GAME_ALREADY_STARTED")));
            return;
          }
          const aiIndex = lobby.players.findIndex((p) => p.id === message.playerId && p.isAI);
          if (aiIndex === -1) {
            ws.send(JSON.stringify(errorResponse("AI_NOT_FOUND")));
            return;
          }
          clearAITimeout(lobby.players[aiIndex].id);
          lobby.players.splice(aiIndex, 1);
          broadcastPlayers(metadata.lobbyId!);
          return;
        }

        case "transfer_creator": {
          const lobby = findOrCreateLobby(metadata.lobbyId!);
          const from = lobby.players.find((p) => p.id === metadata.id);
          if (!from || !from.isCreator) {
            ws.send(JSON.stringify(errorResponse("CREATOR_ONLY_TRANSFER")));
            return;
          }
          const to = lobby.players.find((p) => p.id === message.playerId);
          if (!to || to.isAI || to.disconnected) {
            ws.send(JSON.stringify(errorResponse("TARGET_INVALID")));
            return;
          }
          from.isCreator = false;
          to.isCreator = true;
          broadcastPlayers(metadata.lobbyId!);
          return;
        }

        case "set_draw_mode": {
          const lobby = lobbies.get(metadata.lobbyId!);
          if (!lobby) {
            ws.send(JSON.stringify(errorResponse("NOT_IN_LOBBY")));
            return;
          }
          const creator = lobby.players.find((p) => p.id === metadata.id);
          if (!creator || !creator.isCreator) {
            ws.send(JSON.stringify(errorResponse("CREATOR_ONLY_DRAW_MODE")));
            return;
          }
          if (lobby.game.started) {
            ws.send(JSON.stringify(errorResponse("GAME_ALREADY_STARTED")));
            return;
          }
          lobby.game.drawMode = message.mode === "direct" ? "direct" : "chain";
          broadcastPlayers(metadata.lobbyId!);
          return;
        }

        case "ready": {
          const lobby = lobbies.get(metadata.lobbyId!);
          if (!lobby) {
            ws.send(JSON.stringify(errorResponse("NOT_IN_LOBBY")));
            return;
          }
          let player = lobby.players.find((p) => p.id === metadata.id);
          if (!player) {
            player = {
              id: metadata.id,
              name: metadata.name || "Player",
              ready: false,
              isCreator: lobby.players.length === 0,
            };
            lobby.players.push(player);
          }
          const oldReady = player.ready;
          player.ready = !player.ready;
          serverLog(
            `ready TOGGLE player=${player.name} ${oldReady}>>${player.ready} lobbyId=${metadata.lobbyId?.slice(0, 8)} playerId=${metadata.id?.slice(0, 8)}`,
          );
          logState("ready", metadata, {
            player: player.name,
            ready: player.ready,
            allPlayers: lobby.players.map((p) => ({
              name: p.name,
              ready: p.ready,
              disconnected: p.disconnected,
            })),
          });
          sessions.set(player.id, {
            ...sessions.get(player.id)!,
            pendingReady: player.ready,
          });
          broadcastPlayers(metadata.lobbyId!);
          checkStartGame(metadata.lobbyId!);
          return;
        }

        case "reconnect": {
          const session = sessions.get(message.playerId!);
          logState("reconnect", metadata, {
            session: !!session,
            playerId: message.playerId?.slice(0, 8),
          });
          if (!session) {
            const newId = uuidv4();
            metadata.id = newId;
            ws.send(
              JSON.stringify({
                action: "init",
                id: newId,
                dev: isDev(),
                reconnectLost: true,
              }),
            );
            return;
          }
          const rLobby = lobbies.get(session.lobbyId);
          const lobbyAlive = rLobby && rLobby.players.length > 0;
          logState("reconnect_lobby", metadata, {
            alive: lobbyAlive,
            started: rLobby?.game?.started,
            players: rLobby?.players?.length,
          });
          if (!lobbyAlive) {
            const newId = uuidv4();
            metadata.id = newId;
            serverLog(`reconnect lobby dead, new session newId=${newId.slice(0, 8)}`);
            ws.send(
              JSON.stringify({
                action: "init",
                id: newId,
                dev: isDev(),
                reconnectLost: true,
              }),
            );
            return;
          }
          const existingPlayer = rLobby!.players.find((p) => p.id === message.playerId);
          serverLog(
            `reconnect existingPlayer=${!!existingPlayer} disconnected=${existingPlayer?.disconnected} ready=${existingPlayer?.ready}`,
          );
          if (!existingPlayer) {
            const newId = uuidv4();
            metadata.id = newId;
            ws.send(
              JSON.stringify({
                action: "init",
                id: newId,
                dev: isDev(),
                reconnectLost: true,
              }),
            );
            return;
          }
          metadata.name = session.name;
          metadata.lobbyId = session.lobbyId;
          metadata.id = message.playerId!;
          ws.send(
            JSON.stringify({
              action: "init",
              id: message.playerId,
              dev: isDev(),
            }),
          );
          const oldTimer = disconnectTimers.get(existingPlayer.id);
          if (oldTimer) clearTimeout(oldTimer);
          disconnectTimers.delete(existingPlayer.id);
          const retryTimer = reconnectTimers.get(existingPlayer.id);
          if (retryTimer) clearTimeout(retryTimer);
          reconnectTimers.delete(existingPlayer.id);
          existingPlayer.reconnectDeadline = null;
          existingPlayer.disconnected = false;
          // Cancel the all-humans-gone abort timer if this reconnect
          // restored a human to the lobby.
          const ahgT = allHumansGoneTimers.get(session.lobbyId);
          if (ahgT) {
            clearTimeout(ahgT);
            allHumansGoneTimers.delete(session.lobbyId);
          }
          const deferKey = existingPlayer.id;
          const deferTimer = deferTimers.get(deferKey);
          if (deferTimer) {
            clearTimeout(deferTimer);
            deferTimers.delete(deferKey);
          }
          const pending = sessions.get(existingPlayer.id);
          if (pending && pending.pendingReady !== undefined) {
            existingPlayer.ready = pending.pendingReady;
            serverLog(
              `reconnect restored ready=${existingPlayer.ready} for ${existingPlayer.name}`,
            );
          } else {
            serverLog(
              `reconnect NO pendingReady for ${existingPlayer.name}, current ready=${existingPlayer.ready}`,
            );
          }
          for (const [existingWs, existingMeta] of clients) {
            if (existingMeta.id === message.playerId && existingWs !== ws) {
              existingMeta.lobbyId = null;
            }
          }
          broadcastPlayers(session.lobbyId);
          if (rLobby!.game.started) {
            broadcastGameUpdate(session.lobbyId);
            const player = existingPlayer || rLobby!.players[0];
            if (player && player.hand) {
              ws.send(
                JSON.stringify({
                  action: "start",
                  id: message.playerId,
                  players: sanitizePlayersForClient(rLobby!.players),
                  discardPile: rLobby!.game.discardPile,
                  turn: rLobby!.game.turn,
                  direction: rLobby!.game.direction,
                  gameState: rLobby!.game.state,
                  drawingCount: rLobby!.game.drawingCount,
                  hand: player.hand,
                  turnDeadline: getTurnDeadline(session.lobbyId),
                  turnTimerPaused: isTurnTimerPaused(session.lobbyId),
                }),
              );
            }
          } else {
            ws.send(
              JSON.stringify({
                action: "players",
                players: rLobby!.players,
                turn: rLobby!.game.turn,
                lobbyId: session.lobbyId,
              }),
            );
          }
          return;
        }

        case "play":
          if (!lobbies.has(metadata.lobbyId || "")) {
            ws.send(JSON.stringify(errorResponse("LOBBY_NOT_FOUND")));
            return;
          }
          handlePlay(metadata.lobbyId!, metadata.id, message.card!);
          return;

        case "draw":
          if (!lobbies.has(metadata.lobbyId || "")) {
            ws.send(JSON.stringify(errorResponse("LOBBY_NOT_FOUND")));
            return;
          }
          handleDraw(metadata.lobbyId!, metadata.id);
          return;

        case "uno":
          if (!lobbies.has(metadata.lobbyId || "")) {
            ws.send(JSON.stringify(errorResponse("LOBBY_NOT_FOUND")));
            return;
          }
          handleUno(metadata.lobbyId!, metadata.id);
          return;

        case "play_multiple":
          if (!lobbies.has(metadata.lobbyId || "")) {
            ws.send(JSON.stringify(errorResponse("LOBBY_NOT_FOUND")));
            return;
          }
          handlePlayMultiple(metadata.lobbyId!, metadata.id, message.cards!);
          return;

        case "leave":
          if (metadata.isSpectator) {
            metadata.lobbyId = null;
            metadata.isSpectator = false;
            ws.send(JSON.stringify({ action: "surrendered" }));
            return;
          }
          if (!lobbies.has(metadata.lobbyId || "")) {
            ws.send(JSON.stringify(errorResponse("LOBBY_NOT_FOUND")));
            return;
          }
          handleLeave(metadata.lobbyId!, metadata.id);
          sessions.delete(metadata.id);
          metadata.lobbyId = null;
          return;

        case "surrender": {
          const sLobby = lobbies.get(metadata.lobbyId || "");
          if (!sLobby || !sLobby.game.started) return;
          const surrenderPlayer = sLobby.players.find((p) => p.id === metadata.id);
          if (!surrenderPlayer) return;

          const remaining = sLobby.players.filter((p) => p.id !== metadata.id);
          const realRemaining = remaining.filter((p) => !p.isAI);
          // No human players left → nobody won
          if (realRemaining.length === 0) {
            const lobbyId = metadata.lobbyId!;
            if (surrenderPlayer.hand) sLobby.game.discardPile.push(...surrenderPlayer.hand);
            const idx = sLobby.players.indexOf(surrenderPlayer);
            sLobby.players.splice(idx, 1);
            metadata.lobbyId = null;
            sessions.delete(surrenderPlayer.id);
            ws.send(JSON.stringify({ action: "win", winner: "" }));
            broadcastToLobby(lobbyId, { action: "win", winner: "" });
            for (const [, m] of clients) m.lobbyId === lobbyId && (m.lobbyId = null);
            sLobby.players = [];
            sLobby.game = {
              deck: [],
              discardPile: [],
              turn: 0,
              direction: 1,
              started: false,
              state: LobbyGameState.normal,
              drawingCount: 0,
              drawMode: "chain",
            };
            startedLobbies.delete(lobbyId);
            clearAllAITimeouts(lobbyId);
            resetTurnTimerState(lobbyId);
            return;
          }
          // Single opponent → standard surrender, opponent wins
          if (remaining.length <= 1) {
            const winner = remaining[0];
            if (winner) broadcastWin(metadata.lobbyId!, winner.name);
            return;
          }

          // >2 players: offer spectate
          ws.send(JSON.stringify({ action: "surrender_offer" }));
          return;
        }

        case "spectate_accept": {
          const lobby = lobbies.get(metadata.lobbyId!);
          if (!lobby || !lobby.game.started) return;
          const player = lobby.players.find((p) => p.id === metadata.id);
          if (!player) return;
          if (player.hand) lobby.game.discardPile.push(...player.hand);
          const idx = lobby.players.indexOf(player);
          if (idx === lobby.game.turn) {
            lobby.game.turn =
              (lobby.game.turn + lobby.game.direction + lobby.players.length) %
              lobby.players.length;
          }
          lobby.players.splice(idx, 1);
          if (idx < lobby.game.turn && lobby.players.length > 0) {
            lobby.game.turn = (lobby.game.turn - 1 + lobby.players.length) % lobby.players.length;
          }
          sessions.delete(metadata.id);
          metadata.isSpectator = true;
          ws.send(
            JSON.stringify({
              action: "start",
              id: metadata.id,
              players: sanitizePlayersForClient(lobby.players),
              discardPile: lobby.game.discardPile,
              turn: lobby.game.turn,
              direction: lobby.game.direction,
              hand: [],
              spectator: true,
            }),
          );
          checkGameAborted(metadata.lobbyId!, metadata.id);
          broadcastGameUpdate(metadata.lobbyId!);
          return;
        }

        case "spectate": {
          if (!isValidLobbyId(message.lobbyId)) {
            ws.send(JSON.stringify(errorResponse("NEED_LOBBY_NAME")));
            return;
          }
          if (!isValidPlayerName(message.name)) {
            ws.send(JSON.stringify(errorResponse("INVALID_PLAYER_NAME")));
            return;
          }
          // Match join's lobbyId normalization so spectators can always
          // resolve a room their friend created with mixed-case input.
          message.lobbyId = normalizeLobbyId(message.lobbyId);
          const lobby = lobbies.get(message.lobbyId!);
          if (!lobby || !lobby.game.started) {
            ws.send(JSON.stringify(errorResponse("GAME_NOT_STARTED")));
            return;
          }
          metadata.name = message.name;
          metadata.lobbyId = message.lobbyId;
          metadata.isSpectator = true;
          ws.send(
            JSON.stringify({
              action: "start",
              id: metadata.id,
              players: sanitizePlayersForClient(lobby.players),
              discardPile: lobby.game.discardPile,
              turn: lobby.game.turn,
              direction: lobby.game.direction,
              hand: [],
              spectator: true,
            }),
          );
          return;
        }

        case "reaction":
          const lobby = lobbies.get(metadata.lobbyId!);
          if (!lobby || !lobby.game.started) break;
          // Validate content for both emoji and text the same way: must be a
          // bounded string. The emoji path used to accept arbitrary types and
          // unlimited length, which let a malicious client broadcast an
          // unbounded payload to every player in the room.
          if (typeof message.content !== "string" || message.content.length === 0) break;
          if (message.content.length > REACTION_CONTENT_MAX) break;
          if (message.type === "emoji") {
            broadcastToLobby(metadata.lobbyId!, {
              action: "reaction",
              playerId: metadata.id,
              type: "emoji",
              content: message.content,
            });
          } else if (message.type === "text") {
            let width = 0;
            for (const ch of message.content) {
              if (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch)) width += 1;
              else width += 0.3;
            }
            if (width > 64) break;
            broadcastToLobby(metadata.lobbyId!, {
              action: "reaction",
              playerId: metadata.id,
              type: "text",
              content: message.content,
            });
          }
          break;

        default:
          serverWarn("unhandled event", message);
          return;
      }
    } else {
      if (!isDev()) {
        serverWarn("cannot handle dev event", message);
        return;
      }

      switch (message.action) {
        case "dev_call_win":
          const lobby1 = findOrCreateLobby(metadata.lobbyId!);
          const player1 = lobby1.players.find((p) => p.id === metadata.id);
          if (!player1) {
            ws.send(JSON.stringify(errorResponse("PLAYER_NOT_FOUND")));
            return;
          }
          broadcastWin(metadata.lobbyId!, player1.name);
          return;
        case "dev_add_cards": {
          const lobby2 = findOrCreateLobby(metadata.lobbyId!);
          if (!lobby2.game.started) {
            ws.send(JSON.stringify(errorResponse("GAME_NOT_STARTED")));
            return;
          }
          const player2 = lobby2.players.find((p) => p.id === metadata.id);
          if (!player2) {
            ws.send(JSON.stringify(errorResponse("PLAYER_NOT_FOUND")));
            return;
          }
          const count = Math.min(message.count || 1, 20);
          let drawn = lobby2.game.deck.splice(0, count);
          if (drawn.length < count && lobby2.game.discardPile.length >= 2) {
            const topCard = lobby2.game.discardPile.pop()!;
            lobby2.game.deck = lobby2.game.discardPile;
            lobby2.game.discardPile = [topCard];
            shuffleDeck(metadata.lobbyId!);
            const more = lobby2.game.deck.splice(0, count - drawn.length);
            drawn = [...drawn, ...more];
          }
          player2.hand!.push(...drawn);
          broadcastGameUpdate(metadata.lobbyId!);
          return;
        }
        case "dev_add_all_cards": {
          const lobby2 = findOrCreateLobby(metadata.lobbyId!);
          if (!lobby2.game.started) {
            ws.send(JSON.stringify(errorResponse("GAME_NOT_STARTED")));
            return;
          }
          const player2 = lobby2.players.find((p) => p.id === metadata.id);
          if (!player2) {
            ws.send(JSON.stringify(errorResponse("PLAYER_NOT_FOUND")));
            return;
          }
          let drawn = lobby2.game.deck.splice(0, lobby2.game.deck.length);
          if (drawn.length === 0 && lobby2.game.discardPile.length >= 2) {
            const topCard = lobby2.game.discardPile.pop()!;
            lobby2.game.deck = lobby2.game.discardPile;
            lobby2.game.discardPile = [topCard];
            shuffleDeck(metadata.lobbyId!);
            drawn = lobby2.game.deck.splice(0, lobby2.game.deck.length);
          }
          player2.hand!.push(...drawn);
          broadcastGameUpdate(metadata.lobbyId!);
          return;
        }
        case "dev_remove_cards": {
          const lobby3 = findOrCreateLobby(metadata.lobbyId!);
          if (!lobby3.game.started) {
            ws.send(JSON.stringify(errorResponse("GAME_NOT_STARTED")));
            return;
          }
          const player3 = lobby3.players.find((p) => p.id === metadata.id);
          if (!player3) {
            ws.send(JSON.stringify(errorResponse("PLAYER_NOT_FOUND")));
            return;
          }
          const removeCount = Math.min(message.count || 1, player3.hand!.length);
          player3.hand!.splice(0, removeCount);
          if (player3.hand!.length === 0) {
            broadcastWin(metadata.lobbyId!, player3.name);
          } else {
            broadcastGameUpdate(metadata.lobbyId!);
          }
          return;
        }
        case "dev_skip": {
          const lobby4 = findOrCreateLobby(metadata.lobbyId!);
          if (!lobby4.game.started) {
            ws.send(JSON.stringify(errorResponse("GAME_NOT_STARTED")));
            return;
          }
          lobby4.game.turn =
            (lobby4.game.turn + lobby4.game.direction + lobby4.players.length) %
            lobby4.players.length;
          broadcastGameUpdate(metadata.lobbyId!);
          return;
        }
        case "dev_give_card": {
          // Inject a specific card into the caller's hand. Used by tests that
          // need to stage a particular game state (e.g. force a draw2 to be
          // playable). Production deployments don't expose dev_* events.
          const lobby = findOrCreateLobby(metadata.lobbyId!);
          if (!lobby.game.started) {
            ws.send(JSON.stringify(errorResponse("GAME_NOT_STARTED")));
            return;
          }
          const player = lobby.players.find((p) => p.id === metadata.id);
          if (!player) {
            ws.send(JSON.stringify(errorResponse("PLAYER_NOT_FOUND")));
            return;
          }
          if (!message.card || typeof message.card.type !== "string") return;
          player.hand!.push({ ...message.card });
          broadcastGameUpdate(metadata.lobbyId!);
          return;
        }
        case "dev_set_top": {
          // Stage the discard pile with a specific top card so tests/dev can
          // exercise edge cases (e.g. broken-chain tests). The card is pushed
          // on top; the server treats the latest discard as authoritative for
          // matching, so this is sufficient. No turn change.
          const lobby = findOrCreateLobby(metadata.lobbyId!);
          if (!lobby.game.started) {
            ws.send(JSON.stringify(errorResponse("GAME_NOT_STARTED")));
            return;
          }
          if (!message.card || typeof message.card.type !== "string") return;
          lobby.game.discardPile.push({ ...message.card });
          broadcastGameUpdate(metadata.lobbyId!);
          return;
        }
        case "dev_set_chain": {
          // Force the lobby into chain-drawing state with a given pending
          // penalty. Lets tests assert what happens when a player breaks an
          // existing chain.
          const lobby = findOrCreateLobby(metadata.lobbyId!);
          if (!lobby.game.started) {
            ws.send(JSON.stringify(errorResponse("GAME_NOT_STARTED")));
            return;
          }
          const count = Math.max(0, Math.min(message.count || 0, 1000));
          if (count > 0) {
            lobby.game.state = LobbyGameState.drawing;
            lobby.game.drawingCount = count;
          } else {
            lobby.game.state = LobbyGameState.normal;
            lobby.game.drawingCount = 0;
          }
          broadcastGameUpdate(metadata.lobbyId!);
          return;
        }
        case "dev_clear_hand": {
          const lobby = findOrCreateLobby(metadata.lobbyId!);
          if (!lobby.game.started) {
            ws.send(JSON.stringify(errorResponse("GAME_NOT_STARTED")));
            return;
          }
          const player = lobby.players.find((p) => p.id === metadata.id);
          if (!player) {
            ws.send(JSON.stringify(errorResponse("PLAYER_NOT_FOUND")));
            return;
          }
          player.hand = [];
          broadcastGameUpdate(metadata.lobbyId!);
          return;
        }
        case "dev_export_state": {
          logState("export", metadata);
          ws.send(JSON.stringify({ action: "dev_state_export", log: stateLog }));
          return;
        }
        case "dev_toggle_turn_timer": {
          // Toggle pause/resume the active turn timer for this lobby.
          // Pausing freezes the deadline so the player isn't auto-drawn
          // while we're poking at game state during dev / debugging;
          // resuming re-arms the timer with the wall-clock time that
          // was remaining at pause. Production builds disable the dev_*
          // dispatcher entirely, so this can never run in prod.
          const lobby = lobbies.get(metadata.lobbyId!);
          if (!lobby) {
            ws.send(JSON.stringify(errorResponse("NOT_IN_LOBBY")));
            return;
          }
          if (!lobby.game.started) {
            ws.send(JSON.stringify(errorResponse("GAME_NOT_STARTED")));
            return;
          }
          const t = turnTimers.get(metadata.lobbyId!);
          if (!t) {
            // Nothing to pause — likely an AI turn or no active timer.
            return;
          }
          if (t.paused) {
            // Resume: rebuild deadline + setTimeout.
            const remaining = Math.max(0, t.remainingMs || 0);
            const newToken = (turnTokens.get(metadata.lobbyId!) || 0) + 1;
            turnTokens.set(metadata.lobbyId!, newToken);
            const playerId = t.turnPlayerId;
            const lobbyId = metadata.lobbyId!;
            const timer = setTimeout(() => {
              if (turnTokens.get(lobbyId) !== newToken) return;
              turnTimers.delete(lobbyId);
              onTurnTimeout(lobbyId, playerId);
            }, remaining);
            t.timer = timer;
            t.token = newToken;
            t.deadline = Date.now() + remaining;
            t.paused = false;
            t.remainingMs = undefined;
            serverLog(
              `dev_toggle_turn_timer RESUME lobby=${lobbyId.slice(0, 8)} remaining=${remaining}ms`,
            );
          } else {
            // Pause: clear the timer + remember remaining time.
            const remaining = Math.max(0, t.deadline - Date.now());
            clearTimeout(t.timer);
            t.paused = true;
            t.remainingMs = remaining;
            // Bump the token so any in-flight stale fire is invalidated.
            const newToken = (turnTokens.get(metadata.lobbyId!) || 0) + 1;
            turnTokens.set(metadata.lobbyId!, newToken);
            t.token = newToken;
            serverLog(
              `dev_toggle_turn_timer PAUSE lobby=${metadata.lobbyId!.slice(0, 8)} remaining=${remaining}ms`,
            );
          }
          // Broadcast updated turn state so all clients reflect the
          // pause/resume in their countdown UIs.
          broadcastGameUpdate(metadata.lobbyId!);
          return;
        }
        default:
          serverWarn("unhandled dev event", message);
      }
    }
  });

  ws.on("close", () => {
    const metadata = clients.get(ws);
    logState("close", metadata);
    if (metadata && metadata.lobbyId) {
      const player = lobbies.get(metadata.lobbyId)?.players.find((p) => p.id === metadata.id);
      if (player) player.disconnected = true;
      scheduleProcessClose(metadata.id, ws, metadata);
    }
    clients.delete(ws);
  });
});

function scheduleProcessClose(playerId: string, ws: WebSocket, metadata: ClientMetadata): void {
  const deferKey = playerId || (metadata && metadata.lobbyId!);
  if (!deferKey) return processClose(ws, metadata);
  const existing = deferTimers.get(deferKey);
  if (existing) clearTimeout(existing);
  const deferTimer = setTimeout(() => {
    deferTimers.delete(deferKey);
    processClose(ws, metadata);
  }, RECONNECT_DEFER_MS);
  deferTimers.set(deferKey, deferTimer);
}

function processClose(_ws: WebSocket, metadata: ClientMetadata): void {
  const lobby = lobbies.get(metadata.lobbyId!);
  if (!lobby) return;
  const player = lobby.players.find((p) => p.id === metadata.id);
  if (!player) return;
  player.disconnected = true;
  player.reconnectDeadline = Date.now() + RECONNECT_DEADLINE_MS;
  broadcastPlayers(metadata.lobbyId!);
  if (lobby.game.started) {
    broadcastGameUpdate(metadata.lobbyId!);
  }

  // If the LAST real player just disconnected, the lobby is now AI-only
  // (or empty). Without intervention the disconnect timer waits a full
  // RECONNECT_DEADLINE_MS (15s) before tearing down — which leaves the
  // lobby running with only AI players and no human supervisor.
  // Schedule a SHORT abort timer here that fires unless the human
  // reconnects in the next few seconds. This is shorter than the
  // normal disconnect window because nobody else needs to reconnect —
  // either the same human refreshes back in, or the game is over.
  if (lobby.game.started) {
    const realActive = lobby.players.filter((p) => !p.isAI && !p.disconnected);
    if (realActive.length === 0) {
      // Window: long enough for a page refresh to complete the WS
      // handshake and `reconnect` send (~1-2s usual), short enough
      // that an AI-only lobby doesn't run amok.
      const ALL_HUMANS_GONE_GRACE_MS = 4000;
      const lobbyId = metadata.lobbyId!;
      const prevAbort = allHumansGoneTimers.get(lobbyId);
      if (prevAbort) clearTimeout(prevAbort);
      const abortTimer = setTimeout(() => {
        allHumansGoneTimers.delete(lobbyId);
        // Re-check: maybe somebody reconnected in the grace window.
        const lobbyNow = lobbies.get(lobbyId);
        if (!lobbyNow || !lobbyNow.game.started) return;
        const stillNoHumans =
          lobbyNow.players.filter((p) => !p.isAI && !p.disconnected).length === 0;
        if (stillNoHumans) {
          serverLog(`all-humans-gone abort fires in ${lobbyId.slice(0, 8)}`);
          broadcastGameAborted(lobbyId, "");
        }
      }, ALL_HUMANS_GONE_GRACE_MS);
      allHumansGoneTimers.set(lobbyId, abortTimer);
    }
  }

  const reconnectTimer = setTimeout(() => {
    reconnectTimers.delete(player.id);
    if (!player.disconnected) return;
    if (lobby.game.started && lobby.game.turn === lobby.players.indexOf(player)) {
      lobby.game.turn =
        (lobby.game.turn + lobby.game.direction + lobby.players.length) % lobby.players.length;
      broadcastGameUpdate(metadata.lobbyId!);
    }
    const oldTimer = disconnectTimers.get(player.id);
    if (oldTimer) clearTimeout(oldTimer);
    disconnectTimers.delete(player.id);
    const idx = lobby.players.findIndex((p) => p.id === player.id);
    if (idx > -1) {
      const removed = lobby.players.splice(idx, 1)[0];
      if (removed.isCreator && lobby.players.length > 0) {
        lobby.players[0].isCreator = true;
      }
      sessions.delete(player.id);
      checkGameAborted(metadata.lobbyId!, metadata.id);
      broadcastPlayers(metadata.lobbyId!);
      if (lobby.players.length === 0) lobbies.delete(metadata.lobbyId!);
    }
  }, RECONNECT_DEADLINE_MS);
  reconnectTimers.set(player.id, reconnectTimer);
  const timer = setTimeout(() => {
    disconnectTimers.delete(player.id);
    const idx = lobby.players.findIndex((p) => p.id === player.id);
    if (idx > -1 && lobby.players[idx].disconnected) {
      const removed = lobby.players.splice(idx, 1)[0];
      if (removed.isCreator && !lobby.game.started) {
        const removedAIs = lobby.players.filter((p) => p.isAI);
        lobby.players = lobby.players.filter((p) => !p.isAI);
        for (const ai of removedAIs) clearAITimeout(ai.id);
        if (lobby.players.length > 0) lobby.players[0].isCreator = true;
      }
      sessions.delete(player.id);
      checkGameAborted(metadata.lobbyId!, metadata.id);
      broadcastPlayers(metadata.lobbyId!);
      if (lobby.game.started) {
        broadcastGameUpdate(metadata.lobbyId!);
      }
      if (lobby.players.length === 0) lobbies.delete(metadata.lobbyId!);
    }
  }, DISCONNECT_REMOVE_MS);
  disconnectTimers.set(player.id, timer);
}

function handleLeave(lobbyId: string, playerId: string): void {
  const lobby = lobbies.get(lobbyId);
  if (!lobby) return;

  const playerIndex = lobby.players.findIndex((p) => p.id === playerId);
  if (playerIndex > -1) {
    const player = lobby.players[playerIndex];
    // If game started, put hand cards on discard pile
    if (lobby.game.started && player.hand) {
      lobby.game.discardPile.push(...player.hand);
    }
    // If it was this player's turn, advance
    if (playerIndex === lobby.game.turn) {
      lobby.game.turn =
        (lobby.game.turn + lobby.game.direction + lobby.players.length) % lobby.players.length;
    }
    lobby.players.splice(playerIndex, 1);
    // Adjust turn if removed before current
    if (playerIndex < lobby.game.turn && lobby.players.length > 0) {
      lobby.game.turn = (lobby.game.turn - 1 + lobby.players.length) % lobby.players.length;
    }

    if (player.isCreator && !lobby.game.started) {
      const removedAIs = lobby.players.filter((p) => p.isAI);
      lobby.players = lobby.players.filter((p) => !p.isAI);
      for (const ai of removedAIs) clearAITimeout(ai.id);
      if (lobby.players.length > 0) {
        lobby.players[0].isCreator = true;
      }
    } else if (player.isCreator) {
      if (lobby.players.length > 0) lobby.players[0].isCreator = true;
    }

    checkGameAborted(lobbyId, playerId);

    // After a player leaves, the active turn may have moved to a new
    // player — re-schedule the turn timer so they get the full window.
    if (lobby.game.started) {
      scheduleTurnTimeout(lobbyId);
    }

    broadcastToLobby(
      lobbyId,
      {
        action: "players",
        players: lobby.players,
        turn: lobby.game.turn,
        lobbyId: lobbyId,
        turnDeadline: lobby.game.started ? getTurnDeadline(lobbyId) : null,
        turnTimerPaused: lobby.game.started ? isTurnTimerPaused(lobbyId) : false,
      },
      playerId,
    );

    checkStartGame(lobbyId);
    serverLog(`player leaved from ${lobby.id} :`, player);

    if (lobby.players.length === 0) {
      resetTurnTimerState(lobbyId);
      lobbies.delete(lobbyId);
    }
  }
}

function hasFlagExitImmediately(): boolean {
  return process.argv.includes("--exit-immediately") || process.argv.includes("-e");
}

function isDev(): boolean {
  return process.env.NODE_ENV === "development";
}

function getPort(): number {
  const idx = process.argv.indexOf("--port");
  if (idx !== -1 && process.argv[idx + 1]) {
    const port = parseInt(process.argv[idx + 1], 10);
    if (port > 0 && port < 65536) return port;
  }
  return 3000;
}

const PORT = getPort();

console.log(`UNO Server v${VERSION}`);
console.log(`Copyright (C) 2026 miruku (lovemilk)`);
console.log();

process.on("SIGINT", () => {
  process.stdout.write("\nServer closed");
  if (!!process.stdin && !hasFlagExitImmediately() && !isDev()) {
    console.log(", press any key to close this window...");
    try {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on("data", () => process.exit(0));
    } catch (e) {
      console.warn("cannot wait for any key");
      console.error(e);
      process.exit(0);
    }
  } else {
    console.log();
    process.exit(0);
  }
});

httpServer.on("listening", () => serverLog(`Server started on port http://0.0.0.0:${PORT}\n`));
httpServer.on("error", (e: Error) => {
  console.error(e);
  process.emit("SIGINT");
});
httpServer.listen(PORT);
