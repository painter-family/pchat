const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fsp = require('fs/promises');
const { startServer } = require('../src/server');

async function createSession(baseUrl) {
  const res = await fetch(`${baseUrl}/api/sessions`, { method: 'POST' });
  assert.equal(res.status, 201);
  return res.json();
}

test('supports private invite-link chat and history', async () => {
  const dataRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'pchat-test-'));
  const { server, port } = await startServer({ port: 0, dataRoot });
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const created = await createSession(baseUrl);
    const inviteUrl = new URL(created.joinLink);
    const inviteToken = inviteUrl.searchParams.get('token');
    assert.ok(inviteToken);
    assert.notEqual(inviteToken, created.participantToken);

    let res = await fetch(`${baseUrl}/api/sessions/${created.sessionId}?token=bad`);
    assert.equal(res.status, 404);

    res = await fetch(`${baseUrl}/api/sessions/${created.sessionId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: created.participantToken, text: 'hello' })
    });
    assert.equal(res.status, 201);

    res = await fetch(`${baseUrl}/api/sessions/${created.sessionId}?token=${inviteToken}`);
    assert.equal(res.status, 200);
    const history = await res.json();
    assert.equal(history.messages.length, 1);
    assert.equal(history.messages[0].text, 'hello');
    assert.equal(history.messages[0].mine, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('stores media and only allows owner deletion', async () => {
  const dataRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'pchat-test-'));
  const { server, port } = await startServer({ port: 0, dataRoot });
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const created = await createSession(baseUrl);
    const inviteToken = new URL(created.joinLink).searchParams.get('token');
    const data = Buffer.from('tiny-image').toString('base64');

    let res = await fetch(`${baseUrl}/api/sessions/${created.sessionId}/media`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: created.participantToken,
        filename: 'photo.png',
        mimeType: 'image/png',
        data
      })
    });
    assert.equal(res.status, 201);
    const { mediaId } = await res.json();

    res = await fetch(`${baseUrl}/media/${created.sessionId}/${mediaId}?token=${inviteToken}`);
    assert.equal(res.status, 200);

    res = await fetch(`${baseUrl}/api/sessions/${created.sessionId}/media/${mediaId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: inviteToken })
    });
    assert.equal(res.status, 403);

    res = await fetch(`${baseUrl}/api/sessions/${created.sessionId}/media/${mediaId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: created.participantToken })
    });
    assert.equal(res.status, 200);

    res = await fetch(`${baseUrl}/media/${created.sessionId}/${mediaId}?token=${created.participantToken}`);
    assert.equal(res.status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
