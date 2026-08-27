import { useCallback, useEffect, useRef, useState } from "react";

interface Tab {
  id: string;
  proxiedUrl: string; // "/proxy?url=..." — what the iframe actually loads
  realUrl: string; // the decoded, real address for display
  addressInput: string; // what's currently typed in the bar for this tab
  title: string;
  loading: boolean;
}

interface HistoryEntry {
  url: string;
  title: string;
  savedAt: number;
}

const SHORTCUTS = [
  { label: "DuckDuckGo", url: "https://html.duckduckgo.com/html/" },
  { label: "Google", url: "https://www.google.com" },
  { label: "YouTube", url: "https://www.youtube.com" },
];

function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^[\w-]+(\.[\w-]+)+/.test(trimmed) && !trimmed.includes(" ")) {
    return `https://${trimmed}`;
  }
  return `https://html.duckduckgo.com/html/?q=${encodeURIComponent(trimmed)}`;
}

function toProxied(realUrl: string): string {
  return `/proxy?url=${encodeURIComponent(realUrl)}`;
}

function hostnameOf(realUrl: string): string {
  try {
    return new URL(realUrl).hostname.replace(/^www\./, "");
  } catch {
    return realUrl;
  }
}

let tabCounter = 0;
function newTab(realUrl: string | null): Tab {
  tabCounter += 1;
  const proxiedUrl = realUrl ? toProxied(realUrl) : "";
  return {
    id: `t${tabCounter}-${Date.now()}`,
    proxiedUrl,
    realUrl: realUrl ?? "",
    addressInput: realUrl ?? "",
    title: realUrl ? hostnameOf(realUrl) : "New Tab",
    loading: !!realUrl,
  };
}

export default function App() {
  const [tabs, setTabs] = useState<Tab[]>(() => [newTab(null)]);
  const [activeId, setActiveId] = useState(tabs[0].id);
  const [bookmarks, setBookmarks] = useState<HistoryEntry[]>([]);
  const [showBookmarks, setShowBookmarks] = useState(false);
  const iframeRefs = useRef<Record<string, HTMLIFrameElement | null>>({});

  const activeTab = tabs.find((t) => t.id === activeId) ?? tabs[0];

  const updateTab = useCallback((id: string, patch: Partial<Tab>) => {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }, []);

  const refreshBookmarks = useCallback(() => {
    fetch("/api/bookmarks")
      .then((r) => r.json())
      .then(setBookmarks)
      .catch(() => {});
  }, []);

  useEffect(() => {
    refreshBookmarks();
  }, [refreshBookmarks]);

  // The injected page shim posts { __tunnel: true, title, realUrl } on
  // load, on title changes, and on SPA navigations — this is what keeps
  // the tab label and address bar honest without polling.
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (!e.data || e.data.__tunnel !== true) return;
      const frameEntry = Object.entries(iframeRefs.current).find(
        ([, el]) => el && el.contentWindow === e.source
      );
      if (!frameEntry) return;
      const [tabId] = frameEntry;
      updateTab(tabId, {
        title: e.data.title || hostnameOf(e.data.realUrl),
        realUrl: e.data.realUrl,
        addressInput: e.data.realUrl,
        loading: false,
      });
      fetch("/api/history", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: e.data.realUrl, title: e.data.title }),
      }).catch(() => {});
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [updateTab]);

  function navigate(tabId: string, rawUrl: string) {
    const real = normalizeUrl(rawUrl);
    updateTab(tabId, {
      realUrl: real,
      addressInput: real,
      proxiedUrl: toProxied(real),
      loading: true,
      title: hostnameOf(real),
    });
  }

  function openTab(realUrl: string | null = null) {
    const tab = newTab(realUrl);
    setTabs((prev) => [...prev, tab]);
    setActiveId(tab.id);
  }

  function closeTab(id: string) {
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === id);
      const next = prev.filter((t) => t.id !== id);
      if (next.length === 0) {
        const fresh = newTab(null);
        if (activeId === id) setActiveId(fresh.id);
        return [fresh];
      }
      if (activeId === id) {
        setActiveId(next[Math.max(0, idx - 1)].id);
      }
      return next;
    });
    delete iframeRefs.current[id];
  }

  function goBack() {
    iframeRefs.current[activeTab.id]?.contentWindow?.history.back();
  }
  function goForward() {
    iframeRefs.current[activeTab.id]?.contentWindow?.history.forward();
  }
  function reload() {
    updateTab(activeTab.id, { loading: true });
    iframeRefs.current[activeTab.id]?.contentWindow?.location.reload();
  }

  function toggleBookmark() {
    if (!activeTab.realUrl) return;
    const isBookmarked = bookmarks.some((b) => b.url === activeTab.realUrl);
    if (isBookmarked) {
      fetch(`/api/bookmarks?url=${encodeURIComponent(activeTab.realUrl)}`, { method: "DELETE" })
        .then((r) => r.json())
        .then(setBookmarks)
        .catch(() => {});
    } else {
      fetch("/api/bookmarks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: activeTab.realUrl, title: activeTab.title }),
      })
        .then((r) => r.json())
        .then(setBookmarks)
        .catch(() => {});
    }
  }

  const isBookmarked = bookmarks.some((b) => b.url === activeTab.realUrl);

  return (
    <div className="safari">
      {/* Traffic lights + tab strip */}
      <div className="safari__titlebar">
        <div className="safari__traffic">
          <span className="dot dot--red" />
          <span className="dot dot--yellow" />
          <span className="dot dot--green" />
        </div>

        <div className="safari__tabs">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={`safari__tab ${tab.id === activeId ? "safari__tab--active" : ""}`}
              onClick={() => setActiveId(tab.id)}
            >
              <span className="safari__tab-favicon">
                {tab.loading ? <span className="spinner" /> : <GlobeIcon />}
              </span>
              <span className="safari__tab-title">{tab.title}</span>
              <button
                className="safari__tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(tab.id);
                }}
                aria-label="Close tab"
              >
                ×
              </button>
            </div>
          ))}
          <button className="safari__tab-new" onClick={() => openTab(null)} aria-label="New tab">
            +
          </button>
        </div>
      </div>

      {/* Toolbar */}
      <div className="safari__toolbar">
        <div className="safari__nav-buttons">
          <button onClick={goBack} aria-label="Back">
            <ChevronIcon direction="left" />
          </button>
          <button onClick={goForward} aria-label="Forward">
            <ChevronIcon direction="right" />
          </button>
        </div>

        <form
          className="safari__address"
          onSubmit={(e) => {
            e.preventDefault();
            if (activeTab.addressInput.trim()) navigate(activeTab.id, activeTab.addressInput);
          }}
        >
          <button type="button" className="safari__reload" onClick={reload} aria-label="Reload">
            <ReloadIcon />
          </button>
          <input
            value={activeTab.addressInput}
            onChange={(e) => updateTab(activeTab.id, { addressInput: e.target.value })}
            placeholder="Search or enter website name"
            spellCheck={false}
          />
          <button
            type="button"
            className={`safari__bookmark ${isBookmarked ? "safari__bookmark--active" : ""}`}
            onClick={toggleBookmark}
            aria-label="Bookmark this page"
            disabled={!activeTab.realUrl}
          >
            <BookmarkIcon filled={isBookmarked} />
          </button>
        </form>

        <div className="safari__shortcuts">
          {SHORTCUTS.map((s) => (
            <button key={s.label} onClick={() => navigate(activeTab.id, s.url)}>
              {s.label}
            </button>
          ))}
          <button
            className={`safari__bookmarks-toggle ${showBookmarks ? "safari__bookmarks-toggle--active" : ""}`}
            onClick={() => setShowBookmarks((v) => !v)}
          >
            Bookmarks
          </button>
        </div>
      </div>

      {showBookmarks && (
        <div className="safari__bookmarks-bar">
          {bookmarks.length === 0 && <span className="safari__hint">No bookmarks yet</span>}
          {bookmarks.map((b) => (
            <button key={b.url} onClick={() => navigate(activeTab.id, b.url)} title={b.url}>
              <GlobeIcon /> {b.title || hostnameOf(b.url)}
            </button>
          ))}
        </div>
      )}

      {/* Page content — one iframe per tab, only the active one visible.
          All tabs stay mounted so background tabs keep their state. */}
      <main className="safari__viewport">
        {tabs.map((tab) =>
          tab.proxiedUrl ? (
            <iframe
              key={tab.id}
              ref={(el) => {
                iframeRefs.current[tab.id] = el;
              }}
              src={tab.proxiedUrl}
              title={tab.title}
              className={tab.id === activeId ? "safari__frame safari__frame--active" : "safari__frame"}
              onLoad={() => updateTab(tab.id, { loading: false })}
              sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-modals"
            />
          ) : (
            tab.id === activeId && (
              <div key={tab.id} className="safari__start-page">
                <h1>Start Page</h1>
                <div className="safari__start-shortcuts">
                  {SHORTCUTS.map((s) => (
                    <button key={s.label} onClick={() => navigate(tab.id, s.url)}>
                      <GlobeIcon />
                      <span>{s.label}</span>
                    </button>
                  ))}
                </div>
                <p className="safari__hint">
                  DuckDuckGo's HTML endpoint proxies cleanly. Google and
                  YouTube use heavy bot detection and dynamic loading that a
                  rewriting proxy can only partially replicate.
                </p>
              </div>
            )
          )
        )}
      </main>
    </div>
  );
}

function GlobeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18Z" />
    </svg>
  );
}

function ChevronIcon({ direction }: { direction: "left" | "right" }) {
  const d = direction === "left" ? "M13 5l-6 7 6 7" : "M11 5l6 7-6 7";
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}

function ReloadIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 4v6h6M20 20v-6h-6" />
      <path d="M5.5 15a8 8 0 1 0 1.7-9.1L4 9M18.5 9l2.5.9" />
    </svg>
  );
}

function BookmarkIcon({ filled }: { filled: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.6">
      <path d="M6 3h12v18l-6-4-6 4V3Z" />
    </svg>
  );
}
