// Debug: fetch a real TOHO seat page and dump the screen-table HTML
import { load } from "cheerio";
import { writeFileSync } from "node:fs";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const SCHEDULE_API = "https://api2.tohotheater.jp/api/schedule/v2/schedule";
const TICKET_BASE = "https://hlo.tohotheater.jp/net/ticket";
const SCHEDULE_PAGE = "https://hlo.tohotheater.jp/net/schedule";

const THEATER = process.argv[2] ?? "076"; // TOHOシネマズ 新宿
function nowYYMMDD(): string {
  const d = new Date(Date.now() + 9 * 3600_000); // JST
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

async function parseSetCookie(headers: Headers): Promise<string> {
  const getter = (headers as unknown as { getSetCookie?: () => string[] }).getSetCookie;
  const raw = getter?.call(headers) ?? [headers.get("set-cookie") ?? ""].filter(Boolean);
  if (!raw.length) return "";
  return raw.map((l: string) => l.split(";")[0]).join("; ");
}

const calRes = await fetch(
  `https://api2.tohotheater.jp/api/schedule/v1/schedule/${THEATER}/TNPI3050J03?__type__=html&__useResultInfo__=no&vg_cd=${THEATER}&show_day=${nowYYMMDD()}&term=99&seq_disp_term=7&enter_kbn=&_dc=${Math.floor(Date.now() / 1000)}`,
  { headers: { "user-agent": UA, accept: "application/json", "x-requested-with": "XMLHttpRequest", referer: `${SCHEDULE_PAGE}/${THEATER}/TNPI2000J01.do` } },
);
const cal = await calRes.json();
if (cal.status !== "0") console.error("calendar raw:", JSON.stringify(cal).slice(0, 200), "http", calRes.status);
const dates: string[] = (cal.data ?? []).filter((d: any) => d.selectable === "1").map((d: any) => d.date);
console.log("selectable dates:", dates.join(","));

let show: any = null;
let showDay = dates[0]!;
for (const day of dates) {
  const res = await fetch(
    `${SCHEDULE_API}/${THEATER}/TNPI3050J05?__type__=html&vg_cd=${THEATER}&show_day=${day}&isMember=&enter_kbn=&_dc=${Math.floor(Date.now() / 1000)}`,
    { headers: { "user-agent": UA, accept: "application/json", "x-requested-with": "XMLHttpRequest", referer: `${SCHEDULE_PAGE}/${THEATER}/TNPI2000J01.do` } },
  );
  const json = await res.json();
  const movies = json.data?.[0]?.list?.[0]?.list ?? [];
  console.log(`day=${day} movies=${movies.length}`);
  if (!movies.length) continue;
  outer: for (const movie of movies) {
    for (const s of movie.list ?? []) {
      if (s.unsoldSeatInfo?.unsoldSeatStatus && s.unsoldSeatInfo.unsoldSeatStatus !== "G") {
        show = { movieCode: movie.code, ...s, movieTitle: movie.name };
        showDay = day;
        break outer;
      }
    }
  }
  if (show) break;
}
if (!show) { console.log("no sellable show found"); process.exit(1); }
console.log(`show: ${show.movieTitle} screen=${show.screen.name}/${show.screen.code} pfNo=${show.code} status=${show.unsoldSeatInfo.unsoldSeatStatus} seats=${show.screen.allSeatNum}`);

const formInit =
  `site_cd=${THEATER}&jyoei_date=${showDay}` +
  `&gekijyo_cd=${show.screen.theaterCd}&screen_cd=${show.screen.code}` +
  `&sakuhin_cd=${show.movieCode}&pf_no=${show.code}` +
  `&fnc=1&pageid=2000J01&enter_kbn=`;
const formSkip = formInit.replace("&fnc=1", "") + "&seq_no=0";
const hdr = { "user-agent": UA, "accept-language": "ja,en-US;q=0.9,en;q=0.8", "content-type": "application/x-www-form-urlencoded" };

const s1 = await fetch(`${TICKET_BASE}/${THEATER}/TNPI2040J03.do`, { method: "POST", headers: { ...hdr, referer: `${SCHEDULE_PAGE}/${THEATER}/TNPI2000J01.do` }, body: formInit, redirect: "manual" });
let cookie = await parseSetCookie(s1.headers);
await s1.text();
const s2 = await fetch(`${TICKET_BASE}/${THEATER}/TNPI2040J04.do`, { method: "POST", headers: { ...hdr, referer: `${TICKET_BASE}/${THEATER}/TNPI2040J03.do`, cookie }, body: formSkip, redirect: "manual" });
const c2 = await parseSetCookie(s2.headers);
if (c2) cookie = c2;
await s2.text();
const s3 = await fetch(`${TICKET_BASE}/${THEATER}/TNPI2010J01.do`, { method: "POST", headers: { ...hdr, referer: `${TICKET_BASE}/${THEATER}/TNPI2040J04.do`, cookie }, body: formSkip });
console.log("seat page status:", s3.status);
const buf = await s3.arrayBuffer();
const html = new TextDecoder("shift_jis").decode(buf);
writeFileSync("/tmp/toho-seat.html", html);

const $ = load(html);
const table = $('table[summary="screen-table"]');
console.log("screen-table count:", table.length);
if (table.length) {
  // Print structural summary of first few rows
  table.find("tr").each((i, tr) => {
    if (i > 5) return;
    const cells: string[] = [];
    $(tr).find("td,th").each((_, td) => {
      const tag = (td as any).tagName;
      const colspan = $(td).attr("colspan") ?? "1";
      const rowspan = $(td).attr("rowspan") ?? "1";
      const cls = $(td).attr("class") ?? "";
      const img = $(td).find("img[src*='seat_']");
      const alt = img.length ? `img:${img.attr("src")} alt:${img.attr("alt")}` : `txt:"${$(td).text().trim().slice(0, 10)}"`;
      cells.push(`<${tag} cs=${colspan} rs=${rowspan} class=${cls} ${alt}>`);
    });
    console.log(`row ${i} (${cells.length} cells): ${cells.join(" ")}`);
  });
} else {
  // dump snippets around any seat images
  const imgs = $('img[src*="seat_"]');
  console.log("seat imgs anywhere:", imgs.length);
  if (imgs.length) console.log($.html(imgs.first().parent().parent().parent().parent().parent()).slice(0, 3000));
}
