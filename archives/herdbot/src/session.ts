import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { HerdConfig } from "./config.ts";

/**
 * Per-chat session pointer, persisted to disk.
 *
 * - `sessionId` is the Claude Agent SDK session UUID; pass it to `resume`
 *   to continue a conversation across process restarts.
 * - `lastActiveMs` drives the idle-timeout "turn the page" behavior.
 * - `pendingReplay` holds the user text that triggered a page-turn; when
 *   the user taps "继续上一个会话" we resume the old session and feed
 *   this text as the next prompt.
 */
export interface ChatSession {
  chatId: number;
  sessionId: string;
  lastActiveMs: number;
  pendingReplay?: string;
  createdAt: string;
}

const IDLE_PAGE_TURNED_NOTE = "（已闲置超时，开始新会话。如需继续上一个会话，点击下方按钮。）";

export class SessionStore {
  private readonly dir: string;
  private readonly idleTimeoutMs: number;

  constructor(config: HerdConfig) {
    this.dir = config.sessionDir;
    this.idleTimeoutMs = config.idleTimeoutMs;
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  private path(chatId: number): string {
    return resolve(this.dir, `${chatId}.json`);
  }

  /** Read the current session pointer for a chat. Returns null if none. */
  async get(chatId: number): Promise<ChatSession | null> {
    try {
      const raw = await readFile(this.path(chatId), "utf8");
      return JSON.parse(raw) as ChatSession;
    } catch {
      return null;
    }
  }

  /** Save (create or update) the session pointer for a chat. */
  async save(session: ChatSession): Promise<void> {
    await writeFile(this.path(session.chatId), JSON.stringify(session, null, 2), "utf8");
  }

  /** Delete the session pointer (used by /new). */
  async delete(chatId: number): Promise<void> {
    await rm(this.path(chatId), { force: true });
  }

  /**
   * Check whether the current session has been idle past the timeout.
   * If so, "turn the page": clear the pointer and return the old session
   * ID plus a flag so the caller can offer a resume button.
   *
   * Returns:
   * - `{ expired: true, previousSessionId, pendingReplay? }` — caller
   *   should start a fresh session and offer a resume button.
   * - `{ expired: false }` — session is still fresh, continue normally.
   * - `{ expired: false, session: null }` — no session at all (new chat).
   */
  async checkIdle(
    chatId: number,
  ): Promise<
    | { expired: true; previousSessionId: string; pendingReplay?: string }
    | { expired: false; session: ChatSession | null }
  > {
    const session = await this.get(chatId);
    if (!session) return { expired: false, session: null };

    const now = Date.now();
    if (now - session.lastActiveMs < this.idleTimeoutMs) {
      return { expired: false, session };
    }

    // Page turned: clear pointer, remember old session for resume button.
    const previousSessionId = session.sessionId;
    const pendingReplay = session.pendingReplay;
    await this.delete(chatId);
    return { expired: true, previousSessionId, pendingReplay };
  }

  /**
   * Record that a session is active (or create a new pointer).
   * Called after each successful agent turn.
   */
  async touch(chatId: number, sessionId: string): Promise<void> {
    const existing = await this.get(chatId);
    const now = Date.now();
    await this.save({
      chatId,
      sessionId,
      lastActiveMs: now,
      pendingReplay: existing?.pendingReplay,
      createdAt: existing?.createdAt ?? new Date(now).toISOString(),
    });
  }

  /**
   * Stash the user text that triggered a page-turn, so the resume button
   * can replay it into the old session.
   */
  async setPendingReplay(chatId: number, sessionId: string, text: string): Promise<void> {
    await this.save({
      chatId,
      sessionId,
      lastActiveMs: Date.now(),
      pendingReplay: text,
      createdAt: new Date().toISOString(),
    });
  }
}

export { IDLE_PAGE_TURNED_NOTE };
