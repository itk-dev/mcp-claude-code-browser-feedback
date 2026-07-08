// End-to-end test for the browser widget's annotation flow, covering the
// iframe selection and Escape-to-cancel behavior that the unit suite can't
// reach (it needs a real browser: elementFromPoint, shadow DOM focus,
// cross-origin frames).
//
// Run with `npm run test:e2e`. Not part of the vitest run because it needs a
// locally installed Playwright Chromium: set PLAYWRIGHT_CHROMIUM to a browser
// executable, or have one in the Playwright browser cache
// (`npx playwright install chromium`).

import http from 'node:http';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const WIDGET_ID = 'claude-feedback-widget';

const WIDGET_SRC = readFileSync(
  new URL('../../src/widget.js', import.meta.url),
  'utf8'
).replace(/__WEBSOCKET_URL__/g, 'ws://127.0.0.1:1/ws');

// ---------------------------------------------------------------------------
// Browser discovery
// ---------------------------------------------------------------------------

function findChromium() {
  if (process.env.PLAYWRIGHT_CHROMIUM) return process.env.PLAYWRIGHT_CHROMIUM;

  const cacheDirs = [
    path.join(os.homedir(), 'Library/Caches/ms-playwright'), // macOS
    path.join(os.homedir(), '.cache/ms-playwright'), // Linux
  ];
  const executableSubpaths = [
    'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium',
    'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
    'chrome-linux/chrome',
  ];

  for (const cacheDir of cacheDirs) {
    if (!existsSync(cacheDir)) continue;
    const revisions = readdirSync(cacheDir)
      .filter((d) => /^chromium-\d+$/.test(d))
      .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
    for (const revision of revisions) {
      for (const sub of executableSubpaths) {
        const candidate = path.join(cacheDir, revision, sub);
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return null;
}

const executablePath = findChromium();
if (!executablePath) {
  console.log(
    'SKIP: no Chromium found. Set PLAYWRIGHT_CHROMIUM to a browser executable ' +
      'or run `npx playwright install chromium`.'
  );
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Fixture pages
//
// Layout (all positions absolute, borders 2px):
//   parent:  #same-origin-frame at (50,100) 400x300, #cross-origin-frame at (500,100) 300x300
//   frame:   #inner-btn at (20,60) 120x30, #nested-frame at (20,120) 250x140
//   nested:  #nested-btn at (10,30) 100x25
//
// Derived top-window coordinates used in assertions:
//   #inner-btn  top-left (72,162)  → center (132,177)
//   #nested-btn top-left (84,254)  → center (134,266)
// ---------------------------------------------------------------------------

const FRAME_HTML = `<!doctype html>
<html><head><title>frame</title></head>
<body style="margin:0">
<p style="height:40px;margin:0">Inside iframe</p>
<button id="inner-btn" style="position:absolute; top:60px; left:20px; width:120px; height:30px">Click me</button>
<input id="inner-input" style="position:absolute; top:95px; left:20px; width:120px; height:20px" />
<iframe id="nested-frame" src="/nested.html"
  style="position:absolute; top:120px; left:20px; width:250px; height:140px; border:2px solid #08c"></iframe>
</body></html>`;

const NESTED_HTML = `<!doctype html>
<html><head><title>nested</title></head>
<body style="margin:0">
<button id="nested-btn" style="position:absolute; top:30px; left:10px; width:100px; height:25px">Nested</button>
</body></html>`;

function parentHtml(crossOriginBase) {
  return `<!doctype html>
<html><head><title>parent</title></head>
<body style="margin:0">
<script>
  // Stub WebSocket so the widget thinks it is online and we can capture payloads
  window.__sent = [];
  window.WebSocket = class FakeWS {
    static OPEN = 1;
    constructor(url) {
      this.url = url; this.readyState = 1;
      setTimeout(() => this.onopen && this.onopen(), 0);
    }
    send(data) { window.__sent.push(data); }
    close() {}
    addEventListener(t, fn) { this['on' + t] = fn; }
    removeEventListener() {}
  };
</script>
<h1 style="height:60px;margin:0">Parent page</h1>
<iframe id="same-origin-frame" src="/frame.html"
  style="position:absolute; top:100px; left:50px; width:400px; height:300px; border:2px solid #888"></iframe>
<iframe id="cross-origin-frame" src="${crossOriginBase}/frame.html"
  style="position:absolute; top:100px; left:500px; width:300px; height:300px; border:2px solid #c00"></iframe>
<script src="/widget.js"></script>
</body></html>`;
}

function serve(crossOriginBase) {
  const srv = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    const pages = {
      '/': ['text/html', parentHtml(crossOriginBase)],
      '/frame.html': ['text/html', FRAME_HTML],
      '/nested.html': ['text/html', NESTED_HTML],
      '/widget.js': ['text/javascript', WIDGET_SRC],
    };
    if (pages[url]) {
      res.writeHead(200, { 'content-type': pages[url][0] });
      res.end(pages[url][1]);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  return new Promise((resolve) =>
    srv.listen(0, '127.0.0.1', () =>
      resolve({ srv, base: `http://127.0.0.1:${srv.address().port}` })
    )
  );
}

// Different port = different origin, which is all the widget's cross-origin
// fallback path cares about.
const crossOrigin = await serve('');
const main = await serve(crossOrigin.base);

// ---------------------------------------------------------------------------
// Test driver
// ---------------------------------------------------------------------------

const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });

const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));

const results = [];
const check = (name, cond, detail = '') => results.push({ name, pass: !!cond, detail });

const inShadow = (script) =>
  page.evaluate(
    ({ W, script }) => {
      const sr = document.getElementById(W).shadowRoot;
      return new Function('sr', 'W', `return (${script})`)(sr, W);
    },
    { W: WIDGET_ID, script }
  );

const overlayActive = () => inShadow(`sr.getElementById(W + '-overlay').classList.contains('active')`);
const panelActive = () => inShadow(`sr.getElementById(W + '-panel').classList.contains('active')`);
const tooltipText = () => inShadow(`sr.getElementById(W + '-tooltip').textContent`);
const highlightRect = () =>
  inShadow(`(() => {
    const s = sr.getElementById(W + '-highlight').style;
    return { top: parseFloat(s.top), left: parseFloat(s.left), width: parseFloat(s.width), height: parseFloat(s.height) };
  })()`);

const rectMatches = (r, exp) =>
  ['top', 'left', 'width', 'height'].every((k) => Math.abs(r[k] - exp[k]) <= 2);

// Click whichever annotate button is visible (main button, or "+ Add" once
// pending items exist).
async function startAnnotation() {
  const mainBtn = page.locator(`#${WIDGET_ID}-button`);
  if (await mainBtn.isVisible()) await mainBtn.click();
  else await page.locator(`#${WIDGET_ID}-add-btn`).click();
  await page.waitForTimeout(50);
}

async function submitFeedback(description) {
  await inShadow(`(() => {
    const cb = sr.getElementById(W + '-include-screenshot');
    if (cb) cb.checked = false; // skip html2canvas fetch
    sr.getElementById(W + '-description').value = ${JSON.stringify(description)};
  })()`);
  await page.locator(`#${WIDGET_ID}-send-btn`).click();
  await page.waitForTimeout(150);
}

async function lastFeedbackPayload() {
  const sent = await page.evaluate(() => window.__sent);
  const msgs = sent.map((s) => JSON.parse(s)).filter((m) => m.type === 'feedback');
  return msgs.at(-1)?.payload;
}

await page.goto(main.base + '/');
await page.waitForFunction(
  (W) => document.getElementById(W)?.shadowRoot?.getElementById(`${W}-button`),
  WIDGET_ID
);
// Let the nested iframe finish loading before poking at it
await page.waitForTimeout(200);

// ---- Escape cancels annotation mode started via widget button click -------
// (regression: focus stays on the shadow-root button, which used to swallow
// the keydown before the document handler saw it)
await startAnnotation();
check('annotation mode starts via button click', await overlayActive());
await page.keyboard.press('Escape');
await page.waitForTimeout(100);
check('Escape cancels annotation mode (focus in shadow root)', !(await overlayActive()));

// ---- Hover + select inside a same-origin iframe ----------------------------
await startAnnotation();
await page.mouse.move(132, 177); // #inner-btn center
await page.waitForTimeout(100);
const tt1 = await tooltipText();
check('tooltip shows inner element selector', tt1.includes('#inner-btn'), `tooltip="${tt1}"`);
const hl1 = await highlightRect();
check(
  'highlight positioned at inner element (translated to top window)',
  rectMatches(hl1, { top: 162, left: 72, width: 120, height: 30 }),
  JSON.stringify(hl1)
);

await page.mouse.click(132, 177);
await page.waitForTimeout(150);
check('panel opens after selecting inner element', await panelActive());
const info = await inShadow(`sr.getElementById(W + '-element-info').innerHTML`);
check('panel element info shows #inner-btn', info.includes('#inner-btn'), info.slice(0, 120));

await submitFeedback('iframe test');
const p1 = await lastFeedbackPayload();
check('feedback payload sent', !!p1?.element, p1 ? '' : 'no feedback message');
check('payload element selector is #inner-btn', p1?.element?.selector === '#inner-btn', p1?.element?.selector);
check('payload has frame url', p1?.element?.frame?.url?.includes('/frame.html'), p1?.element?.frame?.url);
check(
  'payload frame selector points at iframe (single level, no chain)',
  p1?.element?.frame?.selector?.includes('same-origin-frame') && !p1?.element?.frame?.selector?.includes('>>>'),
  p1?.element?.frame?.selector
);

// ---- Hover + select inside a NESTED same-origin iframe ---------------------
// (regression: coordinates must be re-translated per frame while descending)
await startAnnotation();
await page.mouse.move(134, 266); // #nested-btn center
await page.waitForTimeout(100);
const tt2 = await tooltipText();
check('tooltip shows nested element selector', tt2.includes('#nested-btn'), `tooltip="${tt2}"`);
const hl2 = await highlightRect();
check(
  'highlight positioned at nested element',
  rectMatches(hl2, { top: 254, left: 84, width: 100, height: 25 }),
  JSON.stringify(hl2)
);

await page.mouse.click(134, 266);
await page.waitForTimeout(150);
await submitFeedback('nested iframe test');
const p2 = await lastFeedbackPayload();
check('nested payload selector is #nested-btn', p2?.element?.selector === '#nested-btn', p2?.element?.selector);
check('nested payload frame url is nested.html', p2?.element?.frame?.url?.includes('/nested.html'), p2?.element?.frame?.url);
check(
  'nested frame selector chains from top document',
  /#same-origin-frame.*>>>.*#nested-frame/.test(p2?.element?.frame?.selector || ''),
  p2?.element?.frame?.selector
);

// ---- Escape closes the feedback panel --------------------------------------
await startAnnotation();
await page.mouse.move(132, 177);
await page.mouse.click(132, 177);
await page.waitForTimeout(150);
if (await panelActive()) {
  await page.keyboard.press('Escape'); // focus is in the shadow-root textarea
  await page.waitForTimeout(100);
  check('Escape closes feedback panel', !(await panelActive()));
} else {
  check('Escape closes feedback panel', false, 'panel did not open');
}

// ---- Cross-origin iframe falls back to the iframe element ------------------
await startAnnotation();
await page.mouse.move(650, 250); // inside #cross-origin-frame
await page.waitForTimeout(100);
const tt3 = await tooltipText();
check('cross-origin iframe falls back to iframe element', tt3.includes('#cross-origin-frame'), `tooltip="${tt3}"`);
await page.keyboard.press('Escape');
await page.waitForTimeout(100);

// ---- Keyboard shortcuts while focus is inside a same-origin iframe (#55) ----
// These drive the keyboard entirely through the iframe document — no widget
// button click — so focus stays in the frame and the event must reach the
// mirrored keydown listener. Without the fix, Shift+C/Escape would be dead here.
const sameOriginFrame = page.frameLocator('#same-origin-frame');

// Shift+C from inside the frame starts annotation mode
await sameOriginFrame.locator('#inner-btn').focus();
check('annotation mode off before frame-Shift+C', !(await overlayActive()));
await page.keyboard.press('Shift+C'); // keydown originates in the iframe document
await page.waitForTimeout(100);
check('Shift+C from inside iframe starts annotation mode', await overlayActive());
if (await overlayActive()) {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
}

// Escape from inside the frame cancels annotation mode. Start via the widget
// button (works regardless of the fix), then move focus into the frame so the
// Escape keydown must travel through the mirrored iframe listener — decoupled
// from the Shift+C check above so it can't trivially pass on an inactive overlay.
await startAnnotation();
check('annotation mode active before frame-Escape', await overlayActive());
await sameOriginFrame.locator('#inner-btn').focus();
await page.keyboard.press('Escape');
await page.waitForTimeout(100);
check('Escape from inside iframe cancels annotation mode', !(await overlayActive()));

// Shift+C is suppressed while typing in an iframe input
await sameOriginFrame.locator('#inner-input').focus();
await page.keyboard.press('Shift+C');
await page.waitForTimeout(100);
check('Shift+C suppressed while typing in iframe input', !(await overlayActive()));
if (await overlayActive()) await page.keyboard.press('Escape');

// Cross-origin frame skipped gracefully — covered by the no-errors check below
// (the sync helper walks it and must not throw). Return focus to the top page.
await page.locator('h1').click();
check('no page errors', pageErrors.length === 0, pageErrors.join('; '));

// ---------------------------------------------------------------------------

console.log('\n=== RESULTS ===');
for (const r of results) {
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  [' + r.detail + ']' : ''}`);
}
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);

await browser.close();
main.srv.close();
crossOrigin.srv.close();
process.exit(failed ? 1 : 0);
