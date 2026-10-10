const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

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
    req.on('data', (chunk) => {
      raw += chunk.toString('utf8');
      if (raw.length > 25 * 1024 * 1024) {
        reject(new Error('Request too large'));
      }
    });
    req.on('end', () => {
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
  const canDelete = media && media.ownerToken === token && !media.deletedAt;
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
  fs.mkdirSync(dataRoot, { recursive: true });

  function getSession(sessionId, token) {
    const session = sessions.get(sessionId);
    if (!session || !session.participants.includes(token)) return null;
    return session;
  }

  async function serveStatic(filePath, res, type) {
    try {
      const content = await fsp.readFile(filePath);
      res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` });
      res.end(content);
    } catch {
      res.writeHead(404);
      res.end('Not found');
    }
  }

  async function handler(req, res) {
    const host = req.headers.host || 'localhost';
    const protocol = req.headers['x-forwarded-proto'] || 'http';
    const url = new URL(req.url, `${protocol}://${host}`);
    const parts = url.pathname.split('/').filter(Boolean);

    if (req.method === 'GET' && url.pathname === '/') {
      return serveStatic(path.join(__dirname, '..', 'public', 'index.html'), res, 'text/html');
    }

    if (req.method === 'POST' && url.pathname === '/api/sessions') {
      const sessionId = randomId();
      const participantToken = randomId();
      const inviteToken = randomId();
      sessions.set(sessionId, {
        id: sessionId,
        participants: [participantToken, inviteToken],
        messages: [],
        media: new Map()
      });
      const joinLink = `${protocol}://${host}/?sessionId=${sessionId}&token=${inviteToken}`;
      return json(res, 201, { sessionId, participantToken, joinLink });
    }

    if (parts[0] === 'api' && parts[1] === 'sessions' && parts[2]) {
      const sessionId = parts[2];
      const token = url.searchParams.get('token');

      if (req.method === 'GET' && parts.length === 3) {
        if (!token) return json(res, 401, { error: 'Missing token' });
        const session = getSession(sessionId, token);
        if (!session) return json(res, 404, { error: 'Session not found' });
        return json(res, 200, {
          sessionId,
          messages: session.messages.map((message) => sanitizeMessage(message, token, session))
        });
      }

      if (req.method === 'POST' && parts[3] === 'messages') {
        const body = await parseBody(req).catch((error) => ({ __error: error.message }));
        if (body.__error) return json(res, 400, { error: body.__error });
        const auth = body.token;
        const text = typeof body.text === 'string' ? body.text.trim() : '';
        if (!auth || !text) return json(res, 400, { error: 'token and text are required' });
        const session = getSession(sessionId, auth);
        if (!session) return json(res, 404, { error: 'Session not found' });
        session.messages.push({
          id: randomId(),
          type: 'text',
          text,
          ownerToken: auth,
          createdAt: new Date().toISOString()
        });
        return json(res, 201, { ok: true });
      }

      if (req.method === 'POST' && parts[3] === 'media') {
        const body = await parseBody(req).catch((error) => ({ __error: error.message }));
        if (body.__error) return json(res, 400, { error: body.__error });
        const auth = body.token;
        const mimeType = typeof body.mimeType === 'string' ? body.mimeType : '';
        const filename = typeof body.filename === 'string' ? body.filename : 'upload';
        const data = typeof body.data === 'string' ? body.data : '';
        if (!auth || !mimeType || !data) return json(res, 400, { error: 'Invalid media payload' });
        if (!mimeType.startsWith('image/') && !mimeType.startsWith('video/')) {
          return json(res, 400, { error: 'Only image and video uploads are allowed' });
        }
        const session = getSession(sessionId, auth);
        if (!session) return json(res, 404, { error: 'Session not found' });
        const base64 = data.includes(',') ? data.split(',')[1] : data;
        const mediaId = randomId();
        const ext = path.extname(filename).replace('.', '') || mimeType.split('/')[1] || 'bin';
        const sessionDir = path.join(dataRoot, sessionId);
        await fsp.mkdir(sessionDir, { recursive: true });
        const mediaPath = path.join(sessionDir, `${mediaId}.${ext}`);
        await fsp.writeFile(mediaPath, Buffer.from(base64, 'base64'));

        session.media.set(mediaId, {
          id: mediaId,
          filename,
          mimeType,
          ownerToken: auth,
          path: mediaPath,
          deletedAt: null
        });
        session.messages.push({
          id: randomId(),
          type: 'media',
          mediaId,
          ownerToken: auth,
          createdAt: new Date().toISOString()
        });
        return json(res, 201, { mediaId });
      }

      if (req.method === 'DELETE' && parts[3] === 'media' && parts[4]) {
        const body = await parseBody(req).catch((error) => ({ __error: error.message }));
        if (body.__error) return json(res, 400, { error: body.__error });
        const auth = body.token;
        const mediaId = parts[4];
        const session = getSession(sessionId, auth);
        if (!session) return json(res, 404, { error: 'Session not found' });
        const media = session.media.get(mediaId);
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
      if (!session || !token || !session.participants.includes(token)) {
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
      json(res, 500, { error: error.message });
    });
  });
  const port = options.port || 3000;
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
