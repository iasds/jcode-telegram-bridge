import { readFileSync, writeFileSync } from "node:fs";
import type { JcodeClient } from "@1jehuang/jcode-sdk";
import type { Config } from "./config.js";

export type ChatMode = "normal" | "plan";

export interface ChatState {
  sessionId: string;
  mode: ChatMode;
  workdir: string;
  createdAt: number;
}

interface Persisted {
  chats: Record<string, ChatState>;
}

/**
 * Maps Telegram chat_id -> jcode session, persists to state.json,
 * and provides a per-session FIFO queue so one session never runs
 * two turns at once.
 */
export class SessionStore {
  private chats: Record<string, ChatState> = {};
  private queues = new Map<string, Promise<unknown>>();
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(
    private client: JcodeClient,
    private cfg: Config,
  ) {
    try {
      const raw = JSON.parse(readFileSync(cfg.stateFile, "utf8")) as Persisted;
      this.chats = raw.chats ?? {};
    } catch {
      this.chats = {};
    }
  }

  /** Get existing session for a chat, or create one. */
  async getOrCreate(chatId: number): Promise<ChatState> {
    const key = String(chatId);
    const existing = this.chats[key];
    if (existing) return existing;
    const sessionId = (await this.client.createSession(this.cfg.workDir)).session_id;
    const state: ChatState = {
      sessionId,
      mode: "normal",
      workdir: this.cfg.workDir,
      createdAt: Date.now(),
    };
    this.chats[key] = state;
    this.persist();
    return state;
  }

  get(chatId: number): ChatState | undefined {
    return this.chats[String(chatId)];
  }

  set(chatId: number, state: ChatState): void {
    this.chats[String(chatId)] = state;
    this.persist();
  }

  remove(chatId: number): void {
    delete this.chats[String(chatId)];
    this.persist();
  }

  all(): [number, ChatState][] {
    return Object.entries(this.chats).map(([k, v]) => [Number(k), v]);
  }

  /** Serialize work on one session: returns a promise that resolves when it's this caller's turn. */
  enqueue<T>(chatId: number, fn: () => Promise<T>): Promise<T> {
    const key = String(chatId);
    const prev = this.queues.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn); // run regardless of previous outcome
    this.queues.set(
      key,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  /** Reverse lookup: sessionId -> chatId (for event routing). */
  chatForSession(sessionId: string): number | undefined {
    for (const [chatId, state] of Object.entries(this.chats)) {
      if (state.sessionId === sessionId) return Number(chatId);
    }
    return undefined;
  }

  /** Synchronous persist, for paths that must hit disk before process exit. */
  persistNow(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    try {
      writeFileSync(this.cfg.stateFile, JSON.stringify({ chats: this.chats }, null, 2), {
        mode: 0o600,
      });
    } catch (err) {
      console.error("[sessions] persist failed:", err);
    }
  }

  private persist(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.persistNow(), 500);
  }
}
