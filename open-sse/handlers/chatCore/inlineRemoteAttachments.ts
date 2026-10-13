/**
 * Inline remote image/document URLs as base64 before translation,
 * for targets that do not fetch URLs themselves:
 *   - GitHub Copilot `/v1/messages` (Claude): `external image URLs are not supported`.
 *   - Gemini / Antigravity: an http URL becomes `fileData{fileUri, mimeType:"image/*"}`,
 *     which Gemini only accepts for its own file URIs.
 * Downloads go through fetchUntrustedRemoteImage (public-only, DNS-pinned, size cap),
 * so a private/LAN URL is refused with 400 before anything is sent upstream.
 * Walks the top-level content parts of `messages` (Chat / Claude) and `input`
 * (Responses); tool results are left as-is.
 */
import { fetchUntrustedRemoteImage } from "@/shared/network/remoteImageFetch";
import { sniffImageMime } from "../imageUpscale/shared.ts";
import { FORMATS } from "../../translator/formats.ts";

type Part = Record<string, unknown>;

const isHttpUrl = (value: unknown): value is string =>
  typeof value === "string" && /^https?:\/\//i.test(value.trim());

export function needsInlineRemoteAttachments(provider: string, targetFormat: string): boolean {
  if (targetFormat === FORMATS.GEMINI || targetFormat === FORMATS.ANTIGRAVITY) return true;
  return targetFormat === FORMATS.CLAUDE && (provider === "github" || provider === "ghe-copilot");
}

function invalidAttachment(url: string, err: unknown): Error {
  const reason = err instanceof Error ? err.message : String(err);
  const error = new Error(`Invalid attachment URL ${url}: ${reason}`) as Error & {
    statusCode: number;
    errorType: string;
  };
  error.statusCode = 400;
  error.errorType = "invalid_request_error";
  return error;
}

async function download(url: string): Promise<{ mime: string; base64: string }> {
  try {
    const { buffer, contentType } = await fetchUntrustedRemoteImage(url.trim());
    const declared = (contentType || "").split(";")[0].trim().toLowerCase();
    const mime =
      declared && declared !== "application/octet-stream" ? declared : sniffImageMime(buffer);
    return { mime, base64: buffer.toString("base64") };
  } catch (err) {
    throw invalidAttachment(url, err);
  }
}

// Returns a setter that writes the inlined data back in the part's own shape,
// or null when the part carries no remote URL.
function remoteUrlOf(part: Part): [string, (mime: string, b64: string) => void] | null {
  const imageUrl = part.image_url as unknown;
  if (part.type === "image_url") {
    const url = typeof imageUrl === "string" ? imageUrl : (imageUrl as Part | undefined)?.url;
    if (isHttpUrl(url)) return [url, (m, b) => (part.image_url = { url: `data:${m};base64,${b}` })];
  }
  if (part.type === "input_image" && isHttpUrl(imageUrl)) {
    return [imageUrl, (m, b) => (part.image_url = `data:${m};base64,${b}`)];
  }
  if (part.type === "file") {
    const file = (part.file || {}) as Part;
    const url = isHttpUrl(file.file_data) ? file.file_data : file.file_url;
    if (isHttpUrl(url)) {
      return [
        url,
        (m, b) => {
          file.file_data = `data:${m};base64,${b}`;
          delete file.file_url;
        },
      ];
    }
  }
  if (part.type === "input_file" && isHttpUrl(part.file_url)) {
    return [
      part.file_url,
      (m, b) => {
        part.file_data = `data:${m};base64,${b}`;
        delete part.file_url;
      },
    ];
  }
  const source = part.source as Part | undefined;
  if ((part.type === "image" || part.type === "document") && source?.type === "url") {
    if (isHttpUrl(source.url)) {
      return [source.url, (m, b) => (part.source = { type: "base64", media_type: m, data: b })];
    }
  }
  return null;
}

function collectRemoteParts(body: unknown): Array<[string, (mime: string, b64: string) => void]> {
  const b = (body || {}) as { messages?: unknown; input?: unknown };
  const turns = [b.messages, b.input].filter(Array.isArray).flat() as Part[];
  const hits: Array<[string, (mime: string, b64: string) => void]> = [];
  for (const turn of turns) {
    if (!Array.isArray(turn?.content)) continue;
    for (const part of turn.content as Part[]) {
      const hit = part && typeof part === "object" ? remoteUrlOf(part) : null;
      if (hit) hits.push(hit);
    }
  }
  return hits;
}

export async function inlineRemoteAttachments<T>(
  body: T,
  provider: string,
  targetFormat: string
): Promise<T> {
  if (!needsInlineRemoteAttachments(provider, targetFormat)) return body;
  if (collectRemoteParts(body).length === 0) return body;
  // Work on a copy so combo fallbacks and logs keep the caller's original body.
  const copy = structuredClone(body);
  const hits = collectRemoteParts(copy);
  // ponytail: parallel downloads, no per-request count cap beyond the fetch helper's size limit.
  const downloads = await Promise.all(hits.map(([url]) => download(url)));
  downloads.forEach(({ mime, base64 }, i) => hits[i][1](mime, base64));
  return copy;
}
