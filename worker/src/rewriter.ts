/**
 * URL/HTML/CSS rewriting for the proxy, built on Cloudflare's native
 * streaming HTMLRewriter — no DOM parsing library needed, and it never
 * buffers the whole page into memory.
 */

export function toProxyUrl(base: string, target: string): string {
  try {
    const absolute = new URL(target, base).toString();
    return `/proxy?url=${encodeURIComponent(absolute)}`;
  } catch {
    // javascript:, mailto:, #anchors, etc. are left untouched.
    return target;
  }
}

const CSS_URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;

export function rewriteCssText(css: string, baseUrl: string): string {
  return css.replace(CSS_URL_RE, (match, quote, url) => {
    if (url.startsWith("data:")) return match;
    return `url(${quote}${toProxyUrl(baseUrl, url)}${quote})`;
  });
}

const ATTR_TAGS: Record<string, string> = {
  a: "href",
  link: "href",
  script: "src",
  img: "src",
  source: "src",
  iframe: "src",
  form: "action",
  video: "src",
  audio: "src",
  embed: "src",
};

/**
 * Injected at the top of <head> on every proxied HTML page. Patches
 * fetch/XHR/WebSocket so JS the page runs on its own also tunnels
 * through /proxy, instead of only the URLs present in the initial HTML.
 */
function buildShim(baseUrl: string): string {
  return `<script>
(function () {
  var REAL_BASE = ${JSON.stringify(baseUrl)};
  function toHttpProxy(u) {
    try {
      var abs = new URL(u, REAL_BASE).toString();
      return "/proxy?url=" + encodeURIComponent(abs);
    } catch (e) { return u; }
  }
  function toWsProxy(u) {
    try {
      var abs = new URL(u, REAL_BASE.replace(/^http/, "ws")).toString();
      var wsScheme = location.protocol === "https:" ? "wss:" : "ws:";
      return wsScheme + "//" + location.host + "/proxy?url=" + encodeURIComponent(abs);
    } catch (e) { return u; }
  }

  var origFetch = window.fetch;
  window.fetch = function (input, init) {
    var url = typeof input === "string" ? input : input && input.url;
    if (url && !/^\\/proxy\\?url=/.test(url)) {
      var proxied = toHttpProxy(url);
      input = typeof input === "string" ? proxied : new Request(proxied, input);
    }
    return origFetch.call(this, input, init);
  };

  var origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    var args = Array.prototype.slice.call(arguments);
    if (url && !/^\\/proxy\\?url=/.test(url)) args[1] = toHttpProxy(url);
    return origOpen.apply(this, args);
  };

  var OrigWebSocket = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    return new OrigWebSocket(toWsProxy(url), protocols);
  };
  window.WebSocket.prototype = OrigWebSocket.prototype;
  window.WebSocket.CONNECTING = OrigWebSocket.CONNECTING;
  window.WebSocket.OPEN = OrigWebSocket.OPEN;
  window.WebSocket.CLOSING = OrigWebSocket.CLOSING;
  window.WebSocket.CLOSED = OrigWebSocket.CLOSED;
})();
</script>`;
}

class AttrRewriter {
  constructor(private attr: string, private baseUrl: string) {}
  element(el: Element) {
    const val = el.getAttribute(this.attr);
    if (val) el.setAttribute(this.attr, toProxyUrl(this.baseUrl, val));
  }
}

class SrcsetRewriter {
  constructor(private baseUrl: string) {}
  element(el: Element) {
    const val = el.getAttribute("srcset");
    if (!val) return;
    const rewritten = val
      .split(",")
      .map((part) => {
        const [url, descriptor] = part.trim().split(/\s+/, 2);
        const proxied = toProxyUrl(this.baseUrl, url);
        return descriptor ? `${proxied} ${descriptor}` : proxied;
      })
      .join(", ");
    el.setAttribute("srcset", rewritten);
  }
}

class StyleAttrRewriter {
  constructor(private baseUrl: string) {}
  element(el: Element) {
    const val = el.getAttribute("style");
    if (val) el.setAttribute("style", rewriteCssText(val, this.baseUrl));
  }
}

/** Inline <style>...</style> text can arrive across several chunks; buffer
 * until the last chunk of the text node, then rewrite the whole thing. */
class InlineStyleTextRewriter {
  private buffer = "";
  constructor(private baseUrl: string) {}
  text(chunk: Text) {
    this.buffer += chunk.text;
    if (chunk.lastInTextNode) {
      chunk.replace(rewriteCssText(this.buffer, this.baseUrl), { html: false });
      this.buffer = "";
    } else {
      chunk.remove();
    }
  }
}

class HeadShimInjector {
  constructor(private baseUrl: string) {}
  element(el: Element) {
    el.prepend(buildShim(this.baseUrl), { html: true });
  }
}

/** Removes <meta> tags that would block or redirect the framed page
 * outside of the proxy tunnel (CSP meta tags, meta-refresh). */
class BlockingMetaStripper {
  element(el: Element) {
    const httpEquiv = (el.getAttribute("http-equiv") || "").toLowerCase();
    if (httpEquiv === "content-security-policy" || httpEquiv === "refresh") {
      el.remove();
    }
  }
}

export function rewriteHtmlResponse(response: Response, baseUrl: string): Response {
  const rewriter = new HTMLRewriter();
  for (const [tag, attr] of Object.entries(ATTR_TAGS)) {
    rewriter.on(tag, new AttrRewriter(attr, baseUrl));
  }
  rewriter.on("[srcset]", new SrcsetRewriter(baseUrl));
  rewriter.on("[style]", new StyleAttrRewriter(baseUrl));
  rewriter.on("style", new InlineStyleTextRewriter(baseUrl));
  rewriter.on("head", new HeadShimInjector(baseUrl));
  rewriter.on("meta", new BlockingMetaStripper());
  return rewriter.transform(response);
}
