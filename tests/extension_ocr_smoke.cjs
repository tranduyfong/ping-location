/* Real MV3 -> real localhost OCR jobs -> visible map result, without API shims.
   Requires the OCR service at 127.0.0.1:8766 and installed Playwright Chromium. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const project = path.resolve(__dirname, '..');
const arg = name => { const i = process.argv.indexOf(name); return i < 0 ? null : process.argv[i + 1]; };
const packagePath = arg('--playwright-path') || process.env.PLAYWRIGHT_CORE_PATH || path.resolve(project, '../MapTagAutomation/MapTagAutomation/bin/Debug/net8.0-windows/.playwright/package');
const { chromium } = require(packagePath);
const localChromium = process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'ms-playwright/chromium-1243/chrome-win64/chrome.exe');
const executablePath = arg('--chrome-path') || process.env.CHROME_PATH || (localChromium && fs.existsSync(localChromium) ? localChromium : undefined);
const fixture = '<!doctype html><html lang="vi"><head><meta charset="utf-8"><title>Ping Location — real OCR fixture</title></head><body style="margin:0;background:#eceee7"><div style="position:absolute;left:430px;top:65px;font:600 18px Segoe UI,Arial,sans-serif;color:#355345">BẢN ĐỒ THỬ NGHIỆM · DỮ LIỆU MÔ PHỎNG</div><div style="position:absolute;left:430px;top:100px;font:14px Segoe UI,Arial,sans-serif;color:#6e7f70">Ảnh canvas → tiện ích Chrome → dịch vụ OCR cục bộ → vị trí mã căn</div><canvas data-ping-map id="test-map" width="800" height="300" style="position:absolute;left:430px;top:150px;width:800px;height:300px"></canvas><script>const c=document.querySelector("canvas").getContext("2d");c.fillStyle="#fff";c.fillRect(0,0,800,300);c.fillStyle="#e8dd9b";c.fillRect(25,25,350,140);c.fillStyle="#c4b9dc";c.fillRect(425,145,350,130);c.fillStyle="#111";c.font="bold 50px Arial";c.textAlign="center";c.textBaseline="middle";c.fillText("VN48-123",200,95);c.fillText("VX-002",600,210);<\/script></body></html>';
const server = http.createServer((request, response) => { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(fixture); });
(async () => {
  const health = await (await fetch('http://127.0.0.1:8766/health', { signal: AbortSignal.timeout(10000) })).json();
  assert.equal(health.ocrReady, true, 'start ping-location/start.cmd and wait for OCR readiness');
  assert.equal(health.jobsApi, 1, 'current asynchronous jobs service is required');
  assert.equal(health.busy, false, 'wait for the current scan before running this test');
  const tempRoot = path.resolve(os.tmpdir()), profile = fs.mkdtempSync(path.join(tempRoot, 'ping-location-real-ocr-test-'));
  let context, worker, tabId;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const extension = path.join(project, 'extension');
    context = await chromium.launchPersistentContext(profile, { executablePath, headless: true, viewport: null, ignoreDefaultArgs: ['--disable-extensions'], args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--enable-unsafe-extension-debugging', '--window-size=1600,1100'] });
    worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
    const extensionId = new URL(worker.url()).hostname;
    // Observe actual progress messages without replacing fetch, captures, jobs,
    // responses or any other implementation of the extension/backend.
    await worker.evaluate(() => { globalThis.__realOcrProgress = []; const send = chrome.tabs.sendMessage; chrome.tabs.sendMessage = (...args) => { if (args[1]?.channel === 'PingLocation' && args[1]?.type === 'ocrProgress') globalThis.__realOcrProgress.push(args[1]); return send(...args); }; });
    const page = await context.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/real-ocr-fixture`);
    await page.bringToFront();
    const pageCdp = await context.newCDPSession(page), browserCdp = await context.browser().newBrowserCDPSession();
    const { targetInfo } = await pageCdp.send('Target.getTargetInfo');
    const { targetInfos } = await browserCdp.send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }, { exclude: true }] });
    const target = targetInfos.find(item => item.url === targetInfo.url); assert.ok(target);
    await browserCdp.send('Extensions.triggerAction', { id: extensionId, targetId: target.targetId });
    await page.locator('#ping-location-root').waitFor({ timeout: 15000 });
    tabId = (await worker.evaluate(() => chrome.tabs.query({ active: true, currentWindow: true }))).find(tab => tab.url?.includes('/real-ocr-fixture'))?.id;
    assert.ok(tabId);
    async function state() {
      return worker.evaluate(async tabId => {
        const result = await chrome.scripting.executeScript({ target: { tabId }, func: () => {
          const s = window.PingLocationApp?.state, shadow = document.querySelector('#ping-location-root')?.shadowRoot, image = shadow?.querySelector('#capturePreview img');
          return s ? { busy: s.busy, scanning: s.scanning, rows: s.info?.rows.length, mapRect: s.info?.mapRect, detections: s.detections, status: shadow.getElementById('status').textContent, markers: shadow.querySelectorAll('.marker').length, preview: image ? { width: image.naturalWidth, height: image.naturalHeight } : null } : null;
        } }); return result[0].result;
      }, tabId);
    }
    async function until(predicate, timeout = 15000) { const end = Date.now() + timeout; while (Date.now() < end) { const s = await state(); if (predicate(s)) return s; await new Promise(resolve => setTimeout(resolve, 150)); } throw new Error(`Timed out: ${JSON.stringify(await state())}`); }
    await page.locator('#ping-location-root #capturePreviewButton').click();
    const preview = await until(s => !s.busy && s.preview?.width > 0);
    assert.deepEqual(preview.preview, { width: 800, height: 300 });
    assert.equal(preview.rows, 0, 'map recognition must work without a pending manager');
    const started = Date.now();
    await page.locator('#ping-location-root #scan').click();
    const completed = await until(s => !s.busy && !s.scanning && (s.detections.length || /hoàn tất OCR|error|lỗi|Không|không|phản hồi|sẵn sàng/i.test(s.status)), 90000);
    assert.deepEqual(completed.detections.map(item => item.code).sort(), ['VN48-123', 'VX-002'], JSON.stringify(completed));
    const expected = { 'VN48-123': { x: 630, y: 245 }, 'VX-002': { x: 1030, y: 360 } };
    for (const detection of completed.detections) { assert.equal(detection.source, 'ocr'); assert.ok(Math.hypot(detection.x - expected[detection.code].x, detection.y - expected[detection.code].y) < 35, `${detection.code}: incorrect screen point ${detection.x},${detection.y}`); }
    assert.equal(completed.markers, 2);
    const progress = await worker.evaluate(() => globalThis.__realOcrProgress);
    assert.ok(progress.length > 0, 'real asynchronous job progress must reach the content script');
    assert.ok(progress.some(item => ['queued', 'running', 'completed'].includes(item.state)));
    assert.deepEqual(errors, []);
    fs.mkdirSync(path.join(project, 'docs'), { recursive: true });
    await page.screenshot({ path: path.join(project, 'docs/ocr-preview-0.2.png') });
    console.log(JSON.stringify({ result: 'PASS real MV3 + real OCR service: native capture, localhost permission, /jobs progress, 2 exact codes, CSS coordinates, no pending rows required', seconds: Number(((Date.now() - started) / 1000).toFixed(2)), progressEvents: progress.length, detections: completed.detections.map(({ code, x, y }) => ({ code, x, y })) }));
  } finally {
    if (worker && tabId) await worker.evaluate(tabId => chrome.tabs.sendMessage(tabId, { channel: 'PingLocation', type: 'stop', reason: 'Kết thúc kiểm thử OCR.' }).catch(() => {}), tabId).catch(() => {});
    if (context) await context.close();
    await new Promise(resolve => server.close(resolve));
    const relative = path.relative(tempRoot, path.resolve(profile));
    if (!relative.startsWith('..') && !path.isAbsolute(relative) && path.basename(profile).startsWith('ping-location-real-ocr-test-')) fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
