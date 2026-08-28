// worker/src/index.ts

import { rewriteHtmlResponse, rewriteCssText } from "./rewriter";
import { CookieJar } from "./cookieJar";

export { CookieJar };

export interface Env {
  ASSETS: Fetcher;
  COOKIE_JAR: DurableObjectNamespace<CookieJar>;
  USER_DATA: KVNamespace;
}

const SESSION_COOKIE = "__psid";
const SESSION_ID_RE = /[0-9a-f-]{36}/i;

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

var FORWARD_REQUEST_HEADERS = new Set([
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

  const closeBoth = (code?: number, reason?: string) => {
    try { server.close(code, reason); } catch {}
    try { upstreamSocket.close(code, reason); } catch {}
  };

  server.addEventListener("message", (evt) => {
    try { upstreamSocket.send(evt.data); } catch {}
  });
  upstreamSocket.addEventListener("message", (evt) => {
    try { server.send(evt.data); } catch {}
  });
  server.addEventListener("close", (evt) => closeBoth(evt.code, evt.reason));
  upstreamSocket.addEventListener("close", (evt) => closeBoth(evt.code, evt.reason));
  server.addEventListener("error", () => closeBoth());
  upstreamSocket.addEventListener("error", () => closeBoth());

  return new Response(null, { status: 101, webSocket: client });
}

async function handleHttpProxy(
  targetUrl: URL,
  request: Request,
  env: Env,
): Promise<Response> {
  const { id: sessionId, isNew } = readSessionId(request);
  const jarId = env.COOKIE_JAR.idFromName(sessionId);
  const jar = env.COOKIE_JAR.get(jarId);
  const targetOrigin = targetUrl.origin;

  const forwardHeaders = new Headers();
  forwardHeaders.set(
    "User-Agent",
    request.headers.get("user-agent") ||
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  );
  forwardHeaders.set("Accept", request.headers.get("accept") || "*/*");
  forwardHeaders.set(
    "Accept-Language",
    request.headers.get("accept-language") || "en-US,en;q=0.9",
  );

  for (const [key, value] of request.headers.entries()) {
    if (FORWARD_REQUEST_HEADERS.has(key.toLowerCase())) {
      forwardHeaders.set(key, value);
    }
  }

  forwardHeaders.set("Referer", targetUrl.toString());
  forwardHeaders.set("Origin", targetOrigin);

  const range = request.headers.get("range");
  if (range) forwardHeaders.set("Range", range);

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
    // multipart/form-data (file uploads) is left as raw bytes untouched —
    // rewriting text inside a binary-safe multipart body isn't attempted.
    if (isTextBody) {
      init.body = unproxyText(await request.text());
    } else {
      init.body = await request.arrayBuffer();
    }
  }

  let upstream = await fetch(targetUrl.toString(), init);

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
          `${SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; Secure; SameSite=Lax`,
        );
      }

      return new Response(null, { status: upstream.status, headers: redirectHeaders });
    }
  }

  const setCookies = upstream.headers.getSetCookie?.() ?? [];
  if (setCookies.length > 0) {
    await jar.storeCookies(targetOrigin, setCookies);
  }

  const responseHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!STRIPPED_RESPONSE_HEADERS.has(key.toLowerCase())) {
      responseHeaders.set(key, value);
    }
  });

  if (isNew) {
    responseHeaders.append(
      "Set-Cookie",
      `${SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; Secure; SameSite=Lax`,
    );
  }

  const contentType = upstream.headers.get("content-type") || "";

  if (contentType.includes("text/html")) {
    return rewriteHtmlResponse(
      new Response(upstream.body, { status: upstream.status, headers: responseHeaders }),
      targetUrl.toString(),
    );
  }

  if (contentType.includes("text/css")) {
    const text = await upstream.text();
    responseHeaders.set("Content-Type", "text/css; charset=utf-8");
    return new Response(rewriteCssText(text, targetUrl.toString()), {
      status: upstream.status,
      headers: responseHeaders,
    });
  }

  if (contentType.includes("javascript") || contentType.includes("application/json")) {
    const text = await upstream.text();
    const rewritten = rewriteJsUrls(text, targetUrl.toString());
    return new Response(rewritten, {
      status: upstream.status,
      headers: responseHeaders,
    });
  }

  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}

const JS_URL_RE = /(["'`])(https?:\/\/[^"'`\s)]+)\1/g;

// Best-effort, regex-based (not a real JS parser) rewrite of import/export
// specifiers and dynamic import() calls, including *relative* ones. This
// matters because a script served from /proxy?url=<encoded-real-url>
// resolves relative specifiers against that proxy URL, not the real
// site's URL — so "./chunk.js" would otherwise 404. Heuristic limits:
// it won't catch computed/templated specifiers (e.g. import(`${base}/x.js`))
// or heavily obfuscated/minified edge cases that don't match this shape.
const IMPORT_EXPORT_RE =
  /\b(import\s*\(\s*|import\s+(?:[\w${}*,\s]+from\s+)?|export\s+(?:[\w${}*,\s]+from\s+)?)(["'])([^"'\n]+)\2/g;

const SOURCE_MAP_RE = /(\/\/[#@]\s*sourceMappingURL=)([^\s]+)/;

function rewriteJsUrls(js: string, baseUrl: string): string {
  let out = js.replace(IMPORT_EXPORT_RE, (match, prefix: string, quote: string, spec: string) => {
    if (spec.startsWith("data:") || spec.includes("/proxy?url=")) return match;
    try {
      const absolute = new URL(spec, baseUrl).toString();
      return `${prefix}${quote}/proxy?url=${encodeURIComponent(absolute)}${quote}`;
    } catch {
      return match;
    }
  });

  out = out.replace(JS_URL_RE, (match, quote: string, url: string) => {
    if (url.includes("/proxy?url=")) return match;
    return `${quote}/proxy?url=${encodeURIComponent(url)}${quote}`;
  });

  out = out.replace(SOURCE_MAP_RE, (match, prefix: string, mapUrl: string) => {
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

/** Reverses /proxy?url=<real> occurrences back to the plain real URL.
 * Used on outgoing POST bodies: if a page's own JS put a proxied URL
 * into a form field or JSON payload (e.g. because our location-rewriting
 * shim touched it upstream), the real origin server needs the real URL
 * back, not our proxy's internal address scheme. */
const PROXIED_URL_IN_TEXT_RE = /\/proxy\?url=([^"'&\s]+)/g;

function unproxyText(text: string): string {
  return text.replace(PROXIED_URL_IN_TEXT_RE, (match, encoded: string) => {
    try {
      return decodeURIComponent(encoded);
    } catch {
      return match;
    }
  });
}

interface StoredEntry {
  url: string;
  title: string;
  savedAt: number;
}

const MAX_HISTORY_ENTRIES = 200;

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

async function readList(env: Env, key: string): Promise<StoredEntry[]> {
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
    let body: { url?: string; title?: string };
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
    let body: { url?: string; title?: string };
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
          `${SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; Secure; SameSite=Lax`,
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
          `${SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; Secure; SameSite=Lax`,
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
