export type Role = "system" | "user" | "assistant";

export interface Message {
  role: Role;
  content: string;
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
