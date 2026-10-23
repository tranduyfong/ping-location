(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PingCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DASHES = /[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g;
  const CODE = /^(\p{L}[\p{L}0-9.]*)-([0-9]+)$/u;
  const READY_SOURCES = new Set(['dom', 'ocr', 'import', 'manual']);

  function normalizedText(value) {
    return typeof value === 'string' ? value.normalize('NFKC').replace(DASHES, '-').toUpperCase() : '';
  }

  function normalizeCode(value) {
    const code = normalizedText(value).replace(/\s+/g, '');
    return CODE.test(code) ? code : '';
  }

  function extractCodes(text) {
    const value = normalizedText(text);
    const result = [];
    const seen = new Set();
    const pattern = /(^|[^\p{L}\p{M}\p{N}._-])(\p{L}[\p{L}0-9.]*\s*-\s*[0-9]+)(?![\p{L}\p{M}\p{N}._-])/gu;
    let match;
    while ((match = pattern.exec(value))) {
      const code = normalizeCode(match[2]);
      if (code && !seen.has(code)) {
        seen.add(code);
        result.push(code);
      }
    }
    return result;
  }

  function finite(value) { return typeof value === 'number' && Number.isFinite(value); }

  function reviewOcrCodes(detections, rowCodes) {
    const prefixes = [...new Set((rowCodes || []).map(row => normalizeCode(typeof row === 'string' ? row : row.code))
      .filter(Boolean).map(code => code.slice(0, code.lastIndexOf('-'))))];
    function distance(a, b) {
      a = [...a]; b = [...b];
      let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
      for (let i = 0; i < a.length; i++) {
        const next = [i + 1];
        for (let j = 0; j < b.length; j++) next.push(Math.min(next[j] + 1, previous[j + 1] + 1, previous[j] + (a[i] === b[j] ? 0 : 1)));
        previous = next;
      }
      return previous[b.length];
    }
    return detections.map(detection => {
      const code = normalizeCode(detection.originalCode || detection.code);
      if (!code || !prefixes.length || detection.source !== 'ocr') return { ...detection };
      const cut = code.lastIndexOf('-'), prefix = code.slice(0, cut);
      if (prefixes.includes(prefix)) return { ...detection, code };
      const candidates = prefixes.filter(known => distance(prefix, known) === 1);
      if (candidates.length !== 1) return { ...detection, requiresReview: true, reviewReason: 'Tiền tố OCR chưa khớp danh sách căn.' };
      return { ...detection, code: candidates[0] + code.slice(cut), originalCode: detection.originalCode || code,
        requiresReview: true, reviewReason: 'Gợi ý tiền tố từ danh sách; cần đối chiếu mã trên bản đồ.' };
    });
  }
  function validRect(rect) {
    return rect && finite(rect.x) && finite(rect.y) && finite(rect.width) && finite(rect.height) && rect.width > 0 && rect.height > 0;
  }
  function inRect(point, rect, margin) {
    return point.x >= rect.x - margin && point.x <= rect.x + rect.width + margin &&
      point.y >= rect.y - margin && point.y <= rect.y + rect.height + margin;
  }
  function insideRect(point, rect, margin) {
    return point.x >= rect.x + margin && point.x < rect.x + rect.width - margin &&
      point.y >= rect.y + margin && point.y < rect.y + rect.height - margin;
  }

  function checkOptions(options) {
    if (options.minConfidence !== undefined && (!finite(options.minConfidence) || options.minConfidence < 0 || options.minConfidence > 1)) return 'Ngưỡng tin cậy không hợp lệ.';
    if (options.margin !== undefined && (!finite(options.margin) || options.margin < 0)) return 'Lề an toàn không hợp lệ.';
    if (options.width !== undefined && (!finite(options.width) || options.width <= 0)) return 'Chiều rộng khung nhìn không hợp lệ.';
    if (options.height !== undefined && (!finite(options.height) || options.height <= 0)) return 'Chiều cao khung nhìn không hợp lệ.';
    if (options.mapRect !== undefined && !validRect(options.mapRect)) return 'Vùng bản đồ không hợp lệ.';
    if (options.excludedRects !== undefined && (!Array.isArray(options.excludedRects) || options.excludedRects.some(rect => !validRect(rect)))) return 'Vùng giao diện cần tránh không hợp lệ.';
    return '';
  }

  function checkPoint(point, options) {
    const margin = options.margin === undefined ? 4 : options.margin;
    if (!finite(point.x) || !finite(point.y)) return 'Tọa độ không hợp lệ.';
    if (!finite(point.confidence) || point.confidence < 0 || point.confidence > 1) return 'Độ tin cậy không hợp lệ.';
    if (typeof point.source !== 'string' || !point.source.trim()) return 'Thiếu nguồn xác định tọa độ.';
    if (point.x < margin || point.y < margin ||
      (options.width !== undefined && point.x >= options.width - margin) ||
      (options.height !== undefined && point.y >= options.height - margin)) return 'Điểm nằm ngoài khung nhìn hoặc quá sát mép.';
    if (options.mapRect && !insideRect(point, options.mapRect, margin)) return 'Điểm nằm ngoài vùng bản đồ hoặc quá sát mép.';
    if ((options.excludedRects || []).some(rect => inRect(point, rect, margin))) return 'Điểm trùng vùng bảng điều khiển hoặc giao diện cần tránh.';
    return '';
  }

  function deduplicate(points) {
    const sorted = points.slice().sort((a, b) => b.confidence - a.confidence);
    const unique = [];
    for (const point of sorted) {
      if (!unique.some(other => Math.hypot(point.x - other.x, point.y - other.y) <= 10)) unique.push(point);
    }
    return unique;
  }

  function buildPlan(rows, detections, options) {
    options = options || {};
    const list = Array.isArray(rows) ? rows : [];
    const rowCodes = list.map(row => normalizeCode(typeof row === 'string' ? row : row && row.code));
    const counts = new Map();
    for (const code of rowCodes) if (code) counts.set(code, (counts.get(code) || 0) + 1);
    const observations = new Map();
    for (const detection of Array.isArray(detections) ? detections : []) {
      if (!detection || typeof detection !== 'object') continue;
      const code = normalizeCode(detection.code);
      if (!code) continue;
      const point = { code, x: detection.x, y: detection.y, confidence: detection.confidence,
        source: detection.source, requiresReview: detection.requiresReview === true,
        originalCode: detection.originalCode, reviewReason: detection.reviewReason, raw: detection.raw };
      if (!observations.has(code)) observations.set(code, []);
      observations.get(code).push(point);
    }
    const configurationError = checkOptions(options);
    const threshold = options.minConfidence === undefined ? 0.85 : options.minConfidence;
    return list.map((row, rowIndex) => {
      const raw = typeof row === 'string' ? row : row && row.code;
      const code = rowCodes[rowIndex];
      const result = { code: code || String(raw || ''), status: 'review', target: null, reason: '', rowIndex };
      if (!code) { result.reason = 'Mã căn không hợp lệ; cần đầy đủ tiền tố và số.'; return result; }
      if (counts.get(code) > 1) { result.reason = 'Mã căn xuất hiện nhiều lần trong danh sách chờ gắn.'; return result; }
      if (configurationError) { result.reason = configurationError; return result; }
      const matches = observations.get(code) || [];
      if (!matches.length) { result.status = 'missing'; result.reason = 'Chưa tìm thấy đúng mã căn.'; return result; }
      // Invalid observations never provide a usable target. All spatial duplicates
      // must be considered before bounds filtering, so an obscured duplicate cannot
      // silently turn an ambiguous code into an automatic click.
      const usable = matches.filter(point => finite(point.x) && finite(point.y) && finite(point.confidence) && point.confidence >= 0 && point.confidence <= 1);
      const distinct = deduplicate(usable);
      if (distinct.length > 1) { result.status = 'ambiguous'; result.reason = 'Có nhiều vị trí khác nhau mang cùng mã căn.'; return result; }
      if (!distinct.length) { result.reason = 'Tọa độ hoặc độ tin cậy không hợp lệ.'; return result; }
      const target = distinct[0];
      const pointError = checkPoint(target, options);
      if (pointError) { result.reason = pointError; return result; }
      result.target = target;
      if (!READY_SOURCES.has(target.source)) { result.reason = target.source === 'sequence' ? 'Điểm suy ra theo dãy cần được kiểm tra và xác nhận thủ công.' : 'Nguồn tọa độ chưa được hỗ trợ để tự gắn.'; return result; }
      if (target.source !== 'manual' && target.requiresReview) { result.reason = (target.originalCode ? `OCR đọc ${target.originalCode}. ` : '') + (target.reviewReason || 'Điểm này cần được kiểm tra và xác nhận thủ công.'); return result; }
      if (target.confidence < threshold) { result.reason = 'Độ tin cậy thấp hơn ngưỡng tự gắn.'; return result; }
      result.status = 'ready';
      result.reason = 'Khớp chính xác mã căn và tọa độ hợp lệ.';
      return result;
    });
  }

  function gcd(a, b) { while (b) { const next = a % b; a = b; b = next; } return a; }

  function interpolateSequence(anchors, options) {
    options = options || {};
    if (!Array.isArray(anchors) || anchors.length < 3) throw new Error('Cần ít nhất 3 điểm mốc để kiểm tra hướng và khoảng cách của dãy.');
    const points = anchors.map(anchor => {
      const code = normalizeCode(anchor && anchor.code);
      const parts = CODE.exec(code);
      const number = parts && Number(parts[2]);
      if (!parts || !Number.isSafeInteger(number) || !finite(anchor.x) || !finite(anchor.y)) throw new Error('Điểm mốc có mã căn hoặc tọa độ không hợp lệ.');
      return { code, prefix: parts[1], digits: parts[2], number, x: anchor.x, y: anchor.y };
    }).sort((a, b) => a.number - b.number);
    const prefix = points[0].prefix;
    if (points.some(point => point.prefix !== prefix)) throw new Error('Các điểm mốc phải có cùng tiền tố chính xác.');
    if (points.some((point, i) => i && point.number === points[i - 1].number)) throw new Error('Mỗi điểm mốc phải có số căn khác nhau.');
    const padded = points.some(point => point.digits.length > 1 && point.digits[0] === '0');
    const digitWidth = padded ? points[0].digits.length : 0;
    if (padded && points.some(point => point.digits.length !== digitWidth)) throw new Error('Số chữ số và cách thêm số 0 của các mã căn phải nhất quán.');
    let inferredStep = points[1].number - points[0].number;
    for (let i = 2; i < points.length; i++) inferredStep = gcd(inferredStep, points[i].number - points[i - 1].number);
    const step = options.step === undefined ? inferredStep : Number(options.step);
    if (!Number.isSafeInteger(step) || step <= 0) throw new Error('Bước nhảy phải là số nguyên dương.');
    const first = points[0].number;
    const last = points[points.length - 1].number;
    if (points.some(point => (point.number - first) % step !== 0)) throw new Error('Các mã mốc không cùng dãy số theo bước nhảy đã chọn.');
    function endpoint(value, fallback) {
      if (value === undefined || value === '') return fallback;
      const code = typeof value === 'string' ? normalizeCode(value) : '';
      if (code) {
        const parts = CODE.exec(code);
        if (parts[1] !== prefix || parts[2] !== String(Number(parts[2])).padStart(digitWidth, '0')) throw new Error('Mã bắt đầu/kết thúc phải cùng tiền tố và định dạng số với điểm mốc.');
        return Number(parts[2]);
      }
      if (typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value.trim()))) return Number(value);
      throw new Error('Số căn bắt đầu/kết thúc không hợp lệ.');
    }
    const start = endpoint(options.start, first);
    const end = endpoint(options.end, last);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < first || end > last || end < start) throw new Error('Chỉ được nội suy trong khoảng giữa các điểm mốc, không kéo dài ra ngoài.');
    if ((start - first) % step || (end - first) % step) throw new Error('Mã bắt đầu/kết thúc không khớp bước nhảy của dãy.');
    if ((end - start) / step > 10000) throw new Error('Dãy quá dài; hãy chia thành các đoạn nhỏ.');
    const count = points.length;
    const meanN = points.reduce((sum, point) => sum + (point.number - first), 0) / count;
    const meanX = points.reduce((sum, point) => sum + point.x, 0) / count;
    const meanY = points.reduce((sum, point) => sum + point.y, 0) / count;
    let denominator = 0, numeratorX = 0, numeratorY = 0;
    for (const point of points) {
      const delta = point.number - first - meanN;
      denominator += delta * delta;
      numeratorX += delta * (point.x - meanX);
      numeratorY += delta * (point.y - meanY);
    }
    const slopeX = numeratorX / denominator, slopeY = numeratorY / denominator;
    if (!finite(slopeX) || !finite(slopeY) || !finite(meanX) || !finite(meanY)) throw new Error('Tọa độ điểm mốc nằm ngoài khoảng tính toán hợp lệ.');
    const fitted = number => ({ x: meanX + (number - first - meanN) * slopeX, y: meanY + (number - first - meanN) * slopeY });
    const tolerance = options.maxResidual === undefined ? 6 : options.maxResidual;
    if (!finite(tolerance) || tolerance < 0) throw new Error('Sai số cho phép không hợp lệ.');
    if (Math.hypot(slopeX * (last - first), slopeY * (last - first)) < 1) throw new Error('Các điểm mốc trùng nhau hoặc nằm quá gần nhau.');
    if (points.some(point => { const fit = fitted(point.number); return Math.hypot(point.x - fit.x, point.y - fit.y) > tolerance; })) throw new Error('Dãy bị cong hoặc khoảng cách không đều; cần chia thành đoạn khác.');
    const result = [];
    for (let number = start; number <= end; number += step) {
      result.push({ code: prefix + '-' + String(number).padStart(digitWidth, '0'), ...fitted(number), confidence: 0.65, source: 'sequence', requiresReview: true });
    }
    return result;
  }

  function escapeCsvCell(value) {
    const text = value === undefined || value === null ? '' : String(value);
    return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
  }
  function toCsv(rows) { return rows.map(row => row.map(escapeCsvCell).join(',')).join('\r\n'); }
  function parseCsv(text) {
    if (typeof text !== 'string') throw new Error('Nội dung CSV phải là chuỗi.');
    text = text.replace(/^\uFEFF/, '');
    const rows = []; let row = [], field = '', quoted = false, endedQuote = false;
    for (let i = 0; i < text.length; i++) {
      const character = text[i];
      if (quoted) {
        if (character === '"' && text[i + 1] === '"') { field += '"'; i++; }
        else if (character === '"') { quoted = false; endedQuote = true; }
        else field += character;
      } else if (character === '"') {
        if (field || endedQuote) throw new Error('Dấu nháy CSV không hợp lệ.');
        quoted = true;
      } else if (character === ',') { row.push(field); field = ''; endedQuote = false; }
      else if (character === '\n' || character === '\r') {
        if (character === '\r' && text[i + 1] === '\n') i++;
        row.push(field); rows.push(row); row = []; field = ''; endedQuote = false;
      } else {
        if (endedQuote && !/\s/.test(character)) throw new Error('Có ký tự thừa sau dấu nháy CSV.');
        if (!endedQuote) field += character;
      }
    }
    if (quoted) throw new Error('CSV có trường chưa đóng dấu nháy.');
    if (field || row.length || endedQuote) { row.push(field); rows.push(row); }
    return rows.filter(values => values.some(value => value.trim() !== ''));
  }
  function numericValue(value) {
    if (finite(value)) return value;
    if (typeof value === 'string' && value.trim() && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())) {
      const number = Number(value);
      if (finite(number)) return number;
    }
    return NaN;
  }
  function validateCoordinateRecords(records, options) {
    options = options || {};
    const detections = [], errors = [];
    if (!Array.isArray(records)) return { detections, errors: ['Dữ liệu phải là một danh sách tọa độ.'] };
    const optionError = checkOptions(options);
    if (optionError) return { detections, errors: [optionError] };
    records.forEach((record, index) => {
      const code = normalizeCode(record && record.code);
      if (!code) { errors.push('Dòng ' + (index + 1) + ': mã căn không hợp lệ.'); return; }
      const confidence = record.confidence === undefined || record.confidence === '' ? 1 : numericValue(record.confidence);
      const point = { code, x: numericValue(record.x), y: numericValue(record.y), confidence, source: 'import', requiresReview: false };
      const error = checkPoint(point, { ...options, margin: options.margin === undefined ? 0 : options.margin });
      if (error) errors.push('Dòng ' + (index + 1) + ' (' + code + '): ' + error);
      else detections.push(point);
    });
    return { detections, errors };
  }
  function parseCoordinateFile(text, filenameOrFormat, options) {
    try {
      if (typeof text !== 'string' || !text.trim()) throw new Error('Tệp tọa độ trống.');
      const format = String(filenameOrFormat || '').toLowerCase();
      const json = format === 'json' || format.endsWith('.json') || (!format.endsWith('.csv') && /^[\s\uFEFF]*[\[{]/.test(text));
      let records;
      if (json) {
        const parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
        records = Array.isArray(parsed) ? parsed : parsed && (parsed.detections || parsed.points || parsed.records || (parsed.code ? [parsed] : undefined));
      } else {
        const rows = parseCsv(text);
        if (!rows.length) throw new Error('Tệp CSV trống.');
        const headers = rows.shift().map(value => value.trim().toLowerCase());
        if (new Set(headers).size !== headers.length) throw new Error('CSV có cột trùng tên.');
        if (['code', 'x', 'y'].some(header => !headers.includes(header))) throw new Error('CSV cần có các cột code,x,y; confidence là tùy chọn.');
        records = rows.map((values, index) => {
          if (values.length !== headers.length) throw new Error('Dòng CSV ' + (index + 2) + ' có số cột không hợp lệ.');
          const record = Object.create(null);
          headers.forEach((header, column) => { record[header] = values[column]; });
          return record;
        });
      }
      return validateCoordinateRecords(records, options);
    } catch (error) { return { detections: [], errors: [error.message || 'Không đọc được tệp tọa độ.'] }; }
  }
  function coordinatesToCsv(records) {
    return toCsv([['code', 'x', 'y', 'confidence'], ...(records || []).map(record => [record.code, record.x, record.y, record.confidence])]);
  }
  function exportPlanCsv(plan) {
    return toCsv([['code', 'status', 'x', 'y', 'confidence', 'source', 'reason'], ...(plan || []).map(item => [item.code, item.status,
      item.target && item.target.x, item.target && item.target.y, item.target && item.target.confidence, item.target && item.target.source, item.reason])]);
  }

  return Object.freeze({ normalizeCode, extractCodes, reviewOcrCodes, buildPlan, interpolateSequence, parseCoordinateFile,
    validateCoordinateRecords, coordinatesToCsv, exportPlanCsv, escapeCsvCell, toCsv, parseCsv });
});
