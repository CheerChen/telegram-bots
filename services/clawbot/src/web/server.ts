import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import QRCode from "qrcode";

import type { ClawState } from "../state.ts";

const UI_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "ui.html");
const MAX_JSON_BODY = 4096;

export interface WebServer {
  close(): Promise<void>;
}

export async function startWebServer(opts: {
  state: ClawState;
  port: number;
  host: string;
}): Promise<WebServer> {
  const uiHtml = await readFile(UI_PATH, "utf-8");

  const server = createServer(async (req, res) => {
    try {
      await dispatch(req, res, opts.state, uiHtml);
    } catch (err) {
      console.error("request handler error", err);
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => {
      server.off("error", reject);
      resolveListen();
    });
  });

  return {
    close: () =>
      new Promise<void>((resolveClose, reject) => {
        server.close((err) => (err ? reject(err) : resolveClose()));
      }),
  };
}

async function dispatch(
  req: IncomingMessage,
  res: ServerResponse,
  state: ClawState,
  uiHtml: string,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const method = req.method ?? "GET";

  if (method === "GET" && path === "/") {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store, must-revalidate",
    });
    res.end(uiHtml);
    return;
  }

  if (method === "GET" && path === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }

  if (method === "GET" && path === "/api/status") {
    sendJson(res, 200, state.getSnapshot());
    return;
  }

  if (method === "GET" && path === "/api/auth/qr.svg") {
    const snap = state.getSnapshot();
    if (!snap.qrcode) {
      sendJson(res, 404, { error: "no qrcode available" });
      return;
    }
    const svg = await QRCode.toString(snap.qrcode, { type: "svg", margin: 1, width: 240 });
    res.writeHead(200, {
      "content-type": "image/svg+xml",
      "cache-control": "no-store",
    });
    res.end(svg);
    return;
  }

  if (method === "POST" && path === "/api/auth/start") {
    const result = state.startAuth();
    sendJson(res, result.ok ? 200 : 409, result);
    return;
  }

  if (method === "POST" && path === "/api/auth/code") {
    const body = await readJsonBody(req);
    if (!body || typeof body.code !== "string") {
      sendJson(res, 400, { error: "expected { code: string }" });
      return;
    }
    const result = state.submitVerifyCode(body.code);
    sendJson(res, result.ok ? 200 : 409, result);
    return;
  }

  if (method === "POST" && path === "/api/auth/cancel") {
    state.cancelAuth();
    sendJson(res, 200, { ok: true });
    return;
  }

  sendJson(res, 404, { error: "not found" });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_JSON_BODY) throw new Error("body too large");
    chunks.push(buf);
  }
  if (total === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf-8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
