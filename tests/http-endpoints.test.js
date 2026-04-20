import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.join(__dirname, '..', 'src', 'server.js');
const TEST_PORT = 19877;
const BASE_URL = `http://localhost:${TEST_PORT}`;

let serverProcess;

async function waitForServer(maxRetries = 20, delay = 250) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const resp = await fetch(`${BASE_URL}/status`);
      if (resp.ok) return;
    } catch {
      // Server not ready yet
    }
    await new Promise(r => setTimeout(r, delay));
  }
  throw new Error('Server did not start in time');
}

beforeAll(async () => {
  serverProcess = spawn('node', [SERVER_PATH], {
    env: { ...process.env, FEEDBACK_PORT: String(TEST_PORT) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Drain stderr to prevent buffer blocking
  serverProcess.stderr.on('data', () => {});

  await waitForServer();
}, 15000);

afterAll(() => {
  if (serverProcess) {
    serverProcess.kill('SIGTERM');
  }
});

// ============================================
// HTTP Basics
// ============================================

describe('HTTP basics', () => {
  it('GET /status returns 200 with expected shape', async () => {
    const resp = await fetch(`${BASE_URL}/status`);
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data).toHaveProperty('status', 'running');
    expect(data).toHaveProperty('port', TEST_PORT);
    expect(data).toHaveProperty('connectedClients');
    expect(data).toHaveProperty('pendingFeedback');
    expect(data).toHaveProperty('sessions');
  });

  it('GET /nonexistent returns 404', async () => {
    const resp = await fetch(`${BASE_URL}/nonexistent`);
    expect(resp.status).toBe(404);
  });
});

// ============================================
// Session Registration Lifecycle
// ============================================

describe('session registration', () => {
  const testSessionId = crypto.randomUUID();

  it('POST /register-session with valid UUID returns 200', async () => {
    const resp = await fetch(`${BASE_URL}/register-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: testSessionId,
        projectDir: '/tmp/test-project',
        projectUrl: 'https://test.local',
      }),
    });
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.success).toBe(true);
  });

  it('POST /register-session with invalid ID returns 400', async () => {
    const resp = await fetch(`${BASE_URL}/register-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'not-a-uuid',
        projectDir: '/tmp/bad',
      }),
    });
    expect(resp.status).toBe(400);
    const data = await resp.json();
    expect(data.error).toMatch(/session/i);
  });

  it('GET /sessions shows the registered session', async () => {
    const resp = await fetch(`${BASE_URL}/sessions`);
    expect(resp.status).toBe(200);
    const data = await resp.json();
    const found = data.sessions.find(s => s.sessionId === testSessionId);
    expect(found).toBeDefined();
    expect(found.projectDir).toBe('/tmp/test-project');
    expect(found.projectUrl).toBe('https://test.local');
  });

  it('POST /unregister-session removes the session', async () => {
    const resp = await fetch(`${BASE_URL}/unregister-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: testSessionId }),
    });
    expect(resp.status).toBe(200);

    const sessionsResp = await fetch(`${BASE_URL}/sessions`);
    const data = await sessionsResp.json();
    const found = data.sessions.find(s => s.sessionId === testSessionId);
    expect(found).toBeUndefined();
  });

  it('POST /unregister-session with invalid ID returns 400', async () => {
    const resp = await fetch(`${BASE_URL}/unregister-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'bad-id' }),
    });
    expect(resp.status).toBe(400);
  });
});

// ============================================
// Session-Scoped Data Isolation
// ============================================

describe('session-scoped data isolation', () => {
  it('GET /status?session=<id> returns zero counts for unknown session', async () => {
    const unknownId = crypto.randomUUID();
    const resp = await fetch(`${BASE_URL}/status?session=${unknownId}`);
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.connectedClients).toBe(0);
    expect(data.pendingFeedback).toBe(0);
  });

  it('GET /feedback?session=<id> returns empty for unknown session', async () => {
    const unknownId = crypto.randomUUID();
    const resp = await fetch(`${BASE_URL}/feedback?session=${unknownId}`);
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.feedback).toEqual([]);
  });

  it('DELETE /feedback/<id>?session=<id> returns 404 for non-existent item', async () => {
    const unknownId = crypto.randomUUID();
    const resp = await fetch(`${BASE_URL}/feedback/nonexistent?session=${unknownId}`, {
      method: 'DELETE',
    });
    expect(resp.status).toBe(404);
    const data = await resp.json();
    expect(data.success).toBe(false);
  });
});

// ============================================
// Broadcast Endpoint
// ============================================

describe('broadcast endpoint', () => {
  it('POST /broadcast with valid JSON returns 200', async () => {
    const resp = await fetch(`${BASE_URL}/broadcast?session=default`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'test', message: 'hello' }),
    });
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.success).toBe(true);
    expect(data.clientCount).toBe(0); // No WebSocket clients connected
  });

  it('POST /broadcast with invalid JSON returns 400', async () => {
    const resp = await fetch(`${BASE_URL}/broadcast?session=default`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    });
    expect(resp.status).toBe(400);
  });
});
