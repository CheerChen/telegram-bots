import { readFile, rename, writeFile } from "node:fs/promises";

export type ClawMode = "echo" | "katakana" | "ctxd";

export interface ClawSession {
  activeMode: ClawMode | null;
  lastActivity: string;
}

type SessionMap = Record<string, ClawSession>;

export class SessionStore {
  private cache: SessionMap = {};
  private loaded = false;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private path: string) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await readFile(this.path, "utf-8");
      this.cache = raw.trim() ? (JSON.parse(raw) as SessionMap) : {};
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        this.cache = {};
      } else if (err instanceof SyntaxError) {
        console.warn(`sessions file at ${this.path} is corrupted; resetting`);
        this.cache = {};
      } else {
        throw err;
      }
    }
    this.loaded = true;
  }

  get(userId: string): ClawSession | undefined {
    return this.cache[userId];
  }

  async put(userId: string, session: ClawSession): Promise<void> {
    this.cache[userId] = session;
    await this.flush();
  }

  async delete(userId: string): Promise<void> {
    delete this.cache[userId];
    await this.flush();
  }

  private flush(): Promise<void> {
    const snapshot = { ...this.cache };
    const tmp = `${this.path}.tmp`;
    this.writeChain = this.writeChain.then(async () => {
      await writeFile(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, "utf-8");
      await rename(tmp, this.path);
    });
    return this.writeChain;
  }
}
