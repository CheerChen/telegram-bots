export type Role = "system" | "user" | "assistant";

export interface TextContentPart {
  type: "text";
  text: string;
}

export interface ImageUrlContentPart {
  type: "image_url";
  image_url: {
    url: string;
  };
}

export type ContentPart = TextContentPart | ImageUrlContentPart;

export interface Message {
  role: Role;
  content: string | ContentPart[];
}

export interface ChatEnv {
  LLM_BASE_URL: string;
  LLM_API_KEY: string;
  LLM_MODEL: string;
}

interface ChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
}

export async function chat(
  env: ChatEnv,
  messages: Message[],
  opts: ChatOptions = {},
): Promise<string> {
  const body: Record<string, unknown> = {
    model: env.LLM_MODEL,
    messages,
    temperature: opts.temperature ?? 0.3,
    enable_thinking: false,
  };
  if (opts.maxTokens !== undefined) body.max_tokens = opts.maxTokens;

  const res = await fetch(`${env.LLM_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.LLM_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`llm ${res.status}: ${detail.slice(0, 200)}`);
  }

  const json = (await res.json()) as ChatResponse;
  const content = json.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.length === 0) {
    throw new Error("llm: empty response");
  }
  return content;
}

// --- Error classification for model-pool fallback ---

export type ErrorClass = {
  kind: "permanent" | "transient";
  detail: string;
};

const PERMANENT_KEYWORDS = [
  "FreeTierOnly",
  "Arrearage",
  "AccessDenied",
  "invalid_api_key",
  "ModelNotFound",
  "model_not_found",
  "Unauthorized",
];

const TRANSIENT_KEYWORDS = [
  "RateQuota",
  "Concurrency",
  "AllocationQuota",
  "insufficient_quota",
  "Too many requests",
  "ServiceUnavailable",
  "InternalError",
  "timeout",
];

export function classifyError(err: unknown): ErrorClass {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();

  // Network / timeout errors are transient.
  if (lower.includes("timeout") || lower.includes("abort") || lower.includes("econn")) {
    return { kind: "transient", detail: msg.slice(0, 120) };
  }

  // Check HTTP status embedded in the error message (e.g. "llm 403: ...").
  const statusMatch = msg.match(/llm (\d{3})/);
  const status = statusMatch ? parseInt(statusMatch[1]!, 10) : 0;

  if (status === 403 || status === 401 || status === 404) {
    return { kind: "permanent", detail: msg.slice(0, 120) };
  }

  if (status === 429 || status >= 500) {
    return { kind: "transient", detail: msg.slice(0, 120) };
  }

  // Keyword-based fallback for error codes in the body.
  for (const kw of PERMANENT_KEYWORDS) {
    if (msg.includes(kw)) return { kind: "permanent", detail: msg.slice(0, 120) };
  }
  for (const kw of TRANSIENT_KEYWORDS) {
    if (msg.includes(kw)) return { kind: "transient", detail: msg.slice(0, 120) };
  }

  // Unknown — treat as permanent to avoid retrying broken models.
  return { kind: "permanent", detail: msg.slice(0, 120) };
}
