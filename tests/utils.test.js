import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  deriveSessionId,
  isValidSessionId,
  getPendingSummary,
  detectProjectUrl,
  formatFeedbackAsContent,
} from '../src/utils.js';

// ============================================
// deriveSessionId
// ============================================

describe('deriveSessionId', () => {
  it('returns a valid UUID-formatted session ID', () => {
    const id = deriveSessionId('/home/user/project');
    expect(isValidSessionId(id)).toBe(true);
  });

  it('returns the same ID for the same project directory', () => {
    const id1 = deriveSessionId('/home/user/project');
    const id2 = deriveSessionId('/home/user/project');
    expect(id1).toBe(id2);
  });

  it('returns different IDs for different project directories', () => {
    const id1 = deriveSessionId('/home/user/project-a');
    const id2 = deriveSessionId('/home/user/project-b');
    expect(id1).not.toBe(id2);
  });

  it('returns lowercase hex characters', () => {
    const id = deriveSessionId('/some/path');
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});

// ============================================
// isValidSessionId
// ============================================

describe('isValidSessionId', () => {
  it('accepts a valid lowercase UUID', () => {
    expect(isValidSessionId('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
  });

  it('accepts a valid uppercase UUID', () => {
    expect(isValidSessionId('550E8400-E29B-41D4-A716-446655440000')).toBe(true);
  });

  it('accepts a mixed-case UUID', () => {
    expect(isValidSessionId('550e8400-E29B-41d4-a716-446655440000')).toBe(true);
  });

  it('rejects an empty string', () => {
    expect(isValidSessionId('')).toBe(false);
  });

  it('rejects null', () => {
    expect(isValidSessionId(null)).toBe(false);
  });

  it('rejects undefined', () => {
    expect(isValidSessionId(undefined)).toBe(false);
  });

  it('rejects a number', () => {
    expect(isValidSessionId(12345)).toBe(false);
  });

  it('rejects a string with wrong length', () => {
    expect(isValidSessionId('550e8400-e29b-41d4-a716')).toBe(false);
  });

  it('rejects a string with invalid characters', () => {
    expect(isValidSessionId('550e8400-e29b-41d4-a716-44665544zzzz')).toBe(false);
  });

  it('rejects a UUID without dashes', () => {
    expect(isValidSessionId('550e8400e29b41d4a716446655440000')).toBe(false);
  });
});

// ============================================
// getPendingSummary
// ============================================

describe('getPendingSummary', () => {
  it('returns empty summary for empty array', () => {
    expect(getPendingSummary([])).toEqual({ count: 0, items: [] });
  });

  it('returns empty summary for non-array input', () => {
    expect(getPendingSummary(null)).toEqual({ count: 0, items: [] });
    expect(getPendingSummary(undefined)).toEqual({ count: 0, items: [] });
  });

  it('maps feedback items correctly', () => {
    const pending = [
      {
        id: 'fb-1',
        timestamp: '2026-01-01T00:00:00Z',
        description: 'Button is misaligned',
        element: { selector: '.btn-primary' },
      },
    ];
    const result = getPendingSummary(pending);
    expect(result.count).toBe(1);
    expect(result.items[0]).toEqual({
      id: 'fb-1',
      timestamp: '2026-01-01T00:00:00Z',
      description: 'Button is misaligned',
      selector: '.btn-primary',
    });
  });

  it('truncates description at 100 characters', () => {
    const longDesc = 'A'.repeat(150);
    const pending = [{ id: 'fb-2', timestamp: 't', description: longDesc }];
    const result = getPendingSummary(pending);
    expect(result.items[0].description).toBe('A'.repeat(100));
  });

  it('falls back from timestamp to receivedAt', () => {
    const pending = [{ id: 'fb-3', receivedAt: '2026-02-01T00:00:00Z' }];
    const result = getPendingSummary(pending);
    expect(result.items[0].timestamp).toBe('2026-02-01T00:00:00Z');
  });

  it('handles missing optional fields', () => {
    const pending = [{ id: 'fb-4' }];
    const result = getPendingSummary(pending);
    expect(result.items[0]).toEqual({
      id: 'fb-4',
      timestamp: undefined,
      description: '',
      selector: '',
    });
  });
});

// ============================================
// formatFeedbackAsContent
// ============================================

describe('formatFeedbackAsContent', () => {
  it('returns a text block for a single item without screenshot', () => {
    const item = { id: 'fb-1', description: 'Test' };
    const result = formatFeedbackAsContent([item]);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('text');
    expect(JSON.parse(result[0].text)).toEqual(item);
  });

  it('returns text + image blocks for item with valid data URL screenshot', () => {
    const item = {
      id: 'fb-2',
      screenshot: 'data:image/png;base64,iVBORw0KGgo=',
    };
    const result = formatFeedbackAsContent([item]);
    expect(result).toHaveLength(2);
    expect(result[0].type).toBe('text');
    expect(result[1]).toEqual({
      type: 'image',
      data: 'iVBORw0KGgo=',
      mimeType: 'image/png',
    });
  });

  it('excludes screenshot from the text JSON', () => {
    const item = {
      id: 'fb-3',
      description: 'With screenshot',
      screenshot: 'data:image/jpeg;base64,abc123',
    };
    const result = formatFeedbackAsContent([item]);
    const parsed = JSON.parse(result[0].text);
    expect(parsed.screenshot).toBeUndefined();
    expect(parsed.id).toBe('fb-3');
  });

  it('does not produce image block for invalid screenshot URL', () => {
    const item = { id: 'fb-4', screenshot: 'https://example.com/img.png' };
    const result = formatFeedbackAsContent([item]);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('text');
  });

  it('adds count header for multiple items', () => {
    const items = [
      { id: 'fb-5', description: 'First' },
      { id: 'fb-6', description: 'Second' },
    ];
    const result = formatFeedbackAsContent(items);
    expect(result[0]).toEqual({
      type: 'text',
      text: 'Received 2 feedback item(s):',
    });
    expect(result).toHaveLength(3); // header + 2 text blocks
  });

  it('coerces a non-array single item to array', () => {
    const item = { id: 'fb-7' };
    const result = formatFeedbackAsContent(item);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('text');
  });
});

// ============================================
// detectProjectUrl
// ============================================

describe('detectProjectUrl', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detect-url-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null when no config files exist', () => {
    const result = detectProjectUrl(tmpDir);
    expect(result).toEqual({ url: null, detectedFrom: null });
  });

  it('reads APP_URL from .env file', () => {
    fs.writeFileSync(path.join(tmpDir, '.env'), 'APP_URL=https://myapp.local\n');
    const result = detectProjectUrl(tmpDir);
    expect(result).toEqual({ url: 'https://myapp.local', detectedFrom: '.env' });
  });

  it('adds https:// when protocol is missing', () => {
    fs.writeFileSync(path.join(tmpDir, '.env'), 'APP_URL=myapp.local\n');
    const result = detectProjectUrl(tmpDir);
    expect(result).toEqual({ url: 'https://myapp.local', detectedFrom: '.env' });
  });

  it('preserves http:// when already present', () => {
    fs.writeFileSync(path.join(tmpDir, '.env'), 'APP_URL=http://localhost:8080\n');
    const result = detectProjectUrl(tmpDir);
    expect(result).toEqual({ url: 'http://localhost:8080', detectedFrom: '.env' });
  });

  it('reads traefik host rule from docker-compose.yml', () => {
    const compose = `
services:
  web:
    labels:
      - "traefik.http.routers.myapp.rule=Host(\`myapp.local.itkdev.dk\`)"
`;
    fs.writeFileSync(path.join(tmpDir, 'docker-compose.yml'), compose);
    const result = detectProjectUrl(tmpDir);
    expect(result).toEqual({
      url: 'https://myapp.local.itkdev.dk',
      detectedFrom: 'docker-compose.yml',
    });
  });

  it('reads homepage from package.json', () => {
    const pkg = JSON.stringify({ name: 'test', homepage: 'https://example.com' });
    fs.writeFileSync(path.join(tmpDir, 'package.json'), pkg);
    const result = detectProjectUrl(tmpDir);
    expect(result).toEqual({ url: 'https://example.com', detectedFrom: 'package.json' });
  });

  it('prefers .env over docker-compose.yml', () => {
    fs.writeFileSync(path.join(tmpDir, '.env'), 'APP_URL=https://from-env.local\n');
    fs.writeFileSync(
      path.join(tmpDir, 'docker-compose.yml'),
      'VIRTUAL_HOST=from-compose.local\n'
    );
    const result = detectProjectUrl(tmpDir);
    expect(result.detectedFrom).toBe('.env');
    expect(result.url).toBe('https://from-env.local');
  });

  it('reads VIRTUAL_HOST from docker-compose.yml', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'docker-compose.yml'),
      'VIRTUAL_HOST=mysite.local\n'
    );
    const result = detectProjectUrl(tmpDir);
    expect(result).toEqual({
      url: 'https://mysite.local',
      detectedFrom: 'docker-compose.yml',
    });
  });
});
