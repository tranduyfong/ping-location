/* DOM adapter. All coordinates are CSS pixels in the top-level viewport. */
(() => {
  'use strict';
  const CHANNEL = 'PingLocation';
  const CODE = /^[A-Z][A-Z0-9]*(?:[._][A-Z0-9]+)*-\d+[A-Z]?$/;
  const CODE_IN_TEXT = /(?<![A-Z0-9._-])[A-Z][A-Z0-9]*(?:[._][A-Z0-9]+)*-\d+[A-Z]?(?![A-Z0-9._-])/g;
  const state = { lastArm: null, picker: null };
  const normalize = value => String(value ?? '').normalize('NFKC').toUpperCase().replace(/[‐‑‒–—−]/g, '-').replace(/\s+/g, '').trim();
  const cleanText = element => (element?.innerText || element?.textContent || element?.value || '').replace(/\s+/g, ' ').trim();
  const rect = element => {
    const r = element.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  };
  const visible = element => {
    if (!(element instanceof Element) || element.closest('#ping-location-root')) return false;
    const r = element.getBoundingClientRect();
    const s = getComputedStyle(element);
    if (!(r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) !== 0)) return false;
    let left = Math.max(0, r.left), top = Math.max(0, r.top), right = Math.min(innerWidth, r.right), bottom = Math.min(innerHeight, r.bottom);
    // A row outside its scrolling list is not on screen even if its rectangle
    // falls inside the browser viewport behind the panel footer.
    for (let ancestor = element.parentElement; ancestor && ancestor !== document.documentElement; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      if (Number(style.opacity) === 0) return false;
      const bounds = ancestor.getBoundingClientRect();
      if (/^(auto|scroll|hidden|clip)$/.test(style.overflowX)) { left = Math.max(left, bounds.left); right = Math.min(right, bounds.right); }
      if (/^(auto|scroll|hidden|clip)$/.test(style.overflowY)) { top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom); }
      if (right <= left || bottom <= top) return false;
    }
    return true;
  };
  function query(root, selector, diagnostics = []) {
    if (!selector) return [];
    try { return [...root.querySelectorAll(selector)].filter(visible); }
    catch { diagnostics.push(`Bộ chọn CSS không hợp lệ: ${selector}`); return []; }
  }
  function codesOf(element, config = {}) {
    const direct = element.getAttribute('data-code') || element.getAttribute('data-ping-code');
    if (direct && CODE.test(normalize(direct))) return [normalize(direct)];
    const nodes = config.codeSelector ? query(element, config.codeSelector) : query(element, '[data-ping-code]');
    const input = nodes.length ? nodes.map(n => n.getAttribute('data-ping-code') || cleanText(n)).join(' ') : cleanText(element);
    return [...new Set((input.toUpperCase().normalize('NFKC').replace(/[‐‑‒–—−]/g, '-').match(CODE_IN_TEXT) || []).map(normalize))];
  }
  const isAttach = element => visible(element) && cleanText(element).toLocaleLowerCase('vi') === 'gắn' && !element.disabled && element.getAttribute('aria-disabled') !== 'true';
  function attachButtons(root, config, diagnostics = []) {
    return query(root, config.attachSelector || '[data-ping-attach],button,[role="button"],a,input[type="button"]', diagnostics).filter(isAttach);
  }
  function panelHeadings(root) {
    return [...root.querySelectorAll('h1,h2,h3,h4,div,span,p')].filter(node => visible(node) && cleanText(node).toLocaleLowerCase('vi') === 'quản lý hotspot' && ![...node.children].some(child => cleanText(child).toLocaleLowerCase('vi') === 'quản lý hotspot'));
  }
  function panelAnchor(panel) {
    const headings = panelHeadings(panel);
    if (headings.length !== 1) return null;
    const heading = headings[0], lineage = [];
    for (let node = panel.parentNode; node; node = node.parentNode) lineage.push(node);
    return { panel, heading, headingParent: heading.parentNode, headerText: cleanText(heading.parentElement), lineage, url: location.href };
  }
  function originalPanel(anchor, config) {
    // Only verification may reuse this exact DOM node after the final Gắn
    // button disappears. A replacement panel or a changed scene is insufficient.
    if (!anchor || config.panelSelector || anchor.url !== location.href || !anchor.panel.isConnected || !visible(anchor.panel) || !anchor.heading.isConnected || anchor.heading.parentNode !== anchor.headingParent || !anchor.panel.contains(anchor.heading) || cleanText(anchor.headingParent) !== anchor.headerText) return null;
    const lineage = [];
    for (let node = anchor.panel.parentNode; node; node = node.parentNode) lineage.push(node);
    if (lineage.length !== anchor.lineage.length || lineage.some((node, index) => node !== anchor.lineage[index])) return null;
    const headings = panelHeadings(document);
    if (headings.length !== 1 || headings[0] !== anchor.heading || query(document, '[data-ping-panel]').length > 1) return null;
    return anchor.panel;
  }
  function findPanel(config, diagnostics) {
    if (config.panelSelector) {
      const panels = query(document, config.panelSelector, diagnostics);
      if (panels.length !== 1) { diagnostics.push(`Bộ chọn bảng phải khớp đúng một phần tử đang hiển thị (hiện có ${panels.length}).`); return null; }
      return panels[0];
    }
    const explicit = query(document, '[data-ping-panel]');
    if (explicit.length === 1) return explicit[0];
    if (explicit.length > 1) { diagnostics.push('Có nhiều bảng hotspot; cần chọn bảng cụ thể.'); return null; }
    const titles = [...document.querySelectorAll('h1,h2,h3,h4,div,span,p')].filter(e => visible(e) && e.children.length < 3 && cleanText(e).toLocaleLowerCase('vi') === 'quản lý hotspot');
    const found = new Set();
    for (const title of titles) {
      let candidate = title.parentElement;
      for (let depth = 0; candidate && depth < 6; depth++, candidate = candidate.parentElement) {
        if (candidate === document.body || candidate === document.documentElement) break;
        const r = candidate.getBoundingClientRect();
        if (r.width <= innerWidth * .75 && r.height <= innerHeight && attachButtons(candidate, config).length) { found.add(candidate); break; }
      }
    }
    if (found.size === 1) return [...found][0];
    diagnostics.push(found.size ? 'Có nhiều bảng Quản lý hotspot; cần cấu hình bộ chọn CSS.' : 'Chưa nhận diện được bảng Quản lý hotspot. Mở tab Chờ gắn hoặc chọn bộ chọn CSS.');
    return null;
  }
  function inferRow(button, panel, config) {
    let node = button.parentElement;
    for (let depth = 0; node && node !== panel && depth < 5; depth++, node = node.parentElement) {
      const r = node.getBoundingClientRect();
      if (codesOf(node, config).length === 1 && attachButtons(node, config).length === 1 && r.height <= 180) return node;
    }
    return null;
  }
  function rowElements(panel, config, diagnostics) {
    if (!panel) return [];
    if (config.rowSelector) return query(panel, config.rowSelector, diagnostics);
    const explicit = query(panel, '[data-ping-row]');
    if (explicit.length) return explicit;
    return [...new Set(attachButtons(panel, config, diagnostics).map(button => inferRow(button, panel, config)).filter(Boolean))];
  }
  function pendingTabIsInactive(panel) {
    if (!panel) return false;
    const active = [...panel.querySelectorAll('[role="tab"][aria-selected="true"],[data-ping-tab][data-active="true"],.tab.active,.tabs .active')].filter(visible);
    return active.some(node => /^đã gắn(?:\s+\d+)?$/i.test(cleanText(node)));
  }
  function pendingCount(panel) {
    if (!panel) return null;
    const marker = panel.matches('[data-pending-total]') ? panel : panel.querySelector('[data-pending-total]');
    const raw = marker?.getAttribute('data-pending-total');
    if (raw != null && /^\d+$/.test(raw)) return Number(raw);
    const label = cleanText(panel).match(/(?:chờ gắn|chưa gắn)\s*[:(]\s*(\d+)/i);
    if (label) return Number(label[1]);
    const pagination = cleanText(panel).match(/Trang\s*\d+\s*\/\s*\d+\s*[·\-–]\s*([\d.,]+)\s*căn/i);
    return pagination ? Number(pagination[1].replace(/[.,]/g, '')) : null;
  }
  function pendingContext(panel, config) {
    if (!panel) return null;
    const rows = rowElements(panel, config, []);
    const controls = [...panel.querySelectorAll('input,select,button,[role="tab"]')].filter(node => visible(node) && !rows.some(row => row.contains(node))).map(node => ({
      tag: node.tagName, text: node.tagName === 'BUTTON' || node.getAttribute('role') === 'tab' ? cleanText(node).replace(/^(Chờ gắn|Đã gắn)\s*\d*$/i, '$1') : '',
      value: 'value' in node ? node.value : '', checked: 'checked' in node ? node.checked : null,
      selected: node.getAttribute('aria-selected'), pressed: node.getAttribute('aria-pressed'), className: node.className
    }));
    const page = cleanText(panel).match(/Trang\s*(\d+)\s*\/\s*\d+/i)?.[1] || null;
    return JSON.stringify({ controls, page });
  }
  function successSignals(config) {
    return query(document, config.successSelector || '[data-ping-success]').map(node => ({
      text: cleanText(node), code: normalize(node.getAttribute('data-code') || ''),
      positive: !/(?:chưa|không|thất bại|lỗi|failed|error|unsuccessful)/i.test(cleanText(node)) && (node.hasAttribute('data-ping-success') || /(?:đã gắn|gắn thành công|successfully|attached|linked)/i.test(cleanText(node))),
      key: `${node.getAttribute('data-event-id') || ''}|${cleanText(node)}|${node.getAttribute('data-code') || ''}`
    }));
  }
  function resolveMap(config, panel, diagnostics) {
    if (config.mapSelector) {
      const candidates = query(document, config.mapSelector, diagnostics);
      if (candidates.length === 1) return candidates[0];
      diagnostics.push(`Bộ chọn bản đồ phải khớp đúng một phần tử đang hiển thị (hiện có ${candidates.length}).`);
      return null;
    }
    const candidates = query(document, '[data-ping-map],#krpanoSWFObject,#krpano,#lockcan-pano,[data-pano],#pano,canvas,svg,img[data-map],img[alt*="mặt bằng" i],img[alt*="bản đồ" i]').filter(node => !panel?.contains(node) && node.getBoundingClientRect().width > 200 && node.getBoundingClientRect().height > 200);
    const unique = candidates.filter(node => !candidates.some(other => other !== node && other.contains(node)));
    if (unique.length === 1) return unique[0];
    diagnostics.push(unique.length ? 'Có nhiều vùng bản đồ; cần chọn bộ chọn CSS.' : 'Chưa nhận diện được vùng bản đồ.');
    return null;
  }
  async function bridge(command, params = {}, timeout = 200) {
    return new Promise(resolve => {
      const id = `pl-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const done = value => { clearTimeout(timer); window.removeEventListener('message', receive); resolve(value); };
      const receive = event => {
        if (event.source !== window || event.data?.channel !== CHANNEL || event.data?.kind !== 'bridge-response' || event.data.id !== id) return;
        done(event.data.ok ? event.data.result : null);
      };
      const timer = setTimeout(() => done(null), timeout);
      window.addEventListener('message', receive);
      window.postMessage({ channel: CHANNEL, kind: 'bridge-request', id, command, params }, location.origin);
    });
  }
  function optionalPanel(config, diagnostics) {
    const notes = [];
    const detected = findPanel(config, notes);
    if (detected) return detected;
    if (config.panelSelector) { diagnostics.push(...notes); return null; }
    // An open empty/assigned manager still masks the map, even with no Gắn.
    const headings = panelHeadings(document);
    if (headings.length !== 1) return null;
    let node = headings[0].parentElement;
    for (let depth = 0; node && depth < 6 && node !== document.body; depth++, node = node.parentElement) {
      const buttons = query(node, 'button,[role="tab"]');
      const names = buttons.map(cleanText);
      const bounds = node.getBoundingClientRect();
      if (bounds.width <= innerWidth * .75 && bounds.height <= innerHeight && names.some(name => /^Chờ gắn(?:\s+\d+)?$/i.test(name)) && names.some(name => /^Đã gắn(?:\s+\d+)?$/i.test(name))) return node;
    }
    return null;
  }
  function viewportRect(value) {
    if (!value || !['x', 'y', 'width', 'height'].every(key => typeof value[key] === 'number' && Number.isFinite(value[key])) || value.width <= 0 || value.height <= 0) return null;
    const x = Math.max(0, value.x), y = Math.max(0, value.y), right = Math.min(innerWidth, value.x + value.width), bottom = Math.min(innerHeight, value.y + value.height);
    return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
  }
  async function inspectMap(config = {}) {
    const diagnostics = [];
    if (window.top !== window) diagnostics.push('Bản đồ nằm trong iframe; hãy mở trang bản đồ chính để kiểm tra.');
    const panel = optionalPanel(config, diagnostics);
    const roi = config.mapROI || config.mapRect;
    const viewPromise = bridge('inspect');
    let map = null, bounds = null;
    if (roi) {
      const clipped = viewportRect(roi);
      if (!clipped || clipped.width < 10 || clipped.height < 10 || Math.abs(clipped.x - roi.x) > 1 || Math.abs(clipped.y - roi.y) > 1 || Math.abs(clipped.width - roi.width) > 1 || Math.abs(clipped.height - roi.height) > 1) diagnostics.push('Vùng bản đồ đã chọn không còn nằm trọn trong màn hình. Hãy chọn lại vùng.');
      else bounds = clipped;
    } else {
      map = resolveMap(config, panel, diagnostics);
      if (map) bounds = viewportRect(rect(map));
    }
    const view = await viewPromise;
    if (!bounds && !roi && !config.mapSelector && view?.rect) bounds = viewportRect(view.rect);
    const canvases = query(document, 'canvas').filter(node => !panel?.contains(node) && (!bounds || overlaps(rect(node), bounds)));
    const frames = query(document, 'iframe').map(node => ({ rect: rect(node), src: node.getAttribute('src') || '' }));
    const loading = query(document, '[aria-busy="true"],[aria-label="Đang tải tour VR"]').some(node => /đang tải/i.test(cleanText(node) || node.getAttribute('aria-label') || ''));
    if (loading) diagnostics.push('Trang còn hiển thị lớp Đang tải dữ liệu. Đợi bản đồ hiện rõ rồi kiểm tra màn hình.');
    if (!bounds && frames.length) diagnostics.push('Có iframe đang hiển thị; tiện ích chưa truy cập được bản đồ bên trong iframe. Có thể chọn vùng ảnh trên màn hình.');
    if (bounds && canvases.length) diagnostics.push(`Đã thấy ${canvases.length} canvas trong vùng bản đồ. Chữ vẽ trong ảnh/canvas cần OCR hoặc chấm mẫu.`);
    return {
      mapRect: bounds, panelRect: panel ? viewportRect(rect(panel)) : null, view, diagnostics,
      mapKind: roi ? 'region' : view?.engine === 'krpano' ? 'krpano' : map?.tagName === 'SVG' || map?.tagName === 'svg' ? 'svg' : map?.tagName === 'IMG' ? 'image' : canvases.length ? 'canvas' : bounds ? 'region' : null,
      rendering: { canvasCount: canvases.length, iframeCount: frames.length, loading, engineFound: Boolean(view?.engine), frames },
      url: location.href, viewport: { width: innerWidth, height: innerHeight, devicePixelRatio }
    };
  }
  function overlaps(a, b) { return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y; }
  function containsPoint(bounds, point) { return bounds && point.x >= bounds.x && point.y >= bounds.y && point.x < bounds.x + bounds.width && point.y < bounds.y + bounds.height; }
  async function readLabels(config = {}) {
    const info = await inspectMap(config);
    if (!info.mapRect) return [];
    const panel = optionalPanel(config, []);
    const map = config.mapROI || config.mapRect ? null : resolveMap(config, panel, []);
    const forbidden = '#ping-location-root,button,input,textarea,select,nav,header,footer,aside,a,[role="dialog"],[role="button"],[contenteditable="true"],[data-lc-pin-label],[id^="lc_hs_"]';
    const candidates = [];
    function add(node, code, bounds, kind) {
      if (!CODE.test(code) || !visible(node) || node.closest(forbidden) || panel?.contains(node) || (map && !map.contains(node) && node !== map)) return;
      if (!bounds || bounds.width <= 0 || bounds.height <= 0) return;
      const point = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
      if (!containsPoint(info.mapRect, point) || (info.panelRect && containsPoint(info.panelRect, point))) return;
      const hit = document.elementFromPoint(point.x, point.y);
      if (!hit || hit.closest(forbidden) || panel?.contains(hit)) return;
      const svg = node.closest('svg');
      if (kind === 'attribute' && svg && !(hit === node || node.contains(hit))) return;
      if (!(hit === node || hit.contains(node) || node.contains(hit) || (svg && svg.contains(hit)) || hit.tagName === 'CANVAS')) return;
      candidates.push({ code, ...point, bounds, kind });
    }
    for (const node of [...document.querySelectorAll('[data-code],[data-ping-code]')].slice(0, 10000)) {
      const code = normalize(node.getAttribute('data-code') || node.getAttribute('data-ping-code'));
      add(node, code, rect(node), 'attribute');
    }
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
    let text, count = 0;
    while ((text = walker.nextNode()) && count++ < 50000) {
      const code = normalize(text.nodeValue);
      if (!CODE.test(code) || !text.parentElement) continue;
      const range = document.createRange(); range.selectNodeContents(text);
      add(text.parentElement, code, range.getBoundingClientRect(), 'text');
    }
    const preferred = candidates.filter(item => item.kind === 'text' || !candidates.some(other => other.kind === 'text' && other.code === item.code && containsPoint(item.bounds, other)));
    const unique = [];
    for (const item of preferred) if (!unique.some(other => other.code === item.code && Math.hypot(item.x - other.x, item.y - other.y) < 3)) unique.push(item);
    const counts = new Map();
    for (const item of unique) counts.set(item.code, (counts.get(item.code) || 0) + 1);
    return unique.filter(item => counts.get(item.code) === 1).map(({ code, x, y }) => ({ code, x, y, confidence: 1, source: 'dom' }));
  }
  async function inspect(config = {}) {
    const diagnostics = [];
    if (window.top !== window) diagnostics.push('Tự động hóa chỉ hỗ trợ trang chính; không chạy bên trong iframe.');
    const panel = findPanel(config, diagnostics);
    const inactive = pendingTabIsInactive(panel);
    if (inactive) diagnostics.push('Đang mở tab Đã gắn. Chuyển sang Chờ gắn trước khi chạy.');
    const elements = rowElements(panel, config, diagnostics);
    const rows = [];
    for (const element of elements) {
      const codes = codesOf(element, config);
      const buttons = attachButtons(element, config, diagnostics);
      if (codes.length !== 1 || buttons.length !== 1 || inactive) continue;
      rows.push({ code: codes[0], buttonRect: rect(buttons[0]), rowRect: rect(element), status: 'pending' });
    }
    const duplicates = rows.filter((row, index) => rows.findIndex(other => other.code === row.code) !== index).map(row => row.code);
    if (duplicates.length) diagnostics.push(`Mã căn trùng trong bảng: ${[...new Set(duplicates)].join(', ')}. Không thể tự chọn các mã này.`);
    const map = resolveMap(config, panel, diagnostics);
    if (document.querySelector('iframe') && !map) diagnostics.push('Bản đồ có thể nằm trong iframe; bộ chọn CSS chỉ truy cập được trang chính.');
    return {
      rows, mapRect: map ? rect(map) : null, panelRect: panel ? rect(panel) : null,
      pendingCount: pendingCount(panel), pendingContext: pendingContext(panel, config), successSignals: successSignals(config), diagnostics,
      view: await bridge('inspect'), url: location.href, viewport: { width: innerWidth, height: innerHeight, devicePixelRatio }
    };
  }
  async function arm(code, config = {}) {
    const target = normalize(code);
    if (!CODE.test(target)) throw new Error('Mã căn không hợp lệ.');
    const hotspotSnapshot = await bridge('hotspots', {}, 700);
    const diagnostics = [];
    const panel = findPanel(config, diagnostics);
    if (!panel || pendingTabIsInactive(panel)) throw new Error(diagnostics.join(' ') || 'Hãy mở tab Chờ gắn.');
    const matching = rowElements(panel, config, diagnostics).filter(row => codesOf(row, config).length === 1 && codesOf(row, config)[0] === target && attachButtons(row, config).length === 1);
    if (matching.length !== 1) throw new Error(`Không tìm thấy duy nhất một dòng Chờ gắn cho ${target}.`);
    const buttons = attachButtons(matching[0], config);
    if (buttons.length !== 1) throw new Error('Nút Gắn đã thay đổi. Đã dừng để tránh thao tác nhầm.');
    const r = buttons[0].getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    if (!hit || !(hit === buttons[0] || buttons[0].contains(hit))) throw new Error('Nút Gắn đang bị một cửa sổ khác che khuất.');
    state.lastArm = { code: target, pendingCount: pendingCount(panel), pendingContext: pendingContext(panel, config), successSignals: successSignals(config), hotspotSnapshot, panelAnchor: panelAnchor(panel), at: Date.now() };
    buttons[0].click();
    return true;
  }
  async function verify(code, config = {}, before = null) {
    const target = normalize(code);
    const diagnostics = [];
    const baseline = state.lastArm?.code === target ? state.lastArm : before;
    const panel = findPanel(config, diagnostics) || originalPanel(baseline?.panelAnchor, config);
    for (const row of rowElements(panel, config, diagnostics)) {
      if (!codesOf(row, config).includes(target)) continue;
      const status = (row.getAttribute('data-status') || row.getAttribute('data-ping-status') || '').toLowerCase();
      if (['attached', 'assigned', 'linked', 'gắn', 'đã gắn'].includes(status) || (!attachButtons(row, config).length && /(?:^|\s)đã gắn(?:\s|$)/i.test(cleanText(row)))) return { confirmed: true, reason: `Dòng ${target} có trạng thái Đã gắn.` };
    }
    const oldSignals = new Set((baseline?.successSignals || []).map(signal => signal.key));
    for (const signal of successSignals(config)) {
      const containsCode = signal.code === target || (signal.text.toUpperCase().match(CODE_IN_TEXT) || []).map(normalize).includes(target);
      if (signal.positive && containsCode && !oldSignals.has(signal.key) && baseline) return { confirmed: true, reason: `Trang xác nhận riêng mã ${target}.` };
    }
    const currentRows = rowElements(panel, config, diagnostics);
    const stillPending = currentRows.some(row => codesOf(row, config).includes(target) && attachButtons(row, config).length);
    const count = pendingCount(panel);
    const sameContext = baseline?.pendingContext && baseline.pendingContext === pendingContext(panel, config);
    if (panel && !pendingTabIsInactive(panel) && !stillPending && sameContext && Number.isInteger(baseline?.pendingCount) && Number.isInteger(count) && count === baseline.pendingCount - 1) return { confirmed: true, reason: `Mã ${target} đã rời danh sách và số căn Chờ gắn giảm đúng một, cùng bộ lọc và trang.` };
    if (panel && !pendingTabIsInactive(panel) && !stillPending && baseline?.hotspotSnapshot && !baseline.hotspotSnapshot.truncated) {
      const latest = await bridge('hotspots', {}, 700);
      if (latest && !latest.truncated && latest.scene === baseline.hotspotSnapshot.scene) {
        const key = pin => `${pin.name}|${pin.title}|${pin.ath}|${pin.atv}`;
        const old = new Set(baseline.hotspotSnapshot.items.map(key));
        if (latest.items.some(pin => normalize(pin.title) === target && !old.has(key(pin)))) return { confirmed: true, reason: `Mã ${target} đã rời danh sách và có hotspot ứng dụng mới mang đúng mã trên cùng scene.` };
      }
    }
    return { confirmed: false, reason: stillPending ? `${target} vẫn ở danh sách Chờ gắn.` : 'Chưa có xác nhận gắn thành công dành riêng cho mã căn này.' };
  }
  function selectorFor(element) {
    if (element.id) return `#${CSS.escape(element.id)}`;
    for (const attribute of ['data-ping-panel', 'data-ping-row', 'data-ping-map', 'data-testid']) {
      if (element.hasAttribute(attribute)) {
        const value = element.getAttribute(attribute);
        const candidate = value ? `[${attribute}="${CSS.escape(value)}"]` : `[${attribute}]`;
        if (document.querySelectorAll(candidate).length === 1) return candidate;
      }
    }
    const segments = [];
    let node = element;
    while (node && node !== document.documentElement && segments.length < 7) {
      let part = node.tagName.toLowerCase();
      if (node.id) { segments.unshift(`#${CSS.escape(node.id)}`); break; }
      const siblings = node.parentElement ? [...node.parentElement.children].filter(sibling => sibling.tagName === node.tagName) : [];
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      segments.unshift(part);
      const candidate = segments.join(' > ');
      if (document.querySelectorAll(candidate).length === 1) return candidate;
      node = node.parentElement;
    }
    return segments.join(' > ');
  }
  async function nextPage(config = {}) {
    const diagnostics = [];
    const panel = findPanel(config, diagnostics);
    if (!panel || pendingTabIsInactive(panel)) return { advanced: false, reason: diagnostics.join(' ') || 'Hãy mở tab Chờ gắn.' };
    const candidates = config.nextSelector ? query(panel, config.nextSelector, diagnostics) : query(panel, 'button,[role="button"]').filter(node => cleanText(node).toLocaleLowerCase('vi') === 'sau');
    if (candidates.length !== 1) return { advanced: false, reason: candidates.length ? 'Có nhiều nút chuyển trang. Chọn bộ chọn Nút trang sau cụ thể.' : diagnostics.join(' ') || 'Không có nút Sau trong bảng này.' };
    const button = candidates[0];
    if (button.disabled || button.getAttribute('aria-disabled') === 'true') return { advanced: false, reason: 'Đã ở trang cuối hoặc bảng đang tải.' };
    const fingerprint = () => JSON.stringify({
      page: cleanText(panel).match(/Trang\s*(\d+)\s*\/\s*\d+/i)?.[1] || null,
      codes: rowElements(panel, config, []).map(row => codesOf(row, config))
    });
    const before = fingerprint(), r = button.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    if (!hit || !(button === hit || button.contains(hit))) return { advanced: false, reason: 'Nút Sau đang bị cửa sổ khác che khuất.' };
    button.click();
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 80));
      if (panel.isConnected && fingerprint() !== before) return { advanced: true, reason: 'Đã chuyển trang danh sách.' };
    }
    return { advanced: false, reason: 'Chưa xác nhận danh sách chuyển trang; đã dừng.' };
  }
  function pickSelector() {
    if (state.picker) state.picker();
    return new Promise(resolve => {
      const previousCursor = document.documentElement.style.cursor;
      document.documentElement.style.cursor = 'crosshair';
      const finish = value => {
        document.documentElement.style.cursor = previousCursor;
        window.removeEventListener('pointerdown', pick, true);
        window.removeEventListener('click', suppress, true);
        window.removeEventListener('keydown', escape, true);
        state.picker = null;
        resolve(value);
      };
      const suppress = event => {
        if (event.target.closest?.('#ping-location-root')) return;
        event.preventDefault(); event.stopImmediatePropagation();
      };
      const pick = event => {
        if (event.target.closest?.('#ping-location-root')) return;
        event.preventDefault(); event.stopImmediatePropagation();
        const selected = selectorFor(event.target);
        // Swallow the click following pointerdown before removing the listener.
        window.removeEventListener('pointerdown', pick, true);
        setTimeout(() => finish(selected), 250);
      };
      const escape = event => { if (event.key === 'Escape') { event.preventDefault(); finish(null); } };
      state.picker = () => finish(null);
      window.addEventListener('pointerdown', pick, true);
      window.addEventListener('click', suppress, true);
      window.addEventListener('keydown', escape, true);
    });
  }
  window.PingAdapter = Object.freeze({ inspect, inspectMap, readLabels, arm, verify, nextPage, pickSelector, getView: () => bridge('inspect'), project: (ath, atv) => bridge('project', { ath, atv }), unproject: (x, y) => bridge('unproject', { x, y }) });
})();
