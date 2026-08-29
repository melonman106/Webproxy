# Tunnel — a Safari-styled, rewriting web proxy on Cloudflare Workers

A single Cloudflare Worker that serves a Safari-inspired multi-tab
browser UI and proxies arbitrary sites through `/proxy?url=...`,
rewriting HTML/CSS/JS so assets, cookies, WebSockets, workers, and
navigation all round-trip through the tunnel.

## Structure

```
webproxy/
  wrangler.toml            Worker config: script, static assets, DO, KV
  worker/src/index.ts      HTTP + WebSocket proxy, cookie jar wiring,
                            bookmarks/history API, JS/body rewriting
  worker/src/rewriter.ts   HTMLRewriter-based rewriting + injected page shim
  worker/src/cookieJar.ts  Durable Object: per-session, per-origin cookie jar
  client/                  Vite + React + TS — Safari-style tab/toolbar UI
  .github/workflows/deploy.yml   CI: builds client, deploys Worker on push
```

## About the Safari look

This is a Safari-**inspired** chrome — traffic lights, a tab strip, a
unified toolbar, a centered address bar — built with plain CSS and
inline SVG icons. It is not literally Apple's Safari: no Apple assets,
icons, or the San Francisco font file are bundled (the `-apple-system`
font-stack entry just tells Apple devices to use their own system font,
which is standard web practice, not asset reuse). Treat this as "close
visual and behavioral homage," not a pixel-identical clone — some
Safari-only behavior (Reader Mode, extensions, Handoff, etc.) isn't
attempted at all.

What *is* real, not cosmetic: because every proxied page is served from
your Worker's own origin, the browser treats it as same-origin. That
means the toolbar's Back/Forward/Reload buttons call the real
`iframe.contentWindow.history.back()/forward()` and
`location.reload()` — this isn't a fake browser chrome sitting in front
of an opaque iframe, the tab bar's title and address bar are also kept
honest by a small `postMessage` reporter injected into every proxied
page (see `reportState()` in `rewriter.ts`).

## What's implemented

- **HTML/CSS rewriting** via `HTMLRewriter`, streaming, no full-page buffering.
- **JS rewriting**: absolute URL string literals, relative `import`/
  `export` specifiers, dynamic `import()`, and `//# sourceMappingURL=`
  comments are all rewritten to resolve against the real page instead
  of the proxy path. This is regex-based, not a real parser — see
  Limitations.
- **WebSocket proxying**, both for the page's own `fetch`-based sockets
  (patched in the shim) and pages that use `new WebSocket(...)`.
- **Cookies persist server-side** in a Durable Object (`CookieJar`), one
  per browser session, keyed by target origin — see "How cookies work"
  below for why this beats forwarding `Set-Cookie` to the browser directly.
- **Service Worker registration** is rewritten (script URL + scope), so
  `navigator.serviceWorker.register(...)` targets the proxy.
- **Web Worker / SharedWorker** construction is rewritten the same way
  `new WebSocket()` is.
- **Multi-tab browsing**: real tabs, each with its own iframe, history,
  title, and favicon slot; background tabs stay mounted so they keep state.
- **Bookmarks and history**, persisted server-side in **Workers KV**
  (`USER_DATA` binding), scoped per session — `/api/bookmarks` and
  `/api/history` (GET/POST/DELETE).
- **POST body reverse-rewriting**: if a page's own JS ends up putting a
  `/proxy?url=...` string into a form field or JSON payload it submits,
  that gets converted back to the real URL before forwarding upstream
  (for `application/x-www-form-urlencoded`, `application/json`, and
  `text/*` bodies — not multipart, see Limitations).
- **Redirect handling** (`Location` header rewritten, cookies preserved
  across the hop) and a `/clear-session` route to wipe a session's cookies.
- **Dynamic DOM content stays inside the tunnel.** The single biggest
  source of "this opened outside the proxy" bugs is JS that builds DOM
  nodes in memory and assigns `src`/`href`/etc. directly — that never
  goes through `fetch`/`XHR`, so the original shim never saw it. Three
  layers now catch this: `Element.prototype.setAttribute` is patched,
  the IDL property setters (`img.src = ...`, `a.href = ...`, etc.) are
  patched, and a `MutationObserver` backstops anything set via
  `innerHTML`/`insertAdjacentHTML`/`cloneNode` that bypasses both. Verified
  against all three paths with a scripted test.
- **`target="_blank"` links used to skip rewriting entirely** (a direct
  proxy bypass) — fixed to open the proxied URL in a new tab via
  `window.open` instead. The iframe's sandbox also now includes
  `allow-popups-to-escape-sandbox` so those new tabs aren't crippled by
  inherited sandbox restrictions.

## How cookies work

The browser never sees the real cookies a proxied site sets. Instead:

1. On first visit, the Worker issues its own first-party session cookie
   (`__psid`, host-only, on your Worker's own domain).
2. That session ID maps to one **Durable Object** instance (`CookieJar`)
   storing `{ targetOrigin: { cookieName: value } }` in durable SQLite storage.
3. Before each upstream fetch, the Worker looks up cookies for that
   target's origin and sends them as the `Cookie` header.
4. After the response, `Set-Cookie` headers are parsed and merged back
   into the jar for that origin (with basic `Max-Age=0`/`Expires` deletion).

This matters mechanically, not just architecturally: a real
`Set-Cookie: Domain=.youtube.com` forwarded straight to the browser
would be **silently dropped**, because the browser only accepts cookies
whose `Domain` matches the response's actual origin (your Worker's
domain, not youtube.com). Keeping cookies server-side, scoped per
target origin, is what makes logins persist and keeps different
proxied sites' cookies from bleeding into each other.

## Deploying

Push to `main` and GitHub Actions builds + deploys automatically (needs
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repo secrets), or if
you're using Cloudflare's own **Workers Builds** dashboard integration
instead, the root `package.json`'s `postinstall` script builds the
client automatically so `client/dist` exists before `wrangler deploy`
runs — see the comment in `package.json` if that ever needs adjusting.

The `USER_DATA` KV namespace and `CookieJar` Durable Object are already
wired up in `wrangler.toml`. If you fork this into a fresh Cloudflare
account, create your own KV namespace (`wrangler kv namespace create
USER_DATA`) and swap in the resulting `id`.

## About the icons

Uses `lucide-react` — genuinely open-source (ISC license), not Apple's
SF Symbols. (If you're looking for that visual style specifically:
OrchardKit/open-symbols converts several open-source icon sets,
including Lucide, into Apple's `.symbols` format for use in native
Apple apps — but the underlying icons are the same open-source ones
used here, just repackaged for Xcode. Apple's actual proprietary SF
Symbols glyphs aren't reusable outside Apple platform apps under
Apple's license, so those aren't what's bundled here.)

## Cloudflare platform limits (this is probably why "it works locally but not on Cloudflare")

Cloudflare enforces resource limits **only on deployed Workers, not in
local `wrangler dev`** — so something can pass every local test and still
fail once it's live. The one most likely to bite this project:

- **Workers Free: 10ms of CPU time per request.** This only counts actual
  computation — waiting on `fetch()`, KV, or Durable Object calls doesn't
  count against it. But the regex-based rewriting this proxy does on JS/CSS
  responses (`rewriteJsUrls`, `rewriteCssText`) is real synchronous CPU
  work, and large minified bundles (YouTube's JS chunks routinely run
  several hundred KB to multiple MB) can plausibly eat that whole budget in
  one response, returning Cloudflare's `Error 1102: Worker exceeded
  resource limits` instead of the page.
- **Mitigation already in place:** `MAX_TEXT_REWRITE_BYTES` (300 KB) in
  `worker/src/index.ts` skips the regex rewriting pass for anything larger
  and passes it through unmodified instead — some embedded URLs in huge
  files may not get proxied, but the script loads rather than the whole
  request failing outright. Tune this constant if you want to trade more
  completeness for more CPU risk, or the reverse.
- **The real fix, if you hit this a lot: upgrade to Workers Paid** ($5/mo
  base). Default CPU time jumps to 30 seconds, configurable up to 5 minutes
  via `[limits] cpu_ms` in `wrangler.toml` (commented out there already —
  just uncomment). That's a different order of magnitude of headroom for
  this kind of workload.
- Other Free-tier limits (100k requests/day, 50 subrequests/request, 3 MB
  Worker bundle size) are unlikely to be the bottleneck for this project as
  currently built — the proxy does one upstream fetch + one cookie-jar
  Durable Object call per request (2 subrequests), and the Worker bundle
  itself (no heavy server-side dependencies — `HTMLRewriter` is native) is
  small.

## Real limitations — please read before relying on this

- **YouTube** remains the hardest case. Its Polymer-based frontend does
  heavy dynamic module loading, signed/short-lived video URLs, and
  DASH/HLS manifests — none of that is solved by better URL rewriting
  alone. Expect the shell to load and playback to be unreliable.
- **Google** fingerprints traffic and frequently shows CAPTCHAs when hit
  from a server-side fetch instead of a real browser session.
- **JS/import rewriting is regex-based, not a real parser.** It handles
  straightforward `import`/`export`/`import()` statements but will miss
  computed or templated specifiers (e.g. `import(`${base}/x.js`)`) and
  can misfire on unusual minified code shapes. Treat it as a heuristic,
  not a guarantee.
- **Service workers and dedicated/shared workers**: the *registration*
  call is rewritten, but a worker's own `fetch()`/`importScripts()`
  calls run in a separate global scope the page-level shim can't reach.
  Those get whatever coverage the blanket JS-text rewriting pass
  provides — real but partial, especially for workers that build URLs
  dynamically at runtime rather than as string literals.
- **Multipart POST bodies** (file uploads) are passed through as raw
  bytes untouched — no attempt is made to rewrite proxy URLs embedded
  inside multipart fields, since doing that safely on binary-safe
  boundaries is a meaningfully bigger project.
- **Single browser instance, not real multi-window**: tabs live in one
  React component's state; there's no persistence of open tabs across a
  page reload of the console itself (bookmarks/history do persist —
  open tabs don't, yet).
- If your goal is bypassing a school, employer, or network
  administrator's content filtering, that may violate the relevant
  acceptable-use policy even where it's technically possible — that's a
  policy question for you to weigh, not something this code addresses.

## Still open / natural next steps

- **Source maps**: `//# sourceMappingURL=` comments are now rewritten
  to route through the proxy, but this hasn't been tested against a
  real DevTools debugging session end-to-end.
- **Tab persistence**: save open tabs (not just bookmarks/history) to
  KV or `localStorage` so a page refresh doesn't lose them.
- **Rate limiting / host allowlisting** if you expose this publicly —
  right now it will fetch any http(s)/ws(s) URL handed to it.
- **A real HTML/JS parser** (e.g. running a bundler-style AST pass)
  instead of regex for cases where the heuristic import rewriting falls
  short — meaningfully more engineering than this project currently
  invests, but the honest ceiling on how far pure text rewriting gets you.
