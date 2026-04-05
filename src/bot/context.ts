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
  /**
   * Chat mode discriminator to avoid state ambiguity.
   * 'payment' = admin↔client chat about a payment proof
   * 'extension' = admin↔client chat about a rental extension
   */
  chatMode?: 'payment' | 'extension';
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
  /** tracked cashier payment message IDs (individual cards) */
  cashierMsgIds?: number[];
  /** ID чека, для которого ожидается ввод причины отклонения */
  rejectProofId?: number;
  /** ID аренды, для которой админ пишет сообщение клиенту */
  boardMsgRentalId?: number;
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
