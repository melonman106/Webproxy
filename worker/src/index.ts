// worker/src/index.ts

import { rewriteHtmlResponse, rewriteCssText, toProxyUrl } from "./rewriter";
import { CookieJar } from "./cookieJar";

export { CookieJar };

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

// Default browser fingerprint headers
const DEFAULT_SEC_FETCH_DEST = "document";
const DEFAULT_SEC_FETCH_MODE = "navigate";
const DEFAULT_SEC_FETCH_SITE = "none";
const DEFAULT_SEC_FETCH_USER = "?1";
const DEFAULT_SEC_CH_UA = '"Chromium";v="120", "Not_A Brand";v="8", "Google Chrome";v="120"';
const DEFAULT_SEC_CH_UA_MOBILE = "?0";
const DEFAULT_SEC_CH_UA_PLATFORM = '"Windows"';

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

/* ------------------------------------------------------------------ */
/* Dashboard HTML — dark mode + liquid glass                           */
/* ------------------------------------------------------------------ */

function getDashboardHTML(): string {
  const quickLinks = [
    { name: "YouTube", url: "https://www.youtube.com", icon: "📺" },
    { name: "Discord", url: "https://discord.com/app", icon: "💬" },
    { name: "Reddit", url: "https://www.reddit.com", icon: "👽" },
    { name: "Twitch", url: "https://www.twitch.tv", icon: "🎮" },
    { name: "Spotify", url: "https://open.spotify.com", icon: "🎵" },
    { name: "GitHub", url: "https://github.com", icon: "🐙" },
    { name: "Wikipedia", url: "https://www.wikipedia.org", icon: "📚" },
    { name: "Twitter/X", url: "https://x.com", icon: "🐦" },
  ];

  const quickLinksHTML = quickLinks
    .map(
      (link) =>
        `<a href="/proxy?url=${encodeURIComponent(link.url)}" class="quick-link">
          <span class="icon">${link.icon}</span>
          <span class="name">${link.name}</span>
        </a>`
    )
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>WebProxy</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }

  :root {
    --bg-start: #0a0a1a;
    --bg-end: #1a0a2e;
    --glass-bg: rgba(255, 255, 255, 0.05);
    --glass-border: rgba(255, 255, 255, 0.1);
    --glass-hover: rgba(255, 255, 255, 0.08);
    --text: #e8e8f0;
    --text-muted: #8888aa;
    --accent: #7c3aed;
    --accent-glow: rgba(124, 58, 237, 0.4);
    --accent-hover: #6d28d9;
    --danger: #ef4444;
    --blur: 20px;
  }

  body {
    background: linear-gradient(135deg, var(--bg-start), var(--bg-end));
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 20px;
    position: relative;
    overflow-x: hidden;
  }

  body::before, body::after {
    content: '';
    position: fixed;
    border-radius: 50%;
    filter: blur(80px);
    z-index: -1;
    animation: float 20s ease-in-out infinite;
  }
  body::before {
    width: 400px; height: 400px;
    background: radial-gradient(circle, rgba(124, 58, 237, 0.15), transparent);
    top: -100px; left: -100px;
  }
  body::after {
    width: 500px; height: 500px;
    background: radial-gradient(circle, rgba(236, 72, 153, 0.1), transparent);
    bottom: -150px; right: -150px;
    animation-delay: -10s;
  }

  @keyframes float {
    0%, 100% { transform: translate(0, 0) scale(1); }
    33% { transform: translate(50px, -30px) scale(1.1); }
    66% { transform: translate(-30px, 50px) scale(0.9); }
  }

  .container { max-width: 800px; width: 100%; }

  header { text-align: center; margin: 50px 0 30px; }
  header h1 {
    font-size: 2.8rem;
    font-weight: 800;
    background: linear-gradient(135deg, #7c3aed, #ec4899, #06b6d4);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
    letter-spacing: -1px;
  }
  header p {
    color: var(--text-muted);
    margin-top: 10px;
    font-size: 1rem;
  }

  .search-bar {
    display: flex;
    gap: 10px;
    margin-bottom: 30px;
  }
  .search-bar input {
    flex: 1;
    padding: 16px 20px;
    background: var(--glass-bg);
    backdrop-filter: blur(var(--blur));
    -webkit-backdrop-filter: blur(var(--blur));
    border: 1px solid var(--glass-border);
    border-radius: 14px;
    color: var(--text);
    font-size: 1.1rem;
    outline: none;
    transition: all 0.3s ease;
  }
  .search-bar input:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-glow);
  }
  .search-bar input::placeholder { color: var(--text-muted); }
  .search-bar button {
    padding: 16px 28px;
    background: var(--glass-bg);
    backdrop-filter: blur(var(--blur));
    -webkit-backdrop-filter: blur(var(--blur));
    border: 1px solid var(--glass-border);
    color: var(--text);
    border-radius: 14px;
    font-size: 1.1rem;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.3s ease;
  }
  .search-bar button:hover {
    background: var(--accent);
    border-color: var(--accent);
    box-shadow: 0 0 20px var(--accent-glow);
  }

  .quick-links {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
    gap: 12px;
    margin-bottom: 30px;
  }
  .quick-link {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 20px 10px;
    background: var(--glass-bg);
    backdrop-filter: blur(var(--blur));
    -webkit-backdrop-filter: blur(var(--blur));
    border: 1px solid var(--glass-border);
    border-radius: 16px;
    text-decoration: none;
    color: var(--text);
    transition: all 0.3s ease;
  }
  .quick-link:hover {
    background: var(--glass-hover);
    border-color: var(--accent);
    transform: translateY(-4px);
    box-shadow: 0 8px 30px var(--accent-glow);
  }
  .quick-link .icon { font-size: 2rem; margin-bottom: 8px; }
  .quick-link .name { font-size: 0.85rem; font-weight: 500; }

  .tabs {
    display: flex;
    gap: 4px;
    margin-bottom: 20px;
    background: var(--glass-bg);
    backdrop-filter: blur(var(--blur));
    -webkit-backdrop-filter: blur(var(--blur));
    border: 1px solid var(--glass-border);
    border-radius: 14px;
    padding: 4px;
  }
  .tab {
    flex: 1;
    padding: 10px 16px;
    background: none;
    border: none;
    color: var(--text-muted);
    font-size: 0.95rem;
    cursor: pointer;
    border-radius: 10px;
    transition: all 0.3s ease;
  }
  .tab.active {
    color: var(--text);
    background: var(--glass-hover);
    box-shadow: 0 2px 10px rgba(0,0,0,0.2);
  }
  .tab-content { display: none; }
  .tab-content.active { display: block; }

  .history-list { list-style: none; }
  .history-item {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 14px 16px;
    background: var(--glass-bg);
    backdrop-filter: blur(var(--blur));
    -webkit-backdrop-filter: blur(var(--blur));
    border: 1px solid var(--glass-border);
    border-radius: 12px;
    margin-bottom: 8px;
    text-decoration: none;
    color: var(--text);
    transition: all 0.3s ease;
  }
  .history-item:hover {
    background: var(--glass-hover);
    border-color: var(--accent);
  }
  .history-item .favicon { font-size: 1.2rem; }
  .history-item .title { font-weight: 500; }
  .history-item .url { color: var(--text-muted); font-size: 0.8rem; margin-left: auto; }
  .history-item .delete {
    background: none; border: none; color: var(--text-muted); cursor: pointer;
    font-size: 1.2rem; padding: 0 4px; opacity: 0.5; transition: all 0.2s;
  }
  .history-item .delete:hover { opacity: 1; color: var(--danger); }
  .empty-state { text-align: center; color: var(--text-muted); padding: 40px; }

  .setting-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 16px;
    background: var(--glass-bg);
    backdrop-filter: blur(var(--blur));
    -webkit-backdrop-filter: blur(var(--blur));
    border: 1px solid var(--glass-border);
    border-radius: 12px;
    margin-bottom: 8px;
  }
  .setting-row label { font-weight: 500; }
  .setting-row .desc { color: var(--text-muted); font-size: 0.8rem; margin-top: 2px; }

  .toggle {
    position: relative;
    width: 48px; height: 26px;
    background: var(--glass-border);
    border-radius: 13px;
    cursor: pointer;
    transition: background 0.3s;
    flex-shrink: 0;
  }
  .toggle.on { background: var(--accent); box-shadow: 0 0 10px var(--accent-glow); }
  .toggle::after {
    content: '';
    position: absolute;
    width: 20px; height: 20px;
    background: #fff;
    border-radius: 50%;
    top: 3px; left: 3px;
    transition: left 0.3s;
  }
  .toggle.on::after { left: 25px; }

  .shortcuts {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    margin-top: 12px;
  }
  .shortcut {
    padding: 12px 16px;
    background: var(--glass-bg);
    backdrop-filter: blur(var(--blur));
    -webkit-backdrop-filter: blur(var(--blur));
    border: 1px solid var(--glass-border);
    border-radius: 10px;
    font-size: 0.85rem;
  }
  .shortcut kbd {
    background: rgba(255,255,255,0.1);
    padding: 2px 8px;
    border-radius: 6px;
    font-size: 0.8rem;
    border: 1px solid var(--glass-border);
  }

  .btn-danger {
    padding: 8px 16px;
    background: var(--glass-bg);
    backdrop-filter: blur(var(--blur));
    -webkit-backdrop-filter: blur(var(--blur));
    border: 1px solid var(--glass-border);
    color: var(--text);
    border-radius: 10px;
    cursor: pointer;
    font-weight: 500;
    transition: all 0.3s;
  }
  .btn-danger:hover {
    background: var(--danger);
    border-color: var(--danger);
  }

  footer {
    text-align: center;
    color: var(--text-muted);
    font-size: 0.8rem;
    margin-top: 40px;
    padding-top: 20px;
    border-top: 1px solid var(--glass-border);
  }

  @media (max-width: 600px) {
    header h1 { font-size: 2rem; }
    .quick-links { grid-template-columns: repeat(3, 1fr); }
    .shortcuts { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>
<div class="container">
  <header>
    <h1>WebProxy</h1>
    <p>Browse the web freely — ad-blocked, encrypted, and fast</p>
  </header>

  <div class="search-bar">
    <input type="text" id="urlInput" placeholder="Enter URL or search..." autofocus>
    <button onclick="navigate()">Go</button>
  </div>

  <div class="quick-links">
    ${quickLinksHTML}
  </div>

  <div class="tabs">
    <button class="tab active" onclick="switchTab('history', this)">📜 History</button>
    <button class="tab" onclick="switchTab('shortcuts', this)">⌨️ Shortcuts</button>
    <button class="tab" onclick="switchTab('settings', this)">⚙️ Settings</button>
  </div>

  <div class="tab-content active" id="tab-history">
    <ul class="history-list" id="historyList">
      <div class="empty-state">No history yet. Start browsing!</div>
    </ul>
  </div>

  <div class="tab-content" id="tab-shortcuts">
    <div class="shortcuts">
      <div class="shortcut"><kbd>Alt</kbd> + <kbd>S</kbd> — Focus search bar</div>
      <div class="shortcut"><kbd>Alt</kbd> + <kbd>H</kbd> — Go to history tab</div>
      <div class="shortcut"><kbd>Alt</kbd> + <kbd>Enter</kbd> — Open in new tab</div>
      <div class="shortcut"><kbd>Esc</kbd> — Clear search bar</div>
    </div>
  </div>

  <div class="tab-content" id="tab-settings">
    <div class="setting-row">
      <div>
        <label>Clear History</label>
        <div class="desc">Remove all browsing history</div>
      </div>
      <button class="btn-danger" onclick="clearHistory()">Clear</button>
    </div>
    <div class="setting-row">
      <div>
        <label>Clear Session</label>
        <div class="desc">Clear cookies and session data</div>
      </div>
      <button class="btn-danger" onclick="clearSession()">Clear</button>
    </div>
  </div>

  <footer>
    WebProxy • Powered by Cloudflare Workers
  </footer>
</div>

<script>
function navigate(newTab) {
  var input = document.getElementById('urlInput');
  var url = input.value.trim();
  if (!url) return;
  if (!/^https?:\\/\\//i.test(url)) {
    if (/^[\\w-]+\\.[\\w.-]+/.test(url)) url = 'https://' + url;
    else url = 'https://www.google.com/search?q=' + encodeURIComponent(url);
  }
  var proxyURL = '/proxy?url=' + encodeURIComponent(url);
  if (newTab) window.open(proxyURL, '_blank');
  else window.location.href = proxyURL;
}

document.getElementById('urlInput').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') {
    if (e.altKey) navigate(true);
    else navigate(false);
  }
  if (e.key === 'Escape') e.target.value = '';
});

function switchTab(name, btn) {
  document.querySelectorAll('.tab').forEach(function(t) { t.classList.remove('active'); });
  document.querySelectorAll('.tab-content').forEach(function(c) { c.classList.remove('active'); });
  btn.classList.add('active');
  document.getElementById('tab-' + name).classList.add('active');
}

function loadHistory() {
  var history = JSON.parse(localStorage.getItem('proxyHistory') || '[]');
  var list = document.getElementById('historyList');
  if (history.length === 0) {
    list.innerHTML = '<div class="empty-state">No history yet. Start browsing!</div>';
    return;
  }
  list.innerHTML = history.map(function(item, i) {
    return '<a class="history-item" href="/proxy?url=' + encodeURIComponent(item.url) + '">' +
      '<span class="favicon">🌐</span>' +
      '<span class="title">' + escapeHtml(item.title || item.url) + '</span>' +
      '<span class="url">' + escapeHtml(item.url) + '</span>' +
      '<button class="delete" onclick="event.preventDefault(); event.stopPropagation(); deleteHistory(' + i + ')">×</button>' +
    '</a>';
  }).join('');
}

function deleteHistory(i) {
  var history = JSON.parse(localStorage.getItem('proxyHistory') || '[]');
  history.splice(i, 1);
  localStorage.setItem('proxyHistory', JSON.stringify(history));
  loadHistory();
}

function clearHistory() {
  localStorage.removeItem('proxyHistory');
  loadHistory();
}

function clearSession() {
  fetch('/clear-session').then(function() {
    alert('Session cleared!');
  });
}

function escapeHtml(s) {
  var d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

document.addEventListener('keydown', function(e) {
  if (e.altKey && e.key === 's') { e.preventDefault(); document.getElementById('urlInput').focus(); }
  if (e.altKey && e.key === 'h') { e.preventDefault(); switchTab('history', document.querySelector('.tab')); }
});

window.addEventListener('message', function(e) {
  if (e.data && e.data.__tunnel) {
    var history = JSON.parse(localStorage.getItem('proxyHistory') || '[]');
    var existing = history.findIndex(function(h) { return h.url === e.data.realUrl; });
    if (existing !== -1) history.splice(existing, 1);
    history.unshift({ url: e.data.realUrl, title: e.data.title, ts: Date.now() });
    if (history.length > 50) history.pop();
    localStorage.setItem('proxyHistory', JSON.stringify(history));
    loadHistory();
  }
});

loadHistory();
</script>
</body>
</html>`;
}

/* ------------------------------------------------------------------ */
/* WebSocket proxy                                                     */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/* HTTP proxy                                                           */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/* JS URL rewriting                                                    */
/* ------------------------------------------------------------------ */

const JS_URL_RE = /(["'`])(https?:\/\/[^"'`\s)]+)\1/g;
const IMPORT_EXPORT_RE = /\b(import\s*\(\s*|import\s+(?:[\w${}*,\s]+from\s+)?|export\s+(?:[\w${}*,\s]+from\s+)?)(["'])([^"'\n]+)\2/g;
const SOURCE_MAP_RE = /(\/\/[#@]\s*sourceMappingURL=)([^\s]+)/;

function rewriteJsUrls(js: string, baseUrl: string): string {
  let out = js.replace(IMPORT_EXPORT_RE, (match, prefix, quote, spec) => {
    if (spec.startsWith("data:") || spec.includes("/proxy?url=")) return match;
    try {
      const absolute = new URL(spec, baseUrl).toString();
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

/* ------------------------------------------------------------------ */
/* Unproxy text                                                        */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/* Main entry                                                          */
/* ------------------------------------------------------------------ */

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "") {
      return new Response(getDashboardHTML(), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

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
          return new Response("Only ws(s) targets support WebSocket upgrade", {
            status: 400,
          });
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

interface Env {
  COOKIE_JAR: DurableObjectNamespace;
  ASSETS: Fetcher;
}
