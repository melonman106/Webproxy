// worker/src/cookieJar.ts

import { DurableObject } from "cloudflare:workers";

const STORAGE_KEY = "jar";

export class CookieJar extends DurableObject {
  async readStore(): Promise<Record<string, Record<string, string>>> {
    return (await this.ctx.storage.get(STORAGE_KEY)) ?? {};
  }

  async getCookieHeader(origin: string): Promise<string> {
    const store = await this.readStore();
    const record = store[origin];
    if (!record) return "";
    return Object.entries(record)
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }

  async storeCookies(origin: string, setCookieHeaders: string[]): Promise<void> {
    if (setCookieHeaders.length === 0) return;
    const store = await this.readStore();
    const record = store[origin] ?? {};
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
