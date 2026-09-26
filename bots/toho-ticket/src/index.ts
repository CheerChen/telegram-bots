import { load } from "cheerio";
import { verifyWebhookSecret } from "shared/auth";
import {
  answerCallbackQuery,
  editMessageMediaFile,
  editMessageText,
  escapeHtml,
  sendMessage,
  sendPhotoFile,
  type InlineKeyboardMarkup,
  type InlineKeyboardButton,
} from "shared/telegram";
import type { CallbackQuery, TelegramUpdate } from "shared/types";

interface Env {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  TOHO_STATE: KVNamespace;
}

// --- Constants ---

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const SCHEDULE_API = "https://api2.tohotheater.jp/api/schedule/v2/schedule";
const CALENDAR_API = "https://api2.tohotheater.jp/api/schedule/v1/schedule";
const TICKET_BASE = "https://hlo.tohotheater.jp/net/ticket";
const SCHEDULE_PAGE = "https://hlo.tohotheater.jp/net/schedule";
const THEATER_FIND_URL = "https://www.tohotheater.jp/theater/find.html";

const THEATER_CACHE_KEY = "meta:theaters";
const THEATER_CACHE_TTL = 60 * 60 * 24 * 7; // 7 days
const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

const STATUS_LABEL: Record<string, string> = {
  A: "販売中 [余裕あり ○○]",
  B: "販売中 [残り半分 ○]",
  C: "販売中 [残席わずか △]",
  D: "満席 [×]",
  G: "販売期間外",
};

// --- Types ---

type SeatKind = 0 | 1 | 2 | 3 | 4 | 5 | 6;
// 0=empty/aisle, 1=available, 2=sold, 3=not-for-sale, 4=wheelchair,
// 5=premium-available, 6=premium-sold

interface Theater {
  code: string;
  name: string;
}

interface TheaterRegion {
  region: string;
  theaters: Theater[];
}

interface TohoShow {
  movieTitle: string;
  movieCode: string;
  mcode: string;
  showingStart: string;
  showingEnd: string;
  screenName: string;
  screenCode: string;
  theaterCd: string;
  allSeatNum: number;
  pfNo: string;
  status: string;
}

interface SeatCount {
  available: number;
  sold: number;
  total: number;
}

interface SeatLayout {
  grid: SeatKind[][];
  rowLabels: string[];
  width: number;
  height: number;
}

// --- Utilities ---

function nowUnixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function nowYYMMDD(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

// "HH:MM" in JST, shown on refreshable messages so a stale view is obvious.
function jstClock(): string {
  const d = new Date(Date.now() + 9 * 3600_000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

function fmtDate(showDay: string): string {
  const m = parseInt(showDay.slice(4, 6), 10);
  const d = parseInt(showDay.slice(6, 8), 10);
  const date = new Date(parseInt(showDay.slice(0, 4), 10), m - 1, d);
  const w = WEEKDAYS[date.getDay()];
  return `${m}/${d}(${w})`;
}

// --- Theater list ---

async function fetchTheaterList(): Promise<TheaterRegion[]> {
  const res = await fetch(THEATER_FIND_URL, {
    headers: { "user-agent": UA, "accept-language": "ja,en-US;q=0.9,en;q=0.8" },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`theater find ${res.status}`);
  const buf = await res.arrayBuffer();
  const html = new TextDecoder("shift_jis").decode(buf);
  return parseTheaterList(html);
}

function parseTheaterList(html: string): TheaterRegion[] {
  const $ = load(html);
  const regions: TheaterRegion[] = [];
  $(".theater-list-section").each((_, section) => {
    const title = $(section).find(".theater-list-title").first().text().trim();
    const region = title.replace(/地区.*/, "").trim();
    const theaters: Theater[] = [];
    const seen = new Set<string>();
    $(section)
      .find('a[href*="/net/schedule/"]')
      .each((_, a) => {
        const href = $(a).attr("href") ?? "";
        const m = href.match(/\/net\/schedule\/(\d+)\//);
        if (!m) return;
        const code = m[1]!;
        if (seen.has(code)) return;
        seen.add(code);
        const name = $(a).find("span").first().contents().first().text().trim();
        theaters.push({ code, name });
      });
    if (theaters.length) regions.push({ region, theaters });
  });
  return regions;
}

async function getTheaterList(env: Env): Promise<TheaterRegion[]> {
  const cached = await env.TOHO_STATE.get(THEATER_CACHE_KEY, "json");
  if (cached && Array.isArray(cached)) return cached as TheaterRegion[];
  const regions = await fetchTheaterList();
  await env.TOHO_STATE.put(THEATER_CACHE_KEY, JSON.stringify(regions), {
    expirationTtl: THEATER_CACHE_TTL,
  });
  return regions;
}

function findTheater(regions: TheaterRegion[], code: string): Theater | undefined {
  for (const r of regions) {
    const t = r.theaters.find((t) => t.code === code);
    if (t) return t;
  }
  return undefined;
}

// --- Schedule API ---

async function fetchCalendar(theater: string): Promise<{ date: string; dayOfWeek: number }[]> {
  const url =
    `${CALENDAR_API}/${theater}/TNPI3050J03` +
    `?__type__=html&__useResultInfo__=no&vg_cd=${theater}` +
    `&show_day=${nowYYMMDD()}&term=99&seq_disp_term=7` +
    `&enter_kbn=&_dc=${nowUnixSeconds()}`;
  const res = await fetch(url, {
    headers: {
      "user-agent": UA,
      accept: "application/json, text/javascript, */*; q=0.01",
      "x-requested-with": "XMLHttpRequest",
      referer: `${SCHEDULE_PAGE}/${theater}/TNPI2000J01.do`,
    },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`calendar ${res.status}`);
  const json = (await res.json()) as { status: string; data?: Array<{ date: string; dayOfWeek: number; selectable: string }> };
  if (json.status !== "0" || !json.data) return [];
  return json.data.filter((d) => d.selectable === "1").map((d) => ({ date: d.date, dayOfWeek: d.dayOfWeek }));
}

async function fetchSchedule(theater: string, showDay: string): Promise<TohoShow[]> {
  const url =
    `${SCHEDULE_API}/${theater}/TNPI3050J05` +
    `?__type__=html&vg_cd=${theater}&show_day=${showDay}` +
    `&isMember=&enter_kbn=&_dc=${nowUnixSeconds()}`;
  const res = await fetch(url, {
    headers: {
      "user-agent": UA,
      accept: "application/json, text/javascript, */*; q=0.01",
      "x-requested-with": "XMLHttpRequest",
      referer: `${SCHEDULE_PAGE}/${theater}/TNPI2000J01.do`,
    },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`schedule ${res.status}`);
  const json = (await res.json()) as {
    status: string;
    data?: Array<{
      list?: Array<{
        list?: Array<{
          name: string;
          code: string;
          mcode: string;
          list?: Array<{
            code: number;
            showingStart: string;
            showingEnd: string;
            screen: { name: string; code: string; theaterCd: string; allSeatNum: number };
            unsoldSeatInfo: { unsoldSeatStatus: string };
          }>;
        }>;
      }>;
    }>;
  };
  if (json.status !== "0" || !json.data?.length) return [];
  const movies = json.data[0]?.list?.[0]?.list ?? [];
  const shows: TohoShow[] = [];
  for (const movie of movies) {
    for (const s of movie.list ?? []) {
      shows.push({
        movieTitle: movie.name,
        movieCode: movie.code,
        mcode: movie.mcode,
        showingStart: s.showingStart,
        showingEnd: s.showingEnd,
        screenName: s.screen.name,
        screenCode: s.screen.code,
        theaterCd: s.screen.theaterCd,
        allSeatNum: s.screen.allSeatNum,
        pfNo: String(s.code),
        status: s.unsoldSeatInfo.unsoldSeatStatus,
      });
    }
  }
  return shows;
}

// --- Seat page fetch (unified 3-step POST → HTML) ---

function parseSetCookie(headers: Headers): string {
  const getter = (headers as unknown as { getSetCookie?: () => string[] }).getSetCookie;
  const raw = getter?.call(headers) ?? [headers.get("set-cookie") ?? ""].filter(Boolean);
  if (!raw.length) return "";
  return raw.map((l: string) => l.split(";")[0]).join("; ");
}

// Fetch the raw seat-selection page HTML. Single implementation shared by
// count parsing and layout parsing (deduplicates the old fetchSeatCount/fetchSeatPage).
async function fetchSeatPage(show: TohoShow, theater: string, showDay: string): Promise<string> {
  const formInit =
    `site_cd=${theater}&jyoei_date=${showDay}` +
    `&gekijyo_cd=${show.theaterCd}&screen_cd=${show.screenCode}` +
    `&sakuhin_cd=${show.movieCode}&pf_no=${show.pfNo}` +
    `&fnc=1&pageid=2000J01&enter_kbn=`;
  const formSkip = formInit.replace("&fnc=1", "") + "&seq_no=0";

  const hdr: Record<string, string> = {
    "user-agent": UA,
    "accept-language": "ja,en-US;q=0.9,en;q=0.8",
    "content-type": "application/x-www-form-urlencoded",
  };

  // Step 1: establish session
  const s1 = await fetch(`${TICKET_BASE}/${theater}/TNPI2040J03.do`, {
    method: "POST",
    headers: { ...hdr, referer: `${SCHEDULE_PAGE}/${theater}/TNPI2000J01.do` },
    body: formInit,
    redirect: "manual",
    signal: AbortSignal.timeout(30000),
  });
  let cookie = parseSetCookie(s1.headers);
  await s1.text();

  // Step 2: skip login promotion
  const s2 = await fetch(`${TICKET_BASE}/${theater}/TNPI2040J04.do`, {
    method: "POST",
    headers: { ...hdr, referer: `${TICKET_BASE}/${theater}/TNPI2040J03.do`, cookie },
    body: formSkip,
    redirect: "manual",
    signal: AbortSignal.timeout(30000),
  });
  const c2 = parseSetCookie(s2.headers);
  if (c2) cookie = c2;
  await s2.text();

  // Step 3: seat selection page
  const s3 = await fetch(`${TICKET_BASE}/${theater}/TNPI2010J01.do`, {
    method: "POST",
    headers: { ...hdr, referer: `${TICKET_BASE}/${theater}/TNPI2040J04.do`, cookie },
    body: formSkip,
    signal: AbortSignal.timeout(30000),
  });
  if (!s3.ok) throw new Error(`seat page ${s3.status}`);
  const buf = await s3.arrayBuffer();
  return new TextDecoder("shift_jis").decode(buf);
}

// --- Seat HTML parsing ---
//
// TOHO seat pages use a nested-table layout: the outer screen-table contains
// large cells (colspan/rowspan) that hold sub-tables for seat groups, e.g.
// a td[colspan=33][rowspan=5] containing rows A-E of an IMAX screen.
// We parse tables recursively, honoring colspan/rowspan, and stamp each
// sub-table into the parent grid at its cell position.
//
// Seat classification is src-based (not alt-based): the image filename
// deterministically identifies the seat type, avoiding mojibake in alt text
// and correctly excluding 選択不可 (seat_0) from the sold count.

function classifySeatSrc(src: string): SeatKind {
  const name = src.split("/").pop() ?? "";
  if (name === "seat_1.gif") return 1; // available
  if (name === "seat_2.gif") return 2; // sold
  if (name === "seat_0.gif") return 3; // not-for-sale (選択不可)
  if (name === "seat_4.gif") return 4; // wheelchair
  if (name === "seat_prm_1.gif") return 5; // premium available
  if (name === "seat_prm_2.gif") return 6; // premium sold
  return 0; // unknown → empty
}

// Parse row label from alt text: "A-8 空席(...)" → "A"
function parseRowLabel(alt: string): string | null {
  const m = alt.match(/^([A-Z]+)-\d+/);
  return m ? m[1]! : null;
}

interface RawCell {
  kind: SeatKind;
  rowLabel: string | null;
}

interface SeatTableGrid {
  cells: RawCell[][];
  width: number;
  height: number;
}

function buildTableGrid($: any, tableEl: any): SeatTableGrid {
  const placed = new Map<string, RawCell>();
  const occupied = new Set<string>();
  let maxR = 0;
  let maxC = 0;

  const reserve = (r: number, c: number, spanC: number, spanR: number, anchor: RawCell): void => {
    for (let rr = r; rr < r + spanR; rr++) {
      for (let cc = c; cc < c + spanC; cc++) {
        occupied.add(`${rr}:${cc}`);
        placed.set(`${rr}:${cc}`, rr === r && cc === c ? anchor : { kind: 0, rowLabel: null });
        if (rr > maxR) maxR = rr;
        if (cc > maxC) maxC = cc;
      }
    }
  };

  const directRows = (el: any): any[] => {
    const rows: any[] = [];
    el.children("tbody").each((_: number, tb: any) => {
      $(tb).children("tr").each((__: number, tr: any) => rows.push($(tr)));
    });
    if (!rows.length) el.children("tr").each((_: number, tr: any) => rows.push($(tr)));
    return rows;
  };

  const processTable = (tableEl: any, startRow: number): void => {
    const trs = directRows(tableEl);
    for (let row = 0; row < trs.length; row++) {
      const r = startRow + row;
      let c = 0;
      trs[row].children("td,th").each((_: number, td: any) => {
        while (occupied.has(`${r}:${c}`)) c++;
        const td$ = $(td);
        const cs = Math.max(1, parseInt(td$.attr("colspan") ?? "1", 10) || 1);
        const rs = Math.max(1, parseInt(td$.attr("rowspan") ?? "1", 10) || 1);

        const subTables = td$.children("table");
        if (subTables.length) {
          let totalSubW = 0;
          let totalSubH = 0;
          const subGrids: SeatTableGrid[] = [];
          subTables.each((_: number, st: any) => {
            const sub = buildTableGrid($, $(st));
            subGrids.push(sub);
            totalSubW = Math.max(totalSubW, sub.width);
            totalSubH += sub.height;
          });
          const spanC = Math.max(cs, totalSubW);
          const spanR = Math.max(rs, totalSubH);
          reserve(r, c, spanC, spanR, { kind: 0, rowLabel: null });
          let sr = r;
          for (const sub of subGrids) {
            for (let i = 0; i < sub.height; i++) {
              for (let j = 0; j < sub.width; j++) {
                placed.set(`${sr + i}:${c + j}`, sub.cells[i]![j]!);
              }
            }
            sr += sub.height;
          }
        } else {
          const img = td$.children('img[src*="seat_"]').first();
          let anchor: RawCell = { kind: 0, rowLabel: null };
          if (img.length) {
            const src = img.attr("src") ?? "";
            const alt = img.attr("alt") ?? "";
            anchor = { kind: classifySeatSrc(src), rowLabel: parseRowLabel(alt) };
          }
          reserve(r, c, cs, rs, anchor);
        }
        c += cs;
      });
    }
  };

  processTable(tableEl, 0);

  const cells: RawCell[][] = [];
  for (let r = 0; r <= maxR; r++) {
    const row: RawCell[] = [];
    for (let c = 0; c <= maxC; c++) row.push(placed.get(`${r}:${c}`) ?? { kind: 0, rowLabel: null });
    cells.push(row);
  }
  return { cells, width: maxC + 1, height: maxR + 1 };
}

function trimGrid(cells: RawCell[][]): { grid: SeatKind[][]; rowLabels: string[] } {
  // Drop rows that contain no seat at all (rowspan artifacts / spacer rows)
  const keepIdx: number[] = [];
  for (let r = 0; r < cells.length; r++) {
    if (cells[r]!.some((c) => c.kind !== 0)) keepIdx.push(r);
  }
  if (!keepIdx.length) return { grid: [], rowLabels: [] };

  // Trim empty leading/trailing columns (keeps interior aisles intact)
  let first = cells[0]!.length;
  let last = -1;
  for (const r of keepIdx) {
    for (let c = 0; c < cells[r]!.length; c++) {
      if (cells[r]![c]!.kind !== 0) {
        if (c < first) first = c;
        if (c > last) last = c;
      }
    }
  }
  if (last < 0) return { grid: [], rowLabels: [] };

  const grid: SeatKind[][] = [];
  const rowLabels: string[] = [];
  for (const r of keepIdx) {
    const row: SeatKind[] = [];
    let label: string | null = null;
    for (let c = first; c <= last; c++) {
      const cell = cells[r]![c]!;
      row.push(cell.kind);
      if (!label && cell.rowLabel) label = cell.rowLabel;
    }
    grid.push(row);
    rowLabels.push(label ?? "");
  }
  return { grid, rowLabels };
}

export function parseSeatLayout(html: string): SeatLayout {
  const $ = load(html);
  const table = $('table[summary="screen-table"]');
  if (!table.length) return { grid: [], rowLabels: [], width: 0, height: 0 };
  const raw = buildTableGrid($, table);
  const { grid, rowLabels } = trimGrid(raw.cells);
  return { grid, rowLabels, width: grid[0]?.length ?? 0, height: grid.length };
}

export function parseSeatCount(html: string): SeatCount {
  const layout = parseSeatLayout(html);
  return countSeats(layout);
}

function countSeats(layout: SeatLayout): SeatCount {
  let available = 0;
  let sold = 0;
  for (const row of layout.grid) {
    for (const c of row) {
      if (c === 1 || c === 5) available++;
      else if (c === 2 || c === 6) sold++;
      // 0=aisle, 3=not-for-sale, 4=wheelchair: excluded from total
    }
  }
  return { available, sold, total: available + sold };
}

// --- 5x7 bitmap font (A-Z, 0-9) ---
// Each glyph: 7 rows, 5 bits per row (bit 4 = leftmost pixel).
// Compact public-domain-style dot matrix, ~250 bytes total.

const FONT5x7: Record<string, number[]> = {
  A: [14, 17, 17, 31, 17, 17, 17],
  B: [30, 17, 17, 30, 17, 17, 30],
  C: [14, 17, 16, 16, 16, 17, 14],
  D: [30, 17, 17, 17, 17, 17, 30],
  E: [31, 16, 16, 30, 16, 16, 31],
  F: [31, 16, 16, 30, 16, 16, 16],
  G: [14, 17, 16, 23, 17, 17, 14],
  H: [17, 17, 17, 31, 17, 17, 17],
  I: [14, 4, 4, 4, 4, 4, 14],
  J: [7, 2, 2, 2, 2, 18, 12],
  K: [17, 18, 20, 24, 20, 18, 17],
  L: [16, 16, 16, 16, 16, 16, 31],
  M: [17, 27, 21, 21, 17, 17, 17],
  N: [17, 17, 19, 21, 22, 17, 17],
  O: [14, 17, 17, 17, 17, 17, 14],
  P: [30, 17, 17, 30, 16, 16, 16],
  Q: [14, 17, 17, 17, 21, 18, 13],
  R: [30, 17, 17, 30, 20, 18, 17],
  S: [14, 17, 16, 14, 1, 17, 14],
  T: [31, 4, 4, 4, 4, 4, 4],
  U: [17, 17, 17, 17, 17, 17, 14],
  V: [17, 17, 17, 17, 17, 10, 4],
  W: [17, 17, 17, 21, 21, 21, 10],
  X: [17, 17, 10, 4, 10, 17, 17],
  Y: [17, 17, 17, 10, 4, 4, 4],
  Z: [31, 1, 2, 4, 8, 16, 31],
  "0": [14, 17, 19, 21, 25, 17, 14],
  "1": [4, 12, 4, 4, 4, 4, 14],
  "2": [14, 17, 1, 2, 4, 8, 31],
  "3": [31, 2, 4, 2, 1, 17, 14],
  "4": [2, 6, 10, 18, 31, 2, 2],
  "5": [31, 16, 30, 1, 1, 17, 14],
  "6": [6, 8, 16, 30, 17, 17, 14],
  "7": [31, 1, 2, 4, 8, 8, 8],
  "8": [14, 17, 17, 14, 17, 17, 14],
  "9": [14, 17, 17, 15, 1, 2, 12],
};

// --- PNG generation (2.5x, row labels, color inversion) ---

// CRC32 for PNG checksums
const CRC_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of data) c = (CRC_TABLE[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const len = data.length;
  const typeBytes = new TextEncoder().encode(type);
  const chunk = new Uint8Array(12 + len);
  const dv = new DataView(chunk.buffer);
  dv.setUint32(0, len);
  chunk.set(typeBytes, 4);
  chunk.set(data, 8);
  const crcInput = new Uint8Array(4 + len);
  crcInput.set(typeBytes, 0);
  crcInput.set(data, 4);
  dv.setUint32(8 + len, crc32(crcInput));
  return chunk;
}

// Seat colors — inverted from original: available is saturated green (stands
// out), sold is light gray (recedes). Premium seats get an outline. Wheelchair
// and not-for-sale use distinct non-red colors.
const COLOR_AVAILABLE: [number, number, number] = [40, 175, 75];
const COLOR_SOLD: [number, number, number] = [205, 205, 205];
const COLOR_NOT_FOR_SALE: [number, number, number] = [170, 170, 170];
const COLOR_WHEELCHAIR: [number, number, number] = [90, 140, 210];
const COLOR_PREMIUM_BORDER: [number, number, number] = [120, 120, 120];
const COLOR_SCREEN: [number, number, number] = [70, 70, 78];
const COLOR_LABEL: [number, number, number] = [90, 90, 90];
const COLOR_BG: [number, number, number] = [255, 255, 255];

function seatColor(kind: SeatKind): [number, number, number] | null {
  switch (kind) {
    case 1: return COLOR_AVAILABLE;
    case 2: return COLOR_SOLD;
    case 3: return COLOR_NOT_FOR_SALE;
    case 4: return COLOR_WHEELCHAIR;
    case 5: return COLOR_AVAILABLE; // premium available — same green, with border
    case 6: return COLOR_SOLD; // premium sold — same gray, with border
    default: return null; // aisle/empty
  }
}

function isPremium(kind: SeatKind): boolean {
  return kind === 5 || kind === 6;
}

export async function generateSeatPngAsync(layout: SeatLayout): Promise<Uint8Array<ArrayBuffer>> {
  if (!layout.height) return new Uint8Array(0);

  const cellSize = 24;
  const gap = 3;
  const margin = 14;
  const screenH = 18;
  const fontScale = 3; // each font dot = 3px → glyph 15×21
  const labelW = 26; // room for 5-char row label
  const cols = layout.width;
  const rows = layout.height;
  const w = margin * 2 + labelW + cols * (cellSize + gap) - gap;
  const h = margin * 2 + screenH + gap + rows * (cellSize + gap) - gap;

  // RGB: 3 bytes per pixel. Each row prefixed with filter byte (0 = none).
  const stride = w * 3;
  const raw = new Uint8Array((stride + 1) * h);
  for (let y = 0; y < h; y++) raw[y * (stride + 1)] = 0;

  const setPx = (x: number, y: number, r: number, g: number, b: number): void => {
    if (x < 0 || x >= w || y < 0 || y >= h) return;
    const o = y * (stride + 1) + 1 + x * 3;
    raw[o] = r; raw[o + 1] = g; raw[o + 2] = b;
  };
  const fillRect = (x: number, y: number, bw: number, bh: number, col: [number, number, number]): void => {
    for (let dy = 0; dy < bh; dy++) for (let dx = 0; dx < bw; dx++) setPx(x + dx, y + dy, col[0], col[1], col[2]);
  };
  const drawChar5x7 = (ch: string, ox: number, oy: number, col: [number, number, number]): void => {
    const glyph = FONT5x7[ch.toUpperCase()];
    if (!glyph) return;
    for (let r = 0; r < 7; r++) {
      const bits = glyph[r]!;
      for (let c = 0; c < 5; c++) {
        if (bits & (1 << (4 - c))) {
          fillRect(ox + c * fontScale, oy + r * fontScale, fontScale, fontScale, col);
        }
      }
    }
  };
  const drawText = (text: string, ox: number, oy: number, col: [number, number, number]): void => {
    for (let i = 0; i < text.length; i++) drawChar5x7(text[i]!, ox + i * (5 * fontScale + 2), oy, col);
  };

  // Background
  fillRect(0, 0, w, h, COLOR_BG);

  // Screen bar
  fillRect(margin + labelW, margin, w - margin - margin - labelW, screenH, COLOR_SCREEN);

  // Seats + row labels
  const seatsY = margin + screenH + gap;
  for (let r = 0; r < rows; r++) {
    const row = layout.grid[r]!;
    const label = layout.rowLabels[r] ?? "";
    // Row label on left, vertically centered with the seat row
    if (label) {
      const labelY = seatsY + r * (cellSize + gap) + Math.floor((cellSize - 7 * fontScale) / 2);
      drawText(label, margin, labelY, COLOR_LABEL);
    }
    for (let c = 0; c < row.length; c++) {
      const kind = row[c]!;
      const col = seatColor(kind);
      if (!col) continue;
      const px = margin + labelW + c * (cellSize + gap);
      const py = seatsY + r * (cellSize + gap);
      fillRect(px, py, cellSize, cellSize, col);
      // Premium seats: draw a darker outline
      if (isPremium(kind)) {
        const [br, bg, bb] = COLOR_PREMIUM_BORDER;
        for (let d = 0; d < cellSize; d++) {
          setPx(px + d, py, br, bg, bb);
          setPx(px + d, py + cellSize - 1, br, bg, bb);
          setPx(px, py + d, br, bg, bb);
          setPx(px + cellSize - 1, py + d, br, bg, bb);
        }
      }
    }
  }

  // Compress with zlib deflate (PNG expects zlib-wrapped deflate)
  const compressed = new Uint8Array(
    await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate"))).arrayBuffer(),
  );

  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = new Uint8Array(13);
  const ihdrDv = new DataView(ihdr.buffer);
  ihdrDv.setUint32(0, w);
  ihdrDv.setUint32(4, h);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: RGB
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const ihdrChunk = pngChunk("IHDR", ihdr);
  const idatChunk = pngChunk("IDAT", compressed);
  const iendChunk = pngChunk("IEND", new Uint8Array(0));
  const total = sig.length + ihdrChunk.length + idatChunk.length + iendChunk.length;
  const png = new Uint8Array(total);
  let offset = 0;
  png.set(sig, offset); offset += sig.length;
  png.set(ihdrChunk, offset); offset += ihdrChunk.length;
  png.set(idatChunk, offset); offset += idatChunk.length;
  png.set(iendChunk, offset);
  return png;
}

// --- Text grid + per-row summary ---

function renderTextGrid(layout: SeatLayout): string {
  if (!layout.height) return "(座席図なし)";
  const lines: string[] = [];
  // Legend line
  lines.push("□空席 ■販売済 ·通路 H車椅子 x選択不可");
  lines.push("");
  for (let r = 0; r < layout.height; r++) {
    const row = layout.grid[r]!;
    const label = (layout.rowLabels[r] ?? "").padEnd(2, " ");
    let line = label;
    for (const kind of row) {
      line += kind === 1 || kind === 5 ? "□"
        : kind === 2 || kind === 6 ? "■"
        : kind === 3 ? "x"
        : kind === 4 ? "H"
        : "·";
    }
    lines.push(line);
  }
  return lines.join("\n");
}

// Per-row available counts: "空席あり: A(7) B(3) M(2)"
function renderRowSummary(layout: SeatLayout): string {
  const parts: string[] = [];
  for (let r = 0; r < layout.height; r++) {
    const row = layout.grid[r]!;
    const label = layout.rowLabels[r];
    if (!label) continue;
    const avail = row.filter((k) => k === 1 || k === 5).length;
    if (avail > 0) parts.push(`${label}(${avail})`);
  }
  if (!parts.length) return "空席なし (満席)";
  return `空席あり: ${parts.join(" ")}`;
}

function buildSeatmapCaption(layout: SeatLayout, movieTitle: string, showDay: string, show: { showingStart: string; showingEnd: string; screenName: string }): string {
  const grid = renderTextGrid(layout);
  const summary = renderRowSummary(layout);
  const count = countSeats(layout);
  const header = `${movieTitle}\n${fmtDate(showDay)} ${show.showingStart}～${show.showingEnd} ${show.screenName}\n空席 ${count.available} / ${count.total}席`;
  return `<pre>${escapeHtml(grid)}</pre>\n\n${escapeHtml(header)}\n${escapeHtml(summary)}`;
}

function kb(rows: InlineKeyboardButton[][]): InlineKeyboardMarkup {
  return { inline_keyboard: rows };
}

function chunk<T>(arr: T[], size: number): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < arr.length; i += size) rows.push(arr.slice(i, i + size));
  return rows;
}

// --- Telegram handlers ---

async function handleUpdate(update: TelegramUpdate, env: Env): Promise<Response> {
  if (update.callback_query) {
    await handleCallback(update.callback_query, env);
    return new Response("ok");
  }
  const msg = update.message;
  if (!msg?.text) return new Response("ok");
  const text = msg.text.trim();
  const chatId = msg.chat.id;

  if (text === "/start" || text === "/help") {
    await sendMessage(env.TELEGRAM_BOT_TOKEN, {
      chatId,
      text:
        "🎬 TOHOシネマズ 场次 / 座位查询\n\n" +
        "Commands:\n" +
        "• /toho — 浏览影院 → 日期 → 影片 → 场次状态\n\n" +
        "场次页可查看每场的座位图；座位图和场次页都能 🔄 原地刷新。",
      disableWebPagePreview: true,
    });
    return new Response("ok");
  }

  if (text === "/toho" || text === "/theaters" || text === "/theater") {
    await sendRegionMenu(env, chatId);
    return new Response("ok");
  }

  await sendMessage(env.TELEGRAM_BOT_TOKEN, {
    chatId,
    text: "发送 /toho 开始浏览。",
    disableWebPagePreview: true,
  });
  return new Response("ok");
}

async function sendRegionMenu(env: Env, chatId: number): Promise<void> {
  const regions = await getTheaterList(env);
  const buttons = regions.map((r, i) => ({ text: r.region, callback_data: `r:${i}` }));
  await sendMessage(env.TELEGRAM_BOT_TOKEN, {
    chatId,
    text: "📍 选择地区",
    replyMarkup: kb(chunk(buttons, 4)),
    disableWebPagePreview: true,
  });
}

async function sendTheaterMenu(env: Env, chatId: number, messageId: number, regionIdx: number): Promise<void> {
  const regions = await getTheaterList(env);
  const region = regions[regionIdx];
  if (!region) {
    await editMessageText(env.TELEGRAM_BOT_TOKEN, { chatId, messageId, text: "地区不存在", disableWebPagePreview: true });
    return;
  }
  const buttons = region.theaters.map((t) => ({ text: t.name.replace("TOHOシネマズ ", ""), callback_data: `t:${t.code}` }));
  buttons.push({ text: "← 返回地区", callback_data: "back:regions" });
  await editMessageText(env.TELEGRAM_BOT_TOKEN, {
    chatId,
    messageId,
    text: `📍 ${region.region}`,
    replyMarkup: kb(chunk(buttons, 2)),
    disableWebPagePreview: true,
  });
}

async function sendDateMenu(env: Env, chatId: number, messageId: number, theaterCode: string): Promise<void> {
  const regions = await getTheaterList(env);
  const theater = findTheater(regions, theaterCode);
  let dates: { date: string; dayOfWeek: number }[];
  try {
    dates = await fetchCalendar(theaterCode);
  } catch {
    await editMessageText(env.TELEGRAM_BOT_TOKEN, { chatId, messageId, text: "获取日期失败，请稍后重试", disableWebPagePreview: true });
    return;
  }
  if (!dates.length) {
    await editMessageText(env.TELEGRAM_BOT_TOKEN, { chatId, messageId, text: "没有可选日期", disableWebPagePreview: true });
    return;
  }
  const buttons = dates.map((d) => {
    const m = parseInt(d.date.slice(4, 6), 10);
    const day = parseInt(d.date.slice(6, 8), 10);
    return { text: `${m}/${day}(${WEEKDAYS[d.dayOfWeek - 1]})`, callback_data: `d:${theaterCode}:${d.date}` };
  });
  buttons.push({ text: "← 返回影院", callback_data: `r:back:${theaterCode}` });
  await editMessageText(env.TELEGRAM_BOT_TOKEN, {
    chatId,
    messageId,
    text: `📅 ${theater?.name ?? theaterCode}`,
    replyMarkup: kb(chunk(buttons, 4)),
    disableWebPagePreview: true,
  });
}

async function sendMovieMenu(env: Env, chatId: number, messageId: number, theaterCode: string, showDay: string): Promise<void> {
  let shows: TohoShow[];
  try {
    shows = await fetchSchedule(theaterCode, showDay);
  } catch {
    await editMessageText(env.TELEGRAM_BOT_TOKEN, { chatId, messageId, text: "获取场次失败，请稍后重试", disableWebPagePreview: true });
    return;
  }
  const movieMap = new Map<string, string>();
  for (const s of shows) movieMap.set(s.movieCode, s.movieTitle);
  if (!movieMap.size) {
    await editMessageText(env.TELEGRAM_BOT_TOKEN, { chatId, messageId, text: "该日期没有场次", disableWebPagePreview: true });
    return;
  }
  const buttons = Array.from(movieMap.entries()).map(([code, title]) => ({
    text: title.length > 40 ? title.slice(0, 38) + "…" : title,
    callback_data: `m:${theaterCode}:${showDay}:${code}`,
  }));
  buttons.push({ text: "← 返回日期", callback_data: `bd:${theaterCode}:${showDay}` });
  await editMessageText(env.TELEGRAM_BOT_TOKEN, {
    chatId,
    messageId,
    text: `🎬 ${fmtDate(showDay)}`,
    replyMarkup: kb(chunk(buttons, 1)),
    disableWebPagePreview: true,
  });
}

// Show all showtimes for a movie with live status, one seatmap button each.
async function sendShowtimeMenu(env: Env, chatId: number, messageId: number, theaterCode: string, showDay: string, movieCode: string): Promise<void> {
  let shows: TohoShow[];
  try {
    shows = await fetchSchedule(theaterCode, showDay);
  } catch {
    await editMessageText(env.TELEGRAM_BOT_TOKEN, { chatId, messageId, text: "获取场次失败，请稍后重试", disableWebPagePreview: true });
    return;
  }
  const movieShows = shows.filter((s) => s.movieCode === movieCode);
  if (!movieShows.length) {
    await editMessageText(env.TELEGRAM_BOT_TOKEN, { chatId, messageId, text: "没有匹配场次", disableWebPagePreview: true });
    return;
  }
  const title = movieShows[0]!.movieTitle;
  const lines: string[] = [`${title}`, `${fmtDate(showDay)}`, ""];
  for (const s of movieShows) {
    const label = STATUS_LABEL[s.status] ?? s.status;
    lines.push(`${s.showingStart}～${s.showingEnd} ${s.screenName} (${s.allSeatNum}席) ${label}`);
  }
  lines.push("", `更新于 ${jstClock()}`);
  const seatmapButtons = movieShows.map((s) => ({
    text: `🗺 ${s.showingStart}`,
    callback_data: `seatmap:${theaterCode}:${showDay}:${movieCode}:${s.pfNo}`,
  }));
  const rows: InlineKeyboardButton[][] = [
    ...chunk(seatmapButtons, 3),
    [
      // Same payload as picking the movie: re-renders this menu with fresh status.
      { text: "🔄 刷新", callback_data: `m:${theaterCode}:${showDay}:${movieCode}` },
      { text: "← 返回影片", callback_data: `bm:${theaterCode}:${showDay}:${movieCode}` },
    ],
  ];
  await editMessageText(env.TELEGRAM_BOT_TOKEN, {
    chatId,
    messageId,
    text: lines.join("\n"),
    replyMarkup: kb(rows),
    disableWebPagePreview: true,
  });
}

// --- Seatmap handler ---

// Render a seat map for one showtime. With refreshMessageId, the photo message
// carrying the pressed 🔄 button is edited in place; otherwise a new photo is
// sent. The refresh button targets the callback's own message, so no state is
// stored anywhere.
async function handleSeatmap(
  env: Env,
  chatId: number,
  callbackQueryId: string,
  theaterCode: string,
  showDay: string,
  movieCode: string,
  pfNo: string,
  refreshMessageId?: number,
): Promise<void> {
  await answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, callbackQueryId, refreshMessageId ? "刷新中…" : "生成中…");

  let shows: TohoShow[];
  try {
    shows = await fetchSchedule(theaterCode, showDay);
  } catch {
    await sendMessage(env.TELEGRAM_BOT_TOKEN, { chatId, text: "获取场次失败", disableWebPagePreview: true });
    return;
  }
  const show = shows.find((s) => s.movieCode === movieCode && s.pfNo === pfNo);
  if (!show) {
    await sendMessage(env.TELEGRAM_BOT_TOKEN, { chatId, text: "场次不存在", disableWebPagePreview: true });
    return;
  }

  let html: string;
  try {
    html = await fetchSeatPage(show, theaterCode, showDay);
  } catch {
    await sendMessage(env.TELEGRAM_BOT_TOKEN, { chatId, text: "选座页面获取失败", disableWebPagePreview: true });
    return;
  }

  const layout = parseSeatLayout(html);
  if (!layout.height) {
    await sendMessage(env.TELEGRAM_BOT_TOKEN, { chatId, text: "座位图解析失败", disableWebPagePreview: true });
    return;
  }

  const png = await generateSeatPngAsync(layout);
  const caption = `${buildSeatmapCaption(layout, show.movieTitle, showDay, show)}\n${escapeHtml(`更新于 ${jstClock()}`)}`;
  const replyMarkup = kb([
    [{ text: "🔄 刷新座位图", callback_data: `sr:${theaterCode}:${showDay}:${movieCode}:${pfNo}` }],
  ]);

  if (refreshMessageId) {
    try {
      await editMessageMediaFile(env.TELEGRAM_BOT_TOKEN, {
        chatId,
        messageId: refreshMessageId,
        photo: png,
        filename: "seatmap.png",
        caption,
        parseMode: "HTML",
        replyMarkup,
      });
      return;
    } catch (error) {
      // Message may be too old or deleted — fall through to send a new one
      console.log(`[seatmap] editMessageMedia failed (msg ${refreshMessageId}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  await sendPhotoFile(env.TELEGRAM_BOT_TOKEN, {
    chatId,
    photo: png,
    filename: "seatmap.png",
    caption,
    parseMode: "HTML",
    replyMarkup,
  });
}

// --- Callback router ---

async function handleCallback(cb: CallbackQuery, env: Env): Promise<void> {
  const data = cb.data ?? "";
  const chatId = cb.message?.chat.id ?? 0;
  const messageId = cb.message?.message_id ?? 0;
  const answer = (text?: string) => answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, cb.id, text);

  // r:<index> — region
  if (data.startsWith("r:")) {
    const rest = data.slice(2);
    if (rest === "back") {
      await answer();
      await sendRegionMenu(env, chatId);
      return;
    }
    if (rest.startsWith("back:")) {
      const theaterCode = rest.slice(5);
      const regions = await getTheaterList(env);
      const idx = regions.findIndex((r) => r.theaters.some((t) => t.code === theaterCode));
      await answer();
      if (idx >= 0) await sendTheaterMenu(env, chatId, messageId, idx);
      return;
    }
    const idx = parseInt(rest, 10);
    await answer();
    await sendTheaterMenu(env, chatId, messageId, idx);
    return;
  }

  // t:<theater> — theater selected
  if (data.startsWith("t:")) {
    const theaterCode = data.slice(2);
    await answer();
    await sendDateMenu(env, chatId, messageId, theaterCode);
    return;
  }

  // d:<theater>:<day> — date selected (forward → movie list)
  if (data.startsWith("d:")) {
    const parts = data.slice(2).split(":");
    await answer();
    if (parts.length >= 2) await sendMovieMenu(env, chatId, messageId, parts[0]!, parts[1]!);
    return;
  }

  // bd:<theater>:<day> — back to date menu
  if (data.startsWith("bd:")) {
    const parts = data.slice(3).split(":");
    await answer();
    if (parts.length >= 1) await sendDateMenu(env, chatId, messageId, parts[0]!);
    return;
  }

  // m:<theater>:<day>:<movieCode> — movie selected (forward → showtime list)
  if (data.startsWith("m:")) {
    const parts = data.slice(2).split(":");
    await answer();
    if (parts.length >= 3) await sendShowtimeMenu(env, chatId, messageId, parts[0]!, parts[1]!, parts[2]!);
    return;
  }

  // bm:<theater>:<day>:<movieCode> — back to movie list
  if (data.startsWith("bm:")) {
    const parts = data.slice(3).split(":");
    await answer();
    if (parts.length >= 2) await sendMovieMenu(env, chatId, messageId, parts[0]!, parts[1]!);
    return;
  }

  // seatmap:<theater>:<day>:<movieCode>:<pfNo> — seat map
  if (data.startsWith("seatmap:")) {
    const parts = data.slice(8).split(":");
    if (parts.length >= 4) {
      await handleSeatmap(env, chatId, cb.id, parts[0]!, parts[1]!, parts[2]!, parts[3]!);
    } else {
      await answer();
    }
    return;
  }

  // sr:<theater>:<day>:<movieCode>:<pfNo> — refresh the pressed seat map in place
  if (data.startsWith("sr:")) {
    const parts = data.slice(3).split(":");
    if (parts.length >= 4) {
      await handleSeatmap(env, chatId, cb.id, parts[0]!, parts[1]!, parts[2]!, parts[3]!, messageId);
    } else {
      await answer();
    }
    return;
  }

  await answer();
}

// --- HTTP handlers ---

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/") {
      return Response.json({ name: "toho-ticket-bot" });
    }

    if (req.method === "POST" && url.pathname === "/webhook") {
      if (!verifyWebhookSecret(req, env.TELEGRAM_WEBHOOK_SECRET)) {
        return new Response("forbidden", { status: 403 });
      }
      try {
        const update = (await req.json()) as TelegramUpdate;
        return await handleUpdate(update, env);
      } catch (err) {
        console.error("webhook handler failed", err);
        return new Response("ok");
      }
    }

    return new Response("not found", { status: 404 });
  },
};
