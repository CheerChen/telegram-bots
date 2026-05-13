import sc2jp from "./sc2jp.json";
import { escapeHtml } from "./telegram.ts";

interface JotobaReading {
  kana?: string;
  kanji?: string;
}

interface JotobaSense {
  glosses: string[];
  pos?: unknown[];
  language?: string;
}

interface JotobaWord {
  reading: JotobaReading;
  common?: boolean;
  senses: JotobaSense[];
}

interface JotobaResponse {
  words?: JotobaWord[];
}

export interface Sense {
  pos: string;
  def: string;
}

export interface Entry {
  reading: string;
  word?: string;
  senses: Sense[];
}

export type LookupResult =
  | { kind: "ok"; entry: Entry }
  | { kind: "notfound"; query: string }
  | { kind: "error"; query: string; reason: string };

const CJK_RE = /[一-鿿]/;
const KATAKANA_RE = /[ァ-ヺー-ヿ]/g;
const STRIP_RE = /[・\s]/g;
const MAX_LEN = 4000;
const CACHE_TTL_SECONDS = 60 * 60 * 24 * 30;
const CACHE_PREFIX = "q2:";

const mapping = sc2jp as Record<string, string | string[]>;

function isCjkInput(text: string): boolean {
  return CJK_RE.test(text);
}

function isKatakanaReading(reading: string | undefined): boolean {
  if (!reading) return false;
  const stripped = reading.replace(STRIP_RE, "");
  if (stripped.length === 0) return false;
  const matches = reading.match(KATAKANA_RE);
  return (matches?.length ?? 0) / stripped.length >= 0.8;
}

function simplifiedToJapaneseCandidates(text: string): string[] {
  let results: string[] = [""];
  for (const c of text) {
    const mapped = mapping[c] ?? c;
    const candidates = Array.isArray(mapped) ? mapped : [mapped];
    const next: string[] = [];
    for (const r of results) {
      for (const ch of candidates) next.push(r + ch);
    }
    results = next;
  }
  return results;
}

function posLabels(pos: unknown[] | undefined): string {
  if (!pos) return "";
  const labels: string[] = [];
  const seen = new Set<string>();
  for (const p of pos) {
    let label: string | undefined;
    if (typeof p === "string") label = p;
    else if (p && typeof p === "object") label = Object.keys(p as Record<string, unknown>)[0];
    if (label && !seen.has(label)) {
      seen.add(label);
      labels.push(label);
    }
  }
  return labels.join(", ");
}

function toEntry(w: JotobaWord, readingOverride?: string): Entry {
  const reading = readingOverride ?? w.reading.kana!;
  return {
    reading,
    word: w.reading.kanji,
    senses: w.senses.slice(0, 2).map((s) => ({
      pos: posLabels(s.pos),
      def: s.glosses.join("; "),
    })),
  };
}

async function jotobaSearch(query: string): Promise<JotobaWord[]> {
  const res = await fetch("https://jotoba.de/api/search/words", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, language: "English", no_english: false }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`jotoba ${res.status}`);
  const json = (await res.json()) as JotobaResponse;
  return json.words ?? [];
}

async function lookupKanji(query: string): Promise<Entry[]> {
  const candidates = simplifiedToJapaneseCandidates(query);
  const queries = Array.from(new Set([...candidates, query]));
  const exactCandidates = new Set(candidates);

  const entries: Entry[] = [];
  const seen = new Set<string>();

  for (const q of queries) {
    const words = await jotobaSearch(q);
    for (const w of words) {
      const word = w.reading.kanji;
      const reading = w.reading.kana;
      if (!word || !reading) continue;
      if (query.length > 1 && word.length < query.length) continue;

      const match =
        candidates.some((c) => word.includes(c) || c.includes(word)) ||
        word.includes(query) ||
        query.includes(word);
      if (!match) continue;

      const key = `${word}:${reading}`;
      if (seen.has(key)) continue;
      seen.add(key);

      entries.push(toEntry(w));
    }
  }

  entries.sort((a, b) => {
    return Number(!exactCandidates.has(a.word ?? "")) - Number(!exactCandidates.has(b.word ?? ""));
  });
  return entries;
}

function isExactKatakanaMatch(w: JotobaWord, query: string): boolean {
  if (w.reading.kanji) return false;
  if (!isKatakanaReading(w.reading.kana)) return false;
  const defs = w.senses[0]?.glosses ?? [];
  const q = query.toLowerCase();
  return defs.some((d) => d.toLowerCase() === q || d.toLowerCase().startsWith(q));
}

async function lookupEnglish(query: string): Promise<Entry[]> {
  const data = await jotobaSearch(query);

  const sorted = [...data].sort((a, b) => {
    return Number(!isExactKatakanaMatch(a, query)) - Number(!isExactKatakanaMatch(b, query));
  });

  const entries: Entry[] = [];
  const seen = new Set<string>();
  for (const w of sorted) {
    const reading = w.reading.kana;
    if (!reading || w.reading.kanji) continue;
    if (!isKatakanaReading(reading)) continue;
    if (seen.has(reading)) continue;
    seen.add(reading);
    entries.push(toEntry(w, reading));
  }
  return entries;
}

export function renderHtml(entry: Entry): string {
  const reading = escapeHtml(entry.reading);
  const head = entry.word
    ? `<code>${reading}</code>（${escapeHtml(entry.word)}）`
    : `<code>${reading}</code>`;
  const senses = entry.senses
    .map((s) => (s.pos ? `<i>[${escapeHtml(s.pos)}]</i> ${escapeHtml(s.def)}` : escapeHtml(s.def)))
    .filter(Boolean)
    .join(" | ");
  const html = senses ? `${head}\n${senses}` : head;
  return html.length > MAX_LEN ? `${html.slice(0, MAX_LEN - 15)}\n…(truncated)` : html;
}

export function renderPlain(entry: Entry): string {
  const head = entry.word ? `${entry.reading}（${entry.word}）` : entry.reading;
  const senses = entry.senses
    .map((s) => (s.pos ? `[${s.pos}] ${s.def}` : s.def))
    .filter(Boolean)
    .join(" | ");
  const text = senses ? `${head}\n${senses}` : head;
  return text.length > MAX_LEN ? `${text.slice(0, MAX_LEN - 15)}\n…(truncated)` : text;
}

export async function lookup(query: string, cache?: KVNamespace): Promise<LookupResult> {
  if (!query) return { kind: "notfound", query };

  const cacheKey = `${CACHE_PREFIX}${query}`;
  if (cache) {
    const cached = await cache.get(cacheKey);
    if (cached) return JSON.parse(cached) as LookupResult;
  }

  let entries: Entry[];
  try {
    entries = isCjkInput(query) ? await lookupKanji(query) : await lookupEnglish(query);
  } catch (e) {
    return {
      kind: "error",
      query,
      reason: e instanceof Error ? e.message : String(e),
    };
  }

  const result: LookupResult =
    entries.length === 0 ? { kind: "notfound", query } : { kind: "ok", entry: entries[0]! };

  if (cache) {
    await cache.put(cacheKey, JSON.stringify(result), { expirationTtl: CACHE_TTL_SECONDS });
  }
  return result;
}
