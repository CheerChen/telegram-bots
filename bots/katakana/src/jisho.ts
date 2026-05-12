import { escapeHtml } from "shared/telegram";
import sc2jp from "./sc2jp.json";

interface JishoJapanese {
  word?: string;
  reading?: string;
}

interface JishoSense {
  english_definitions: string[];
  parts_of_speech: string[];
}

interface JishoEntry {
  japanese?: JishoJapanese[];
  senses?: JishoSense[];
}

interface JishoResponse {
  data?: JishoEntry[];
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

async function jishoSearch(word: string, page = 1): Promise<JishoEntry[]> {
  const url = `https://jisho.org/api/v1/search/words?keyword=${encodeURIComponent(word)}&page=${page}`;
  const res = await fetch(url, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36",
    },
  });
  if (!res.ok) {
    throw new Error(`jisho ${res.status}`);
  }
  const json = (await res.json()) as JishoResponse;
  return json.data ?? [];
}

function formatSenseHtml(sense: JishoSense | undefined): string {
  if (!sense) return "";
  const pos = sense.parts_of_speech.join(", ");
  const def = sense.english_definitions.join("; ");
  if (!pos) return escapeHtml(def);
  return `<i>[${escapeHtml(pos)}]</i> ${escapeHtml(def)}`;
}

async function lookupKanji(query: string): Promise<Result[]> {
  const candidates = simplifiedToJapaneseCandidates(query);
  const queries = Array.from(new Set([...candidates, query]));

  const results: Result[] = [];
  const seen = new Set<string>();

  // Prefer entries where word exactly equals one of the direct sc2jp candidates.
  const exactCandidates = new Set(candidates);

  for (const q of queries) {
    const data = await jishoSearch(q);
    for (const entry of data) {
      if (!entry.japanese || !entry.senses) continue;
      for (const jp of entry.japanese) {
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

        const definition = entry.senses.slice(0, 2).map(formatSenseHtml).filter(Boolean).join(" | ");
        results.push({ reading, word, definition });
      }
    }
  }

  // Exact candidate match → top.
  results.sort((a, b) => {
    return Number(!exactCandidates.has(a.word ?? "")) - Number(!exactCandidates.has(b.word ?? ""));
  });
  return results;
}

function isExactKatakanaMatch(entry: JishoEntry, query: string): boolean {
  const jp = entry.japanese?.[0];
  if (!jp || jp.word || !isKatakanaReading(jp.reading)) return false;
  const defs = entry.senses?.[0]?.english_definitions ?? [];
  const q = query.toLowerCase();
  return defs.some((d) => d.toLowerCase() === q || d.toLowerCase().startsWith(q));
}

async function lookupEnglish(query: string): Promise<Result[]> {
  let data = await jishoSearch(query);

  if (data.length >= 20 && !data.some((e) => isExactKatakanaMatch(e, query))) {
    const katakanaOnlyCount = data.filter(
      (e) => e.japanese?.[0] && !e.japanese[0].word && isKatakanaReading(e.japanese[0].reading),
    ).length;
    if (katakanaOnlyCount < 5) {
      data = data.concat(await jishoSearch(query, 2));
    }
  }

  const sorted = [...data].sort((a, b) => {
    return Number(!isExactKatakanaMatch(a, query)) - Number(!isExactKatakanaMatch(b, query));
  });

  const results: Result[] = [];
  const seen = new Set<string>();
  for (const entry of sorted) {
    const jp = entry.japanese?.[0];
    const reading = jp?.reading;
    if (!jp || !reading || jp.word) continue;
    if (!isKatakanaReading(reading)) continue;
    if (seen.has(reading)) continue;
    seen.add(reading);
    results.push({ reading, definition: formatSenseHtml(entry.senses?.[0]) });
  }
  return results;
}

export async function lookup(query: string): Promise<LookupResult> {
  if (!query) return { kind: "notfound", query };

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

  if (results.length === 0) return { kind: "notfound", query };

  const r = results[0]!;
  const reading = escapeHtml(r.reading);
  // <code> so iOS/Android Telegram lets the user tap-to-copy the reading.
  const head = r.word ? `<code>${reading}</code>（${escapeHtml(r.word)}）` : `<code>${reading}</code>`;
  const html = r.definition ? `${head}\n${r.definition}` : head;
  const truncated = html.length > MAX_LEN ? `${html.slice(0, MAX_LEN - 15)}\n…(truncated)` : html;
  return { kind: "ok", html: truncated };
}
