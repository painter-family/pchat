const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
// Cap request bodies to keep in-memory buffering bounded for text and base64 media uploads.
const MAX_BODY_BYTES = 25 * 1024 * 1024;

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function randomId() {
  return crypto.randomBytes(12).toString('hex');
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let failed = false;
    req.on('data', (chunk) => {
      if (failed) return;
      raw += chunk.toString('utf8');
      if (raw.length > MAX_BODY_BYTES) {
        failed = true;
        reject(new Error('Request too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (failed) return;
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

async function safeParseBody(req) {
  try {
    return { ok: true, body: await parseBody(req) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function sanitizeMessage(message, token, session) {
  if (message.type === 'text') {
    return {
      id: message.id,
      type: 'text',
      text: message.text,
      createdAt: message.createdAt,
      mine: message.ownerToken === token
    };
  }
  const media = session.media.get(message.mediaId);
  const canDelete = Boolean(media && media.ownerToken === token && !media.deletedAt);
  return {
    id: message.id,
    type: 'media',
    mediaId: message.mediaId,
    createdAt: message.createdAt,
    mine: message.ownerToken === token,
    canDelete,
    media: media
      ? {
          id: media.id,
          filename: media.filename,
          mimeType: media.mimeType,
          deleted: Boolean(media.deletedAt)
        }
      : null
  };
}

function createApp({ dataRoot = path.join(process.cwd(), 'uploads') } = {}) {
  const sessions = new Map();
  const allowedMediaExtensions = new Set([
    'png',
    'jpg',
    'jpeg',
    'gif',
    'webp',
    'bmp',
    'mp4',
    'webm',
    'mov',
    'avi',
    'mkv',
    'ogg'
  ]);
  const extensionToMime = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
    mp4: 'video/mp4',
    webm: 'video/webm',
    mov: 'video/quicktime',
    avi: 'video/x-msvideo',
    mkv: 'video/x-matroska',
    ogg: 'video/ogg'
  };
  fs.mkdirSync(dataRoot, { recursive: true });

  function getSession(sessionId, token) {
    const session = sessions.get(sessionId);
    if (!session || !session.participants.some((participant) => participant && participant.token === token)) return null;
    return session;
  }

  async function serveStatic(filePath, res, type) {
    try {
      const content = await fsp.readFile(filePath);
      const contentType = type.startsWith('text/') ? `${type}; charset=utf-8` : type;
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    } catch {
      res.writeHead(404);
      res.end('Not found');
    }
  }

  async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);

    if (req.method === 'GET' && url.pathname === '/') {
      return serveStatic(path.join(__dirname, '..', 'public', 'index.html'), res, 'text/html');
    }

    if (req.method === 'POST' && url.pathname === '/api/sessions') {
      const sessionId = randomId();
      const participantToken = randomId();
      const inviteCode = randomId();
      sessions.set(sessionId, {
        id: sessionId,
        participants: [{ token: participantToken }, null],
        inviteCode,
        inviteConsumed: false,
        messages: [],
        media: new Map()
      });
      const joinLink = `/?sessionId=${encodeURIComponent(sessionId)}&token=${encodeURIComponent(inviteCode)}`;
      return json(res, 201, { sessionId, participantToken, joinLink });
    }

    if (parts[0] === 'api' && parts[1] === 'sessions' && parts[2]) {
      const sessionId = parts[2];
      const token = url.searchParams.get('token');
      const session = sessions.get(sessionId);

      if (req.method === 'POST' && parts[3] === 'join') {
        const parsed = await safeParseBody(req);
        if (!parsed.ok) return json(res, 400, { error: parsed.error });
        if (!session) return json(res, 404, { error: 'Session not found' });
        const inviteCode = typeof parsed.body.inviteCode === 'string' ? parsed.body.inviteCode : '';
        if (inviteCode !== session.inviteCode) return json(res, 403, { error: 'Invalid invite code' });
        if (session.inviteConsumed) return json(res, 409, { error: 'Invite link has already been used' });
        const participantToken = randomId();
        session.participants[1] = { token: participantToken };
        session.inviteConsumed = true;
        return json(res, 201, { participantToken });
      }

      if (req.method === 'GET' && parts.length === 3) {
        if (!token) return json(res, 401, { error: 'Missing token' });
        const authorizedSession = getSession(sessionId, token);
        if (!authorizedSession) return json(res, 404, { error: 'Session not found' });
        return json(res, 200, {
          sessionId,
          messages: authorizedSession.messages.map((message) => sanitizeMessage(message, token, authorizedSession))
        });
      }

      if (req.method === 'POST' && parts[3] === 'messages') {
        const parsed = await safeParseBody(req);
        if (!parsed.ok) return json(res, 400, { error: parsed.error });
        const auth = parsed.body.token;
        const text = typeof parsed.body.text === 'string' ? parsed.body.text.trim() : '';
        if (!auth || !text) return json(res, 400, { error: 'token and text are required' });
        const authorizedSession = getSession(sessionId, auth);
        if (!authorizedSession) return json(res, 404, { error: 'Session not found' });
        authorizedSession.messages.push({
          id: randomId(),
          type: 'text',
          text,
          ownerToken: auth,
          createdAt: new Date().toISOString()
        });
        return json(res, 201, { ok: true });
      }

      if (req.method === 'POST' && parts[3] === 'media') {
        const parsed = await safeParseBody(req);
        if (!parsed.ok) return json(res, 400, { error: parsed.error });
        const auth = parsed.body.token;
        const mimeType = typeof parsed.body.mimeType === 'string' ? parsed.body.mimeType.trim().toLowerCase() : '';
        const filename = typeof parsed.body.filename === 'string' ? parsed.body.filename : 'upload';
        const data = typeof parsed.body.data === 'string' ? parsed.body.data : '';
        if (!auth || !mimeType || !data) return json(res, 400, { error: 'Invalid media payload' });
        const mimeMatch = mimeType.match(/^(image|video)\/([a-z0-9.+-]+)$/);
        if (!mimeMatch) {
          return json(res, 400, { error: 'Only image and video uploads are allowed' });
        }
        const authorizedSession = getSession(sessionId, auth);
        if (!authorizedSession) return json(res, 404, { error: 'Session not found' });
        const base64 = data.includes(',') ? data.split(',')[1] : data;
        const mediaId = randomId();
        const extFromMime = mimeMatch[2].split(/[+;]/)[0].toLowerCase();
        const ext = allowedMediaExtensions.has(extFromMime) ? extFromMime : null;
        if (!ext) return json(res, 400, { error: 'Unsupported media type' });
        const safeMimeType = extensionToMime[ext];
        const sessionDir = path.join(dataRoot, sessionId);
        await fsp.mkdir(sessionDir, { recursive: true });
        const mediaPath = path.join(sessionDir, `${mediaId}.${ext}`);
        await fsp.writeFile(mediaPath, Buffer.from(base64, 'base64'));
        const safeFilename = path.basename(filename).replace(/[^\w.\- ]/g, '_').slice(0, 120) || `upload.${ext}`;

        authorizedSession.media.set(mediaId, {
          id: mediaId,
          filename: safeFilename,
          mimeType: safeMimeType,
          ownerToken: auth,
          path: mediaPath,
          deletedAt: null
        });
        authorizedSession.messages.push({
          id: randomId(),
          type: 'media',
          mediaId,
          ownerToken: auth,
          createdAt: new Date().toISOString()
        });
        return json(res, 201, { mediaId });
      }

      if (req.method === 'DELETE' && parts[3] === 'media' && parts[4]) {
        const parsed = await safeParseBody(req);
        if (!parsed.ok) return json(res, 400, { error: parsed.error });
        const auth = parsed.body.token;
        if (!auth) return json(res, 400, { error: 'token is required' });
        const mediaId = parts[4];
        const authorizedSession = getSession(sessionId, auth);
        if (!authorizedSession) return json(res, 404, { error: 'Session not found' });
        const media = authorizedSession.media.get(mediaId);
        if (!media || media.deletedAt) return json(res, 404, { error: 'Media not found' });
        if (media.ownerToken !== auth) return json(res, 403, { error: 'Not allowed' });
        media.deletedAt = new Date().toISOString();
        try {
          await fsp.unlink(media.path);
        } catch {}
        return json(res, 200, { ok: true });
      }
    }

    if (parts[0] === 'media' && parts[1] && parts[2] && req.method === 'GET') {
      const session = sessions.get(parts[1]);
      const token = url.searchParams.get('token');
      if (!session || !token || !session.participants.some((participant) => participant && participant.token === token)) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      const media = session.media.get(parts[2]);
      if (!media || media.deletedAt) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      try {
        const content = await fsp.readFile(media.path);
        res.writeHead(200, { 'Content-Type': media.mimeType });
        res.end(content);
      } catch {
        res.writeHead(404);
        res.end('Not found');
      }
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  }

  return { handler };
}

function startServer(options = {}) {
  const app = createApp(options);
  const server = http.createServer((req, res) => {
    Promise.resolve(app.handler(req, res)).catch((error) => {
      console.error(error);
      json(res, 500, { error: 'Internal server error' });
    });
  });
  const port = options.port ?? 3000;
  return new Promise((resolve) => {
    server.listen(port, () => resolve({ server, port: server.address().port }));
  });
}

if (require.main === module) {
  startServer().then(({ port }) => {
    process.stdout.write(`pchat server running on http://localhost:${port}\n`);
  });
}

module.exports = { createApp, startServer };
