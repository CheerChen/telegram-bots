import assert from "node:assert/strict";
import test from "node:test";

import { animationUrl, isAnimated, parseProductId, pickTitle, stickerSetName } from "./line.ts";

test("parseProductId accepts store, share and bare ids", () => {
  assert.equal(parseProductId("https://store.line.me/stickershop/product/8525/ja"), "8525");
  assert.equal(
    parseProductId("https://store.line.me/officialaccount/event/sticker/19101/ja"),
    "19101",
  );
  assert.equal(parseProductId("look https://line.me/S/sticker/11537/?lang=ja&ref=lsh"), "11537");
  assert.equal(parseProductId(" 8525 "), "8525");
  assert.equal(parseProductId("https://store.line.me/emojishop/product/5ac1bfd5040ab15980c9b435/ja"), null);
  assert.equal(parseProductId("hello"), null);
});

test("pickTitle prefers ja, falls back, and caps at 64", () => {
  const base = { packageId: 1, stickers: [] };
  assert.equal(pickTitle({ ...base, title: { en: "E", ja: "J" } }), "J");
  assert.equal(pickTitle({ ...base, title: { "zh-Hant": "T" } }), "T");
  assert.equal(pickTitle({ ...base, title: {} }), "LINE 1");
  assert.equal(pickTitle({ ...base, title: { en: "x".repeat(80) } }).length, 64);
});

test("stickerSetName is deterministic and within Telegram's 64-char limit", () => {
  const name = stickerSetName("123456789012", "a".repeat(32));
  assert.equal(name, `line_123456789012_by_${"a".repeat(32)}`);
  assert.ok(name.length <= 64);
});

test("pop-up packs count as animated and use the popup APNG", () => {
  const base = { packageId: 1, title: {}, stickers: [] };
  const popup = { ...base, hasAnimation: false, stickerResourceType: "POPUP" };
  assert.equal(isAnimated(popup), true);
  assert.equal(isAnimated({ ...popup, stickerResourceType: "POPUP_SOUND" }), true);
  assert.equal(isAnimated({ ...base, stickerResourceType: "STATIC" }), false);
  assert.match(animationUrl(popup, 9), /\/sticker\/9\/iPhone\/sticker_popup\.png$/);
  assert.match(animationUrl({ ...base, hasAnimation: true }, 9), /sticker_animation@2x\.png$/);
});
