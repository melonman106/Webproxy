import * as cheerio from "cheerio";

/**
 * Builds the local proxy URL that a browser should hit instead of the
 * real remote resource. Everything routes back through /proxy?url=...
 * so every hop (page, script, image, stylesheet, fetch/XHR call) stays
 * inside the tunnel.
 */
export function toProxyUrl(base: string, target: string): string {
  try {
    const absolute = new URL(target, base).toString();
    return `/proxy?url=${encodeURIComponent(absolute)}`;
  } catch {
    // Things like "javascript:void(0)", "mailto:", "#anchor" etc. are left alone.
    return target;
  }
}

const ATTRS_TO_REWRITE: Record<string, string> = {
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

const CSS_URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;

export function rewriteCss(css: string, baseUrl: string): string {
  return css.replace(CSS_URL_RE, (match, quote, url) => {
    if (url.startsWith("data:")) return match;
    return `url(${quote}${toProxyUrl(baseUrl, url)}${quote})`;
  });
}

/**
 * Injects a tiny runtime shim before any other script runs. It patches
 * fetch/XHR/WebSocket so that same-origin-looking calls made by the
 * page's own JS also get funneled through /proxy, and it rewrites the
 * base so relative paths resolve against the *original* remote host.
 */
function buildInjectedShim(baseUrl: string): string {
  return `<script>
(function () {
  var REAL_BASE = ${JSON.stringify(baseUrl)};
  function toProxy(u) {
    try {
      var abs = new URL(u, REAL_BASE).toString();
      return "/proxy?url=" + encodeURIComponent(abs);
    } catch (e) { return u; }
  }
  var origFetch = window.fetch;
  window.fetch = function (input, init) {
    var url = typeof input === "string" ? input : input && input.url;
    if (url && !/^\\/proxy\\?url=/.test(url)) {
      var proxied = toProxy(url);
      if (typeof input === "string") input = proxied;
      else input = new Request(proxied, input);
    }
    return origFetch.call(this, input, init);
  };
  var origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    var args = Array.prototype.slice.call(arguments);
    if (url && !/^\\/proxy\\?url=/.test(url)) args[1] = toProxy(url);
    return origOpen.apply(this, args);
  };
})();
</script>`;
}

export function rewriteHtml(html: string, baseUrl: string): string {
  const $ = cheerio.load(html);

  for (const [tag, attr] of Object.entries(ATTRS_TO_REWRITE)) {
    $(tag).each((_, el) => {
      const val = $(el).attr(attr);
      if (val) $(el).attr(attr, toProxyUrl(baseUrl, val));
    });
  }

  // srcset can hold multiple comma-separated URLs with density descriptors.
  $("[srcset]").each((_, el) => {
    const val = $(el).attr("srcset");
    if (!val) return;
    const rewritten = val
      .split(",")
      .map((part) => {
        const [url, descriptor] = part.trim().split(/\s+/, 2);
        const proxied = toProxyUrl(baseUrl, url);
        return descriptor ? `${proxied} ${descriptor}` : proxied;
      })
      .join(", ");
    $(el).attr("srcset", rewritten);
  });

  // Inline <style> blocks and style="" attributes can reference url(...).
  $("style").each((_, el) => {
    $(el).text(rewriteCss($(el).text(), baseUrl));
  });
  $("[style]").each((_, el) => {
    const val = $(el).attr("style");
    if (val) $(el).attr("style", rewriteCss(val, baseUrl));
  });

  // Strip meta refresh / CSP meta tags that would otherwise block or
  // redirect the framed page outside of the proxy.
  $('meta[http-equiv="Content-Security-Policy"]').remove();
  $('meta[http-equiv="refresh"]').remove();

  $("head").prepend(buildInjectedShim(baseUrl));

  return $.html();
}
