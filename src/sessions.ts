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

/** Thrown when a chat's turn queue is full (QUEUE_LIMIT). */
export class QueueFullError extends Error {
  constructor(public readonly limit: number) {
    super(`queue full (limit ${limit})`);
    this.name = "QueueFullError";
  }
}

/**
 * Maps Telegram chat_id -> jcode session, persists to state.json,
 * and provides a per-session FIFO queue so one session never runs
 * two turns at once.
 */
export class SessionStore {
  private chats: Record<string, ChatState> = {};
  private queues = new Map<string, Promise<unknown>>();
  /** Running + pending turn count per chat key. */
  private depths = new Map<string, number>();
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
  enqueue<T>(chatId: number, fn: () => Promise<T>, limit = Infinity): Promise<T> {
    const key = String(chatId);
    const depth = (this.depths.get(key) ?? 0) + 1;
    if (depth > limit) {
      return Promise.reject(new QueueFullError(limit));
    }
    this.depths.set(key, depth);
    const prev = this.queues.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn); // run regardless of previous outcome
    this.queues.set(
      key,
      run.then(
        () => this.decDepth(key),
        () => this.decDepth(key),
      ),
    );
    return run;
  }

  /** Running + pending turns for a chat (0 when idle). */
  queueDepth(chatId: number): number {
    return this.depths.get(String(chatId)) ?? 0;
  }

  /** All non-idle chats with their queue depths. */
  allQueueDepths(): Array<[number, number]> {
    return [...this.depths.entries()]
      .filter(([, d]) => d > 0)
      .map(([k, d]) => [Number(k), d]);
  }

  private decDepth(key: string): void {
    const next = (this.depths.get(key) ?? 1) - 1;
    if (next <= 0) this.depths.delete(key);
    else this.depths.set(key, next);
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
