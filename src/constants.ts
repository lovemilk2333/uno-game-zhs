// Reconnect / disconnect timing (milliseconds)
export const RECONNECT_DEFER_MS = 500;
export const RECONNECT_DEADLINE_MS = 15000;
export const DISCONNECT_REMOVE_MS = 15000;

// Game limits
export const MAX_HAND_CARDS = 100;

export const NAME_LENGTH_MIN = 2;
export const NAME_LENGTH_MAX = 32;

// Lobby identifier limits — kept generous so existing IDs keep working,
// but bounded so a malicious client cannot pin arbitrary-sized strings as
// Map keys.
export const LOBBY_ID_LENGTH_MIN = 1;
export const LOBBY_ID_LENGTH_MAX = 64;

// Per-lobby AI cap. Each AI runs a setTimeout/decideMove cycle and is
// echoed in every players broadcast, so the count needs an upper bound.
export const MAX_AI_PER_LOBBY = 7;

// Reaction (emoji / text) content cap measured in code units.
export const REACTION_CONTENT_MAX = 256;

// WebSocket payload cap. Real game messages stay under a few hundred bytes;
// anything materially larger is either a bug or an abuse attempt.
export const WS_MAX_PAYLOAD = 64 * 1024;

// Per-connection malformed-message limit before the socket is closed.
export const MAX_PARSE_ERRORS_PER_CONN = 20;

// Per-turn play timeout (milliseconds). If a player does not act within this
// window, the server auto-draws a card on their behalf and advances the turn.
// Browsers heavily throttle setTimeout/setInterval in background tabs, so the
// authoritative timer must live on the server (Node) — clients only display
// the countdown using Date.now() diffs against an absolute deadline.
export const PLAY_TIMEOUT_MS = 30000;

// Grace period added to the server-side timeout before kicking in. The client
// also gets a small grace, so a slow message-rtt does not cause a kick at the
// same instant the user clicked. Total user-visible window = PLAY_TIMEOUT_MS;
// server uses PLAY_TIMEOUT_MS + grace to account for clock skew / rtt.
export const PLAY_TIMEOUT_GRACE_MS = 1500;
