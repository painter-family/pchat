import { chatApi } from "@/lib/chat-api";
import { chatStore } from "@/lib/chat-store";
import { byteRange, uploadSize, readUpload } from "@/lib/chat-media";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return chatApi(request, false, async (user) => {
    const file = await (await chatStore()).attachment(id, user.id);
    const size = await uploadSize(file);
    let range;
    try { range = byteRange(request.headers.get("range"), size); }
    catch { return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } }); }
    const headers = new Headers({
      "Content-Type": file.mime,
      "Content-Length": String(range ? range.end - range.start + 1 : size),
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(file.name).replace(/'/g, "%27")}`,
      "X-Content-Type-Options": "nosniff",
      "Accept-Ranges": "bytes",
    });
    if (range) headers.set("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
    return new Response(await readUpload(file, range), { status: range ? 206 : 200, headers });
  });
}
