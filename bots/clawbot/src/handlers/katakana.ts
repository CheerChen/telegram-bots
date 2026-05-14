const TIMEOUT_MS = 12_000;

export interface KatakanaHandlerOptions {
  workerUrl: string;
  secret: string;
}

export interface HandlerResult {
  ok: boolean;
  text: string;
}

export async function callKatakana(
  opts: KatakanaHandlerOptions,
  userId: string,
  text: string,
): Promise<HandlerResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(opts.workerUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-claw-secret": opts.secret,
      },
      body: JSON.stringify({ userId, text }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, text: `katakana worker ${res.status}: ${body.slice(0, 200)}` };
    }
    const json = (await res.json()) as { text?: string; error?: string };
    if (json.error) return { ok: false, text: `katakana error: ${json.error}` };
    return { ok: true, text: json.text ?? "" };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ok: false, text: "katakana worker timeout" };
    }
    return { ok: false, text: `katakana fetch failed: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    clearTimeout(timer);
  }
}
