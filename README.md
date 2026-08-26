# Tunnel — HTML/CSS/JS rewriting web proxy (Cloudflare Workers)

A single Cloudflare Worker that serves a React console UI and proxies
arbitrary sites through `/proxy?url=...`, rewriting HTML/CSS so every
asset round-trips through the tunnel, with server-side cookie
persistence and WebSocket proxying.

## Structure

```
webproxy/
  wrangler.toml            Worker config: script, static assets, Durable Object
  worker/src/index.ts      HTTP + WebSocket proxy logic
  worker/src/rewriter.ts   HTMLRewriter-based URL/CSS rewriting + JS shim
  worker/src/cookieJar.ts  Durable Object: per-session, per-origin cookie jar
  client/                  Vite + React + TS console UI (address bar, iframe)
  .github/workflows/deploy.yml   CI: builds client, deploys Worker on push to main
```

## Why Cloudflare Workers instead of the earlier Express version

Workers run on a different runtime than Node — no `express`, no
`node-fetch`, no filesystem. So this isn't the old server ported over;
it's rewritten against Workers' native primitives:

- **HTML rewriting** uses the built-in `HTMLRewriter` (streaming, no
  buffering the whole page into memory) instead of `cheerio`.
- **WebSocket proxying** uses Workers' outbound WebSocket support:
  `fetch(url, { headers: { Upgrade: "websocket" } })` returns a response
  with a `.webSocket` you can pipe against a `WebSocketPair`.
- **Cookies** are held server-side in a **Durable Object** (one per
  browser session), keyed by target origin, rather than being passed
  through to the browser — see "How cookies work" below for why.
- **The React app is served by the same Worker** via Workers' static
  assets binding, so there's one deployable unit, not a separate
  frontend host.

## Deploying

### One-time setup

1. Push this project to a GitHub repo.
2. Get a Cloudflare **API token** (Dashboard → My Profile → API Tokens →
   Create Token → "Edit Cloudflare Workers" template works) and your
   **Account ID** (Dashboard → right sidebar on any domain, or
   Workers & Pages overview page).
3. In your GitHub repo, go to Settings → Secrets and variables →
   Actions, and add:
   - `CLOUDFLARE_API_TOKEN`
   - `CLOUDFLARE_ACCOUNT_ID`

### Deploy

Push to `main`. `.github/workflows/deploy.yml` builds the React client,
type-checks the Worker, and runs `wrangler deploy` for you. Your app
goes live at `https://tunnel-proxy.<your-subdomain>.workers.dev`
(rename the Worker by changing `name` in `wrangler.toml`).

### A note on Cloudflare's "Workers Builds" (dashboard Git integration)

If you connect this repo directly in the Cloudflare dashboard (Workers &
Pages → Create → Connect to Git) instead of using the GitHub Actions
workflow above, Cloudflare runs its own build system called **Workers
Builds**. By default it just runs `<package manager> install` then your
deploy command (`npx wrangler deploy`) — it does **not** run the client
build in between, and it explicitly does not honor a `[build]` section
in `wrangler.toml`.

This repo works around that with a `postinstall` script in the root
`package.json` that builds the client automatically as part of the
install step, so `client/dist` exists by the time `wrangler deploy`
runs — no dashboard configuration required. If you ever see a
`client/dist does not exist` error from Workers Builds, check that this
`postinstall` script is still intact, or explicitly set a **Build
command** in the project's Settings → Build to
`npm run build:client` as a manual override.

### Deploying manually instead

```bash
npm install -g wrangler
wrangler login
npm run deploy
```

### Running locally

```bash
npm run dev     # builds the client, then wrangler dev
```

`wrangler dev` simulates Durable Objects and static assets locally, so
cookies and WebSocket proxying both work in local dev too.

## How the rewriting works

1. `GET /proxy?url=<target>` fetches the target from the Worker.
2. **HTML** responses are streamed through `HTMLRewriter`, which
   rewrites every `href`/`src`/`action`/`srcset` to
   `/proxy?url=<absolute-url>`, rewrites `url(...)` in `style="..."`
   attributes and inline `<style>` blocks, strips blocking
   `<meta http-equiv="Content-Security-Policy">` / `refresh` tags, and
   injects a small shim into `<head>` that patches `fetch`, `XHR`, and
   `WebSocket` so JS the page runs *after* load also tunnels through
   the proxy — not just the URLs present in the initial HTML.
3. **CSS** responses get the same `url(...)` treatment.
4. Everything else (JS files, images, fonts, video segments, JSON)
   streams through unmodified.
5. Blocking response headers (`Content-Security-Policy`,
   `X-Frame-Options`) are stripped so the page can be framed.

## How cookies work

The browser never sees the real cookies a proxied site sets. Instead:

1. On first visit, the Worker issues its own first-party session cookie
   (`__psid`, host-only, on your Worker's own domain).
2. That session ID maps to one **Durable Object** instance (`CookieJar`)
   which stores a `{ targetOrigin: { cookieName: value } }` map in
   durable storage.
3. Before each upstream fetch, the Worker looks up cookies for that
   target's origin and sends them as the `Cookie` header.
4. After the response, any `Set-Cookie` headers are parsed and merged
   back into the jar for that origin (with basic `Max-Age=0`/`Expires`
   handling for deletion).

This is deliberate, not just simpler: a real `Set-Cookie: Domain=.youtube.com`
forwarded straight to the browser would be **silently dropped**, because
the browser only accepts cookies whose `Domain` matches the page's
actual origin (your Worker's domain, not youtube.com). Keeping the real
cookies server-side, scoped per target origin, is what makes logins and
session state actually persist — and it also means cookies from
different proxied sites never bleed into each other.

## How WebSocket proxying works

When a request to `/proxy?url=ws(s)://...` carries an `Upgrade:
websocket` header, the Worker opens its own outbound WebSocket to the
target, accepts the browser's WebSocket via a `WebSocketPair`, and
pipes messages between the two until either side closes. The shim
injected into proxied pages also overrides `window.WebSocket` so pages
that open their own sockets (chat widgets, live updates, etc.) get
routed through this same path automatically.

## Real limitations — please read before relying on this

- **DuckDuckGo's HTML endpoint** (`html.duckduckgo.com/html/`) is
  lightweight and mostly static, so it proxies cleanly.
- **Google** actively fingerprints traffic and frequently shows
  CAPTCHAs or blank results when hit from a server-side fetch instead
  of a real browser session — no proxy architecture fixes that on its
  own.
- **YouTube** is the hardest case: signed/short-lived video URLs,
  DASH/HLS manifests, EME/DRM-adjacent code paths, and service workers
  aren't things a rewriting proxy fully replicates. Expect the shell to
  load and playback to be unreliable.
- Long-lived WebSocket connections and heavy proxying will consume
  Workers CPU time; check the current Workers pricing/limits page for
  what your plan allows before relying on this for sustained use.
- If your goal is bypassing a school, employer, or network
  administrator's content filtering, that may violate the relevant
  acceptable-use policy even where it's technically possible — that's a
  policy question for you to weigh, not something this code addresses.

## Extending it further

- Add a `/clear-session` route that calls the Durable Object's
  `clear()` method so users can log out / reset cookies.
- Add a service-worker shim so pages that register their own service
  worker don't escape the tunnel.
- Rate-limit or allowlist target hosts if you're exposing this
  publicly, since right now it will fetch any http(s)/ws(s) URL handed
  to it.
