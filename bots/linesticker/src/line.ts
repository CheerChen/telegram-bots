// LINE sticker CDN. Public, no auth; layout verified against live packs.
const CDN = "https://stickershop.line-scdn.net/stickershop/v1";

export interface LineStickerMeta {
  packageId: number;
  title: Record<string, string>;
  hasAnimation?: boolean;
  stickerResourceType?: string;
  stickers: { id: number; width: number; height: number }[];
}

const PRODUCT_PATTERNS = [
  /store\.line\.me\/stickershop\/product\/(\d+)/,
  /line\.me\/S\/sticker\/(\d+)/,
];

export function parseProductId(text: string): string | null {
  for (const re of PRODUCT_PATTERNS) {
    const m = text.match(re);
    if (m?.[1]) return m[1];
  }
  const bare = text.trim();
  return /^\d{1,12}$/.test(bare) ? bare : null;
}

export function metaUrl(productId: string): string {
  return `${CDN}/product/${productId}/iphone/productInfo.meta`;
}

export function staticUrl(stickerId: number): string {
  return `${CDN}/sticker/${stickerId}/iPhone/sticker@2x.png`; // pg-allow: CDN retina suffix, not an email
}

// Old packs serve Apple CgBI PNGs on the iPhone path; android is standard PNG.
export function androidStaticUrl(stickerId: number): string {
  return `${CDN}/sticker/${stickerId}/android/sticker.png`;
}

export function animationUrl(stickerId: number): string {
  return `${CDN}/sticker/${stickerId}/iPhone/sticker_animation@2x.png`; // pg-allow: CDN retina suffix, not an email
}

export function isAnimated(meta: LineStickerMeta): boolean {
  return meta.hasAnimation === true;
}

export async function fetchMeta(productId: string): Promise<LineStickerMeta | null> {
  const res = await fetch(metaUrl(productId), { signal: AbortSignal.timeout(15_000) });
  if (res.status === 404 || res.status === 403) return null;
  if (!res.ok) throw new Error(`line meta ${res.status}`);
  const meta = (await res.json()) as LineStickerMeta;
  if (!Array.isArray(meta.stickers) || meta.stickers.length === 0) return null;
  return meta;
}

const TITLE_LANGS = ["ja", "en", "zh-Hant", "zh-Hans", "ko"];

// Telegram caps set titles at 64 chars.
export function pickTitle(meta: LineStickerMeta): string {
  const t = meta.title ?? {};
  const title = TITLE_LANGS.map((l) => t[l]).find(Boolean) ?? Object.values(t)[0];
  return (title || `LINE ${meta.packageId}`).slice(0, 64);
}

// Deterministic so the set itself is the dedup / resume state.
export function stickerSetName(productId: string, botUsername: string): string {
  return `line_${productId}_by_${botUsername}`;
}

export function addStickersUrl(setName: string): string {
  return `https://t.me/addstickers/${setName}`;
}
