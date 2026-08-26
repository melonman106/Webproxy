import express, { Request, Response } from "express";
import cors from "cors";
import fetch, { Headers } from "node-fetch";
import { rewriteHtml, rewriteCss } from "./rewriter";

const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;

app.use(cors());
app.use(express.raw({ type: "*/*", limit: "25mb" }));

// Headers that must never be forwarded to the browser, either because
// they are hop-by-hop or because they'd block the page from being
// framed / fetched cross-origin through this proxy.
const STRIPPED_RESPONSE_HEADERS = new Set([
  "content-security-policy",
  "content-security-policy-report-only",
  "x-frame-options",
  "content-encoding", // node-fetch already decodes gzip/br for us
  "content-length", // length changes once we rewrite the body
  "strict-transport-security",
  "set-cookie", // simplest safe default; see README for cookie handling
]);

app.all("/proxy", async (req: Request, res: Response) => {
  const target = req.query.url;
  if (typeof target !== "string") {
    res.status(400).send("Missing ?url= query parameter");
    return;
  }

  let targetUrl: URL;
  try {
    targetUrl = new URL(target);
  } catch {
    res.status(400).send("Invalid target URL");
    return;
  }
  if (!/^https?:$/.test(targetUrl.protocol)) {
    res.status(400).send("Only http(s) targets are allowed");
    return;
  }

  try {
    const forwardHeaders = new Headers();
    forwardHeaders.set(
      "User-Agent",
      req.get("user-agent") ||
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
    );
    forwardHeaders.set("Accept", req.get("accept") || "*/*");
    forwardHeaders.set("Accept-Language", req.get("accept-language") || "en-US,en;q=0.9");
    if (req.get("range")) forwardHeaders.set("Range", req.get("range")!);

    const upstream = await fetch(targetUrl.toString(), {
      method: req.method,
      headers: forwardHeaders,
      redirect: "follow",
      body: ["GET", "HEAD"].includes(req.method) ? undefined : (req.body as Buffer),
    });

    upstream.headers.forEach((value, key) => {
      if (!STRIPPED_RESPONSE_HEADERS.has(key.toLowerCase())) {
        res.setHeader(key, value);
      }
    });
    res.status(upstream.status);

    const contentType = upstream.headers.get("content-type") || "";

    if (contentType.includes("text/html")) {
      const body = await upstream.text();
      res.send(rewriteHtml(body, targetUrl.toString()));
      return;
    }

    if (contentType.includes("text/css")) {
      const body = await upstream.text();
      res.send(rewriteCss(body, targetUrl.toString()));
      return;
    }

    // Everything else (JS, images, fonts, video chunks, JSON, etc.) is
    // streamed through unmodified — rewriting arbitrary JS reliably
    // isn't feasible, so app logic is patched at runtime instead via
    // the shim injected into every HTML page (see rewriter.ts).
    const buf = await upstream.buffer();
    res.send(buf);
  } catch (err) {
    console.error("Proxy error for", target, err);
    res.status(502).send("Upstream fetch failed: " + (err as Error).message);
  }
});

app.get("/health", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Proxy server listening on http://localhost:${PORT}`);
});
