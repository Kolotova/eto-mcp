import { pathToFileURL } from "node:url";

import { mockSearchTours } from "../../src/mockSearch.js";
import { searchToursInputSchema } from "../../src/schemas.js";

export type EventInput =
  | { type: "text"; text: string }
  | { type: "callback"; data: string }
  | { type: "callback_label"; label: string; index?: number };

export type CapturedCall = {
  method: string;
  payload: Record<string, unknown>;
  normalized: {
    method: string;
    text?: string;
    caption?: string;
    keyboard?: Array<Array<{ text: string; callback_data?: string }>>;
    callbackData?: string;
    chatAction?: string;
  };
};

export type ConversationResult = {
  calls: CapturedCall[];
  messages: string[];
  finalState: unknown;
};

type BotTestModule = {
  bot: {
    handleUpdate: (update: unknown) => Promise<void>;
    telegram: {
      callApi: (method: string, payload: Record<string, unknown>) => Promise<unknown>;
    };
  };
  __test: {
    resetAll: () => void;
    setSearchOverride: (fn?: (args: Record<string, unknown>) => Promise<any>) => void;
    getChatState: (chatId: number) => unknown;
  };
};

let cachedModulePromise: Promise<BotTestModule> | undefined;

async function importBotTestModule(): Promise<BotTestModule> {
  if (!cachedModulePromise) {
    process.env.BOT_TEST_MODE = "1";
    process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "TEST_BOT_TOKEN";
    process.env.API_KEY = process.env.API_KEY ?? "devkey";
    process.env.DATA_PROVIDER = "mock";
    process.env.LLM_PROVIDER = process.env.LLM_PROVIDER ?? "mock";
    process.env.FORCE_LLM_ACTIVE = "1";
    const modUrl = pathToFileURL(`${process.cwd()}/src/bot.ts`).href;
    cachedModulePromise = import(modUrl) as Promise<BotTestModule>;
  }
  return cachedModulePromise;
}

function normalizeKeyboard(replyMarkup: any): Array<Array<{ text: string; callback_data?: string }>> | undefined {
  const inline = replyMarkup?.inline_keyboard;
  if (!Array.isArray(inline)) return undefined;
  return inline.map((row: any[]) =>
    row.map((btn) => ({
      text: String(btn?.text ?? ""),
      callback_data: typeof btn?.callback_data === "string" ? btn.callback_data : undefined
    }))
  );
}

function normalizeCall(method: string, payload: Record<string, unknown>): CapturedCall["normalized"] {
  const normalized: CapturedCall["normalized"] = { method };
  if (method === "sendMessage") {
    normalized.text = String(payload.text ?? "");
    normalized.keyboard = normalizeKeyboard(payload.reply_markup);
  } else if (method === "sendPhoto") {
    normalized.caption = String(payload.caption ?? "");
    normalized.keyboard = normalizeKeyboard(payload.reply_markup);
  } else if (method === "answerCallbackQuery") {
    normalized.callbackData = String(payload.callback_query_id ?? "");
    if (typeof payload.text === "string") normalized.text = payload.text;
  } else if (method === "sendChatAction") {
    normalized.chatAction = String(payload.action ?? "");
  }
  return normalized;
}

function messageUpdate(chatId: number, userId: number, text: string, updateId: number): any {
  const entities = text.startsWith("/") ? [{ type: "bot_command", offset: 0, length: text.split(" ")[0].length }] : undefined;
  return {
    update_id: updateId,
    message: {
      message_id: updateId * 10,
      date: 1_700_000_000 + updateId,
      text,
      entities,
      chat: { id: chatId, type: "private" },
      from: { id: userId, is_bot: false, first_name: "Test" }
    }
  };
}

function callbackUpdate(chatId: number, userId: number, data: string, updateId: number): any {
  return {
    update_id: updateId,
    callback_query: {
      id: `cbq-${updateId}`,
      from: { id: userId, is_bot: false, first_name: "Test" },
      chat_instance: `ci-${chatId}`,
      data,
      message: {
        message_id: updateId * 10,
        date: 1_700_000_000 + updateId,
        chat: { id: chatId, type: "private" }
      }
    }
  };
}

function findCallbackByLabel(calls: CapturedCall[], label: string, index = 0): string {
  const matches: string[] = [];
  for (const call of calls) {
    const keyboard = call.normalized.keyboard;
    if (!keyboard) continue;
    for (const row of keyboard) {
      for (const btn of row) {
        if (btn.text === label && btn.callback_data) {
          matches.push(btn.callback_data);
        }
      }
    }
  }
  const picked = matches[index];
  if (!picked) {
    throw new Error(`Callback label not found: ${label} [index=${index}]`);
  }
  return picked;
}

export async function runConversation(
  events: EventInput[],
  opts?: { chatId?: number; userId?: number; forceLLMActive?: boolean }
): Promise<ConversationResult> {
  const chatId = opts?.chatId ?? 1001;
  const userId = opts?.userId ?? 2001;
  const mod = await importBotTestModule();
  const prevForceLLM = process.env.FORCE_LLM_ACTIVE;
  process.env.FORCE_LLM_ACTIVE = opts?.forceLLMActive === false ? "0" : "1";

  mod.__test.resetAll();
  mod.__test.setSearchOverride(async (args) => {
    const parsed = searchToursInputSchema.parse(args);
    return (await mockSearchTours(parsed as any)) as any;
  });

  const calls: CapturedCall[] = [];
  let sentMessageId = 1;
  const telegramProto = Object.getPrototypeOf(mod.bot.telegram) as { callApi: (method: string, payload: Record<string, unknown>) => Promise<unknown> };
  const originalCallApi = telegramProto.callApi;
  telegramProto.callApi = async function (method: string, payload: Record<string, unknown>) {
    const call: CapturedCall = {
      method,
      payload,
      normalized: normalizeCall(method, payload)
    };
    calls.push(call);

    if (method === "getMe") {
      return {
        id: 999001,
        is_bot: true,
        first_name: "TriplyTest",
        username: "triply_test_bot"
      };
    }
    if (method === "getWebhookInfo") {
      return { url: "", pending_update_count: 0 };
    }
    if (method === "deleteWebhook") {
      return true;
    }
    if (method === "sendMessage" || method === "sendPhoto") {
      return {
        ok: true,
        message_id: sentMessageId++,
        chat: { id: chatId, type: "private" }
      };
    }
    if (method === "answerCallbackQuery" || method === "sendChatAction") {
      return true;
    }
    return { ok: true, result: true };
  };

  try {
    let updateId = 1;
    for (const event of events) {
      if (event.type === "text") {
        await mod.bot.handleUpdate(messageUpdate(chatId, userId, event.text, updateId++));
        continue;
      }

      const data = event.type === "callback"
        ? event.data
        : findCallbackByLabel(calls, event.label, event.index ?? 0);
      await mod.bot.handleUpdate(callbackUpdate(chatId, userId, data, updateId++));
    }
  } finally {
    telegramProto.callApi = originalCallApi;
    process.env.FORCE_LLM_ACTIVE = prevForceLLM;
  }

  return {
    calls,
    messages: calls
      .filter((c) => c.method === "sendMessage" || c.method === "sendPhoto")
      .map((c) => c.normalized.text ?? c.normalized.caption ?? ""),
    finalState: mod.__test.getChatState(chatId)
  };
}

export function summarizeConversation(result: ConversationResult): unknown {
  return {
    messages: result.messages,
    calls: result.calls.map((c) => c.normalized),
    finalState: result.finalState
  };
}
