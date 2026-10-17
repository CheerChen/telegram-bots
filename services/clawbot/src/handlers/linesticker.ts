// LINE sticker links go to the linesticker-bot Worker, which owns parsing,
// conversion and the reply text; clawbot only relays (see bots/linesticker/src/web.ts).
import type { ClawConfig } from "../config.ts";

const LINE_STICKER_LINK = /(store\.line\.me\/stickershop\/product\/\d+|line\.me\/S\/sticker\/\d+)/;

export function isLineStickerLink(text: string): boolean {
  return LINE_STICKER_LINK.test(text);
}

export async function requestLineSticker(config: ClawConfig, text: string): Promise<string> {
  if (!config.linestickerUrl || !config.linestickerSecret) {
    throw new Error("LINESTICKER_URL / LINESTICKER_SECRET not set");
  }
  const res = await fetch(`${config.linestickerUrl}/wx/request`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-claw-secret": config.linestickerSecret },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`linesticker ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const { reply } = (await res.json()) as { reply?: string };
  if (!reply) throw new Error("linesticker: empty reply");
  return reply;
}
