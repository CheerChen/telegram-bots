export interface SessionSource {
  n: number;
  url: string;
  type: string;
  fetchedAt: string;
  content: string;
}

export interface SessionMessage {
  role: "user" | "assistant";
  content: string;
}

export interface Session {
  sources: SessionSource[];
  messages: SessionMessage[];
  createdAt: string;
  lastActivity: string;
}

export interface SessionStore {
  get(chatId: number | string): Promise<Session | null>;
  put(chatId: number | string, session: Session): Promise<void>;
  delete(chatId: number | string): Promise<void>;
}

export function kvSessionStore(kv: KVNamespace, prefix = "session:"): SessionStore {
  return {
    async get(chatId) {
      const raw = await kv.get(`${prefix}${chatId}`);
      return raw ? (JSON.parse(raw) as Session) : null;
    },
    async put(chatId, session) {
      await kv.put(`${prefix}${chatId}`, JSON.stringify(session));
    },
    async delete(chatId) {
      await kv.delete(`${prefix}${chatId}`);
    },
  };
}

export function newSession(): Session {
  const now = new Date().toISOString();
  return { sources: [], messages: [], createdAt: now, lastActivity: now };
}

export function touch(s: Session): Session {
  return { ...s, lastActivity: new Date().toISOString() };
}
