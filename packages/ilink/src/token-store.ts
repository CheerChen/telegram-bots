import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { TokenFile } from "./types.ts";

export function resolveTokenPath(defaultPath: string): string {
  const fromEnv = process.env.ILINK_TOKEN_FILE?.trim();
  return fromEnv ? resolve(fromEnv) : resolve(defaultPath);
}

export async function readTokenFile(path: string): Promise<TokenFile> {
  const raw = await readFile(path, "utf-8");
  const parsed = JSON.parse(raw) as Partial<TokenFile>;
  if (!parsed.bot_token?.trim()) {
    throw new Error(`token file exists but bot_token is empty: ${path}`);
  }
  return parsed as TokenFile;
}

export async function readTokenFileIfExists(path: string): Promise<TokenFile | undefined> {
  try {
    return await readTokenFile(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    if (err instanceof SyntaxError || (err as Error).message?.includes("bot_token is empty")) {
      console.warn(
        `token file at ${path} is corrupted (${(err as Error).message}); ignoring and treating as no token`,
      );
      return undefined;
    }
    throw err;
  }
}

export async function writeTokenFile(path: string, data: TokenFile): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
  try {
    await chmod(tmp, 0o600);
  } catch {
    // chmod is best-effort on non-POSIX filesystems.
  }
  await rename(tmp, path);
}
