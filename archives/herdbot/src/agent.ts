import { query, type SDKMessage, type Options } from "@anthropic-ai/claude-agent-sdk";

import type { HerdConfig } from "./config.ts";
import { ctxdEnv } from "./config.ts";
import { buildSystemPrompt, INITIAL_SUMMARY_INSTRUCTION } from "./prompts.ts";

/**
 * The agent has one tool: `ctxd <url>`. We restrict Bash to exactly that
 * command prefix so Claude cannot run arbitrary shell commands.
 *
 * `disallowedTools` blocks every built-in tool by name, then
 * `allowedTools: ["Bash(ctxd:*)"]` re-enables only ctxd-prefixed bash.
 * The SDK's permission model: allowedTools auto-approves without prompting;
 * disallowedTools hard-denies. Tools not in either list fall through to
 * permissionMode — we use "default" which would prompt, but since every
 * built-in is disallowed, the only tool that survives is our ctxd bash rule.
 */
const AGENT_OPTIONS_BASE: Partial<Options> = {
  // Allow only ctxd-prefixed bash commands; deny everything else.
  allowedTools: ["Bash(ctxd:*)"],
  disallowedTools: [
    "Read",
    "Write",
    "Edit",
    "Glob",
    "Grep",
    "WebFetch",
    "WebSearch",
    "Task",
    "NotebookEdit",
    "MultiEdit",
  ],
  permissionMode: "default",
};

export interface AgentTurnResult {
  /** The final text answer from the assistant. */
  text: string;
  /** The session ID (stable across turns, used for resume). */
  sessionId: string;
  /** True if this was the first turn of a new session. */
  isNewSession: boolean;
}

/**
 * Run one agent turn.
 *
 * - If `resumeSessionId` is provided, the SDK resumes that session.
 * - If `isFirstTurn` is true, the prompt is wrapped with the initial
 *   summary instruction so the first response follows the scannable format.
 * - `onProgress` is called with intermediate assistant text (for
 *   editMessageText progress updates).
 */
/**
 * Set up the environment variables the Claude Agent SDK (bundled Claude Code
 * binary) reads at startup. Supports two modes:
 *
 * 1. Native Anthropic API: ANTHROPIC_API_KEY set, no ANTHROPIC_BASE_URL.
 * 2. DashScope Anthropic-compatible endpoint: ANTHROPIC_AUTH_TOKEN holds the
 *    DashScope key, ANTHROPIC_API_KEY is empty, ANTHROPIC_BASE_URL points at
 *    /apps/anthropic. Model names are Qwen (e.g. qwen3.7-plus), not Claude.
 */
function configureAgentEnv(config: HerdConfig): void {
  if (config.anthropicBaseUrl) {
    process.env.ANTHROPIC_BASE_URL = config.anthropicBaseUrl;
  }
  if (config.anthropicAuthToken) {
    process.env.ANTHROPIC_AUTH_TOKEN = config.anthropicAuthToken;
    // DashScope requires ANTHROPIC_API_KEY to be empty (not unset) to prevent
    // the SDK from trying OAuth fallback.
    process.env.ANTHROPIC_API_KEY = "";
  } else {
    process.env.ANTHROPIC_API_KEY = config.anthropicApiKey;
  }
  if (config.claudeModel) {
    // The SDK uses sonnet as the default tier; point all three at the same
    // model so it works regardless of which tier the SDK picks.
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = config.claudeModel;
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = config.claudeModel;
    process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = config.claudeModel;
  }
  // The agent's Bash tool inherits process.env; export the ctxd credential
  // mapping (notably ATLASSIAN_* → CONFLUENCE_*) so bare `ctxd` sees the same
  // credentials the bridge's spawn path used to pass explicitly.
  Object.assign(process.env, ctxdEnv(config));
  // Disable experimental betas — DashScope's Qwen endpoint doesn't support them.
  if (config.anthropicAuthToken) {
    process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = "1";
  }
}

export async function runAgentTurn(opts: {
  config: HerdConfig;
  prompt: string;
  resumeSessionId?: string;
  isFirstTurn?: boolean;
  cwd?: string;
  onProgress?: (text: string) => void;
}): Promise<AgentTurnResult> {
  const { config, prompt, resumeSessionId, isFirstTurn, cwd, onProgress } = opts;

  configureAgentEnv(config);
  const systemPrompt = await buildSystemPrompt(config);
  const fullPrompt = isFirstTurn
    ? `${prompt}\n\n${INITIAL_SUMMARY_INSTRUCTION}`
    : prompt;

  const options: Options = {
    ...AGENT_OPTIONS_BASE,
    systemPrompt,
    ...(config.claudeModel ? { model: config.claudeModel } : {}),
    ...(cwd ? { cwd } : {}),
    ...(resumeSessionId ? { resume: resumeSessionId } : {}),
    // Keep the agent from spiraling on tool errors.
    maxTurns: 10,
  };

  let finalText = "";
  let sessionId = resumeSessionId ?? "";
  let lastAssistantText = "";

  // If resume fails (e.g. session data lost on container rebuild, or the
  // DashScope endpoint doesn't persist sessions), retry as a new session.
  const runStream = async (opts: { resume?: string }): Promise<void> => {
    const streamOptions: Options = { ...options };
    if (opts.resume) streamOptions.resume = opts.resume;
    else delete streamOptions.resume;

    const stream = query({ prompt: fullPrompt, options: streamOptions });

    for await (const message of stream as AsyncIterable<SDKMessage>) {
      switch (message.type) {
        case "assistant": {
          const content = message.message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === "text" && typeof block.text === "string") {
                lastAssistantText = block.text;
              }
            }
          }
          if (message.session_id) sessionId = message.session_id;
          if (onProgress && lastAssistantText) onProgress(lastAssistantText);
          break;
        }
        case "result": {
          if (message.session_id) sessionId = message.session_id;
          if (message.subtype === "success") {
            finalText = message.result || lastAssistantText;
          } else {
            const errors = "errors" in message ? message.errors : [];
            finalText = errors.length
              ? `处理出错：${errors.join("; ")}`
              : lastAssistantText || "处理失败。";
          }
          break;
        }
        default:
          break;
      }
    }
  };

  try {
    await runStream(resumeSessionId ? { resume: resumeSessionId } : {});
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // If resume failed, retry without resume (fresh session).
    if (resumeSessionId && /No conversation found|session/i.test(msg)) {
      console.log(`[agent] resume failed (${msg}), starting fresh session`);
      sessionId = "";
      lastAssistantText = "";
      finalText = "";
      await runStream({});
    } else {
      throw e;
    }
  }

  if (!finalText) finalText = lastAssistantText || "（无输出）";
  if (!sessionId) {
    // Should not happen, but guard against it.
    throw new Error("agent returned no session_id");
  }

  return {
    text: finalText,
    sessionId,
    isNewSession: !resumeSessionId,
  };
}
