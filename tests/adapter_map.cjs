/* Independent map discovery and direct SVG/DOM label regression tests. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const project = path.resolve(__dirname, '..');
const arg = name => { const index = process.argv.indexOf(name); return index < 0 ? null : process.argv[index + 1]; };
let playwright;
for (const candidate of [arg('--playwright-path') || process.env.PLAYWRIGHT_CORE_PATH, 'playwright-core', path.resolve(project, '../MapTagAutomation/MapTagAutomation/bin/Debug/net8.0-windows/.playwright/package')].filter(Boolean)) {
  try { playwright = require(candidate); break; } catch {}
}
if (!playwright) throw new Error('Pass --playwright-path <installed Playwright Core package>. No dependencies are downloaded.');
const executablePath = arg('--chrome-path') || process.env.CHROME_PATH || ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(file => fs.existsSync(file));
const server = http.createServer((request, response) => { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end('<!doctype html><html lang="vi"><body></body></html>'); });
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await playwright.chromium.launch({ executablePath, headless: true });
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.setContent('<div id="lockcan-pano" style="position:absolute;inset:0;width:1100px;height:800px"><div id="krpanoSWFObject" style="position:absolute;inset:0"><canvas style="position:absolute;inset:0;width:100%;height:100%"></canvas><canvas style="position:absolute;inset:0;width:100%;height:100%"></canvas></div></div>');
    await page.evaluate(() => { const api = document.querySelector('#krpanoSWFObject'); api.get = key => ({ 'xml.scene': 'scene_mb_quy_can', 'view.hlookat': 0, 'view.vlookat': 0, 'view.fov': 90, stagewidth: 1100, stageheight: 800 })[key]; api.spheretoscreen = (x, y) => ({ x, y }); api.screentosphere = (x, y) => ({ x, y }); });
    for (const file of ['bridge.js', 'adapter.js']) await page.addScriptTag({ path: path.join(project, 'extension', file) });
    const engineMap = await page.evaluate(() => PingAdapter.inspectMap());
    assert.deepEqual(engineMap.mapRect, { x: 0, y: 0, width: 1100, height: 800 });
    assert.equal(engineMap.panelRect, null);
    assert.equal(engineMap.mapKind, 'krpano');
    assert.equal(engineMap.rendering.canvasCount, 2);
    assert.equal(engineMap.view.scene, 'scene_mb_quy_can');
    assert.ok(!engineMap.diagnostics.some(text => /Quản lý hotspot/.test(text)), 'closed manager must not block map inspection');
    assert.deepEqual(await page.evaluate(() => PingAdapter.readLabels()), []);

    await page.setContent(`<svg id="map" width="1000" height="700" style="position:absolute;left:40px;top:70px" xmlns="http://www.w3.org/2000/svg">
      <rect width="1000" height="700" fill="#ece7db"/>
      <text id="rotated" x="140" y="160" transform="rotate(-32 140 160)" font-size="24">VX-02</text>
      <text x="340" y="180" style="display:none">ASP-233</text>
      <g opacity="0"><text x="400" y="200">VN48-123</text></g>
      <text x="2000" y="190">VX-04</text>
      <text x="500" y="250">VNB.TP.1-345</text>
      <text x="500" y="350">VNB.TP.1-345</text>
      <text data-lc-pin-label x="160" y="450">VX-08</text>
      <text x="150" y="550" style="pointer-events:none">ASP-235</text>
      <rect data-code="VN48-125" x="700" y="400" width="100" height="100" fill="#e1b0be"/>
      <text x="600" y="600">VX-12</text>
    </svg><button style="position:absolute;left:700px;top:90px">VX-10</button><div style="position:absolute;left:620px;top:640px;width:170px;height:70px;background:#fff">Che nhãn</div><aside style="position:absolute;left:1100px;top:100px">VN48-999</aside><div id="empty-manager" style="position:absolute;left:800px;top:80px;width:220px;height:210px;background:white"><div><h2>Quản lý hotspot</h2><span>scene_mb_quy_can</span></div><button>Chờ gắn</button><button>Đã gắn</button><span>ASP-241</span></div>`);
    const labels = await page.evaluate(() => PingAdapter.readLabels());
    assert.deepEqual(labels.map(item => item.code).sort(), ['ASP-235', 'VN48-125', 'VX-02']);
    const expected = await page.locator('#rotated').boundingBox();
    const rotated = labels.find(item => item.code === 'VX-02');
    assert.ok(Math.abs(rotated.x - expected.x - expected.width / 2) < 1);
    assert.ok(Math.abs(rotated.y - expected.y - expected.height / 2) < 1);
    assert.ok(labels.every(item => item.source === 'dom' && item.confidence === 1));
    const roi = { x: 40, y: 70, width: 1000, height: 700 };
    const roiInfo = await page.evaluate(roi => PingAdapter.inspectMap({ mapROI: roi }), roi);
    assert.deepEqual(roiInfo.mapRect, roi);
    assert.ok(roiInfo.panelRect, 'an empty manager without Gắn still masks its map area');
    assert.deepEqual((await page.evaluate(roi => PingAdapter.readLabels({ mapROI: roi }), roi)).map(item => item.code).sort(), ['ASP-235', 'VN48-125', 'VX-02']);
    assert.equal((await page.evaluate(() => PingAdapter.inspectMap({ mapROI: { x: 1500, y: 900, width: 500, height: 500 } }))).mapRect, null);
    await page.setContent('<svg width="800" height="600" style="position:absolute;left:0;top:-150px"><rect width="800" height="600" fill="#ddd"/></svg>');
    assert.deepEqual((await page.evaluate(() => PingAdapter.inspectMap())).mapRect, { x: 0, y: 0, width: 800, height: 450 });
    assert.deepEqual(errors, []);
    console.log('PASS map adapter: no manager required; real VHUB-style stacked canvases/engine; ROI; clipped bounds; rotated SVG and data codes; hidden/offscreen/duplicate/assigned/UI/occluded labels rejected.');
  } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
