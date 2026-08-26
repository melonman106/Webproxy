import { rewriteHtmlResponse, rewriteCssText } from "./rewriter";
import { CookieJar } from "./cookieJar";

export { CookieJar };

export interface Env {
  ASSETS: Fetcher;
  COOKIE_JAR: DurableObjectNamespace<CookieJar>;
}

const SESSION_COOKIE = "__psid";
const SESSION_ID_RE = /[0-9a-f-]{36}/i;

// Hop-by-hop or tunnel-breaking headers we never forward back to the browser.
const STRIPPED_RESPONSE_HEADERS = new Set([
  "content-security-policy",
  "content-security-policy-report-only",
  "x-frame-options",
  "content-encoding", // fetch() already decoded the body for us
  "content-length", // length changes once we rewrite the body
  "strict-transport-security",
  "set-cookie", // real cookies stay server-side in the CookieJar DO
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
  // Outbound WebSockets in Workers are established via fetch() to the
  // http(s) equivalent of the target with an Upgrade header — see
  // https://developers.cloudflare.com/workers/runtime-apis/websockets/
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
    try {
      server.close(code, reason);
    } catch {
      /* already closed */
    }
    try {
      upstreamSocket.close(code, reason);
    } catch {
      /* already closed */
    }
  };

  server.addEventListener("message", (evt) => {
    try {
      upstreamSocket.send(evt.data as string | ArrayBuffer);
    } catch {
      /* upstream gone */
    }
  });
  upstreamSocket.addEventListener("message", (evt) => {
    try {
      server.send(evt.data as string | ArrayBuffer);
    } catch {
      /* client gone */
    }
  });
  server.addEventListener("close", (evt) => closeBoth(evt.code, evt.reason));
  upstreamSocket.addEventListener("close", (evt) => closeBoth(evt.code, evt.reason));
  server.addEventListener("error", () => closeBoth());
  upstreamSocket.addEventListener("error", () => closeBoth());

  return new Response(null, { status: 101, webSocket: client });
}

async function handleHttpProxy(targetUrl: URL, request: Request, env: Env): Promise<Response> {
  const { id: sessionId, isNew } = readSessionId(request);
  const jarId = env.COOKIE_JAR.idFromName(sessionId);
  const jar = env.COOKIE_JAR.get(jarId);
  const targetOrigin = targetUrl.origin;

  const forwardHeaders = new Headers();
  forwardHeaders.set(
    "User-Agent",
    request.headers.get("user-agent") ||
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
  );
  forwardHeaders.set("Accept", request.headers.get("accept") || "*/*");
  forwardHeaders.set("Accept-Language", request.headers.get("accept-language") || "en-US,en;q=0.9");
  const range = request.headers.get("range");
  if (range) forwardHeaders.set("Range", range);

  const jarCookieHeader = await jar.getCookieHeader(targetOrigin);
  if (jarCookieHeader) forwardHeaders.set("Cookie", jarCookieHeader);

  const init: RequestInit = {
    method: request.method,
    headers: forwardHeaders,
    redirect: "follow",
  };
  if (!["GET", "HEAD"].includes(request.method)) {
    init.body = await request.arrayBuffer();
  }

  const upstream = await fetch(targetUrl.toString(), init);

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
      `${SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; Secure; SameSite=Lax`
    );
  }

  const contentType = upstream.headers.get("content-type") || "";

  if (contentType.includes("text/html")) {
    return rewriteHtmlResponse(
      new Response(upstream.body, { status: upstream.status, headers: responseHeaders }),
      targetUrl.toString()
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

  // JS, images, fonts, video segments, JSON, etc. stream through as-is.
  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/proxy") {
      const target = url.searchParams.get("url");
      if (!target) return new Response("Missing ?url= query parameter", { status: 400 });

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
      } catch (err) {
        return new Response("Upstream fetch failed: " + (err as Error).message, { status: 502 });
      }
    }

    if (url.pathname === "/health") {
      return Response.json({ ok: true });
    }

    // Anything else is the React console UI, served as static assets.
    return env.ASSETS.fetch(request);
  },
};
