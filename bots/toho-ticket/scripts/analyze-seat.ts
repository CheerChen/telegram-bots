import { load } from "cheerio";
import { readFileSync } from "node:fs";

const html = new TextDecoder("shift_jis").decode(readFileSync("/tmp/toho-seat.html"));
const $ = load(html);
const table = $('table[summary="screen-table"]');

// Walk only direct rows of the outer table (skip nested tables)
function walk(el: any, depth: number, label: string) {
  const $el = $(el);
  const rows = $el.children("tbody").length ? $el.children("tbody") : $el.children();
  console.log(`\n== ${label} (depth ${depth}), children tags:`, $el.children().length);
  $el.children("tbody,tr").each((i, child) => {
    const tag = (child as any).tagName;
    if (tag === "tbody") {
      $(child).children("tr").each((j, tr) => describeRow(tr, `outer row ${j}`));
    } else if (tag === "tr") {
      describeRow(child, `direct row ${i}`);
    } else {
      console.log(`child ${i}: <${tag}>`);
    }
  });
}

function describeRow(tr: any, label: string) {
  const tds = $(tr).children("td");
  const seats = tds.find('img[src*="seat_"]').length;
  const spans = tds.filter("[colspan], [rowspan]").length;
  console.log(`${label}: tds=${tds.length} seats=${seats} spanned=${spans} nestedTables=${$(tr).find("table").length}`);
}

walk(table, 0, "screen-table");

// Detail of the big rowspan cell
const big = table.find('td[colspan="33"]');
if (big.length) {
  console.log("\nbig cell html:", $.html(big).slice(0, 500));
  console.log("its parent tr html:", $.html(big.closest("tr")).slice(0, 300));
}

// Distinct alt texts (proper utf8 this time since html already decoded once)
const alts = new Map<string, number>();
table.find('img[src*="seat_"]').each((_, el) => {
  const alt = $(el).attr("alt") ?? "(none)";
  alts.set(alt, (alts.get(alt) ?? 0) + 1);
});
const distinct = [...alts.entries()];
console.log("\ndistinct alts count:", distinct.length);
// check duplicates
const dup = distinct.filter(([, n]) => n > 1);
console.log("duplicated alts:", dup);

// src types within table
const srcs = new Map<string, number>();
table.find('img[src*="seat_"]').each((_, el) => {
  const src = $(el).attr("src")!;
  srcs.set(src, (srcs.get(src) ?? 0) + 1);
});
console.log("src histogram:", [...srcs.entries()]);
