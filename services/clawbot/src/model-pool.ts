// Auto-discovering LLM model pool with fallback.
//
// Given one or more API keys, fetches the DashScope model catalog
// (GET /api/v1/models?capabilities=TG), filters to pure-text chat models,
// sorts by published_time descending (newest first), and provides a single
// chat() method that transparently falls back across models on 403/401/404.
//
// Transient errors (429/5xx/timeout) retry once on the same model before
// falling back. Quota-exhausted models are permanently disabled until restart.

import type { ChatOptions, Message } from "./llm.ts";
import { chat, classifyError, type ErrorClass } from "./llm.ts";

// --- DashScope /api/v1/models response types ---

interface DSModel {
  model: string;
  name?: string;
  capabilities?: string[];
  features?: string[];
  published_time?: string | null;
  equivalent_snapshot?: string | null;
  provider?: string;
  inference_metadata?: {
    request_modality?: string[];
    response_modality?: string[];
  };
  model_info?: {
    context_window?: number | null;
    max_input_tokens?: number | null;
    max_output_tokens?: number | null;
  };
}

interface DSModelsResponse {
  success?: boolean;
  code?: string | null;
  message?: string | null;
  output?: {
    total?: number;
    models?: DSModel[];
  };
}

// --- Pool types ---

export interface PoolEntry {
  apiKey: string;
  model: string;
  name: string;
  publishedTime: string;
  contextWindow: number | null;
}

export interface DisabledEntry {
  model: string;
  reason: string;
  at: string;
}

export interface ChatResult {
  content: string;
  model: string;
}

const DASHSCOPE_INTL_API = "https://dashscope-intl.aliyuncs.com";
const DASHSCOPE_INTL_COMPAT = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";

// Models with these features are not general-purpose chat — skip them.
// NOTE: "model-experience" means the model supports free-tier trial, NOT that
// it is experimental. Most production qwen models have it, so we do NOT exclude it.
const EXCLUDE_FEATURES = new Set<string>([]);

// Name substrings that indicate non-chat or specialized models.
const EXCLUDE_NAME_PATTERNS = [
  "coder",
  "character",
  "mt-",
  "mt-lite",
  "mt-plus",
  "mt-turbo",
  "livetranslate",
  "tingwu",
  "slp",
];

// Dated snapshot suffix pattern: -YYYY-MM-DD or -YYYY-MM-DD-...
const DATED_SNAPSHOT_RE = /-\d{4}-\d{2}-\d{2}/;

export class ModelPool {
  private entries: PoolEntry[] = [];
  private disabled = new Map<string, DisabledEntry>();
  private cursor = 0;
  private apiBaseUrl: string;
  private compatBaseUrl: string;

  constructor(
    private readonly apiKeys: string[],
    opts?: { apiBaseUrl?: string; compatBaseUrl?: string },
  ) {
    this.apiBaseUrl = opts?.apiBaseUrl ?? DASHSCOPE_INTL_API;
    this.compatBaseUrl = opts?.compatBaseUrl ?? DASHSCOPE_INTL_COMPAT;
  }

  /** Fetch model catalog and build the ordered fallback list. */
  async init(): Promise<void> {
    const all: PoolEntry[] = [];
    for (const key of this.apiKeys) {
      try {
        const models = await this.fetchModels(key);
        all.push(...models.map((m) => this.toPoolEntry(m, key)));
      } catch (err) {
        console.error(
          `[pool] failed to fetch model list for key ...${key.slice(-6)}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    // Deduplicate by model id (same model from different keys = separate entries,
    // but identical model+key pairs shouldn't appear twice).
    const seen = new Set<string>();
    this.entries = all.filter((e) => {
      const k = `${e.apiKey}:${e.model}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    if (this.entries.length === 0) {
      console.error("[pool] no models discovered — chat will be unavailable");
    } else {
      console.log(
        `[pool] discovered ${this.entries.length} models:`,
        this.entries.map((e) => e.model).join(", "),
      );
    }
  }

  availableCount(): number {
    return this.entries.filter((e) => !this.disabled.has(`${e.apiKey}:${e.model}`)).length;
  }

  isAvailable(): boolean {
    return this.availableCount() > 0;
  }

  getSnapshot(): {
    total: number;
    available: number;
    cursor: number;
    currentModel: string | null;
    disabled: DisabledEntry[];
    models: { model: string; available: boolean }[];
  } {
    const available = this.availableCount();
    const current = this.entries[this.cursor];
    return {
      total: this.entries.length,
      available,
      cursor: this.cursor,
      currentModel: current ? current.model : null,
      disabled: [...this.disabled.values()],
      models: this.entries.map((e) => ({
        model: e.model,
        available: !this.disabled.has(`${e.apiKey}:${e.model}`),
      })),
    };
  }

  /** Chat with automatic fallback. Throws if all models exhausted. */
  async chat(
    messages: Message[],
    opts: ChatOptions = {},
    preferredModel?: string,
  ): Promise<ChatResult> {
    const tried: string[] = [];
    const n = this.entries.length;

    // Build the try-order: preferred model first (if set), then cursor-based.
    const order: number[] = [];
    if (preferredModel) {
      const prefIdx = this.entries.findIndex(
        (e) => e.model === preferredModel && !this.disabled.has(`${e.apiKey}:${e.model}`),
      );
      if (prefIdx >= 0) {
        order.push(prefIdx);
      }
    }
    for (let i = 0; i < n; i++) {
      const idx = (this.cursor + i) % n;
      if (!order.includes(idx)) order.push(idx);
    }

    for (const idx of order) {
      const entry = this.entries[idx]!;
      const key = `${entry.apiKey}:${entry.model}`;

      if (this.disabled.has(key)) {
        tried.push(`${entry.model}(disabled)`);
        continue;
      }

      try {
        const content = await chat(
          {
            LLM_BASE_URL: this.compatBaseUrl,
            LLM_API_KEY: entry.apiKey,
            LLM_MODEL: entry.model,
          },
          messages,
          opts,
        );
        // Success — stick to this model.
        if (this.cursor !== idx) {
          console.log(`[pool] switched to "${entry.model}" (cursor=${idx})`);
          this.cursor = idx;
        }
        return { content, model: entry.model };
      } catch (err) {
        const classified = classifyError(err);
        tried.push(`${entry.model}(${classified.kind})`);

        if (classified.kind === "transient") {
          // Retry once on the same model.
          try {
            const content = await chat(
              {
                LLM_BASE_URL: this.compatBaseUrl,
                LLM_API_KEY: entry.apiKey,
                LLM_MODEL: entry.model,
              },
              messages,
              opts,
            );
            if (this.cursor !== idx) {
              console.log(`[pool] switched to "${entry.model}" (cursor=${idx}, after retry)`);
              this.cursor = idx;
            }
            return { content, model: entry.model };
          } catch (err2) {
            const c2 = classifyError(err2);
            tried[tried.length - 1] = `${entry.model}(${c2.kind},retry-fail)`;
            if (c2.kind === "permanent") {
              this.disable(key, entry.model, c2.detail);
            }
            // Continue to next model regardless.
          }
        } else {
          // Permanent — disable and move on.
          this.disable(key, entry.model, classified.detail);
        }
      }
    }

    throw new Error(`all models exhausted: ${tried.join(", ")}`);
  }

  private disable(key: string, model: string, reason: string): void {
    this.disabled.set(key, { model, reason, at: new Date().toISOString() });
    console.log(`[pool] model "${model}" disabled (${reason})`);
  }

  // --- Model discovery ---

  private async fetchModels(apiKey: string): Promise<DSModel[]> {
    const all: DSModel[] = [];
    let page = 1;
    const pageSize = 200;
    // Paginate — typically all TG models fit in one page.
    for (let i = 0; i < 10; i++) {
      const url = `${this.apiBaseUrl}/api/v1/models?capabilities=TG&page_no=${page}&page_size=${pageSize}`;
      const res = await fetch(url, {
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        const detail = await res.text();
        throw new Error(`models API ${res.status}: ${detail.slice(0, 200)}`);
      }
      const json = (await res.json()) as DSModelsResponse;
      if (!json.success || !json.output?.models) {
        throw new Error(`models API error: ${json.code ?? json.message ?? "unknown"}`);
      }
      all.push(...json.output.models);
      const total = json.output.total ?? 0;
      if (all.length >= total || json.output.models.length < pageSize) break;
      page++;
    }
    return this.filterAndSort(all);
  }

  /** Filter to pure-text chat models and sort newest-first. */
  private filterAndSort(models: DSModel[]): DSModel[] {
    const filtered = models.filter((m) => {
      const caps = m.capabilities ?? [];
      // Must have TG (text generation).
      if (!caps.includes("TG")) return false;
      // Exclude VU (visual understanding) — user wants text-only.
      if (caps.includes("VU")) return false;
      // Exclude dated snapshots — the base name (e.g. "qwen-plus") already
      // aliases to the latest snapshot, so dated versions are redundant.
      if (DATED_SNAPSHOT_RE.test(m.model)) return false;

      // Exclude specialized models by name.
      const low = m.model.toLowerCase();
      if (EXCLUDE_NAME_PATTERNS.some((p) => low.includes(p))) return false;

      // Exclude by features.
      const feats = m.features ?? [];
      if (feats.some((f) => EXCLUDE_FEATURES.has(f))) return false;

      return true;
    });

    // Sort by published_time descending (newest first).
    filtered.sort((a, b) => {
      const ta = a.published_time ? Date.parse(a.published_time) : 0;
      const tb = b.published_time ? Date.parse(b.published_time) : 0;
      return tb - ta;
    });

    return filtered;
  }

  private toPoolEntry(m: DSModel, apiKey: string): PoolEntry {
    return {
      apiKey,
      model: m.model,
      name: m.name ?? m.model,
      publishedTime: m.published_time ?? "",
      contextWindow: m.model_info?.context_window ?? null,
    };
  }
}
