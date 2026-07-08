import { sendMessage } from "shared/telegram";

import type { PokemonStockConfig } from "./config.ts";
import type { PokemonStockState, ProductState } from "./state.ts";

// ---------------------------------------------------------------------------
// Cookie jar + manual redirect following
// ---------------------------------------------------------------------------

/** Minimal cookie jar that accumulates Set-Cookie across redirects. */
class CookieJar {
  private cookies = new Map<string, string>();

  mergeHeader(header: string): void {
    for (const pair of header.split(";")) {
      const trimmed = pair.trim();
      if (!trimmed.includes("=")) continue;
      const idx = trimmed.indexOf("=");
      const k = trimmed.slice(0, idx).trim();
      const v = trimmed.slice(idx + 1).trim();
      this.cookies.set(k, v);
    }
  }

  absorbSetCookie(headers: Headers): void {
    const raw = headers.getSetCookie?.();
    if (raw) {
      for (const line of raw) {
        const kv = line.split(";")[0]!;
        if (!kv.includes("=")) continue;
        const idx = kv.indexOf("=");
        this.cookies.set(kv.slice(0, idx).trim(), kv.slice(idx + 1).trim());
      }
    }
  }

  toHeader(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

const MAX_REDIRECTS = 12;

/**
 * Fetch *url* following redirects manually, accumulating cookies into a jar.
 * The Pokémon Center site uses SFCC wr risk control + QueueIT — the first
 * request 302s to a challenge page which 302s back with a queueittoken.
 * Auto-redirect can't handle this because cookies must be carried across
 * domains (wr.pokemoncenter-online.com → www.pokemoncenter-online.com).
 */
async function fetchWithCookies(
  url: string,
  jar: CookieJar,
  userAgent: string,
): Promise<{ html: string; finalUrl: string }> {
  let current = url;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const cookieHeader = jar.toHeader();
    const res = await fetch(current, {
      redirect: "manual",
      headers: {
        "User-Agent": userAgent,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "ja-JP,ja;q=0.9",
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      },
    });
    jar.absorbSetCookie(res.headers);

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (loc) {
        current = new URL(loc, current).href;
        continue;
      }
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${current}`);
    const html = await res.text();
    return { html, finalUrl: current };
  }
  throw new Error(`too many redirects for ${url}`);
}

// ---------------------------------------------------------------------------
// HTML parsing — stock signal detection
// ---------------------------------------------------------------------------

// Signal 1 (most reliable): <select id="quantity" disabled ...> => unavailable
const RE_QUANTITY_DISABLED = /<select\s+id="quantity"\s+disabled\b/i;
// Signal 2: add-to-cart-button with "default" class => disabled/greyed
const RE_CART_BTN_DEFAULT = /class="add-to-cart-button\s+btn\s+default"/i;
// Signal 3 (auxiliary): <li class="order">存在 => 再入荷/预告态
const RE_ORDER_TAG = /<li\s+class="order"[^>]*>([^<]*)<\/li>/i;
// Product name
const RE_TITLE = /<h1\s+class="lead">(.*?)<span/s;
// Product page structure markers (used to detect queue/login/error pages)
const RE_HAS_TITLE = /<h1\s+class="lead"/i;
const RE_HAS_QUANTITY = /<select\s+id="quantity"/i;
// QueueIT waiting room detection — final URL domain or HTML content markers
const RE_QUEUEIT_URL = /queue-it\.net/i;
const RE_QUEUEIT_HTML = /queue-it\.net|QueueIT|virtual.*queue|waiting.*room|待機室|仮想待合室/i;

interface ParseResult {
  state: ProductState;
  /** True if the HTML looks like a real product page (not a queue/login page). */
  isProductPage: boolean;
}

function parseProductPage(html: string): ParseResult {
  const isProductPage = RE_HAS_TITLE.test(html) && RE_HAS_QUANTITY.test(html);

  const quantityDisabled = RE_QUANTITY_DISABLED.test(html);
  const cartDefault = RE_CART_BTN_DEFAULT.test(html);
  const orderMatch = html.match(RE_ORDER_TAG);
  const orderTag = orderMatch?.[1]?.trim() ?? "";

  const available = !quantityDisabled && !cartDefault;

  const titleMatch = html.match(RE_TITLE);
  const title = titleMatch?.[1]?.trim() ?? "(unknown)";

  return {
    state: { available, quantityDisabled, cartButtonDefault: cartDefault, orderTag, title },
    isProductPage,
  };
}

// ---------------------------------------------------------------------------
// Fetch one product
// ---------------------------------------------------------------------------

interface CheckResult {
  state: ProductState | null;
  isProductPage: boolean;
  waitingRoom: boolean;
  error: string | null;
}

async function checkOne(
  url: string,
  loginCookie: string | undefined,
  userAgent: string,
): Promise<CheckResult> {
  // Fresh jar per product: seed SFCC session cookies anonymously, then
  // merge login cookies if provided. Reusing a jar across products risks
  // stale tokens. Anonymous access is sufficient for reading stock signals.
  const jar = new CookieJar();
  try {
    await fetchWithCookies(url, jar, userAgent);
  } catch {
    // Cookie-seed pass may fail; we retry below (with or without login cookie).
  }

  if (loginCookie) jar.mergeHeader(loginCookie);
  try {
    const { html, finalUrl } = await fetchWithCookies(url, jar, userAgent);

    // Detect QueueIT waiting room: redirect to queue-it.net domain or
    // HTML contains QueueIT markers. This is a normal pre-sale state, not
    // a monitor failure.
    const isQueueItUrl = RE_QUEUEIT_URL.test(finalUrl);
    const isQueueItHtml = RE_QUEUEIT_HTML.test(html);
    if (isQueueItUrl || isQueueItHtml) {
      return { state: null, isProductPage: false, waitingRoom: true, error: null };
    }

    const { state, isProductPage } = parseProductPage(html);
    return { state, isProductPage, waitingRoom: false, error: null };
  } catch (err) {
    return {
      state: null,
      isProductPage: false,
      waitingRoom: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

async function notify(config: PokemonStockConfig, text: string): Promise<void> {
  if (!config.telegramEnabled) return;
  console.log(`[notify] ${text.replace(/\n/g, " | ")}`);
  await sendMessage(config.telegramBotToken, {
    chatId: config.telegramChatId,
    text,
    messageThreadId: config.telegramMessageThreadId,
    disableWebPagePreview: true,
  });
}

/**
 * Send a Bark push notification (iOS, time-sensitive lock-screen delivery).
 * Best-effort: errors are logged but do not fail the cycle.
 */
async function notifyBark(
  config: PokemonStockConfig,
  title: string,
  body: string,
  opts?: { url?: string; call?: boolean },
): Promise<void> {
  if (!config.barkServerUrl || !config.barkDeviceKey) return;
  try {
    const payload: Record<string, string> = {
      device_key: config.barkDeviceKey,
      title,
      body,
      group: "pokemon-stock",
      level: "timeSensitive",
    };
    if (config.barkIcon) payload.icon = config.barkIcon;
    if (opts?.url) payload.url = opts.url;
    if (opts?.call) payload.call = "1";

    const res = await fetch(`${config.barkServerUrl}/push`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.log(`[bark] HTTP ${res.status}: ${await res.text()}`);
    }
  } catch (err) {
    console.log(`[bark] send failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Send a startup confirmation so you know the bot is wired up. */
export async function notifyStartup(config: PokemonStockConfig): Promise<void> {
  const msg =
    `pokemon-stock 已启动\n` +
    `监控 ${config.targets.length} 个目标，轮询间隔 ${Math.round(config.pollIntervalMs / 1000)}s` +
    (config.cookie ? "" : "\n⚠️ 未配置 POKEMON_COOKIE，使用匿名访问");
  await notify(config, msg);
  await notifyBark(config, "pokemon-stock 已启动", `${config.targets.length} 个目标 · ${Math.round(config.pollIntervalMs / 1000)}s 轮询`);
}

function withinCooldown(lastAlertAt: string | undefined, cooldownMs: number): boolean {
  if (!lastAlertAt) return false;
  const elapsed = Date.now() - new Date(lastAlertAt).getTime();
  return elapsed < cooldownMs;
}

// ---------------------------------------------------------------------------
// Cycle
// ---------------------------------------------------------------------------

export interface CycleStats {
  checked: number;
  notified: number;
  failures: number;
  monitorAlert: boolean;
  logs: string[];
}

export async function runCycle(
  config: PokemonStockConfig,
  store: { load(): Promise<PokemonStockState>; save(state: PokemonStockState): Promise<void> },
): Promise<CycleStats> {
  const stats: CycleStats = { checked: 0, notified: 0, failures: 0, monitorAlert: false, logs: [] };
  const prev = await store.load();
  const newTargets: Record<string, ProductState> = {};

  // --- Check each target ---
  let allFailed = true;
  let anyWaitingRoom = false;

  for (let i = 0; i < config.targets.length; i++) {
    const url = config.targets[i]!;
    const log = (msg: string): void => {
      const line = `[${i + 1}/${config.targets.length}] ${msg}`;
      console.log(line);
      stats.logs.push(line);
    };

    const result = await checkOne(url, config.cookie, config.userAgent);

    // QueueIT waiting room — normal pre-sale state, not a failure.
    if (result.waitingRoom) {
      anyWaitingRoom = true;
      allFailed = false;
      log("waiting room active (QueueIT)");
      // Preserve previous state so we don't lose transition tracking.
      if (prev.targets[url]) newTargets[url] = prev.targets[url];
      continue;
    }

    if (result.error || !result.state || !result.isProductPage) {
      stats.failures++;
      const reason = result.error ?? "page structure mismatch (queue/login page?)";
      log(`fetch failed: ${reason}`);
      // Preserve previous state so we don't lose transition tracking.
      if (prev.targets[url]) newTargets[url] = prev.targets[url];
      continue;
    }

    allFailed = false;
    stats.checked++;
    const state = result.state;
    log(
      `${state.title} — available=${state.available} ` +
        `qty_disabled=${state.quantityDisabled} ` +
        `cart_default=${state.cartButtonDefault} ` +
        `order=${state.orderTag || "—"}`,
    );

    const prevState = prev.targets[url];
    const prevAvailable = prevState?.available;

    // Notify on transition: unavailable -> available
    if (state.available && prevAvailable === false) {
      const msg = `开卖了！${state.title}\n${url}`;
      try {
        await notify(config, msg);
        stats.notified++;
      } catch (err) {
        log(`notify failed: ${err}`);
      }
      await notifyBark(config, "开卖了！", state.title, { url, call: true });
    } else if (prevAvailable === undefined && state.available) {
      log("first run, already available (no notification)");
    } else if (!state.available && prevAvailable === true) {
      log("went unavailable");
      const msg = `卖完了…${state.title}\n${url}`;
      try {
        await notify(config, msg);
        stats.notified++;
      } catch (err) {
        log(`notify failed: ${err}`);
      }
      await notifyBark(config, "卖完了…", state.title, { url });
    }

    newTargets[url] = state;

    // Pace between products.
    if (i < config.targets.length - 1) {
      await new Promise((r) => setTimeout(r, config.interProductDelayMs));
    }
  }

  // --- Waiting room notification ---
  if (anyWaitingRoom) {
    stats.logs.push("waiting room detected for one or more targets");
    if (!withinCooldown(prev.lastMonitorAlertAt, config.monitorAlertCooldownMs)) {
      const msg =
        "🚪 虚拟等候室已开启\n" +
        "即将开卖，请准备！\n" +
        "https://www.pokemoncenter-online.com/";
      try {
        await notify(config, msg);
        stats.notified++;
      } catch (err) {
        stats.logs.push(`waiting room alert send failed: ${err}`);
      }
      await notifyBark(config, "虚拟等候室已开启", "即将开卖，请准备！", { url: "https://www.pokemoncenter-online.com/" });
      prev.lastMonitorAlertAt = new Date().toISOString();
    }
  }

  // --- Monitor health alert: all targets failed (not waiting room) ---
  if (allFailed && config.targets.length > 0) {
    stats.logs.push("all targets failed — monitor may be broken");
    if (!withinCooldown(prev.lastMonitorAlertAt, config.monitorAlertCooldownMs)) {
      const msg =
        "⚠️ pokemon-stock 监控可能失效\n" +
        `所有 ${config.targets.length} 个目标都无法解析商品页\n` +
        "请检查 POKEMON_COOKIE 是否过期或网络是否被 QueueIT 拦截";
      try {
        await notify(config, msg);
        stats.notified++;
      } catch (err) {
        stats.logs.push(`monitor alert send failed: ${err}`);
      }
      await notifyBark(config, "监控可能失效", `所有 ${config.targets.length} 个目标无法解析`);
      prev.lastMonitorAlertAt = new Date().toISOString();
      stats.monitorAlert = true;
    }
  }

  // --- Persist state ---
  await store.save({
    targets: newTargets,
    lastMonitorAlertAt: prev.lastMonitorAlertAt,
  });

  return stats;
}
