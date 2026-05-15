import assert from "node:assert/strict";
import test from "node:test";

import {
  extractStatusId,
  probeTelegramVideoUrl,
  selectVideo,
  TELEGRAM_REMOTE_VIDEO_MAX_BYTES,
} from "./fxtwitter.ts";

test("extractStatusId supports x/twitter/fx style status URLs", () => {
  assert.equal(extractStatusId("https://x.com/user/status/1234567890"), "1234567890");
  assert.equal(extractStatusId("see https://twitter.com/user/statuses/1234567890?s=20"), "1234567890");
  assert.equal(extractStatusId("https://vxtwitter.com/user/status/1234567890/video/1"), "1234567890");
  assert.equal(extractStatusId("not a status URL"), null);
});

test("selectVideo prefers highest quality sendable mp4 format", () => {
  const selected = selectVideo([
    {
      url: "https://video.example/master.m3u8",
      formats: [
        {
          container: "m3u8",
          url: "https://video.example/master.m3u8",
          height: 1080,
          width: 1920,
        },
        {
          container: "mp4",
          url: "https://video.example/low.mp4",
          size: 2_000_000,
          height: 360,
          width: 640,
          bitrate: 832,
        },
        {
          container: "mp4",
          url: "https://video.example/high.mp4",
          size: 8_000_000,
          height: 720,
          width: 1280,
          bitrate: 2176,
        },
      ],
    },
  ]);

  assert.equal(selected?.url, "https://video.example/high.mp4");
  assert.equal(selected?.telegramReady, true);
});

test("selectVideo marks only oversized mp4 candidates as direct-link only", () => {
  const selected = selectVideo([
    {
      url: "https://video.example/master.m3u8",
      formats: [
        {
          container: "mp4",
          url: "https://video.example/huge.mp4",
          size: TELEGRAM_REMOTE_VIDEO_MAX_BYTES + 1,
          height: 1080,
          width: 1920,
          bitrate: 4096,
        },
      ],
    },
  ]);

  assert.equal(selected?.url, "https://video.example/huge.mp4");
  assert.equal(selected?.telegramReady, false);
});

test("selectVideo ignores non-mp4 and m3u8-only videos", () => {
  const selected = selectVideo([
    {
      url: "https://video.example/master.m3u8",
      formats: [
        { container: "m3u8", url: "https://video.example/master.m3u8" },
        { container: "webm", url: "https://video.example/video.webm" },
      ],
    },
  ]);

  assert.equal(selected, null);
});

test("probeTelegramVideoUrl accepts video/mp4 within Telegram remote limit", async () => {
  const fetcher = async () =>
    new Response("x", {
      status: 206,
      headers: {
        "content-type": "video/mp4",
        "content-range": "bytes 0-0/12345",
      },
    });

  assert.deepEqual(await probeTelegramVideoUrl("https://video.example/video.mp4", fetcher), {
    ok: true,
  });
});

test("probeTelegramVideoUrl rejects html pages", async () => {
  const fetcher = async () =>
    new Response("<html></html>", {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });

  const result = await probeTelegramVideoUrl("https://video.example/video.mp4", fetcher);
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /not video content/);
});

test("probeTelegramVideoUrl rejects videos above Telegram remote limit", async () => {
  const fetcher = async () =>
    new Response("x", {
      status: 206,
      headers: {
        "content-type": "video/mp4",
        "content-range": `bytes 0-0/${TELEGRAM_REMOTE_VIDEO_MAX_BYTES + 1}`,
      },
    });

  const result = await probeTelegramVideoUrl("https://video.example/video.mp4", fetcher);
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /video too large/);
});
