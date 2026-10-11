import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { chatApi } from "@/lib/chat-api";
import { ChatError, chatStore } from "@/lib/chat-store";
import { byteRange, uploadPath } from "@/lib/chat-media";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return chatApi(request, false, async (user) => {
    const file = chatStore().attachment(id, user.id);
    const filename = uploadPath(file.storageName);
    const info = await stat(filename).catch(() => { throw new ChatError("Attachment not found.", 404); });
    let range;
    try { range = byteRange(request.headers.get("range"), info.size); }
    catch { return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${info.size}` } }); }
    const headers = new Headers({
      "Content-Type": file.mime,
      "Content-Length": String(range ? range.end - range.start + 1 : info.size),
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(file.name).replace(/'/g, "%27")}`,
      "X-Content-Type-Options": "nosniff",
      "Accept-Ranges": "bytes",
    });
    if (range) headers.set("Content-Range", `bytes ${range.start}-${range.end}/${info.size}`);
    const stream = createReadStream(filename, range || undefined);
    return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { status: range ? 206 : 200, headers });
  });
}
