export interface Card {
  color?: string;
  type: string;
}

export interface Player {
  id: string;
  name: string;
  hand?: Card[];
  isAI?: boolean;
  disconnected?: boolean;
}
export interface Lobby {
  players: Player[];
  game: {
    turn: number;
    discardPile: Card[];
  };
}

export type AIMove =
  | { type: "play"; card: Card }
  | { type: "play_multiple"; cards: Card[] }
  | { type: "draw" };

function chooseBestColor(hand: Card[]): string {
  const counts: Record<string, number> = { red: 0, yellow: 0, green: 0, blue: 0 };
  for (const card of hand) {
    if (card.color && counts[card.color] !== undefined) {
      counts[card.color]++;
    }
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}

export function decideMove(lobby: Lobby): AIMove {
  const player = lobby.players[lobby.game.turn];
  const hand = player.hand;
  if (!hand) return { type: "draw" };
  const topCard = lobby.game.discardPile[lobby.game.discardPile.length - 1];

  const playable = hand.filter(
    (c) =>
      c.type !== "wild" &&
      c.type !== "wild4" &&
      (c.color === topCard.color || c.type === topCard.type),
  );

  if (playable.length > 0) {
    const byType: Record<string, Card[]> = {};
    for (const card of playable) {
      if (!byType[card.type]) byType[card.type] = [];
      byType[card.type].push(card);
    }

    const entries = Object.entries(byType);
    entries.sort((a, b) => {
      const aHasColor = a[1].some((c) => c.color === topCard.color) ? 1 : 0;
      const bHasColor = b[1].some((c) => c.color === topCard.color) ? 1 : 0;
      if (aHasColor !== bHasColor) return bHasColor - aHasColor;
      return b[1].length - a[1].length;
    });

    const cardsToPlay = entries[0][1];
    if (cardsToPlay.length > 1) {
      return { type: "play_multiple", cards: cardsToPlay };
    }
    return { type: "play", card: { ...cardsToPlay[0] } };
  }

  const wilds = hand.filter((c) => c.type === "wild" || c.type === "wild4");
  if (wilds.length > 0) {
    const wild = wilds.find((c) => c.type === "wild") || wilds[0];
    const color = chooseBestColor(hand);
    return { type: "play", card: { ...wild, color } };
  }

  return { type: "draw" };
}
