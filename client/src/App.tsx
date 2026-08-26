import { useState, useRef, FormEvent } from "react";

interface Shortcut {
  label: string;
  url: string;
}

const SHORTCUTS: Shortcut[] = [
  { label: "DuckDuckGo", url: "https://html.duckduckgo.com/html/" },
  { label: "Google", url: "https://www.google.com" },
  { label: "YouTube", url: "https://www.youtube.com" },
];

function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

export default function App() {
  const [addressBar, setAddressBar] = useState("");
  const [activeUrl, setActiveUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  function navigate(rawUrl: string) {
    const target = normalizeUrl(rawUrl);
    setAddressBar(target);
    setLoading(true);
    setActiveUrl(`/proxy?url=${encodeURIComponent(target)}`);
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (addressBar.trim()) navigate(addressBar);
  }

  return (
    <div className="console">
      <header className="console__bar">
        <span className="console__brand">TUNNEL</span>

        <form className="console__address" onSubmit={handleSubmit}>
          <span className="console__prompt">url&gt;</span>
          <input
            value={addressBar}
            onChange={(e) => setAddressBar(e.target.value)}
            placeholder="duckduckgo.com, google.com, youtube.com…"
            spellCheck={false}
          />
          <button type="submit">Go</button>
        </form>

        <div className="console__shortcuts">
          {SHORTCUTS.map((s) => (
            <button key={s.label} onClick={() => navigate(s.url)}>
              {s.label}
            </button>
          ))}
        </div>
      </header>

      <div className="console__status">
        {loading && <span className="pulse">loading tunnel…</span>}
        {!loading && activeUrl && <span>connected</span>}
        {!activeUrl && <span>idle — enter an address above</span>}
      </div>

      <main className="console__viewport">
        {activeUrl ? (
          <iframe
            ref={iframeRef}
            src={activeUrl}
            title="proxied-content"
            onLoad={() => setLoading(false)}
            sandbox="allow-scripts allow-forms allow-same-origin allow-popups"
          />
        ) : (
          <div className="console__empty">
            <p>No page loaded yet.</p>
            <p className="console__hint">
              Note: DuckDuckGo's HTML endpoint proxies cleanly. Google and
              YouTube use heavy bot detection, service workers, and
              streaming DRM that a lightweight rewriting proxy like this one
              cannot fully replicate — expect partial functionality.
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
