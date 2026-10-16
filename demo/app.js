(() => {
  'use strict';
  const canvas = document.getElementById('demo-map');
  const ctx = canvas.getContext('2d');
  const panel = document.querySelector('[data-ping-panel]');
  const list = document.getElementById('hotspot-list');
  const groups = [
    { x: 165, y: 305, angle: -22, prefix: 'VN48-', start: 101, step: 1, color: '#c3bee4', size: 6 },
    { x: 1000, y: 125, angle: 67, prefix: 'VX-', start: 2, step: 2, color: '#e9df86', size: 6, columns: 2 },
    { x: 165, y: 800, angle: -22, prefix: 'ASP-', start: 233, step: 2, color: '#e7adc1', size: 6 },
    { x: 1000, y: 605, angle: 67, prefix: 'VNB.TP.1-', start: 345, step: 2, color: '#b6d5bd', size: 6, columns: 2 }
  ];
  const plots = [];
  let id = 0;
  for (const group of groups) {
    const a = group.angle * Math.PI / 180;
    const transform = (x, y) => ({ x: group.x + Math.cos(a) * x - Math.sin(a) * y, y: group.y + Math.sin(a) * x + Math.cos(a) * y });
    for (let n = 0; n < group.size; n++) {
      const localX = (n % (group.columns || 3)) * 148;
      const localY = Math.floor(n / (group.columns || 3)) * 116;
      const width = 145, height = 112;
      const polygon = n === 0 ? [[12, 0], [width, 0], [width, height], [0, height], [0, 16]] : [[0, 0], [width, 0], [width, height], [0, height]];
      const num = group.start + n * group.step;
      plots.push({ id: ++id, code: group.prefix + (group.prefix === 'VX-' ? String(num).padStart(2, '0') : num), color: group.color, angle: a,
        polygon: polygon.map(([x, y]) => transform(localX + x, localY + y)), center: transform(localX + width / 2, localY + height / 2), area: 230 + n * 3.8,
        assigned: false });
    }
  }
  // Intentionally unordered rows: automation must match text, not row position.
  const ordering = [3, 6, 14, 18, 1, 8, 12, 20, 5, 11, 16, 22, 0, 9, 15, 23, 2, 7, 13, 19, 4, 10, 17, 21];
  const state = { armed: null, tab: 'pending', page: 0, search: '', zoom: 1, panX: 0, panY: 0, pageSize: 5, dragging: null };
  const width = () => canvas.clientWidth;
  const height = () => canvas.clientHeight;
  const toWorld = (x, y) => ({ x: (x - state.panX) / state.zoom, y: (y - state.panY) / state.zoom });
  function path(points) { ctx.beginPath(); points.forEach((point, index) => index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y)); ctx.closePath(); }
  function draw() {
    const dpr = devicePixelRatio || 1;
    if (canvas.width !== Math.round(width() * dpr) || canvas.height !== Math.round(height() * dpr)) { canvas.width = Math.round(width() * dpr); canvas.height = Math.round(height() * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width(), height());
    ctx.fillStyle = '#eff0e5'; ctx.fillRect(0, 0, width(), height());
    ctx.translate(state.panX, state.panY); ctx.scale(state.zoom, state.zoom);
    // Park, water and roads make color alone insufficient to identify a plot.
    ctx.fillStyle = '#d9e6cb'; ctx.beginPath(); ctx.ellipse(150, 150, 280, 115, -.3, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#b4d9df'; ctx.beginPath(); ctx.ellipse(1120, 480, 130, 540, -.35, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#fdfbf3'; ctx.lineWidth = 44; ctx.beginPath(); ctx.moveTo(20, 590); ctx.lineTo(1190, 120); ctx.moveTo(575, 120); ctx.lineTo(880, 900); ctx.stroke();
    ctx.strokeStyle = '#c7cbb9'; ctx.lineWidth = 1; ctx.setLineDash([7, 9]); ctx.beginPath(); ctx.moveTo(20, 590); ctx.lineTo(1190, 120); ctx.moveTo(575, 120); ctx.lineTo(880, 900); ctx.stroke(); ctx.setLineDash([]);
    ctx.save(); ctx.translate(340, 458); ctx.rotate(-.38); ctx.font = '14px Segoe UI,Arial,sans-serif'; ctx.fillStyle = '#9ba792'; ctx.fillText('ĐƯỜNG VỊNH NGỌC · 21 m', 0, 0); ctx.restore();
    ctx.save(); ctx.translate(575, 180); ctx.rotate(1.2); ctx.font = '13px Segoe UI,Arial,sans-serif'; ctx.fillStyle = '#9ba792'; ctx.fillText('ĐẠI LỘ XANH · 43 m', 0, 0); ctx.restore();
    for (const plot of plots) {
      path(plot.polygon); ctx.fillStyle = plot.assigned ? '#94bc9e' : plot.color; ctx.fill();
      ctx.strokeStyle = plot.assigned ? '#4d8e63' : '#84938d'; ctx.lineWidth = plot.assigned ? 3 : 1.25; ctx.stroke();
      if (state.armed === plot.code) { path(plot.polygon); ctx.strokeStyle = '#876e39'; ctx.lineWidth = 3; ctx.stroke(); }
      ctx.save(); ctx.translate(plot.center.x, plot.center.y); ctx.rotate(plot.angle);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#344178';
      ctx.font = `600 ${plot.code.length > 11 ? 15 : 19}px Arial,sans-serif`; ctx.fillText(plot.code, 0, -9);
      ctx.font = '12px Arial,sans-serif'; ctx.fillStyle = '#4c5b69'; ctx.fillText(`${plot.area.toFixed(1)} m²`, 0, 15);
      if (plot.assigned) { ctx.fillStyle = '#477653'; ctx.font = '10px Arial,sans-serif'; ctx.fillText('ĐÃ GẮN', 0, 36); }
      ctx.restore();
    }
  }
  function fit() {
    state.zoom = Math.min((width() - 60) / 1240, (height() - 130) / 1070);
    state.panX = (width() - 1240 * state.zoom) / 2;
    state.panY = 90 + (height() - 130 - 1070 * state.zoom) / 2;
    draw();
  }
  function toast(text, code, error = false) {
    const target = document.getElementById('success-message');
    target.hidden = false; target.textContent = text; target.classList.toggle('error', error);
    target.dataset.code = code || ''; target.dataset.eventId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    if (error) target.removeAttribute('data-ping-success'); else target.setAttribute('data-ping-success', '');
    clearTimeout(toast.timer); toast.timer = setTimeout(() => { target.hidden = true; }, 6000);
  }
  function filtered() { return ordering.map(index => plots[index]).filter(plot => plot.assigned === (state.tab === 'assigned') && plot.code.toLowerCase().includes(state.search.toLowerCase())); }
  function renderList() {
    const pending = plots.filter(plot => !plot.assigned).length;
    panel.dataset.pendingTotal = String(pending);
    document.getElementById('pending-badge').textContent = pending;
    document.getElementById('assigned-badge').textContent = plots.length - pending;
    for (const tab of ['pending', 'assigned']) {
      const target = document.getElementById(`${tab}-tab`);
      target.setAttribute('aria-selected', String(state.tab === tab)); target.dataset.active = String(state.tab === tab);
    }
    const all = filtered(), pages = Math.max(1, Math.ceil(all.length / state.pageSize));
    state.page = Math.min(state.page, pages - 1);
    list.replaceChildren();
    for (const plot of all.slice(state.page * state.pageSize, (state.page + 1) * state.pageSize)) {
      const row = document.createElement('div'); row.className = 'hotspot-row'; row.dataset.pingRow = ''; row.dataset.code = plot.code;
      row.dataset.status = plot.assigned ? 'attached' : 'pending'; row.dataset.armed = String(state.armed === plot.code);
      const info = document.createElement('div');
      const code = document.createElement('div'); code.className = 'unit-code'; code.dataset.pingCode = plot.code; code.textContent = plot.code;
      const meta = document.createElement('p'); meta.className = 'unit-meta';
      const stock = document.createElement('span'); stock.className = 'stock'; stock.textContent = 'Còn hàng';
      meta.append(stock, document.createTextNode(`  ·  ${plot.area.toFixed(1)} m²`)); info.append(code, meta); row.append(info);
      if (plot.assigned) { const label = document.createElement('span'); label.className = 'attached-label'; label.textContent = '✓ Đã gắn'; row.append(label); }
      else {
        const button = document.createElement('button'); button.className = 'attach-button'; button.dataset.pingAttach = ''; button.textContent = 'Gắn';
        button.addEventListener('click', () => { state.armed = plot.code; canvas.classList.add('armed'); document.getElementById('map-hint').textContent = `Đang gắn ${plot.code} · Bấm đúng căn trên bản đồ`; renderList(); draw(); });
        row.append(button);
      }
      list.append(row);
    }
    if (!all.length) { const empty = document.createElement('p'); empty.className = 'empty-list'; empty.textContent = state.search ? 'Không có mã căn phù hợp.' : state.tab === 'pending' ? 'Tất cả căn đã được gắn.' : 'Chưa có căn được gắn.'; list.append(empty); }
    document.getElementById('page-info').textContent = `Trang ${state.page + 1}/${pages} · ${all.length} căn`;
    document.getElementById('prev-page').disabled = state.page === 0;
    document.getElementById('next-page').disabled = state.page >= pages - 1;
  }
  function inside(point, polygon) {
    let result = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const a = polygon[i], b = polygon[j];
      if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) result = !result;
    }
    return result;
  }
  canvas.addEventListener('pointerdown', event => { if (event.button !== 0) return; state.dragging = { x: event.clientX, y: event.clientY, panX: state.panX, panY: state.panY, moved: false }; canvas.setPointerCapture(event.pointerId); });
  canvas.addEventListener('pointermove', event => {
    if (!state.dragging) return;
    const dx = event.clientX - state.dragging.x, dy = event.clientY - state.dragging.y;
    if (Math.hypot(dx, dy) > 4) state.dragging.moved = true;
    if (state.dragging.moved) { state.panX = state.dragging.panX + dx; state.panY = state.dragging.panY + dy; draw(); }
  });
  canvas.addEventListener('pointerup', event => {
    const drag = state.dragging; state.dragging = null;
    if (!drag || drag.moved || !state.armed) return;
    const r = canvas.getBoundingClientRect(); const point = toWorld(event.clientX - r.x, event.clientY - r.y);
    const hit = plots.find(plot => inside(point, plot.polygon));
    if (!hit || hit.code !== state.armed) { toast(`Chưa đúng vị trí ${state.armed}. Hãy thử lại.`, null, true); return; }
    hit.assigned = true; state.armed = null; canvas.classList.remove('armed');
    document.getElementById('map-hint').textContent = 'Cuộn để phóng to · Kéo để di chuyển bản đồ';
    toast(`Đã gắn thành công ${hit.code}`, hit.code); renderList(); draw();
  });
  canvas.addEventListener('pointercancel', () => { state.dragging = null; });
  function zoom(multiplier, x = width() / 2, y = height() / 2) {
    const world = toWorld(x, y); state.zoom = Math.max(.25, Math.min(4, state.zoom * multiplier));
    state.panX = x - world.x * state.zoom; state.panY = y - world.y * state.zoom; draw();
  }
  canvas.addEventListener('wheel', event => { event.preventDefault(); const r = canvas.getBoundingClientRect(); zoom(event.deltaY < 0 ? 1.12 : 1 / 1.12, event.clientX - r.x, event.clientY - r.y); }, { passive: false });
  document.getElementById('zoom-in').addEventListener('click', () => zoom(1.25));
  document.getElementById('zoom-out').addEventListener('click', () => zoom(.8));
  document.getElementById('fit-map').addEventListener('click', fit);
  document.getElementById('search-code').addEventListener('input', event => { state.search = event.target.value; state.page = 0; renderList(); });
  for (const tab of ['pending', 'assigned']) document.getElementById(`${tab}-tab`).addEventListener('click', () => { state.tab = tab; state.page = 0; renderList(); });
  document.getElementById('prev-page').addEventListener('click', () => { state.page--; renderList(); });
  document.getElementById('next-page').addEventListener('click', () => { state.page++; renderList(); });
  document.getElementById('reset-demo').addEventListener('click', () => { plots.forEach(plot => { plot.assigned = false; }); Object.assign(state, { armed: null, page: 0, tab: 'pending', search: '' }); document.getElementById('search-code').value = ''; document.getElementById('success-message').hidden = true; canvas.classList.remove('armed'); renderList(); fit(); });
  window.addEventListener('keydown', event => { if (event.key === 'Escape') { state.armed = null; canvas.classList.remove('armed'); renderList(); draw(); } });
  new ResizeObserver(fit).observe(canvas);
  renderList(); fit();
  // Read-only ground truth for automated local smoke tests; absent on the real website.
  window.__pingDemo = Object.freeze({ centers: () => plots.map(plot => ({ code: plot.code, assigned: plot.assigned, x: canvas.getBoundingClientRect().x + state.panX + plot.center.x * state.zoom, y: canvas.getBoundingClientRect().y + state.panY + plot.center.y * state.zoom })), pending: () => plots.filter(plot => !plot.assigned).length });
})();
