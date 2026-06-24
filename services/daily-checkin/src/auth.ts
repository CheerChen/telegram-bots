// Interactive MSAL auth — run locally to generate/refresh the token cache.
// Usage: pnpm --filter daily-checkin auth
//   (needs AZURE_CLIENT_ID, AZURE_TENANT_ID, MSAL_CACHE_PATH in env or .env)
//
// Starts a local HTTP server on port 39911 to receive the OAuth redirect,
// opens a browser for login, then serializes the cache to MSAL_CACHE_PATH.

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createServer } from "node:http";

import { PublicClientApplication, type Configuration } from "@azure/msal-node";

const AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID;
const AZURE_TENANT_ID = process.env.AZURE_TENANT_ID;
const MSAL_CACHE_PATH = process.env.MSAL_CACHE_PATH ?? ".msal_cache.json";
const REDIRECT_PORT = 39911;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}`;
const SCOPES = ["Calendars.Read"];

if (!AZURE_CLIENT_ID || !AZURE_TENANT_ID) {
  console.error("[auth] AZURE_CLIENT_ID and AZURE_TENANT_ID must be set");
  process.exit(1);
}

const msalConfig: Configuration = {
  auth: {
    clientId: AZURE_CLIENT_ID,
    authority: `https://login.microsoftonline.com/${AZURE_TENANT_ID}`,
  },
  cache: {
    cachePlugin: {
      beforeCacheAccess: async (ctx) => {
        if (existsSync(MSAL_CACHE_PATH)) {
          ctx.cache.deserialize(readFileSync(MSAL_CACHE_PATH, "utf-8"));
          console.log(`[auth] loaded existing cache (${MSAL_CACHE_PATH})`);
        }
      },
      afterCacheAccess: async (ctx) => {
        if (ctx.cacheHasChanged) {
          const dir = dirname(MSAL_CACHE_PATH);
          if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
          writeFileSync(MSAL_CACHE_PATH, ctx.cache.serialize());
          console.log(`[auth] saved cache (${MSAL_CACHE_PATH})`);
        }
      },
    },
  },
};

const msalApp = new PublicClientApplication(msalConfig);

// Check if we already have a valid token
const accounts = await msalApp.getTokenCache().getAllAccounts();
if (accounts.length > 0) {
  try {
    const result = await msalApp.acquireTokenSilent({ account: accounts[0]!, scopes: SCOPES });
    if (result?.accessToken) {
      console.log("[auth] silent token OK — no re-login needed");
      console.log(`[auth] accounts: ${accounts.map((a) => a.username).join(", ")}`);
      process.exit(0);
    }
  } catch {
    console.log("[auth] silent token failed, proceeding to interactive login");
  }
}

// Start local server to catch the redirect
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${REDIRECT_PORT}`);
  if (url.pathname !== "/" && url.pathname !== "") {
    res.writeHead(404).end("not found");
    return;
  }
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  if (error) {
    res.writeHead(400, { "Content-Type": "text/html" }).end(`Auth error: ${error}`);
    console.error(`[auth] OAuth error: ${error}`);
    server.close();
    process.exit(1);
  }
  if (!code) {
    res.writeHead(400).end("missing code");
    return;
  }
  try {
    const tokenResult = await msalApp.acquireTokenByCode({
      code,
      redirectUri: REDIRECT_URI,
      scopes: SCOPES,
    });
    res.writeHead(200, { "Content-Type": "text/html" }).end(
      "<h1>Auth OK</h1><p>You can close this tab.</p>",
    );
    console.log(`[auth] OK, access_token len=${tokenResult.accessToken.length}`);
    const accts = await msalApp.getTokenCache().getAllAccounts();
    console.log(`[auth] accounts: ${accts.map((a) => a.username).join(", ")}`);
    console.log(`[auth] cache written to ${MSAL_CACHE_PATH}`);
    server.close();
    process.exit(0);
  } catch (exc) {
    res.writeHead(500, { "Content-Type": "text/html" }).end(
      `<h1>Auth failed</h1><pre>${exc instanceof Error ? exc.message : String(exc)}</pre>`,
    );
    console.error(`[auth] acquireTokenByCode failed: ${exc}`);
    server.close();
    process.exit(1);
  }
});

server.listen(REDIRECT_PORT, async () => {
  console.log(`[auth] local server listening on :${REDIRECT_PORT}`);
  const authCodeUrl = await msalApp.getAuthCodeUrl({
    scopes: SCOPES,
    redirectUri: REDIRECT_URI,
  });
  console.log(`[auth] open this URL in your browser:\n${authCodeUrl}`);
  // Try to open browser (macOS)
  try {
    const { execSync } = await import("node:child_process");
    execSync(`open "${authCodeUrl}"`);
    console.log("[auth] browser launched");
  } catch {
    console.log("[auth] could not auto-open browser, please open the URL manually");
  }
});
