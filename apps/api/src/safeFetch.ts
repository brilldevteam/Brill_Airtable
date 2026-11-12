import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";
import type { Readable } from "node:stream";
import { HttpError } from "./errors";

/**
 * Fetch a user-supplied URL without letting it reach the server's own network (SSRF):
 *  - only http/https, ports 80/443 or >1024
 *  - every DNS answer is checked against private, loopback, link-local and other reserved
 *    ranges *at connect time* (so DNS rebinding can't swap the address after the check)
 *  - redirects are followed manually (max 3), each re-checked
 *  - size and time limits
 */

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
  // (IPv4-mapped ::ffff:a.b.c.d is handled in isBlockedAddress: as a BlockList rule it would match every IPv4.)
  ["::", 128], ["::1", 128], ["100::", 64], ["2001:db8::", 32],
  ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const) blocked.addSubnet(net, prefix, "ipv6");

export function isBlockedAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 0) return true;
  // IPv4-mapped / NAT64 IPv6 addresses: judge the IPv4 address inside.
  const mapped = /^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return isBlockedAddress(mapped[1]);
  if (family === 6 && /^(::ffff:|64:ff9b::)/i.test(ip)) return true; // hex-form mapped addresses: refuse
  return blocked.check(ip, family === 6 ? "ipv6" : "ipv4");
}

const isLoopback = (ip: string) => /^127\./.test(ip) || ip === "::1";

/** DNS lookup that refuses to hand out blocked addresses. */
const makeLookup = (allowLoopback: boolean) => (hostname: string, options: any, callback: any) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses: LookupAddress[]) => {
    if (err) return callback(err);
    const ok = addresses.filter((a) => !isBlockedAddress(a.address) || (allowLoopback && isLoopback(a.address)));
    if (!ok.length) return callback(new HttpError(400, "That address isn't allowed (private or local network)"));
    if (options?.all) return callback(null, ok);
    callback(null, ok[0].address, ok[0].family);
  });
};

export interface FetchedFile {
  stream: Readable;
  mime: string;
  filename: string;
  length: number | null;
}

/** `allowLoopbackForTests` exists only so tests can serve files from a local server. Never set it in the app. */
export async function safeFetch(
  rawUrl: string,
  opts: { timeoutMs?: number; maxRedirects?: number; allowLoopbackForTests?: boolean } = {},
): Promise<FetchedFile> {
  const lookup = makeLookup(!!opts.allowLoopbackForTests);
  const timeoutMs = opts.timeoutMs ?? 20_000;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new HttpError(400, "That doesn't look like a valid link");
  }
  for (let hop = 0; hop <= (opts.maxRedirects ?? 3); hop++) {
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new HttpError(400, "Only http and https links are supported");
    if (url.username || url.password) throw new HttpError(400, "Links with passwords aren't supported");
    const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
    if (port !== 80 && port !== 443 && port <= 1024) throw new HttpError(400, "That port isn't allowed");
    const bare = url.hostname.replace(/^\[|\]$/g, "");
    if (isIP(bare) && isBlockedAddress(bare) && !(opts.allowLoopbackForTests && isLoopback(bare))) {
      throw new HttpError(400, "That address isn't allowed (private or local network)");
    }

    const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const lib = url.protocol === "https:" ? https : http;
      const req = lib.get(url, { lookup: lookup as any, timeout: timeoutMs, headers: { "User-Agent": "BrillTables/1.0", Accept: "*/*" } }, resolve);
      req.on("timeout", () => req.destroy(new HttpError(504, "The link took too long to respond")));
      req.on("error", (e) => reject(e instanceof HttpError ? e : new HttpError(502, `Couldn't download that link (${(e as Error).message})`)));
    });

    if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      res.resume();
      url = new URL(res.headers.location, url);
      continue;
    }
    if (!res.statusCode || res.statusCode >= 400) {
      res.resume();
      throw new HttpError(502, `The link returned an error (${res.statusCode})`);
    }
    const mime = String(res.headers["content-type"] ?? "application/octet-stream").split(";")[0].trim().toLowerCase();
    const cd = String(res.headers["content-disposition"] ?? "");
    const fromHeader = /filename\*=UTF-8''([^;]+)/i.exec(cd)?.[1] ?? /filename="?([^";]+)"?/i.exec(cd)?.[1];
    const fromPath = decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() ?? "");
    let filename = (fromHeader ? decodeURIComponent(fromHeader) : fromPath) || url.hostname;
    if (!filename.includes(".")) {
      const ext = mime.split("/")[1]?.replace("jpeg", "jpg").replace(/[^a-z0-9]/g, "");
      if (ext && ext.length <= 5) filename += "." + ext;
    }
    const length = res.headers["content-length"] ? Number(res.headers["content-length"]) : null;
    return { stream: res, mime, filename, length };
  }
  throw new HttpError(400, "The link redirected too many times");
}
