/* Runs in the page MAIN world. Read-only, fixed krpano API surface. */
(() => {
  'use strict';
  if (window.__pingLocationBridgeInstalled) return;
  window.__pingLocationBridgeInstalled = true;
  const CHANNEL = 'PingLocation';
  function engine() {
    const candidates = [document.getElementById('krpanoSWFObject'), document.getElementById('krpano'), document.getElementById('pano'), window.krpano];
    for (const candidate of candidates) if (candidate && typeof candidate.get === 'function' && typeof candidate.screentosphere === 'function' && typeof candidate.spheretoscreen === 'function') return candidate;
    for (const candidate of document.querySelectorAll('embed,object,[id*="krpano" i]')) if (typeof candidate.get === 'function' && typeof candidate.screentosphere === 'function' && typeof candidate.spheretoscreen === 'function') return candidate;
    return null;
  }
  function safeGet(api, key) { try { const value = api.get(key); return ['string', 'number', 'boolean'].includes(typeof value) ? value : null; } catch { return null; } }
  function rectangle(api) {
    const target = typeof api.getBoundingClientRect === 'function' ? api : document.getElementById('pano');
    if (!target) return null;
    const r = target.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }
  function finite(value) { return typeof value === 'number' && Number.isFinite(value); }
  function run(command, params) {
    const api = engine();
    if (!api) return null;
    const bounds = rectangle(api);
    if (command === 'hotspots') {
      const total = Number(safeGet(api, 'hotspot.count'));
      if (!Number.isInteger(total) || total < 0) return null;
      const items = [];
      for (let index = 0; index < Math.min(total, 10000); index++) {
        const prefix = `hotspot[${index}]`;
        const name = safeGet(api, `${prefix}.name`), title = safeGet(api, `${prefix}.title`);
        // Only application-created product pins can prove a newly saved assignment.
        if (typeof name !== 'string' || !name.startsWith('lc_hs_') || typeof title !== 'string' || title.length > 100) continue;
        const ath = safeGet(api, `${prefix}.ath`), atv = safeGet(api, `${prefix}.atv`);
        if (finite(ath) && finite(atv)) items.push({ name, title, ath, atv });
      }
      return { scene: safeGet(api, 'xml.scene'), items, truncated: total > 10000 };
    }
    if (command === 'inspect') return {
      engine: 'krpano', hlookat: safeGet(api, 'view.hlookat'), vlookat: safeGet(api, 'view.vlookat'),
      fov: safeGet(api, 'view.fov'), fovtype: safeGet(api, 'view.fovtype'), projection: safeGet(api, 'view.stereographic'),
      scene: safeGet(api, 'xml.scene'), viewportWidth: safeGet(api, 'stagewidth'), viewportHeight: safeGet(api, 'stageheight'), rect: bounds
    };
    if (command === 'project' && finite(params?.ath) && finite(params?.atv) && Math.abs(params.atv) <= 90 && Math.abs(params.ath) <= 360000) {
      const point = api.spheretoscreen(params.ath, params.atv);
      const x = Number(point?.x ?? point?.[0]), y = Number(point?.y ?? point?.[1]);
      return finite(x) && finite(y) ? { x: x + (bounds?.x || 0), y: y + (bounds?.y || 0), space: 'viewport-css' } : null;
    }
    if (command === 'unproject' && finite(params?.x) && finite(params?.y)) {
      const point = api.screentosphere(params.x - (bounds?.x || 0), params.y - (bounds?.y || 0));
      const ath = Number(point?.x ?? point?.ath ?? point?.[0]), atv = Number(point?.y ?? point?.atv ?? point?.[1]);
      return finite(ath) && finite(atv) ? { ath, atv } : null;
    }
    return null;
  }
  window.addEventListener('message', event => {
    const message = event.data;
    if (event.source !== window || event.origin !== location.origin || message?.channel !== CHANNEL || message.kind !== 'bridge-request' || typeof message.id !== 'string' || message.id.length > 150 || !['inspect', 'project', 'unproject', 'hotspots'].includes(message.command)) return;
    try { window.postMessage({ channel: CHANNEL, kind: 'bridge-response', id: message.id, ok: true, result: run(message.command, message.params) }, location.origin); }
    catch { window.postMessage({ channel: CHANNEL, kind: 'bridge-response', id: message.id, ok: false, result: null }, location.origin); }
  });
})();
