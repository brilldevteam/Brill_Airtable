import type { AttachmentInfo } from "@brill/shared";

export type FileKind = "image" | "video" | "audio" | "pdf" | "other";

export function kindOf(f: Pick<AttachmentInfo, "mime" | "filename">): FileKind {
  if (f.mime.startsWith("image/") && !f.mime.includes("svg")) return "image";
  if (f.mime.startsWith("video/")) return "video";
  if (f.mime.startsWith("audio/")) return "audio";
  if (f.mime === "application/pdf") return "pdf";
  return "other";
}

export const fileExt = (name: string) => (name.includes(".") ? name.split(".").pop()!.slice(0, 4).toUpperCase() : "FILE");

export const formatBytes = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`;

/** Small badge images for the canvas grid: a play button for videos, the extension for other files. */
const badgeCache = new Map<string, string>();
export function gridBadge(f: AttachmentInfo | undefined): string {
  const kind = f ? kindOf(f) : "other";
  const key = kind === "video" || kind === "audio" ? kind : fileExt(f?.filename ?? "");
  let url = badgeCache.get(key);
  if (!url) {
    const body =
      kind === "video"
        ? `<rect x="1" y="1" width="78" height="62" rx="9" fill="#f4f4f5" stroke="#d4d4d8"/><path d="M32 20 L52 32 L32 44 Z" fill="none" stroke="#71717a" stroke-width="3" stroke-linejoin="round"/>`
        : kind === "audio"
          ? `<rect x="1" y="1" width="78" height="62" rx="9" fill="#f4f4f5" stroke="#d4d4d8"/><path d="M34 42a5 5 0 1 1-1-3V20l16-4v20a5 5 0 1 1-1-3V22l-14 3.5" fill="none" stroke="#71717a" stroke-width="2.6" stroke-linejoin="round"/>`
          : `<rect x="1" y="1" width="78" height="62" rx="9" fill="#eef0ff" stroke="#c7c9fb"/><text x="40" y="39" font-family="Arial, sans-serif" font-size="15" font-weight="700" fill="#4338ca" text-anchor="middle">${key}</text>`;
    url = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="80" height="64">${body}</svg>`);
    badgeCache.set(key, url);
  }
  return url;
}
