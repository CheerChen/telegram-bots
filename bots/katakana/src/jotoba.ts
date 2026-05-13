import { escapeHtml } from "shared/telegram";
import sc2jp from "./sc2jp.json";

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

interface Result {
  reading: string;
  word?: string;
  definition: string;
}

export type LookupResult =
  | { kind: "ok"; html: string }
  | { kind: "notfound"; query: string }
  | { kind: "error"; query: string; reason: string };

const CJK_RE = /[一-鿿]/;
const KATAKANA_RE = /[ァ-ヺー-ヿ]/g;
const STRIP_RE = /[・\s]/g;
const MAX_LEN = 4000;
const CACHE_TTL_SECONDS = 60 * 60 * 24 * 30;

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

function formatSenseHtml(sense: JotobaSense | undefined): string {
  if (!sense) return "";
  const pos = posLabels(sense.pos);
  const def = sense.glosses.join("; ");
  if (!pos) return escapeHtml(def);
  return `<i>[${escapeHtml(pos)}]</i> ${escapeHtml(def)}`;
}

async function jotobaSearch(query: string): Promise<JotobaWord[]> {
  const res = await fetch("https://jotoba.de/api/search/words", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, language: "English", no_english: false }),
  });
  if (!res.ok) throw new Error(`jotoba ${res.status}`);
  const json = (await res.json()) as JotobaResponse;
  return json.words ?? [];
}

async function lookupKanji(query: string): Promise<Result[]> {
  const candidates = simplifiedToJapaneseCandidates(query);
  const queries = Array.from(new Set([...candidates, query]));
  const exactCandidates = new Set(candidates);

  const results: Result[] = [];
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

      const definition = w.senses.slice(0, 2).map(formatSenseHtml).filter(Boolean).join(" | ");
      results.push({ reading, word, definition });
    }
  }

  results.sort((a, b) => {
    return Number(!exactCandidates.has(a.word ?? "")) - Number(!exactCandidates.has(b.word ?? ""));
  });
  return results;
}

function isExactKatakanaMatch(w: JotobaWord, query: string): boolean {
  if (w.reading.kanji) return false;
  if (!isKatakanaReading(w.reading.kana)) return false;
  const defs = w.senses[0]?.glosses ?? [];
  const q = query.toLowerCase();
  return defs.some((d) => d.toLowerCase() === q || d.toLowerCase().startsWith(q));
}

async function lookupEnglish(query: string): Promise<Result[]> {
  const data = await jotobaSearch(query);

  const sorted = [...data].sort((a, b) => {
    return Number(!isExactKatakanaMatch(a, query)) - Number(!isExactKatakanaMatch(b, query));
  });

  const results: Result[] = [];
  const seen = new Set<string>();
  for (const w of sorted) {
    const reading = w.reading.kana;
    if (!reading || w.reading.kanji) continue;
    if (!isKatakanaReading(reading)) continue;
    if (seen.has(reading)) continue;
    seen.add(reading);
    results.push({ reading, definition: formatSenseHtml(w.senses[0]) });
  }
  return results;
}

function renderHtml(r: Result): string {
  const reading = escapeHtml(r.reading);
  const head = r.word ? `<code>${reading}</code>（${escapeHtml(r.word)}）` : `<code>${reading}</code>`;
  const html = r.definition ? `${head}\n${r.definition}` : head;
  return html.length > MAX_LEN ? `${html.slice(0, MAX_LEN - 15)}\n…(truncated)` : html;
}

export async function lookup(query: string, cache?: KVNamespace): Promise<LookupResult> {
  if (!query) return { kind: "notfound", query };

  const cacheKey = `q:${query}`;
  if (cache) {
    const cached = await cache.get(cacheKey);
    if (cached) return JSON.parse(cached) as LookupResult;
  }

  let results: Result[];
  try {
    results = isCjkInput(query) ? await lookupKanji(query) : await lookupEnglish(query);
  } catch (e) {
    return {
      kind: "error",
      query,
      reason: e instanceof Error ? e.message : String(e),
    };
  }

  const result: LookupResult =
    results.length === 0
      ? { kind: "notfound", query }
      : { kind: "ok", html: renderHtml(results[0]!) };

  if (cache) {
    await cache.put(cacheKey, JSON.stringify(result), { expirationTtl: CACHE_TTL_SECONDS });
  }
  return result;
}
