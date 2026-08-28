// worker/src/rewriter.ts

function toProxyUrl(base: string, target: string): string {
  try {
    if (
      !target ||
      target.startsWith("#") ||
      target.startsWith("data:") ||
      target.startsWith("mailto:") ||
      target.startsWith("tel:") ||
      target.startsWith("javascript:")
    ) {
      return target;
    }
    const absolute = new URL(target, base).toString();
    // Don't proxy Cloudflare challenge resources — they must load directly
    // from challenges.cloudflare.com or the bot verification will fail.
    if (absolute.includes("challenges.cloudflare.com")) {
      return absolute;
    }
    return `/proxy?url=${encodeURIComponent(absolute)}`;
  } catch {
    return target;
  }
}

const CSS_URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;

function rewriteCssText(css: string, baseUrl: string): string {
  return css.replace(CSS_URL_RE, (match, quote: string, url: string) => {
    if (url.startsWith("data:")) return match;
    return `url(${quote}${toProxyUrl(baseUrl, url)}${quote})`;
  });
}

function buildShim(baseUrl: string): string {
  return `<script>
(function () {
  var REAL_BASE = ${JSON.stringify(baseUrl)};

  function isProxied(u) {
    return /^\\/proxy\\?url=/.test(u) || u.indexOf("/proxy?url=") === 0;
  }

  function toHttpProxy(u) {
    try {
      if (!u || u === "" || u === "#" ||
          u.startsWith("javascript:") || u.startsWith("data:") ||
          u.startsWith("mailto:") || u.startsWith("tel:") ||
          u.startsWith("blob:") || isProxied(u))
        return u;
      var abs = new URL(u, REAL_BASE).toString();
      // Don't proxy Cloudflare challenge resources
      if (abs.indexOf("challenges.cloudflare.com") !== -1) return abs;
      return "/proxy?url=" + encodeURIComponent(abs);
    } catch (e) { return u; }
  }

  function toWsProxy(u) {
    try {
      var wsBase = REAL_BASE.replace(/^http/, "ws");
      var abs = new URL(u, wsBase).toString();
      var wsScheme = location.protocol === "https:" ? "wss:" : "ws:";
      return wsScheme + "//" + location.host + "/proxy?url=" + encodeURIComponent(abs);
    } catch (e) { return u; }
  }

  var origFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      var url = typeof input === "string" ? input : (input && input.url);
      if (url && !isProxied(url)) {
        var proxied = toHttpProxy(url);
        input = typeof input === "string" ? proxied : new Request(proxied, input);
      }
    } catch (e) {}
    return origFetch.call(this, input, init);
  };

  var origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    var args = Array.prototype.slice.call(arguments);
    try {
      if (url && !isProxied(url)) args[1] = toHttpProxy(url);
    } catch (e) {}
    return origOpen.apply(this, args);
  };

  var OrigWebSocket = window.WebSocket;
  function PatchedWebSocket(url, protocols) {
    return new OrigWebSocket(toWsProxy(url), protocols);
  }
  PatchedWebSocket.prototype = OrigWebSocket.prototype;
  PatchedWebSocket.CONNECTING = OrigWebSocket.CONNECTING;
  PatchedWebSocket.OPEN = OrigWebSocket.OPEN;
  PatchedWebSocket.CLOSING = OrigWebSocket.CLOSING;
  PatchedWebSocket.CLOSED = OrigWebSocket.CLOSED;
  window.WebSocket = PatchedWebSocket;

  // Service workers: rewrite the script URL through the proxy so the SW
  // itself is fetched via /proxy (its own fetch() calls are covered by
  // the JS-text rewriting pass on the server, not this page-level shim,
  // since a service worker runs in a separate global scope).
  try {
    if (window.navigator && navigator.serviceWorker && navigator.serviceWorker.register) {
      var origSwRegister = navigator.serviceWorker.register.bind(navigator.serviceWorker);
      navigator.serviceWorker.register = function (scriptUrl, options) {
        var proxiedScript = toHttpProxy(scriptUrl);
        var opts = options ? Object.assign({}, options) : undefined;
        // A SW's effective scope can't exceed its own directory, and our
        // script now lives at /proxy?url=..., so an unset/real-site scope
        // would fail to register. Defaulting to root keeps it working;
        // this does mean scope-based routing on the original site is lost.
        if (opts && opts.scope) opts.scope = "/";
        return origSwRegister(proxiedScript, opts);
      };
    }
  } catch (e) {}

  // Web Workers / SharedWorkers: rewrite the script URL the same way as
  // WebSocket above. Same caveat as service workers: the worker's own
  // fetch/import calls inside its script are handled by the server-side
  // JS rewriting pass, not by this shim.
  try {
    var OrigWorker = window.Worker;
    if (OrigWorker) {
      window.Worker = function (scriptUrl, options) {
        return new OrigWorker(toHttpProxy(scriptUrl), options);
      };
      window.Worker.prototype = OrigWorker.prototype;
    }
  } catch (e) {}
  try {
    var OrigSharedWorker = window.SharedWorker;
    if (OrigSharedWorker) {
      window.SharedWorker = function (scriptUrl, options) {
        return new OrigSharedWorker(toHttpProxy(scriptUrl), options);
      };
      window.SharedWorker.prototype = OrigSharedWorker.prototype;
    }
  } catch (e) {}

  // Report title/URL changes up to the parent chrome so the Safari-style
  // tab bar and address bar can reflect the real page without needing
  // cross-origin postMessage cooperation from the site itself.
  try {
    function currentRealUrl() {
      try {
        var href = location.href;
        var marker = "/proxy?url=";
        var idx = href.indexOf(marker);
        if (idx !== -1) {
          return decodeURIComponent(href.slice(idx + marker.length).split("&")[0]);
        }
      } catch (e) {}
      return REAL_BASE;
    }
    function reportState() {
      try {
        parent.postMessage(
          { __tunnel: true, title: document.title, realUrl: currentRealUrl() },
          "*"
        );
      } catch (e) {}
    }
    document.addEventListener("DOMContentLoaded", reportState);
    window.addEventListener("load", reportState);
    window.addEventListener("popstate", reportState);
    var titleEl = document.querySelector("title");
    if (titleEl && window.MutationObserver) {
      new MutationObserver(reportState).observe(titleEl, { childList: true });
    } else if (window.MutationObserver && document.head) {
      new MutationObserver(reportState).observe(document.head, { childList: true, subtree: true });
    }
    // Catch SPA pushState/replaceState navigations too (already patched
    // above to rewrite the URL argument) by re-reporting right after.
    var wrapHistoryMethod = function (name) {
      var orig = history[name];
      history[name] = function () {
        var ret = orig.apply(this, arguments);
        reportState();
        return ret;
      };
    };
    wrapHistoryMethod("pushState");
    wrapHistoryMethod("replaceState");
  } catch (e) {}

  var origWindowOpen = window.open;
  window.open = function (url, target, features) {
    try {
      if (url && !isProxied(url)) url = toHttpProxy(url);
    } catch (e) {}
    return origWindowOpen.call(this, url, target, features);
  };

  try {
    var origAssign = Location.prototype.assign;
    Location.prototype.assign = function (url) {
      if (url && !isProxied(url)) url = toHttpProxy(url);
      return origAssign.call(this, url);
    };
    var origReplace = Location.prototype.replace;
    Location.prototype.replace = function (url) {
      if (url && !isProxied(url)) url = toHttpProxy(url);
      return origReplace.call(this, url);
    };
  } catch (e) {}

  try {
    var locProto = Object.getPrototypeOf(location);
    var hrefDesc = Object.getOwnPropertyDescriptor(locProto, "href");
    if (hrefDesc && hrefDesc.set) {
      Object.defineProperty(locProto, "href", {
        set: function (url) {
          if (url && !isProxied(url)) url = toHttpProxy(url);
          hrefDesc.set.call(this, url);
        },
        get: hrefDesc.get,
        configurable: true,
      });
    }
  } catch (e) {}

  try {
    var origPushState = history.pushState;
    history.pushState = function (state, title, url) {
      if (url && !isProxied(url)) url = toHttpProxy(url);
      return origPushState.call(this, state, title, url);
    };
    var origReplaceState = history.replaceState;
    history.replaceState = function (state, title, url) {
      if (url && !isProxied(url)) url = toHttpProxy(url);
      return origReplaceState.call(this, state, title, url);
    };
  } catch (e) {}

  document.addEventListener("submit", function (e) {
    var form = e.target;
    if (!form || form.tagName !== "FORM") return;
    if (form.dataset.ps === "1") return;

    var action = form.getAttribute("action") || "";
    var method = (form.getAttribute("method") || "GET").toUpperCase();

    var targetUrl;
    try {
      if (action.indexOf("/proxy?url=") === 0) {
        var raw = action.substring("/proxy?url=".length).split("&")[0];
        targetUrl = new URL(decodeURIComponent(raw));
      } else if (action === "" || action === null) {
        targetUrl = new URL(REAL_BASE);
      } else {
        targetUrl = new URL(action, REAL_BASE);
      }
    } catch (err) {
      return;
    }

    e.preventDefault();
    e.stopPropagation();

    if (method === "GET") {
      var formData = new FormData(form);
      for (var entry of formData.entries()) {
        targetUrl.searchParams.append(entry[0], entry[1]);
      }
      location.href = "/proxy?url=" + encodeURIComponent(targetUrl.toString());
    } else {
      form.setAttribute("action", "/proxy?url=" + encodeURIComponent(targetUrl.toString()));
      form.dataset.ps = "1";
      form.submit();
    }
  }, true);

  document.addEventListener("click", function (e) {
    if (e.defaultPrevented || e.button !== 0) return;
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    var link = e.target.closest ? e.target.closest("a") : null;
    if (!link) return;
    var href = link.getAttribute("href");
    if (!href || href === "#" || href.startsWith("javascript:") ||
        href.startsWith("data:") || isProxied(href)) return;
    if (link.target === "_blank") return;
    e.preventDefault();
    location.href = toHttpProxy(href);
  }, true);
})();
<\/script>`;
}

const ATTR_TAGS: Record<string, string> = {
  a: "href",
  link: "href",
  script: "src",
  img: "src",
  source: "src",
  iframe: "src",
  video: "src",
  audio: "src",
  embed: "src",
  track: "src",
  object: "data",
};

class AttrRewriter implements HTMLRewriterElementContentHandlers {
  constructor(private attr: string, private baseUrl: string) {}
  element(el: Element) {
    const val = el.getAttribute(this.attr);
    if (val) el.setAttribute(this.attr, toProxyUrl(this.baseUrl, val));
  }
}

class SrcsetRewriter implements HTMLRewriterElementContentHandlers {
  constructor(private baseUrl: string) {}
  element(el: Element) {
    const val = el.getAttribute("srcset");
    if (!val) return;
    const rewritten = val.split(",").map((part) => {
      const [url, descriptor] = part.trim().split(/\s+/, 2);
      const proxied = toProxyUrl(this.baseUrl, url);
      return descriptor ? `${proxied} ${descriptor}` : proxied;
    }).join(", ");
    el.setAttribute("srcset", rewritten);
  }
}

class StyleAttrRewriter implements HTMLRewriterElementContentHandlers {
  constructor(private baseUrl: string) {}
  element(el: Element) {
    const val = el.getAttribute("style");
    if (val) el.setAttribute("style", rewriteCssText(val, this.baseUrl));
  }
}

class InlineStyleTextRewriter implements HTMLRewriterElementContentHandlers {
  private buffer = "";
  constructor(private baseUrl: string) {}
  text(chunk: TextChunk) {
    this.buffer += chunk.text;
    if (chunk.lastInTextNode) {
      chunk.replace(rewriteCssText(this.buffer, this.baseUrl), { html: false });
      this.buffer = "";
    } else {
      chunk.remove();
    }
  }
}

class HeadShimInjector implements HTMLRewriterElementContentHandlers {
  constructor(private baseUrl: string) {}
  element(el: Element) {
    el.prepend(buildShim(this.baseUrl), { html: true });
  }
}

class BlockingMetaStripper implements HTMLRewriterElementContentHandlers {
  element(el: Element) {
    const httpEquiv = (el.getAttribute("http-equiv") || "").toLowerCase();
    if (httpEquiv === "content-security-policy" || httpEquiv === "refresh") {
      el.remove();
    }
  }
}

class BaseStripper implements HTMLRewriterElementContentHandlers {
  element(el: Element) {
    el.remove();
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
  rewriter.on("base", new BaseStripper());
  return rewriter.transform(response);
}

export function rewriteCssTextExport(css: string, baseUrl: string): string {
  return rewriteCssText(css, baseUrl);
}
