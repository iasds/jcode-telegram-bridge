import type { JcodeClient } from "@1jehuang/jcode-sdk";
import type { Context, Telegraf } from "telegraf";
import { formatMessage, escapeMdv2 } from "./markdown.js";

/**
 * Interactive /model picker, ported 1:1 from hermes-agent's
 * send_model_picker / _handle_model_picker_callback (Python telegram-bot ->
 * telegraf). Two-step drill-down: provider -> model, paginated inline
 * keyboards, ✓ current markers, ◀ Back / ✗ Cancel, in-place edits.
 */

const PROVIDER_PAGE_SIZE = 10;
const MODEL_PAGE_SIZE = 8;

export interface ProviderInfo {
  name: string;
  models: string[];
  isCurrent: boolean;
}

interface PickerState {
  chatId: number;
  msgId: number;
  sessionId: string;
  providers: ProviderInfo[];
  selectedProvider?: string;
  modelList: string[];
  providerPage: number;
  modelPage: number;
  currentModel: string;
  currentProvider: string;
}

const pickerStates = new Map<number, PickerState>();

function shortName(modelId: string): string {
  const short = modelId.includes("/") ? modelId.split("/").pop()! : modelId;
  return short.length > 38 ? `${short.slice(0, 35)}...` : short;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < arr.length; i += size) rows.push(arr.slice(i, i + size));
  return rows;
}

interface KeyboardResult {
  keyboard: { inline_keyboard: unknown[][] };
  pageInfo: string;
}

export function buildProviderKeyboard(state: PickerState, page: number): KeyboardResult {
  const total = state.providers.length;
  const totalPages = Math.max(1, Math.ceil(total / PROVIDER_PAGE_SIZE));
  const safePage = Math.max(0, Math.min(page, totalPages - 1));
  const start = safePage * PROVIDER_PAGE_SIZE;
  const end = Math.min(start + PROVIDER_PAGE_SIZE, total);

  const buttons = state.providers.slice(start, end).map((p, i) => ({
    text: `${p.isCurrent ? "✓ " : ""}${p.name} (${p.models.length})`,
    callback_data: `mp:${start + i}`,
  }));

  const rows = chunk(buttons, 2);
  if (totalPages > 1) {
    const nav = [];
    if (safePage > 0) nav.push({ text: "◀ Prev", callback_data: `mpv:${safePage - 1}` });
    nav.push({ text: `${safePage + 1}/${totalPages}`, callback_data: "mx:noop" });
    if (safePage < totalPages - 1) nav.push({ text: "Next ▶", callback_data: `mpv:${safePage + 1}` });
    rows.push(nav);
  }
  rows.push([{ text: "✗ Cancel", callback_data: "mx" }]);

  const pageInfo = totalPages > 1 ? ` (${start + 1}–${end} of ${total})` : "";
  return { keyboard: { inline_keyboard: rows }, pageInfo };
}

export function buildModelKeyboard(state: PickerState, page: number): KeyboardResult {
  const total = state.modelList.length;
  const totalPages = Math.max(1, Math.ceil(total / MODEL_PAGE_SIZE));
  const safePage = Math.max(0, Math.min(page, totalPages - 1));
  const start = safePage * MODEL_PAGE_SIZE;
  const end = Math.min(start + MODEL_PAGE_SIZE, total);

  const buttons = state.modelList.slice(start, end).map((m, i) => ({
    text: shortName(m),
    callback_data: `mm:${start + i}`,
  }));

  const rows = chunk(buttons, 2);
  if (totalPages > 1) {
    const nav = [];
    if (safePage > 0) nav.push({ text: "◀ Prev", callback_data: `mg:${safePage - 1}` });
    nav.push({ text: `${safePage + 1}/${totalPages}`, callback_data: "mx:noop" });
    if (safePage < totalPages - 1) nav.push({ text: "Next ▶", callback_data: `mg:${safePage + 1}` });
    rows.push(nav);
  }
  rows.push([
    { text: "◀ Back", callback_data: "mb" },
    { text: "✗ Cancel", callback_data: "mx" },
  ]);

  const pageInfo = totalPages > 1 ? ` (${start + 1}–${end} of ${total})` : "";
  return { keyboard: { inline_keyboard: rows }, pageInfo };
}

async function getPickerData(
  client: JcodeClient,
  sessionId: string,
): Promise<{ providers: ProviderInfo[]; currentModel: string; currentProvider: string }> {
  const [rt, catalog] = await Promise.all([
    client.getRuntimeInfo(sessionId),
    client.listModels(sessionId),
  ]);
  const currentModel = catalog.current ?? "?";
  const currentProvider = String(rt.provider ?? "?");
  const routes = (rt.routes ?? []) as { model: string; provider: string }[];
  const providerNames = (rt.providers as string[] | undefined)?.length
    ? (rt.providers as string[])
    : Array.from(new Set(routes.map((r) => r.provider)));
  const providers: ProviderInfo[] = providerNames.map((name) => ({
    name,
    models: routes.filter((r) => r.provider === name).map((r) => r.model),
    isCurrent: name === currentProvider,
  }));
  // Fallback: no routes -> single provider holding the full catalog.
  if (providers.every((p) => p.models.length === 0)) {
    const names = (catalog.models as string[]) ?? [];
    return {
      providers: [{ name: currentProvider, models: names, isCurrent: true }],
      currentModel,
      currentProvider,
    };
  }
  return { providers, currentModel, currentProvider };
}

/** Send the interactive picker; returns without blocking on user input. */
export async function sendModelPicker(
  bot: Telegraf,
  client: JcodeClient,
  sessionId: string,
  chatId: number,
  replyTo?: number,
): Promise<void> {
  try {
    const data = await getPickerData(client, sessionId);
    const state: PickerState = {
      chatId,
      msgId: 0,
      sessionId,
      providers: data.providers,
      modelList: [],
      providerPage: 0,
      modelPage: 0,
      currentModel: data.currentModel,
      currentProvider: data.currentProvider,
    };
    const { keyboard, pageInfo } = buildProviderKeyboard(state, 0);
    const text = formatMessage(
      `⚙ *Model Configuration*\n\nCurrent model: \`${escapeMdv2(state.currentModel)}\`\nProvider: ${escapeMdv2(state.currentProvider)}\n\nSelect a provider:${pageInfo}`,
    );
    const msg = await bot.telegram.sendMessage(chatId, text, {
      parse_mode: "MarkdownV2",
      reply_markup: keyboard as never,
      reply_parameters: replyTo ? { message_id: replyTo } : undefined,
    });
    state.msgId = msg.message_id;
    pickerStates.set(chatId, state);
  } catch (err) {
    console.error("[picker] send failed:", err);
    await bot.telegram.sendMessage(
      chatId,
      formatMessage(`Model picker failed to open: ${err instanceof Error ? err.message : String(err)}`),
      { parse_mode: "MarkdownV2" },
    );
  }
}

/** Handle inline keyboard callback data (mp:/mpv:/mm:/mg:/mb:/mx:). */
export async function handleModelPickerCallback(bot: Telegraf, client: JcodeClient, ctx: Context): Promise<void> {
  const query = ctx.callbackQuery;
  if (!query) return;
  const data = String((query as { data?: string }).data ?? "");
  const chatId = query.message && "chat" in query.message ? (query.message.chat.id as number) : 0;
  const state = pickerStates.get(chatId);
  if (!state) {
    await ctx.answerCbQuery("Picker expired — use /model again.");
    return;
  }

  const edit = async (text: string, keyboard?: { inline_keyboard: unknown[][] }) => {
    try {
      await bot.telegram.editMessageText(chatId, state.msgId, undefined, text, {
        parse_mode: "MarkdownV2",
        reply_markup: keyboard as never,
      });
    } catch (err) {
      // MarkdownV2 rejected -> plain text
      try {
        await bot.telegram.editMessageText(chatId, state.msgId, undefined, text, {
          reply_markup: keyboard as never,
        });
      } catch (err2) {
        console.error("[picker] edit failed:", err2);
      }
    }
  };

  if (data.startsWith("mp:")) {
    const idx = Number(data.slice(3));
    const p = state.providers[idx];
    if (!p) return;
    state.selectedProvider = p.name;
    state.modelList = p.models;
    state.modelPage = 0;
    const { keyboard, pageInfo } = buildModelKeyboard(state, 0);
    const total = p.models.length;
    const shown = state.modelList.length;
    const extra = total > shown ? `\n_${total - shown} more available — type \`/model <name>\` directly_` : "";
    await edit(
      formatMessage(
        `⚙ *Model Configuration*\n\nProvider: *${escapeMdv2(p.name)}*${pageInfo}\nSelect a model:${extra}`,
      ),
      keyboard,
    );
  } else if (data.startsWith("mpv:")) {
    const page = Number(data.slice(4));
    state.providerPage = page;
    const { keyboard, pageInfo } = buildProviderKeyboard(state, page);
    await edit(
      formatMessage(
        `⚙ *Model Configuration*\n\nCurrent model: \`${escapeMdv2(state.currentModel)}\`\nProvider: ${escapeMdv2(state.currentProvider)}\n\nSelect a provider:${pageInfo}`,
      ),
      keyboard,
    );
  } else if (data.startsWith("mg:")) {
    const page = Number(data.slice(3));
    state.modelPage = page;
    const { keyboard, pageInfo } = buildModelKeyboard(state, page);
    await edit(
      formatMessage(
        `⚙ *Model Configuration*\n\nProvider: *${escapeMdv2(state.selectedProvider ?? "")}*${pageInfo}\nSelect a model:`,
      ),
      keyboard,
    );
  } else if (data.startsWith("mm:")) {
    const idx = Number(data.slice(3));
    const model = state.modelList[idx];
    if (!model) return;
    let result: string;
    try {
      await client.setModel(state.sessionId, model);
      result = `✅ Switched to \`${escapeMdv2(model)}\`.`;
    } catch (err) {
      result = `❌ Switch failed: ${escapeMdv2(err instanceof Error ? err.message : String(err))}`;
    }
    await edit(formatMessage(result));
    pickerStates.delete(chatId);
  } else if (data === "mb") {
    const { keyboard, pageInfo } = buildProviderKeyboard(state, state.providerPage);
    await edit(
      formatMessage(
        `⚙ *Model Configuration*\n\nCurrent model: \`${escapeMdv2(state.currentModel)}\`\nProvider: ${escapeMdv2(state.currentProvider)}\n\nSelect a provider:${pageInfo}`,
      ),
      keyboard,
    );
  } else if (data === "mx" || data === "mx:noop") {
    if (data === "mx") {
      await edit(formatMessage("❌ Model picker cancelled."));
      pickerStates.delete(chatId);
    }
  }
  await ctx.answerCbQuery();
}
