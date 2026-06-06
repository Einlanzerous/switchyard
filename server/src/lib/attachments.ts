// Attachment storage helpers — mime-sniffing + filesystem write.
//
// Storage path: ${UPLOAD_DIR}/yyyy/mm/<uuid>.<ext>
// Sniffer covers the common image/audio/text formats we expect from the
// agentic pipeline (phone-recorded audio, screenshot pastes, plain-text
// transcripts). Anything we can't identify falls back to the client-claimed
// kind, which the API still accepts — agents are trusted-ish on the
// homelab. Untrusted-input case would tighten this.
import { mkdir, unlink } from "node:fs/promises";
import { dirname, resolve, extname } from "node:path";
import { randomUUID } from "node:crypto";
import { env, ATTACHMENT_LIMITS } from "../env.js";
import { unprocessable, badRequest } from "../errors.js";
import type { AttachmentKind } from "@switchyard/shared";

export type Sniffed = {
  kind: AttachmentKind;
  mime: string;
  ext: string;
};

// Tight set of magic-byte checks.
function sniff(bytes: Uint8Array): Sniffed | null {
  const h = (i: number) => bytes[i] ?? 0;

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (h(0) === 0x89 && h(1) === 0x50 && h(2) === 0x4e && h(3) === 0x47) {
    return { kind: "image", mime: "image/png", ext: ".png" };
  }
  // JPEG: FF D8 FF
  if (h(0) === 0xff && h(1) === 0xd8 && h(2) === 0xff) {
    return { kind: "image", mime: "image/jpeg", ext: ".jpg" };
  }
  // GIF: 47 49 46 38
  if (h(0) === 0x47 && h(1) === 0x49 && h(2) === 0x46 && h(3) === 0x38) {
    return { kind: "image", mime: "image/gif", ext: ".gif" };
  }
  // RIFF container — could be WebP (image) or WAV (audio).
  if (h(0) === 0x52 && h(1) === 0x49 && h(2) === 0x46 && h(3) === 0x46) {
    if (h(8) === 0x57 && h(9) === 0x45 && h(10) === 0x42 && h(11) === 0x50) {
      return { kind: "image", mime: "image/webp", ext: ".webp" };
    }
    if (h(8) === 0x57 && h(9) === 0x41 && h(10) === 0x56 && h(11) === 0x45) {
      return { kind: "audio", mime: "audio/wav", ext: ".wav" };
    }
  }
  // ID3 (MP3 with tags): 49 44 33
  if (h(0) === 0x49 && h(1) === 0x44 && h(2) === 0x33) {
    return { kind: "audio", mime: "audio/mpeg", ext: ".mp3" };
  }
  // MP3 frame sync: FF Ex/Fx
  if (h(0) === 0xff && (h(1) & 0xe0) === 0xe0) {
    return { kind: "audio", mime: "audio/mpeg", ext: ".mp3" };
  }
  // OGG: 4F 67 67 53
  if (h(0) === 0x4f && h(1) === 0x67 && h(2) === 0x67 && h(3) === 0x53) {
    return { kind: "audio", mime: "audio/ogg", ext: ".ogg" };
  }
  // FLAC: 66 4C 61 43
  if (h(0) === 0x66 && h(1) === 0x4c && h(2) === 0x61 && h(3) === 0x43) {
    return { kind: "audio", mime: "audio/flac", ext: ".flac" };
  }
  // M4A / MP4 / 3GP: at offset 4 you see "ftyp"
  if (h(4) === 0x66 && h(5) === 0x74 && h(6) === 0x79 && h(7) === 0x70) {
    return { kind: "audio", mime: "audio/mp4", ext: ".m4a" };
  }
  // PDF: 25 50 44 46
  if (h(0) === 0x25 && h(1) === 0x50 && h(2) === 0x44 && h(3) === 0x46) {
    // We don't accept PDFs as attachments today — would need a "document" kind.
    return null;
  }
  return null;
}

// Best-effort UTF-8 validity check. If the buffer decodes cleanly, we treat
// it as text (and infer mime from the original filename's extension).
function sniffText(bytes: Uint8Array, originalName: string | undefined): Sniffed | null {
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    decoder.decode(bytes);
    const ext = originalName ? extname(originalName).toLowerCase() : ".txt";
    const knownExts: Record<string, string> = {
      ".md": "text/markdown",
      ".markdown": "text/markdown",
      ".txt": "text/plain",
      ".log": "text/plain",
      ".csv": "text/csv",
      ".json": "application/json",
    };
    const mime = knownExts[ext] ?? "text/plain";
    return { kind: "text", mime, ext: ext === "" ? ".txt" : ext };
  } catch {
    return null;
  }
}

export type ResolvedSniff = Sniffed & { matchedClaimed: boolean };

export function resolveSniff(
  bytes: Uint8Array,
  claimedKind: AttachmentKind,
  originalName: string | undefined
): ResolvedSniff {
  const binary = sniff(bytes);
  if (binary) {
    if (binary.kind !== claimedKind) {
      throw unprocessable(
        `file content is ${binary.kind} (${binary.mime}) but claimed kind is ${claimedKind}`
      );
    }
    return { ...binary, matchedClaimed: true };
  }

  if (claimedKind === "text") {
    const text = sniffText(bytes, originalName);
    if (!text) throw unprocessable("file content is not valid UTF-8 text");
    return { ...text, matchedClaimed: true };
  }

  // Unknown binary; trust the claimed kind but emit a generic mime.
  const fallbackExt = originalName ? extname(originalName).toLowerCase() || ".bin" : ".bin";
  const fallbackMime = claimedKind === "image" ? "application/octet-stream"
    : claimedKind === "audio" ? "application/octet-stream"
    : "application/octet-stream";
  return { kind: claimedKind, mime: fallbackMime, ext: fallbackExt, matchedClaimed: false };
}

export function checkSizeCap(kind: AttachmentKind, sizeBytes: number): void {
  const cap = ATTACHMENT_LIMITS[kind];
  if (sizeBytes > cap) {
    throw unprocessable(
      `file is ${sizeBytes} bytes; max for ${kind} is ${cap} bytes`,
      { kind, size_bytes: sizeBytes, max_bytes: cap }
    );
  }
}

export function buildStoragePath(ext: string): string {
  const id = randomUUID();
  const now = new Date();
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  return resolve(env.UPLOAD_DIR, yyyy, mm, `${id}${ext}`);
}

export async function writeBytes(absolutePath: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(absolutePath), { recursive: true });
  await Bun.write(absolutePath, bytes);
}

export async function unlinkSafe(absolutePath: string): Promise<void> {
  try {
    await unlink(absolutePath);
  } catch {
    // best-effort: log? for now silent — orphans don't break behavior, just leak disk.
  }
}

// Resolve a stored relative path into an absolute path under UPLOAD_DIR,
// rejecting any path that escapes via "..".
export function safeResolve(storagePath: string): string {
  const base = resolve(env.UPLOAD_DIR);
  const abs = resolve(storagePath);
  if (!abs.startsWith(base + "/") && abs !== base) {
    // storagePath wasn't generated by buildStoragePath — refuse to read.
    throw badRequest("invalid storage path");
  }
  return abs;
}
