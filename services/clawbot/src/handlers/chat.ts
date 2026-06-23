import { createDecipheriv, createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { WeixinMessage } from "ilink/types";

import type { ClawConfig } from "../config.ts";
import { chat, type ContentPart, type Message as LlmMessage } from "../llm.ts";

const MAX_RECENT_MESSAGES = 12;
const MAX_RECENT_CHARS = 16_000;
const OUTGOING_TEXT_LIMIT = 900;
const MEMORY_MAX_CHARS = 1_200;

const SYSTEM_PROMPT = `你是 clawbot，一个在手机聊天窗口里工作的助手。

默认规则：
- 默认使用简体中文，除非用户明确要求其他语言
- 回答要适合手机阅读，优先给短段落、要点和明确结论
- 用户可能会直接粘贴聊天记录、工单内容、会议纪要或零散片段；你需要先整理事实，再回答
- 如果用户要求总结，优先提炼：发生了什么、谁参与、结论、待办、风险
- 如果用户要求起草回复，只能基于当前会话里明确出现的事实，不要编造已完成事项
- 不要假装看到了不存在的图片、附件或未展开链接
- 当信息不足时，直接指出缺少什么，不要硬猜
- 如果用户没有明确要求长文，尽量简洁`;

const MEMORY_SYSTEM_PROMPT = `你负责压缩历史对话，供另一个助手继续会话使用。

只保留：
- 用户的目标和当前问题
- 已确认的事实、结论、决定
- 尚未解决的事项和待办
- 对回复语言、风格、格式的偏好

输出要求：
- 简体中文
- 最多 10 条
- 不要写寒暄
- 不要复制大段原文`;

const DEFAULT_IMAGE_PROMPT = `用户刚发送了一张图片，没有附加说明。

请按这个顺序处理：
1. 先客观描述图片里能看见的主要内容
2. 如果图片里有文字，尽量提取并概括
3. 结合当前会话，判断用户大概率想让我关注什么

约束：
- 默认使用简体中文
- 不要假装看到了看不清的细节
- 不确定就直接说不确定
- 回答保持适合手机阅读，尽量简洁`;

export interface ChatHandlerResult {
  ok: boolean;
  messages: string[];
  error?: string;
}

export interface MessageCapture {
  id: string;
  reason: string;
  summary: string;
}

interface ImageArtifact {
  filePath: string;
  mimeType: string;
  byteLength: number;
  dataUrl: string;
  thumbWidth?: number;
  thumbHeight?: number;
  midSize?: number;
  hdSize?: number;
}

interface StoredSession {
  userId: string;
  summary?: string;
  messages: LlmMessage[];
  createdAt: string;
  updatedAt: string;
}

export async function handleChatMessage(
  config: ClawConfig,
  userId: string,
  text: string,
): Promise<ChatHandlerResult> {
  const env = getChatEnv(config);
  if (!env) {
    return {
      ok: false,
      messages: ["聊天能力未配置：缺少 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL。"],
      error: "llm not configured",
    };
  }

  const session = await loadSession(config, userId);
  session.messages.push({ role: "user", content: text.trim() });
  await condenseSession(config, session, env);

  try {
    const answer = await chat(env, buildPromptMessages(session), {
      temperature: 0.3,
      maxTokens: 1200,
    });
    session.messages.push({ role: "assistant", content: answer });
    await condenseSession(config, session, env);
    await saveSession(config, session);
    return { ok: true, messages: splitOutgoingMessages(answer) };
  } catch (err) {
    session.messages.pop();
    await saveSession(config, session);
    return {
      ok: false,
      messages: [`处理失败：${err instanceof Error ? err.message : String(err)}`],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function resetChatSession(config: ClawConfig, userId: string): Promise<void> {
  await rm(sessionFilePath(config, userId), { force: true });
}

export async function handleImageMessage(
  config: ClawConfig,
  userId: string,
  message: WeixinMessage,
): Promise<ChatHandlerResult> {
  const env = getChatEnv(config);
  if (!env) {
    return {
      ok: false,
      messages: ["聊天能力未配置：缺少 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL。"],
      error: "llm not configured",
    };
  }

  const imageItem = extractImageItem(message);
  if (!imageItem?.fullUrl) {
    return {
      ok: false,
      messages: ["图片消息已收到，但当前还没拿到可下载地址。原始结构已经落盘。"],
      error: "image url missing",
    };
  }

  try {
    const artifact = await downloadImageArtifact(config, imageItem);
    const session = await loadSession(config, userId);
    const imageNote = buildImageSessionNote(artifact);
    session.messages.push({ role: "user", content: imageNote });
    await condenseSession(config, session, env);

    const answer = await chat(
      env,
      [
        ...buildPromptMessages(session),
        {
          role: "user",
          content: buildImagePromptContent(message, artifact),
        },
      ],
      {
        temperature: 0.2,
        maxTokens: 1200,
      },
    );
    session.messages.push({ role: "assistant", content: answer });
    await condenseSession(config, session, env);
    await saveSession(config, session);
    return {
      ok: true,
      messages: splitOutgoingMessages(answer),
    };
  } catch (err) {
    return {
      ok: false,
      messages: [`图片已收到，但下载失败：${err instanceof Error ? err.message : String(err)}`],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function maybeCaptureStructuredMessage(
  config: ClawConfig,
  message: WeixinMessage,
  extractedText?: string,
): Promise<MessageCapture | null> {
  const reason = detectStructuredMessageReason(message, extractedText);
  if (!reason) return null;

  await mkdir(config.captureDir, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(":", "-");
  const id = `${stamp}-${randomUUID().slice(0, 8)}`;
  const summary = buildMessageStructureSummary(message, extractedText);
  await writeFile(
    join(config.captureDir, `${id}.json`),
    JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        reason,
        summary,
        structure: describeMessageStructure(message, extractedText),
        message,
      },
      null,
      2,
    ),
    "utf-8",
  );
  return { id, reason, summary };
}

function getChatEnv(config: ClawConfig): {
  LLM_BASE_URL: string;
  LLM_API_KEY: string;
  LLM_MODEL: string;
} | null {
  if (!config.llmBaseUrl || !config.llmApiKey || !config.llmModel) return null;
  return {
    LLM_BASE_URL: config.llmBaseUrl,
    LLM_API_KEY: config.llmApiKey,
    LLM_MODEL: config.llmModel,
  };
}

function buildPromptMessages(session: StoredSession): LlmMessage[] {
  const system = session.summary?.trim()
    ? `${SYSTEM_PROMPT}

长期记忆摘要：
${session.summary}`
    : SYSTEM_PROMPT;
  return [{ role: "system", content: system }, ...session.messages];
}

async function condenseSession(
  config: ClawConfig,
  session: StoredSession,
  env: {
    LLM_BASE_URL: string;
    LLM_API_KEY: string;
    LLM_MODEL: string;
  },
): Promise<void> {
  if (session.messages.length <= MAX_RECENT_MESSAGES && totalChars(session.messages) <= MAX_RECENT_CHARS) {
    return;
  }

  const keep = session.messages.slice(-MAX_RECENT_MESSAGES);
  const old = session.messages.slice(0, Math.max(0, session.messages.length - MAX_RECENT_MESSAGES));
  if (old.length === 0) return;

  try {
    const content = old
      .map((m, i) => `${i + 1}. ${m.role === "user" ? "用户" : "助手"}：${m.content}`)
      .join("\n\n");
    const summary = await chat(
      env,
      [
        { role: "system", content: MEMORY_SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            session.summary?.trim() ? `已有摘要：\n${session.summary}` : "已有摘要：无",
            "请整合以下较早的对话：",
            content,
          ].join("\n\n"),
        },
      ],
      { temperature: 0.1, maxTokens: 800 },
    );
    session.summary = truncateMemory(summary);
    session.messages = keep;
  } catch {
    session.summary = truncateMemory(buildFallbackSummary(session.summary, old));
    session.messages = keep;
  }

  session.updatedAt = new Date().toISOString();
  await saveSession(config, session);
}

function buildFallbackSummary(existing: string | undefined, messages: LlmMessage[]): string {
  const lines = messages
    .slice(-8)
    .map((m) => `${m.role === "user" ? "用户" : "助手"}：${stringifyMessageContent(m.content).replace(/\s+/g, " ").slice(0, 120)}`);
  return [existing?.trim(), ...lines].filter(Boolean).join("\n");
}

function truncateMemory(summary: string): string {
  return summary.length > MEMORY_MAX_CHARS ? `${summary.slice(0, MEMORY_MAX_CHARS - 1)}…` : summary;
}

function extractImageItem(message: WeixinMessage): {
  fullUrl?: string;
  aesKeyHex?: string;
  thumbWidth?: number;
  thumbHeight?: number;
  midSize?: number;
  hdSize?: number;
} | null {
  for (const item of message.item_list ?? []) {
    const record = asRecord(item);
    if (record.type !== 2) continue;
    const imageItem = asRecord(record.image_item);
    const media = asRecord(imageItem.media);
    return {
      fullUrl: typeof media.full_url === "string" ? media.full_url : undefined,
      aesKeyHex: typeof imageItem.aeskey === "string"
        ? imageItem.aeskey
        : typeof media.aes_key === "string"
          ? decodeBase64Key(media.aes_key)
          : undefined,
      thumbWidth: typeof imageItem.thumb_width === "number" ? imageItem.thumb_width : undefined,
      thumbHeight: typeof imageItem.thumb_height === "number" ? imageItem.thumb_height : undefined,
      midSize: typeof imageItem.mid_size === "number" ? imageItem.mid_size : undefined,
      hdSize: typeof imageItem.hd_size === "number" ? imageItem.hd_size : undefined,
    };
  }
  return null;
}

async function downloadImageArtifact(
  config: ClawConfig,
  image: {
    fullUrl?: string;
    aesKeyHex?: string;
    thumbWidth?: number;
    thumbHeight?: number;
    midSize?: number;
    hdSize?: number;
  },
): Promise<ImageArtifact> {
  if (!image.fullUrl) throw new Error("missing image full_url");
  if (!image.aesKeyHex) throw new Error("missing image aes key");
  await mkdir(config.mediaDir, { recursive: true });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(image.fullUrl, {
      signal: controller.signal,
      headers: {
        "user-agent": config.botAgent,
      },
    });
    if (!res.ok) throw new Error(`image download ${res.status}`);

    const encrypted = Buffer.from(await res.arrayBuffer());
    const buffer = decryptCdnImage(encrypted, image.aesKeyHex);
    const mimeType = sniffImageMimeType(buffer);
    const filePath = join(
      config.mediaDir,
      `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID().slice(0, 8)}${mimeToExt(mimeType)}`,
    );
    await writeFile(filePath, buffer);
    return {
      filePath,
      mimeType,
      byteLength: buffer.byteLength,
      dataUrl: `data:${mimeType};base64,${buffer.toString("base64")}`,
      thumbWidth: image.thumbWidth,
      thumbHeight: image.thumbHeight,
      midSize: image.midSize,
      hdSize: image.hdSize,
    };
  } finally {
    clearTimeout(timer);
  }
}

function buildImageSessionNote(artifact: ImageArtifact): string {
  const dims = artifact.thumbWidth && artifact.thumbHeight
    ? `${artifact.thumbWidth}x${artifact.thumbHeight}`
    : "unknown";
  return [
    "[图片消息]",
    `- 本地文件：${artifact.filePath}`,
    `- MIME：${artifact.mimeType}`,
    `- 文件大小：${artifact.byteLength} bytes`,
    `- 预览尺寸：${dims}`,
    artifact.midSize !== undefined ? `- 中图大小：${artifact.midSize} bytes` : "",
    artifact.hdSize !== undefined ? `- 高清大小：${artifact.hdSize} bytes` : "",
    "- 这张图片的明文文件已经可用，后续轮次如有需要可以继续结合图片内容分析。",
  ].filter(Boolean).join("\n");
}

function buildImagePromptContent(message: WeixinMessage, artifact: ImageArtifact): ContentPart[] {
  const text = extractUserTextHint(message);
  const prompt = text
    ? `用户发送了一张图片，并附带了这句说明：\n${text}\n\n你现在可以直接查看这张图片本身。请结合图片和这句说明回答，不要说自己看不到图片。`
    : `${DEFAULT_IMAGE_PROMPT}\n\n你现在可以直接查看这张图片本身，不要说自己看不到图片。`;
  return [
    { type: "text", text: prompt },
    {
      type: "image_url",
      image_url: {
        url: artifact.dataUrl,
      },
    },
  ];
}

function extractUserTextHint(message: WeixinMessage): string {
  const parts = (message.item_list ?? [])
    .filter((item) => item.type === 1 && item.text_item?.text)
    .map((item) => item.text_item?.text?.trim() ?? "")
    .filter(Boolean);
  return parts.join("\n").trim();
}

function normalizeMimeType(value: string | null): string {
  return value?.split(";")[0]?.trim().toLowerCase() || "application/octet-stream";
}

function decodeBase64Key(base64: string): string | undefined {
  try {
    const raw = Buffer.from(base64, "base64");
    return raw.length > 0 ? raw.toString("hex") : undefined;
  } catch {
    return undefined;
  }
}

function decryptCdnImage(encrypted: Buffer, aesKeyHex: string): Buffer {
  const key = Buffer.from(aesKeyHex, "hex");
  if (key.length !== 16) throw new Error(`invalid aes key length: ${key.length}`);

  const decipher = createDecipheriv("aes-128-ecb", key, null);
  decipher.setAutoPadding(false);
  const plain = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return stripPkcs7Padding(plain);
}

function stripPkcs7Padding(buffer: Buffer): Buffer {
  if (buffer.length === 0) return buffer;
  const pad = buffer[buffer.length - 1]!;
  if (pad < 1 || pad > 16 || pad > buffer.length) return buffer;
  for (let i = 1; i <= pad; i += 1) {
    if (buffer[buffer.length - i] !== pad) return buffer;
  }
  return buffer.subarray(0, buffer.length - pad);
}

function sniffImageMimeType(buffer: Buffer): string {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return "image/png";
  }
  if (buffer.length >= 6 && buffer.subarray(0, 6).toString("ascii") === "GIF87a") {
    return "image/gif";
  }
  if (buffer.length >= 6 && buffer.subarray(0, 6).toString("ascii") === "GIF89a") {
    return "image/gif";
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return "application/octet-stream";
}

function mimeToExt(mimeType: string): string {
  switch (mimeType) {
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/webp":
      return ".webp";
    case "image/gif":
      return ".gif";
    default:
      return ".bin";
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function stringifyMessageContent(content: string | ContentPart[]): string {
  if (typeof content === "string") return content;
  return content
    .map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "image_url") return "[image]";
      return "[content]";
    })
    .join(" ");
}

function detectStructuredMessageReason(
  message: WeixinMessage,
  extractedText?: string,
): string | null {
  const items = message.item_list ?? [];
  if (items.length === 0) return "missing-item-list";

  const hasNonTextItem = items.some((item) => item.type !== 1 || hasExtraItemFields(item));
  if (hasNonTextItem) return "structured-item-list";
  if (!extractedText?.trim()) return "empty-text";
  return null;
}

function describeMessageStructure(message: WeixinMessage, extractedText?: string): Record<string, unknown> {
  const items = message.item_list ?? [];
  return {
    messageType: message.message_type ?? null,
    messageState: message.message_state ?? null,
    topLevelKeys: Object.keys(message as Record<string, unknown>),
    itemCount: items.length,
    itemTypes: items.map((item) => item.type ?? null),
    itemShapes: items.map((item, index) => describeItemShape(item, index)),
    extractedTextLength: extractedText?.length ?? 0,
    extractedTextPreview: extractedText?.slice(0, 200) ?? "",
  };
}

function describeItemShape(item: unknown, index: number): Record<string, unknown> {
  const record = asRecord(item);
  const keys = Object.keys(record);
  return {
    index,
    type: typeof record.type === "number" ? record.type : null,
    keys,
    hint: inferStructureHint(keys),
  };
}

function buildMessageStructureSummary(message: WeixinMessage, extractedText?: string): string {
  const items = message.item_list ?? [];
  const hints = items
    .map((item, index) => {
      const record = asRecord(item);
      const keys = Object.keys(record);
      const hint = inferStructureHint(keys);
      return `#${index}:${record.type ?? "?"}:${hint}:${keys.join("|")}`;
    })
    .join(", ");
  return `message_type=${message.message_type ?? "?"}; items=${items.length}; extracted_text=${extractedText?.length ?? 0}; ${hints || "no-items"}`;
}

function hasExtraItemFields(item: unknown): boolean {
  const keys = Object.keys(asRecord(item));
  return keys.some((key) => key !== "type" && key !== "text_item");
}

function inferStructureHint(keys: string[]): string {
  const lower = keys.map((key) => key.toLowerCase());
  if (lower.some((key) => key.includes("image") || key.includes("img") || key.includes("pic"))) {
    return "image-like";
  }
  if (lower.some((key) => key.includes("merge") || key.includes("record") || key.includes("forward") || key.includes("chat"))) {
    return "merged-chat-like";
  }
  if (lower.includes("text_item")) return "text-like";
  return "unknown";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function splitOutgoingMessages(text: string): string[] {
  const normalized = text.trim();
  if (!normalized) return ["(空响应)"];

  const chunks = splitByParagraphs(normalized, OUTGOING_TEXT_LIMIT);
  if (chunks.length <= 1) return chunks;
  return chunks.map((chunk, index) => `(${index + 1}/${chunks.length})\n${chunk}`);
}

function splitByParagraphs(text: string, limit: number): string[] {
  const paragraphs = text.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  if (paragraphs.length === 0) return splitHard(text, limit);

  const chunks: string[] = [];
  let current = "";
  for (const part of paragraphs) {
    const candidate = current ? `${current}\n\n${part}` : part;
    if (candidate.length <= limit) {
      current = candidate;
      continue;
    }
    if (current) chunks.push(current);
    if (part.length <= limit) {
      current = part;
      continue;
    }
    const hard = splitHard(part, limit);
    chunks.push(...hard.slice(0, -1));
    current = hard[hard.length - 1] ?? "";
  }
  if (current) chunks.push(current);
  return chunks.length > 0 ? chunks : splitHard(text, limit);
}

function splitHard(text: string, limit: number): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < Math.floor(limit * 0.5)) cut = rest.lastIndexOf("。", limit);
    if (cut < Math.floor(limit * 0.5)) cut = rest.lastIndexOf(" ", limit);
    if (cut < Math.floor(limit * 0.5)) cut = limit;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks.filter(Boolean);
}

function totalChars(messages: LlmMessage[]): number {
  return messages.reduce((sum, message) => sum + message.content.length, 0);
}

async function loadSession(config: ClawConfig, userId: string): Promise<StoredSession> {
  const file = sessionFilePath(config, userId);
  try {
    const raw = await readFile(file, "utf-8");
    return JSON.parse(raw) as StoredSession;
  } catch {
    const now = new Date().toISOString();
    return {
      userId,
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
  }
}

async function saveSession(config: ClawConfig, session: StoredSession): Promise<void> {
  await mkdir(config.sessionDir, { recursive: true });
  session.updatedAt = new Date().toISOString();
  await writeFile(sessionFilePath(config, session.userId), JSON.stringify(session, null, 2), "utf-8");
}

function sessionFilePath(config: ClawConfig, userId: string): string {
  const key = createHash("sha1").update(userId).digest("hex");
  return join(config.sessionDir, `${key}.json`);
}
