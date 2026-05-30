export interface ErrorDef {
  message: string;
  needRefresh?: boolean;
}

export const ERR: Record<string, ErrorDef> = {
  NOT_IN_LOBBY: { message: "未加入大厅" },
  LOBBY_NOT_FOUND: { message: "游戏房间已不存在，请刷新页面", needRefresh: true },
  PLAYER_NOT_FOUND: { message: "玩家ID未找到" },
  GAME_NOT_STARTED: { message: "对局未开始" },
  GAME_ALREADY_STARTED: { message: "对局已开始" },
  CREATOR_ONLY: { message: "只有房主可以邀请 AI" },
  CREATOR_ONLY_AI_READY: { message: "只有房主可以准备 AI" },
  CREATOR_ONLY_KICK_AI: { message: "只有房主可以踢出 AI" },
  CREATOR_ONLY_TRANSFER: { message: "只有房主可以转让" },
  CREATOR_ONLY_DRAW_MODE: { message: "只有房主可以修改加牌模式" },
  AI_NOT_FOUND: { message: "AI 玩家未找到" },
  AI_LIMIT_REACHED: { message: "AI 玩家数量已达上限" },
  TARGET_INVALID: { message: "目标玩家无效" },
  NEED_LOBBY_NAME: { message: "请提供大厅名称" },
  LOBBY_STARTED_JOIN: { message: "大厅已开始对局, 请使用其他名称" },
  NAME_DUPLICATE: { message: "该大厅中已存在同名玩家，请选择其他名称", needRefresh: false },
  INVALID_PLAYER_NAME: { message: "玩家名称无效", needRefresh: false },
} as const;

export type ErrorCode = keyof typeof ERR;

export function errorResponse(code: ErrorCode): { action: string; errorKey: ErrorCode } {
  return { action: "error", errorKey: code };
}
