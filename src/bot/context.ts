import { Context, SessionFlavor } from "grammy";
import { Role } from "@prisma/client";

export interface SessionData {
  /** internal user id from DB */
  userId?: number;
  role?: Role;
  spotId?: number;
  /** walk-in rental flow state */
  walkin?: {
    boardId?: number;
    tariffId?: number;
  };
  /** client waiting to type board code */
  waitingBoardCode?: boolean;
  /** admin waiting to send MBank QR photo */
  waitingMBankQR?: boolean;
  /** admin↔client chat: admin writing to a client about a proof */
  chatWithClientTgId?: number;
  chatProofId?: number;
  /** admin↔client chat about rental extension */
  chatRentalId?: number;
  /** client replying to admin about a proof */
  chatWithAdminTgId?: number;
  chatReplyProofId?: number;
  /** client replying to admin about extension */
  chatReplyRentalId?: number;
  /** tracked bot message IDs for auto-cleanup */
  lastBotMsgIds?: number[];
}

export type BotContext = Context &
  SessionFlavor<SessionData> & {
    /** populated by auth middleware */
    dbUser?: {
      id: number;
      tgId: bigint;
      role: Role;
      name: string;
      phone: string | null;
      spotId: number | null;
    };
  };
