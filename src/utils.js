import fs from "fs";
import path from "path";

// UUID format validation for session IDs
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isValidSessionId(id) {
  return typeof id === 'string' && UUID_RE.test(id);
}

// Generate pending feedback summary (without full payloads)
export function getPendingSummary(pending) {
  if (!Array.isArray(pending)) pending = [];
  return {
    count: pending.length,
    items: pending.map(f => ({
      id: f.id,
      timestamp: f.timestamp || f.receivedAt,
      description: f.description ? f.description.slice(0, 100) : '',
      selector: f.element?.selector || '',
    })),
  };
}

// Detect project URL from configuration files
export function detectProjectUrl(projectDir) {
  const detectionStrategies = [
    {
      file: '.env',
      patterns: [
        /^(?:APP_URL|BASE_URL|SITE_URL|PROJECT_URL|HOSTNAME)=["']?([^"'\s]+)["']?/m,
        /^(?:VIRTUAL_HOST|COMPOSE_DOMAIN)=["']?([^"'\s]+)["']?/m,
      ],
      transform: (match) => {
        const value = match[1];
        if (!value.startsWith('http://') && !value.startsWith('https://')) {
          return `https://${value}`;
        }
        return value;
      },
    },
    {
      file: '.env.local',
      patterns: [
        /^(?:APP_URL|BASE_URL|SITE_URL|PROJECT_URL|HOSTNAME)=["']?([^"'\s]+)["']?/m,
        /^(?:VIRTUAL_HOST|COMPOSE_DOMAIN)=["']?([^"'\s]+)["']?/m,
      ],
      transform: (match) => {
        const value = match[1];
        if (!value.startsWith('http://') && !value.startsWith('https://')) {
          return `https://${value}`;
        }
        return value;
      },
    },
    {
      file: 'docker-compose.yml',
      patterns: [
        /VIRTUAL_HOST[=:]\s*["']?([^"'\s]+)["']?/,
        /traefik\.http\.routers\.[^.]+\.rule[=:]\s*["']?Host\(`([^`]+)`\)["']?/,
      ],
      transform: (match) => {
        const value = match[1];
        if (!value.startsWith('http://') && !value.startsWith('https://')) {
          return `https://${value}`;
        }
        return value;
      },
    },
    {
      file: 'docker-compose.override.yml',
      patterns: [
        /VIRTUAL_HOST[=:]\s*["']?([^"'\s]+)["']?/,
        /traefik\.http\.routers\.[^.]+\.rule[=:]\s*["']?Host\(`([^`]+)`\)["']?/,
      ],
      transform: (match) => {
        const value = match[1];
        if (!value.startsWith('http://') && !value.startsWith('https://')) {
          return `https://${value}`;
        }
        return value;
      },
    },
    {
      file: 'package.json',
      patterns: [
        /"homepage"\s*:\s*"([^"]+)"/,
        /"proxy"\s*:\s*"([^"]+)"/,
      ],
      transform: (match) => match[1],
    },
  ];

  for (const strategy of detectionStrategies) {
    const filePath = path.join(projectDir, strategy.file);
    if (fs.existsSync(filePath)) {
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        for (const pattern of strategy.patterns) {
          const match = content.match(pattern);
          if (match) {
            return {
              url: strategy.transform(match),
              detectedFrom: strategy.file,
            };
          }
        }
      } catch (err) {
        // Continue to next strategy
      }
    }
  }

  return { url: null, detectedFrom: null };
}

// Format feedback items as MCP content blocks with ImageContent for screenshots
export function formatFeedbackAsContent(items) {
  if (!Array.isArray(items)) items = [items];

  const content = [];
  for (const item of items) {
    const { screenshot, ...rest } = item;

    content.push({
      type: "text",
      text: JSON.stringify(rest, null, 2),
    });

    if (screenshot && typeof screenshot === 'string') {
      const match = screenshot.match(/^data:([^;]+);base64,(.+)$/);
      if (match) {
        content.push({
          type: "image",
          data: match[2],
          mimeType: match[1],
        });
      }
    }
  }

  if (items.length > 1) {
    content.unshift({
      type: "text",
      text: `Received ${items.length} feedback item(s):`,
    });
  }

  return content;
}
