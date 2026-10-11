import { fileTypeFromBuffer } from "file-type";
import { mkdir, writeFile, unlink, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { ChatError, dataDirectory, type StoredAttachment } from "./chat-store";
import { cloudStorage, storageBackend } from "./cloudflare-storage";

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "video/mp4", "video/webm"]);
export function uploadPath(storageName: string) { return path.join(dataDirectory(), "uploads", storageName); }

export async function limitedFormData(request: Request) {
  const limit = MAX_UPLOAD_BYTES + 64 * 1024;
  if (Number(request.headers.get("content-length")) > limit) throw new ChatError("Upload exceeds the 25 MB limit.", 413);
  if (!request.body) throw new ChatError("A message body is required.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); throw new ChatError("Upload exceeds the 25 MB limit.", 413); }
    chunks.push(value);
  }
  try {
    return await new Response(Buffer.concat(chunks), { headers: { "Content-Type": request.headers.get("content-type") || "" } }).formData();
  } catch { throw new ChatError("Invalid message upload."); }
}

export async function saveUpload(file: File): Promise<StoredAttachment> {
  if (!file.size || file.size > MAX_UPLOAD_BYTES) throw new ChatError("Choose a file between 1 byte and 25 MB.", 413);
  const bytes = Buffer.from(await file.arrayBuffer());
  const type = await fileTypeFromBuffer(bytes).catch(() => undefined);
  if (!type || !ALLOWED_MIME.has(type.mime)) throw new ChatError("Choose a JPEG, PNG, GIF, WebP, MP4, or WebM file.");
  const id = randomUUID();
  const storageName = `${id}.${type.ext}`;
  if (storageBackend() === "cloudflare") {
    await (await cloudStorage()).MEDIA.put(storageName, bytes, { httpMetadata: { contentType: type.mime } });
  } else {
    await mkdir(path.dirname(uploadPath(storageName)), { recursive: true });
    await writeFile(uploadPath(storageName), bytes, { flag: "wx" });
  }
  return { id, name: (file.name.split(/[\\/]/).pop() || "attachment").slice(0, 150), mime: type.mime, size: bytes.length, storageName };
}

export async function discardUpload(file: StoredAttachment) {
  if (storageBackend() === "cloudflare") {
    await (await cloudStorage()).MEDIA.delete(file.storageName).catch(() => {});
  } else {
    await unlink(uploadPath(file.storageName)).catch(() => {});
  }
}

export async function uploadSize(file: StoredAttachment) {
  if (storageBackend() === "cloudflare") {
    const object = await (await cloudStorage()).MEDIA.head(file.storageName);
    if (!object) throw new ChatError("Attachment not found.", 404);
    return object.size;
  }
  return (await stat(uploadPath(file.storageName)).catch(() => { throw new ChatError("Attachment not found.", 404); })).size;
}

export async function readUpload(file: StoredAttachment, range: { start: number; end: number } | null) {
  if (storageBackend() === "cloudflare") {
    const object = await (await cloudStorage()).MEDIA.get(file.storageName,
      range ? { range: { offset: range.start, length: range.end - range.start + 1 } } : undefined);
    if (!object) throw new ChatError("Attachment not found.", 404);
    return object.body as unknown as ReadableStream<Uint8Array>;
  }
  return Readable.toWeb(createReadStream(uploadPath(file.storageName), range || undefined)) as ReadableStream<Uint8Array>;
}

export function byteRange(header: string | null, size: number): { start: number; end: number } | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) throw new ChatError("Invalid byte range.", 416);
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] ? (match[2] ? Math.min(Number(match[2]), size - 1) : size - 1) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) {
    throw new ChatError("Invalid byte range.", 416);
  }
  return { start, end };
}
