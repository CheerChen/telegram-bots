// Test: parse the real fetched seat page and render PNG + text grid preview
import { readFileSync, writeFileSync } from "node:fs";
import { parseSeatLayout, generateSeatPngAsync, parseSeatCount } from "../src/index";

const html = readFileSync("/tmp/toho-seat.html", "utf8");

const count = parseSeatCount(html);
console.log("seat count:", count);

const layout = parseSeatLayout(html);
console.log("layout rows:", layout.height, "cols:", layout.width);
console.log("row labels:", layout.rowLabels.join(", "));
for (let r = 0; r < layout.height; r++) {
  const row = layout.grid[r]!;
  const label = (layout.rowLabels[r] ?? "").padEnd(2, " ");
  const line = row.map((c) => (c === 1 || c === 5 ? "□" : c === 2 || c === 6 ? "■" : c === 3 ? "x" : c === 4 ? "H" : "·")).join("");
  console.log(`${label}${line}`);
}

const png = await generateSeatPngAsync(layout);
writeFileSync("/tmp/seatmap-test.png", png);
console.log("png bytes:", png.length, "written to /tmp/seatmap-test.png");
