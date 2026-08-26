import { DurableObject } from "cloudflare:workers";

type CookieRecord = Record<string, string>; // cookie name -> value
type JarStore = Record<string, CookieRecord>; // target origin -> cookies

const STORAGE_KEY = "jar";

/**
 * One instance of this Durable Object is created per proxy session
 * (see SESSION_COOKIE in index.ts). It holds the *real* cookies that
 * upstream sites set — the browser never sees them directly, so
 * cookies from different proxied sites never collide, and there's no
 * dependency on the browser accepting a Set-Cookie whose Domain
 * doesn't match our own origin.
 */
export class CookieJar extends DurableObject {
  private async readStore(): Promise<JarStore> {
    return (await this.ctx.storage.get<JarStore>(STORAGE_KEY)) ?? {};
  }

  /** Cookie header string to send upstream for this target origin. */
  async getCookieHeader(origin: string): Promise<string> {
    const store = await this.readStore();
    const record = store[origin];
    if (!record) return "";
    return Object.entries(record)
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }

  /** Merge a batch of Set-Cookie header values from one upstream response. */
  async storeCookies(origin: string, setCookieHeaders: string[]): Promise<void> {
    if (setCookieHeaders.length === 0) return;
    const store = await this.readStore();
    const record: CookieRecord = store[origin] ?? {};

    for (const header of setCookieHeaders) {
      const firstPart = header.split(";")[0]?.trim();
      if (!firstPart || !firstPart.includes("=")) continue;
      const eq = firstPart.indexOf("=");
      const name = firstPart.slice(0, eq).trim();
      const value = firstPart.slice(eq + 1).trim();
      if (!name) continue;

      if (isExpiredCookie(header)) {
        delete record[name];
      } else {
        record[name] = value;
      }
    }

    store[origin] = record;
    await this.ctx.storage.put(STORAGE_KEY, store);
  }

  /** Wipe every cookie this session has accumulated, across all origins. */
  async clear(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}

function isExpiredCookie(setCookieHeader: string): boolean {
  if (/max-age=0/i.test(setCookieHeader)) return true;
  const match = /expires=([^;]+)/i.exec(setCookieHeader);
  if (!match) return false;
  const expiry = Date.parse(match[1]);
  return !Number.isNaN(expiry) && expiry < Date.now();
}
