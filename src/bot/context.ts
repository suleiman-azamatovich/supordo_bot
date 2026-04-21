import { Context, SessionFlavor } from "grammy";
import { Role } from "@prisma/client";

/** Состояние чата админа с клиентом (discriminated union) */
export type AdminChatState =
  | { mode: 'payment'; clientTgId: number; proofId: number }
  | { mode: 'extension'; clientTgId: number; rentalId: number }
  | undefined;

/** Состояние чата клиента с админом (discriminated union) */
export type ClientChatState =
  | { mode: 'payment'; proofId: number }
  | { mode: 'extension'; rentalId: number }
  | undefined;

/** Режим ввода текста — определяет, как обрабатывать message:text */
export type InputMode =
  | 'walkin_name'         // Ожидание имени клиента для walk-in
  | 'board_code'          // Ожидание ввода кода доски
  | 'mbank_qr'            // Ожидание фото MBank QR
  | 'board_msg'           // Ожидание сообщения клиенту доски
  | 'reject_reason'       // Ожидание причины отклонения
  | 'tariff_text'         // Тариф: ввод кастомного значения (имя/длительность/цена)
  | 'rental_discount_pct' // Скидка на аренду: ввод процента вручную
  | 'rental_discount_amt' // Скидка на аренду: ввод суммы в сомах
  | undefined;

/** Черновик создания/редактирования тарифа — управляется кнопочным пикером */
export interface TariffDraft {
  mode: 'create' | 'edit';
  spotId: number;
  tariffId?: number;
  /** рабочие значения пикера */
  name?: string;
  durationMinutes?: number;
  price?: number;
  /** акционная цена (null = убрать акцию) */
  promoPrice?: number | null;
  /** поле, для которого ожидается кастомный текстовый ввод */
  pendingField?: 'name' | 'duration' | 'price' | 'promo';
}

/** Черновик скидки на конкретную аренду (для multi-step ввода в разделе «Доски») */
export interface RentalDiscountDraft {
  rentalId: number;
}

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

  /** Режим ввода текста (вместо множества boolean-флагов) */
  inputMode?: InputMode;

  /** Чат админа с клиентом (discriminated union по mode) */
  adminChat?: AdminChatState;

  /** Чат клиента с админом (discriminated union по mode) */
  clientChat?: ClientChatState;

  /** tracked bot message IDs for auto-cleanup */
  lastBotMsgIds?: number[];
  /** tracked cashier payment message IDs (individual cards) */
  cashierMsgIds?: number[];

  /** ID чека, для которого ожидается ввод причины отклонения */
  rejectProofId?: number;
  /** ID аренды, для которой админ пишет сообщение клиенту */
  boardMsgRentalId?: number;

  /** Черновик тарифа при создании/редактировании админом */
  tariffDraft?: TariffDraft;

  /** Черновик скидки на аренду (из раздела «Доски») */
  rentalDiscountDraft?: RentalDiscountDraft;
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
      discountPercent: number;
    };
  };
