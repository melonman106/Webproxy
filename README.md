# Tunnel — HTML/CSS/JS rewriting web proxy

A two-part project: an Express + TypeScript backend that fetches a target
page and rewrites its URLs so every asset round-trips through the proxy,
and a React + TypeScript frontend that gives you an address bar + iframe
to browse through it.

## Structure

```
webproxy/
  server/   Express + TypeScript proxy (port 8080)
  client/   Vite + React + TypeScript UI (port 5173)
```

## Running it

```bash
# terminal 1
cd server
npm install
npm run dev        # http://localhost:8080

# terminal 2
cd client
npm install
npm run dev         # http://localhost:5173
```

Open http://localhost:5173, type a URL (or click a shortcut), and it loads
inside the iframe via `/proxy?url=...`.

## How the rewriting works

1. `GET /proxy?url=<target>` fetches the target server-side.
2. If the response is **HTML**, it's parsed with `cheerio` and every
   `href`/`src`/`action`/`srcset` is rewritten to point back at
   `/proxy?url=<absolute-url>`, so links, images, stylesheets, and
   sub-frames all stay inside the tunnel. A small shim is injected into
   `<head>` that patches `fetch` and `XMLHttpRequest` so JavaScript
   the page runs later *also* routes through the proxy.
3. If the response is **CSS**, any `url(...)` reference is rewritten the
   same way.
4. Everything else (JS files, images, fonts, video segments, JSON) is
   streamed through unmodified — rewriting arbitrary compiled JavaScript
   reliably isn't feasible, which is why the runtime shim exists instead.
5. Headers that would block framing or cross-origin loading
   (`Content-Security-Policy`, `X-Frame-Options`) are stripped from the
   response.

## Real limitations — please read before relying on this

- **DuckDuckGo's HTML endpoint** (`html.duckduckgo.com/html/`) is
  lightweight and mostly static, so it proxies cleanly.
- **Google** actively fingerprints traffic, uses heavy inline JS, and
  will frequently show CAPTCHAs or blank results when hit from a
  server-side fetch instead of a real browser session.
- **YouTube** is the hardest case: video delivery uses signed,
  short-lived URLs, DASH/HLS manifests, EME/DRM-adjacent code paths, and
  service workers, none of which a lightweight rewriting proxy like this
  can fully reproduce. Expect the shell to load and playback to be
  unreliable or broken.
- This is a functional starting point (similar in spirit to projects
  like Rammerhead/Ultraviolet), not a production-grade unblocker —
  cookie/session handling, WebSocket proxying, and service-worker
  interception are all left as further work if you want to extend it.
- If your goal is bypassing a school, employer, or network
  administrator's content filtering, be aware that doing so may violate
  the relevant acceptable-use policy even where it's technically
  possible — that's a policy question for you to weigh, not something
  this code addresses.

## Extending it

- Add WebSocket proxying (needed for YouTube's chat/live features and
  many modern SPAs) via a `ws` upgrade handler in `server.ts`.
- Add a service-worker shim so pages that install their own SW don't
  escape the tunnel.
- Add per-session cookie jars (currently `Set-Cookie` is stripped for
  simplicity, so logins won't persist).
