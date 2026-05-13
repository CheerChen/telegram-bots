import type { Entry } from "shared/jotoba";
import type { LineMessageOut } from "shared/line";

const HEADER_COLOR = "#1f2937";
const SUB_COLOR = "#6b7280";
const POS_COLOR = "#6366f1";

function altText(entry: Entry): string {
  return entry.word ? `${entry.reading}（${entry.word}）` : entry.reading;
}

export function buildEntryFlex(entry: Entry): LineMessageOut {
  const headContents: unknown[] = [
    {
      type: "text",
      text: entry.reading,
      size: "xxl",
      weight: "bold",
      color: HEADER_COLOR,
      wrap: true,
    },
  ];
  if (entry.word) {
    headContents.push({
      type: "text",
      text: entry.word,
      size: "lg",
      color: SUB_COLOR,
      margin: "xs",
      wrap: true,
    });
  }

  const senseRows = entry.senses
    .filter((s) => s.def)
    .map((s) => ({
      type: "box",
      layout: "horizontal",
      spacing: "sm",
      contents: [
        {
          type: "text",
          text: s.pos ? `[${s.pos}]` : " ",
          color: POS_COLOR,
          size: "xs",
          flex: 2,
          weight: "bold",
          wrap: true,
        },
        {
          type: "text",
          text: s.def,
          size: "sm",
          flex: 5,
          wrap: true,
        },
      ],
    }));

  const bodyContents: unknown[] = [...headContents];
  if (senseRows.length > 0) {
    bodyContents.push({ type: "separator", margin: "md" });
    bodyContents.push({
      type: "box",
      layout: "vertical",
      spacing: "sm",
      margin: "md",
      contents: senseRows,
    });
  }

  return {
    type: "flex",
    altText: altText(entry).slice(0, 400),
    contents: {
      type: "bubble",
      size: "kilo",
      body: {
        type: "box",
        layout: "vertical",
        contents: bodyContents,
      },
    },
  };
}
