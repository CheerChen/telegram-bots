import type { SourceType } from "./url.ts";

export interface CachedContext {
  id: string;
  url: string;
  markdown: string;
  sourceType: SourceType;
  createdAt: string;
}

const CONTEXT_PREFIX = "ctxd:context:";
const LATEST_PREFIX = "ctxd:latest:";

export function newContextId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

function contextKey(id: string): string {
  return `${CONTEXT_PREFIX}${id}`;
}

function latestKey(scope: string, id: string | number): string {
  return `${LATEST_PREFIX}${scope}:${id}`;
}

export async function putContext(kv: KVNamespace, context: CachedContext): Promise<void> {
  await kv.put(contextKey(context.id), JSON.stringify(context));
}

export async function getContext(kv: KVNamespace, id: string): Promise<CachedContext | null> {
  const raw = await kv.get(contextKey(id));
  return raw ? (JSON.parse(raw) as CachedContext) : null;
}

export async function deleteContext(kv: KVNamespace, id: string): Promise<void> {
  await kv.delete(contextKey(id));
}

export async function setLatestContextId(
  kv: KVNamespace,
  scope: string,
  id: string | number,
  contextId: string,
): Promise<void> {
  await kv.put(latestKey(scope, id), contextId);
}

export async function getLatestContextId(
  kv: KVNamespace,
  scope: string,
  id: string | number,
): Promise<string | null> {
  return kv.get(latestKey(scope, id));
}

export async function deleteLatestContextId(
  kv: KVNamespace,
  scope: string,
  id: string | number,
): Promise<void> {
  await kv.delete(latestKey(scope, id));
}
