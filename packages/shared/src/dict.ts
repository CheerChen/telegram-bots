import sc2jp from "./sc2jp.json";
import { escapeHtml } from "./telegram.ts";

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
const TIMEOUT_MS = 8000;

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

// ---------------------------------------------------------------------------
// Jisho.org adapter
// ---------------------------------------------------------------------------

interface JishoJapanese {
  word?: string;
  reading: string;
}

interface JishoSense {
  english_definitions: string[];
  parts_of_speech: string[];
}

interface JishoWord {
  japanese: JishoJapanese[];
  senses: JishoSense[];
}

interface JishoResponse {
  data?: JishoWord[];
}

async function jishoSearch(query: string): Promise<JishoWord[]> {
  const url = `https://jisho.org/api/v1/search/words?keyword=${encodeURIComponent(query)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`jisho ${res.status}`);
  const json = (await res.json()) as JishoResponse;
  return json.data ?? [];
}

function jishoToEntry(w: JishoWord): Entry {
  const jp = w.japanese[0]!;
  return {
    reading: jp.reading,
    word: jp.word,
    senses: w.senses.slice(0, 2).map((s) => ({
      pos: s.parts_of_speech.filter(Boolean).join(", "),
      def: s.english_definitions.join("; "),
    })),
  };
}

function jishoIsExactKatakanaMatch(w: JishoWord, query: string): boolean {
  const jp = w.japanese[0];
  if (!jp || jp.word) return false;
  if (!isKatakanaReading(jp.reading)) return false;
  const defs = w.senses[0]?.english_definitions ?? [];
  const q = query.toLowerCase();
  return defs.some((d) => d.toLowerCase() === q || d.toLowerCase().startsWith(q));
}

async function jishoLookupKanji(query: string, candidates: string[]): Promise<Entry[]> {
  const results = await Promise.all(candidates.map((c) => jishoSearch(c)));
  const exactCandidates = new Set(candidates);

  const entries: Entry[] = [];
  const seen = new Set<string>();
  for (const words of results) {
    for (const w of words) {
      const jp = w.japanese[0];
      if (!jp) continue;
      const word = jp.word;
      const reading = jp.reading;
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
      entries.push(jishoToEntry(w));
    }
  }

  entries.sort(
    (a, b) =>
      Number(!exactCandidates.has(a.word ?? "")) -
      Number(!exactCandidates.has(b.word ?? "")),
  );
  return entries;
}

async function jishoLookupEnglish(query: string): Promise<Entry[]> {
  const data = await jishoSearch(query);
  const sorted = [...data].sort(
    (a, b) =>
      Number(!jishoIsExactKatakanaMatch(a, query)) -
      Number(!jishoIsExactKatakanaMatch(b, query)),
  );

  const entries: Entry[] = [];
  const seen = new Set<string>();
  for (const w of sorted) {
    const jp = w.japanese[0];
    if (!jp) continue;
    const reading = jp.reading;
    if (!reading || jp.word) continue;
    if (!isKatakanaReading(reading)) continue;
    if (seen.has(reading)) continue;
    seen.add(reading);
    entries.push(jishoToEntry(w));
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Genji (dict-api.illusions.app) adapter
// ---------------------------------------------------------------------------

interface GenjiReading {
  primary: string;
}

interface GenjiDefinition {
  gloss: string;
  index: number;
}

interface GenjiEntry {
  entry: string;
  reading: GenjiReading;
  grammar: { pos: string[] };
  definitions: GenjiDefinition[];
}

interface GenjiLookupResponse {
  entries?: GenjiEntry[];
}

interface GenjiSearchDefItem {
  entry: string;
  gloss: string;
  reading_primary: string;
}

interface GenjiSearchDefResponse {
  results?: GenjiSearchDefItem[];
}

async function genjiLookupEntry(word: string): Promise<GenjiEntry | null> {
  const url = `https://dict-api.illusions.app/v1/lookup/entry?word=${encodeURIComponent(word)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`genji ${res.status}`);
  const json = (await res.json()) as GenjiLookupResponse;
  return json.entries?.[0] ?? null;
}

async function genjiSearchDefinitions(query: string, limit: number): Promise<GenjiSearchDefItem[]> {
  const url =
    `https://dict-api.illusions.app/v1/search/definitions?q=${encodeURIComponent(query)}` +
    `&limit=${limit}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`genji ${res.status}`);
  const json = (await res.json()) as GenjiSearchDefResponse;
  return json.results ?? [];
}

function genjiToEntry(e: GenjiEntry): Entry {
  const pos = e.grammar?.pos?.filter(Boolean).join(", ") ?? "";
  return {
    reading: e.reading.primary,
    word: CJK_RE.test(e.entry) ? e.entry : undefined,
    senses: e.definitions.slice(0, 2).map((d) => ({ pos, def: d.gloss })),
  };
}

async function genjiLookupKanji(query: string, candidates: string[]): Promise<Entry[]> {
  const results = await Promise.all(candidates.map((c) => genjiLookupEntry(c)));
  const exactCandidates = new Set(candidates);

  const entries: Entry[] = [];
  const seen = new Set<string>();
  for (const entry of results) {
    if (!entry) continue;
    const word = entry.entry;
    const reading = entry.reading?.primary;
    if (!reading) continue;
    if (query.length > 1 && word.length < query.length) continue;

    const match =
      candidates.some((c) => word.includes(c) || c.includes(word)) ||
      word.includes(query) ||
      query.includes(word);
    if (!match) continue;

    const key = `${word}:${reading}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(genjiToEntry(entry));
  }

  entries.sort(
    (a, b) =>
      Number(!exactCandidates.has(a.word ?? "")) -
      Number(!exactCandidates.has(b.word ?? "")),
  );
  return entries;
}

async function genjiLookupEnglish(query: string): Promise<Entry[]> {
  // Genji's search/definitions is a full-text search on English glosses.
  // Simple katakana words (e.g. ソフト, コンピュータ) are buried under compound
  // words ("soft focus", "analog computer"). Restrict to exact gloss matches
  // so Genji only wins the race when it has a true hit; otherwise Jisho wins.
  const results = await genjiSearchDefinitions(query, 50);
  const q = query.toLowerCase();

  const entries: Entry[] = [];
  const seen = new Set<string>();
  for (const r of results) {
    if (r.gloss.toLowerCase() !== q) continue;
    if (CJK_RE.test(r.entry)) continue;
    if (!isKatakanaReading(r.reading_primary)) continue;
    if (seen.has(r.reading_primary)) continue;
    seen.add(r.reading_primary);
    entries.push({
      reading: r.reading_primary,
      senses: [{ pos: "", def: r.gloss }],
    });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Race: first source to return a non-empty result wins
// ---------------------------------------------------------------------------

async function raceFirstNonEmpty(promises: Promise<Entry[]>[]): Promise<Entry[]> {
  return new Promise((resolve, reject) => {
    let remaining = promises.length;
    const errors: unknown[] = [];

    for (const p of promises) {
      p.then((result) => {
        if (result.length > 0) {
          resolve(result);
          return;
        }
        if (--remaining === 0) {
          if (errors.length === promises.length) {
            reject(new Error(errors.map((e) => (e instanceof Error ? e.message : String(e))).join("; ")));
          } else {
            resolve([]);
          }
        }
      }).catch((e) => {
        errors.push(e);
        if (--remaining === 0) {
          if (errors.length === promises.length) {
            reject(new Error(errors.map((e) => (e instanceof Error ? e.message : String(e))).join("; ")));
          } else {
            resolve([]);
          }
        }
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

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
    if (isCjkInput(query)) {
      const candidates = simplifiedToJapaneseCandidates(query);
      entries = await raceFirstNonEmpty([
        jishoLookupKanji(query, candidates),
        genjiLookupKanji(query, candidates),
      ]);
    } else {
      entries = await raceFirstNonEmpty([
        jishoLookupEnglish(query),
        genjiLookupEnglish(query),
      ]);
    }
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
