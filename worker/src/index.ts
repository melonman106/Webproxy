// worker/src/index.ts

import { rewriteHtmlResponse, rewriteCssTextExport } from "./rewriter";

// ─── Session ────────────────────────────────────────────────────────
const SESSION_COOKIE = "__psid";
const SESSION_ID_RE = /[0-9a-f-]{36}/i;

// ─── Header sets ─────────────────────────────────────────────────────
const STRIPPED_RESPONSE_HEADERS = new Set([
  "content-security-policy",
  "content-security-policy-report-only",
  "x-frame-options",
  "content-encoding",
  "content-length",
  "strict-transport-security",
  "set-cookie",
  "location",
  "transfer-encoding",
]);

const FORWARD_REQUEST_HEADERS = new Set([
  "user-agent",
  "accept",
  "accept-language",
  "content-type",
  "range",
  "origin",
  "referer",
  "sec-fetch-dest",
  "sec-fetch-mode",
  "sec-fetch-site",
  "sec-fetch-user",
  "sec-ch-ua",
  "sec-ch-ua-mobile",
  "sec-ch-ua-platform",
  "priority",
]);

// Default browser fingerprint headers — set when the client doesn't
// provide them so the upstream always sees a consistent browser-like
// request, which lowers the bot score on sites using Cloudflare's
// Managed Challenge.
const DEFAULT_SEC_FETCH_DEST = "document";
const DEFAULT_SEC_FETCH_MODE = "navigate";
const DEFAULT_SEC_FETCH_SITE = "none";
const DEFAULT_SEC_FETCH_USER = "?1";
const DEFAULT_SEC_CH_UA = '"Chromium";v="120", "Not_A Brand";v="8", "Google Chrome";v="120"';
const DEFAULT_SEC_CH_UA_MOBILE = "?0";
const DEFAULT_SEC_CH_UA_PLATFORM = '"Windows"';

// ─── Session helpers ────────────────────────────────────────────────
function readSessionId(request: Request): { id: string; isNew: boolean } {
  const cookieHeader = request.headers.get("Cookie") || "";
  for (const part of cookieHeader.split(";")) {
    const [name, value] = part.trim().split("=");
    if (name === SESSION_COOKIE && value && SESSION_ID_RE.test(value)) {
      return { id: value, isNew: false };
    }
  }
  return { id: crypto.randomUUID(), isNew: true };
}

// ─── WebSocket proxy ───────────────────────────────────────────────
async function handleWebSocketProxy(targetUrl: URL, request: Request): Promise<Response> {
  const upstreamHttpUrl = new URL(targetUrl.toString());
  upstreamHttpUrl.protocol = targetUrl.protocol === "wss:" ? "https:" : "http:";
  const upstreamResponse = await fetch(upstreamHttpUrl.toString(), {
    headers: {
      Upgrade: "websocket",
      "User-Agent": request.headers.get("user-agent") || "Mozilla/5.0",
      Origin: `${targetUrl.protocol === "wss:" ? "https" : "http"}://${targetUrl.host}`,
    },
  });
  const upstreamSocket = upstreamResponse.webSocket;
  if (!upstreamSocket) {
    return new Response("Upstream did not accept the WebSocket upgrade", { status: 502 });
  }
  upstreamSocket.accept();
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  server.accept();

  const closeBoth = (code: number, reason: string) => {
    try { server.close(code, reason); } catch {}
    try { upstreamSocket.close(code, reason); } catch {}
  };

  server.addEventListener("message", (evt: MessageEvent) => {
    try { upstreamSocket.send(evt.data); } catch {}
  });
  upstreamSocket.addEventListener("message", (evt: MessageEvent) => {
    try { server.send(evt.data); } catch {}
  });
  server.addEventListener("close", (evt: CloseEvent) => closeBoth(evt.code, evt.reason));
  upstreamSocket.addEventListener("close", (evt: CloseEvent) => closeBoth(evt.code, evt.reason));
  server.addEventListener("error", () => closeBoth(0, ""));
  upstreamSocket.addEventListener("error", () => closeBoth(0, ""));

  return new Response(null, { status: 101, webSocket: client });
}

// ─── HTTP proxy ─────────────────────────────────────────────────────
async function handleHttpProxy(targetUrl: URL, request: Request, env: Env): Promise<Response> {
  const { id: sessionId, isNew } = readSessionId(request);
  const jarId = env.COOKIE_JAR.idFromName(sessionId);
  const jar = env.COOKIE_JAR.get(jarId);
  const targetOrigin = targetUrl.origin;

  // Build forward headers
  const forwardHeaders = new Headers();

  // User-Agent — default to a realistic Chrome UA if not provided
  forwardHeaders.set(
    "User-Agent",
    request.headers.get("user-agent") ||
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  );

  forwardHeaders.set("Accept", request.headers.get("accept") || "*/*");
  forwardHeaders.set("Accept-Language", request.headers.get("accept-language") || "en-US,en;q=0.9");

  // Forward allowed headers from the client
  for (const [key, value] of request.headers.entries()) {
    if (FORWARD_REQUEST_HEADERS.has(key.toLowerCase())) {
      forwardHeaders.set(key, value);
    }
  }

  // Set default sec-fetch-* headers if the client didn't send them
  if (!forwardHeaders.has("sec-fetch-dest")) {
    forwardHeaders.set("Sec-Fetch-Dest", DEFAULT_SEC_FETCH_DEST);
  }
  if (!forwardHeaders.has("sec-fetch-mode")) {
    forwardHeaders.set("Sec-Fetch-Mode", DEFAULT_SEC_FETCH_MODE);
  }
  if (!forwardHeaders.has("sec-fetch-site")) {
    forwardHeaders.set("Sec-Fetch-Site", DEFAULT_SEC_FETCH_SITE);
  }
  if (!forwardHeaders.has("sec-fetch-user")) {
    forwardHeaders.set("Sec-Fetch-User", DEFAULT_SEC_FETCH_USER);
  }

  // Set default sec-ch-ua headers if the client didn't send them
  if (!forwardHeaders.has("sec-ch-ua")) {
    forwardHeaders.set("Sec-Ch-Ua", DEFAULT_SEC_CH_UA);
  }
  if (!forwardHeaders.has("sec-ch-ua-mobile")) {
    forwardHeaders.set("Sec-Ch-Ua-Mobile", DEFAULT_SEC_CH_UA_MOBILE);
  }
  if (!forwardHeaders.has("sec-ch-ua-platform")) {
    forwardHeaders.set("Sec-Ch-Ua-Platform", DEFAULT_SEC_CH_UA_PLATFORM);
  }

  forwardHeaders.set("Referer", targetUrl.toString());
  forwardHeaders.set("Origin", targetOrigin);

  const range = request.headers.get("range");
  if (range) forwardHeaders.set("Range", range);

  // Attach cookies from the jar
  const jarCookieHeader = await jar.getCookieHeader(targetOrigin);
  if (jarCookieHeader) forwardHeaders.set("Cookie", jarCookieHeader);

  const init: RequestInit = {
    method: request.method,
    headers: forwardHeaders,
    redirect: "manual",
  };

  if (!["GET", "HEAD"].includes(request.method)) {
    const reqContentType = (request.headers.get("content-type") || "").toLowerCase();
    const isTextBody =
      reqContentType.includes("application/x-www-form-urlencoded") ||
      reqContentType.includes("application/json") ||
      reqContentType.startsWith("text/");
    if (isTextBody) {
      init.body = unproxyText(await request.text());
    } else {
      init.body = await request.arrayBuffer();
    }
  }

  let upstream = await fetch(targetUrl.toString(), init);

  // Handle redirects
  if ([301, 302, 303, 307, 308].includes(upstream.status)) {
    const location = upstream.headers.get("location");
    if (location) {
      const redirectUrl = new URL(location, targetUrl).toString();
      const proxiedRedirect = `/proxy?url=${encodeURIComponent(redirectUrl)}`;
      const redirectHeaders = new Headers();
      upstream.headers.forEach((value, key) => {
        if (!STRIPPED_RESPONSE_HEADERS.has(key.toLowerCase())) {
          redirectHeaders.set(key, value);
        }
      });
      redirectHeaders.set("Location", proxiedRedirect);
      if (isNew) {
        redirectHeaders.append(
          "Set-Cookie",
          `${SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; Secure; SameSite=Lax`
        );
      }
      return new Response(null, { status: upstream.status, headers: redirectHeaders });
    }
  }

  // Store cookies
  const setCookies = upstream.headers.getSetCookie?.() ?? [];
  if (setCookies.length > 0) {
    await jar.storeCookies(targetOrigin, setCookies);
  }

  // Build response headers
  const responseHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!STRIPPED_RESPONSE_HEADERS.has(key.toLowerCase())) {
      responseHeaders.set(key, value);
    }
  });
  if (isNew) {
    responseHeaders.append(
      "Set-Cookie",
      `${SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; Secure; SameSite=Lax`
    );
  }

  const contentType = upstream.headers.get("content-type") || "";

  // Rewrite HTML
  if (contentType.includes("text/html")) {
    return rewriteHtmlResponse(
      new Response(upstream.body, { status: upstream.status, headers: responseHeaders }),
      targetUrl.toString()
    );
  }

  // Rewrite CSS
  if (contentType.includes("text/css")) {
    const text = await upstream.text();
    responseHeaders.set("Content-Type", "text/css; charset=utf-8");
    return new Response(rewriteCssTextExport(text, targetUrl.toString()), {
      status: upstream.status,
      headers: responseHeaders,
    });
  }

  // Rewrite JavaScript / JSON
  if (contentType.includes("javascript") || contentType.includes("application/json")) {
    const text = await upstream.text();
    const rewritten = rewriteJsUrls(text, targetUrl.toString());
    return new Response(rewritten, {
      status: upstream.status,
      headers: responseHeaders,
    });
  }

  // Pass through everything else
  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}

// ─── JS URL rewriting ───────────────────────────────────────────────
const JS_URL_RE = /(["'`])(https?:\/\/[^"'`\s)]+)\1/g;
const IMPORT_EXPORT_RE = /\b(import\s*\(\s*|import\s+(?:[\w${}*,\s]+from\s+)?|export\s+(?:[\w${}*,\s]+from\s+)?)(["'])([^"'\n]+)\2/g;
const SOURCE_MAP_RE = /(\/\/[#@]\s*sourceMappingURL=)([^\s]+)/;

function rewriteJsUrls(js: string, baseUrl: string): string {
  let out = js.replace(IMPORT_EXPORT_RE, (match, prefix, quote, spec) => {
    if (spec.startsWith("data:") || spec.includes("/proxy?url=")) return match;
    try {
      const absolute = new URL(spec, baseUrl).toString();
      // Don't proxy Cloudflare challenge resources
      if (absolute.includes("challenges.cloudflare.com")) return match;
      return `${prefix}${quote}/proxy?url=${encodeURIComponent(absolute)}${quote}`;
    } catch {
      return match;
    }
  });
  out = out.replace(JS_URL_RE, (match, quote, url) => {
    if (url.includes("/proxy?url=")) return match;
    if (url.includes("challenges.cloudflare.com")) return match;
    return `${quote}/proxy?url=${encodeURIComponent(url)}${quote}`;
  });
  out = out.replace(SOURCE_MAP_RE, (match, prefix, mapUrl) => {
    if (mapUrl.startsWith("data:") || mapUrl.includes("/proxy?url=")) return match;
    try {
      const absolute = new URL(mapUrl, baseUrl).toString();
      return `${prefix}/proxy?url=${encodeURIComponent(absolute)}`;
    } catch {
      return match;
    }
  });
  return out;
}

// ─── Unproxy text ───────────────────────────────────────────────────
const PROXIED_URL_IN_TEXT_RE = /\/proxy\?url=([^"&\s]+)/g;

function unproxyText(text: string): string {
  return text.replace(PROXIED_URL_IN_TEXT_RE, (match, encoded) => {
    try {
      return decodeURIComponent(encoded);
    } catch {
      return match;
    }
  });
}

// ─── Bookmarks & History ────────────────────────────────────────────
const MAX_HISTORY_ENTRIES = 200;

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

async function readList(env: Env, key: string): Promise<any[]> {
  const raw = await env.USER_DATA.get(key);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function handleBookmarks(request: Request, env: Env, sessionId: string): Promise<Response> {
  const key = `bookmarks:${sessionId}`;
  if (request.method === "GET") {
    return jsonResponse(await readList(env, key));
  }
  if (request.method === "POST") {
    let body: any;
    try {
      body = await request.json();
    } catch {
      return new Response("Invalid JSON body", { status: 400 });
    }
    if (!body.url) return new Response("Missing url", { status: 400 });
    const list = await readList(env, key);
    const withoutDupe = list.filter((entry) => entry.url !== body.url);
    withoutDupe.unshift({ url: body.url, title: body.title || body.url, savedAt: Date.now() });
    await env.USER_DATA.put(key, JSON.stringify(withoutDupe));
    return jsonResponse(withoutDupe);
  }
  if (request.method === "DELETE") {
    const target = new URL(request.url).searchParams.get("url");
    const list = await readList(env, key);
    const filtered = list.filter((entry) => entry.url !== target);
    await env.USER_DATA.put(key, JSON.stringify(filtered));
    return jsonResponse(filtered);
  }
  return new Response("Method not allowed", { status: 405 });
}

async function handleHistory(request: Request, env: Env, sessionId: string): Promise<Response> {
  const key = `history:${sessionId}`;
  if (request.method === "GET") {
    return jsonResponse(await readList(env, key));
  }
  if (request.method === "POST") {
    let body: any;
    try {
      body = await request.json();
    } catch {
      return new Response("Invalid JSON body", { status: 400 });
    }
    if (!body.url) return new Response("Missing url", { status: 400 });
    const list = await readList(env, key);
    const withoutDupe = list.filter((entry) => entry.url !== body.url);
    withoutDupe.unshift({ url: body.url, title: body.title || body.url, savedAt: Date.now() });
    await env.USER_DATA.put(key, JSON.stringify(withoutDupe.slice(0, MAX_HISTORY_ENTRIES)));
    return jsonResponse(withoutDupe.slice(0, MAX_HISTORY_ENTRIES));
  }
  if (request.method === "DELETE") {
    await env.USER_DATA.delete(key);
    return jsonResponse([]);
  }
  return new Response("Method not allowed", { status: 405 });
}

// ─── Main entry ─────────────────────────────────────────────────────
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/proxy") {
      const target = url.searchParams.get("url");
      if (!target) {
        return new Response("Missing ?url= query parameter", { status: 400 });
      }
      let targetUrl: URL;
      try {
        targetUrl = new URL(target);
      } catch {
        return new Response("Invalid target URL", { status: 400 });
      }
      if (request.headers.get("Upgrade") === "websocket") {
        if (!/^wss?:$/.test(targetUrl.protocol)) {
          return new Response("Only ws(s) targets support WebSocket upgrade", { status: 400 });
        }
        return handleWebSocketProxy(targetUrl, request);
      }
      if (!/^https?:$/.test(targetUrl.protocol)) {
        return new Response("Only http(s) targets are allowed", { status: 400 });
      }
      try {
        return await handleHttpProxy(targetUrl, request, env);
      } catch (err: any) {
        return new Response("Upstream fetch failed: " + err.message, { status: 502 });
      }
    }

    if (url.pathname === "/health") {
      return Response.json({ ok: true });
    }

    if (url.pathname === "/api/bookmarks") {
      const { id: sessionId, isNew } = readSessionId(request);
      const resp = await handleBookmarks(request, env, sessionId);
      if (isNew) {
        resp.headers.append(
          "Set-Cookie",
          `${SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; Secure; SameSite=Lax`
        );
      }
      return resp;
    }

    if (url.pathname === "/api/history") {
      const { id: sessionId, isNew } = readSessionId(request);
      const resp = await handleHistory(request, env, sessionId);
      if (isNew) {
        resp.headers.append(
          "Set-Cookie",
          `${SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; Secure; SameSite=Lax`
        );
      }
      return resp;
    }

    if (url.pathname === "/clear-session") {
      const { id: sessionId } = readSessionId(request);
      const jarId = env.COOKIE_JAR.idFromName(sessionId);
      const jar = env.COOKIE_JAR.get(jarId);
      await jar.clear();
      return new Response("Session cleared", {
        status: 200,
        headers: { "Set-Cookie": `${SESSION_COOKIE}=; Path=/; Max-Age=0` },
      });
    }

    return env.ASSETS.fetch(request);
  },
};

// ─── CookieJar Durable Object ───────────────────────────────────────
export { CookieJar } from "./cookieJar";

// ─── Env type ───────────────────────────────────────────────────────
interface Env {
  COOKIE_JAR: DurableObjectNamespace;
  USER_DATA: KVNamespace;
  ASSETS: Fetcher;
}
