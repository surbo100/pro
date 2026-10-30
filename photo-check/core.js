(function (root) {
  'use strict';
  const api = {};
  const labels = {
    match: '식별자 일치',
    not_found: '목록에서 미발견',
    review: '판정 보류',
    error: '검사 오류',
  };

  // Ordinary Google Photos dedup keys can represent an upload's SHA-1.
  // This is NOT a checksum of the currently downloadable cloud file.
  function normalizeKey(value) {
    if (typeof value !== 'string') return null;
    const key = value.trim().replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    if (!/^[A-Za-z0-9_-]{27}$/.test(key)) return null;
    // SHA-1 is 20 bytes; its Base64 encoding has two zero padding bits.
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    return alphabet.indexOf(key[26]) % 4 === 0 ? key : null;
  }

  function keyFromBytes(bytes) {
    let text = '';
    for (const byte of bytes) text += String.fromCharCode(byte);
    return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function parseCsv(text) {
    const rows = [];
    let row = [], field = '', quoted = false, closed = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quoted) {
        if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
        else if (ch === '"') { quoted = false; closed = true; }
        else field += ch;
      } else if (ch === '"' && !field && !closed) quoted = true;
      else if (ch === ',' || ch === '\n' || ch === '\r') {
        row.push(field); field = ''; closed = false;
        if (ch !== ',') {
          if (ch === '\r' && text[i + 1] === '\n') i++;
          if (row.some(value => value !== '')) rows.push(row);
          row = [];
        }
      } else {
        if (closed || ch === '"') throw new Error('CSV 따옴표 형식이 올바르지 않습니다.');
        field += ch;
      }
    }
    if (quoted) throw new Error('CSV 파일이 중간에 잘렸습니다.');
    row.push(field);
    if (row.some(value => value !== '')) rows.push(row);
    return rows;
  }

  const bool = value => value === true || value === 'true' ? true : value === false || value === 'false' ? false : null;

  function parseInventory(text) {
    text = text.replace(/^\uFEFF/, '').trim();
    let inventory;
    if (text.startsWith('{')) {
      inventory = JSON.parse(text);
      if (inventory.schema !== 'photo-check-inventory-v1' || !Array.isArray(inventory.items)) {
        throw new Error('지원하지 않는 목록 JSON입니다. 제공된 내보내기 도구를 사용하세요.');
      }
    } else {
      const rows = parseCsv(text);
      const headers = rows.shift() || [];
      if (!headers.includes('dedupKey') || !headers.includes('mediaKey')) {
        throw new Error('CSV에 dedupKey와 mediaKey 열이 필요합니다.');
      }
      if (new Set(headers).size !== headers.length) throw new Error('CSV 열 이름이 중복되었습니다.');
      inventory = {
        source: 'Google Photos Toolkit CSV', complete: false, account: null, exportedAt: null,
        items: rows.map(row => {
          if (row.length !== headers.length) throw new Error('CSV 열 수가 일치하지 않습니다.');
          return Object.fromEntries(headers.map((key, i) => [key, row[i]]));
        }),
        errors: ['CSV에는 전체 조회 완료 여부와 조회 시각을 보증하는 정보가 없습니다.'],
      };
    }
    if (inventory.items.some(item => !item || typeof item !== 'object' || Array.isArray(item))) {
      throw new Error('사진 목록 항목의 형식이 올바르지 않습니다.');
    }
    const items = inventory.items.map(item => ({
      ...item,
      normalizedKey: normalizeKey(item.dedupKey),
      isOriginalQuality: bool(item.isOriginalQuality),
      isPartialUpload: bool(item.isPartialUpload),
      isOwned: bool(item.isOwned),
      inTrash: bool(item.inTrash),
    }));
    const valid = items.filter(item => item.normalizedKey && typeof item.mediaKey === 'string' && item.mediaKey);
    const invalidCount = items.length - valid.length;
    const errors = Array.isArray(inventory.errors) ? inventory.errors : [];
    const index = new Map();
    for (const item of valid) {
      if (!index.has(item.normalizedKey)) index.set(item.normalizedKey, []);
      index.get(item.normalizedKey).push(item);
    }
    const account = typeof inventory.account === 'string' ? inventory.account : '';
    const exportedAt = typeof inventory.exportedAt === 'string' ? inventory.exportedAt : '';
    return {
      index, items, invalidCount, account, exportedAt, errors,
      source: inventory.source || 'Google Photos 메타데이터',
      complete: inventory.complete === true && Array.isArray(inventory.errors) && errors.length === 0 && invalidCount === 0 &&
        account.trim().length > 0 && Number.isFinite(Date.parse(exportedAt)) &&
        inventory.scope === 'library-and-archive',
    };
  }

  function compareFile(file, hash, inventory) {
    const key = normalizeKey(hash);
    if (!key) throw new Error('로컬 해시 형식이 올바르지 않습니다.');
    const matches = inventory.index.get(key) || [];
    const eligible = matches.filter(item => item.isPartialUpload !== true && item.inTrash !== true && item.isOwned !== false);
    let status, detail;
    if (eligible.length) {
      status = 'match';
      const original = eligible.find(item => item.isOriginalQuality === true);
      if (original) detail = '같은 식별자와 원본 화질 표시를 찾았습니다. 현재 클라우드 파일의 바이트 검증 결과는 아닙니다.';
      else if (eligible.every(item => item.isOriginalQuality === false)) detail = '식별자는 일치하지만 저장용량 절약 화질로 표시됩니다. 원본 보존을 확인하세요.';
      else detail = '같은 식별자를 찾았습니다. 백업 화질은 이 목록에서 확인할 수 없습니다.';
    } else if (matches.length) {
      status = 'review'; detail = '일치 후보가 업로드 진행 중·휴지통·다른 소유자의 항목으로 표시됩니다.';
    } else if (inventory.complete) {
      status = 'not_found'; detail = '이 목록의 조회 시점과 범위에서 일치 항목을 찾지 못했습니다. 미백업 확정은 아닙니다.';
    } else {
      status = 'review'; detail = '일치 항목이 없지만 목록의 완전성을 확인할 수 없어 판정을 보류합니다.';
    }
    return {
      name: file.name, size: file.size, sha1Base64Url: key, status,
      label: labels[status], detail,
      mediaKeys: [...new Set(matches.map(item => item.mediaKey))],
    };
  }

  function reportCsv(results, inventory) {
    function cell(value) {
      let text = String(value ?? '');
      // Prevent spreadsheet formula execution for untrusted file/account names.
      if (/^[\s]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
      return '"' + text.replace(/"/g, '""') + '"';
    }
    const rows = [['파일명', '바이트', '결과', '설명', 'SHA1_Base64URL', '포토식별자', '조회계정', '목록조회시각']];
    for (const row of results) rows.push([row.name, row.size, row.label, row.detail, row.sha1Base64Url,
      row.mediaKeys.join(' | '), inventory.account, inventory.exportedAt]);
    return '\uFEFF' + rows.map(row => row.map(cell).join(',')).join('\r\n');
  }

  Object.assign(api, { labels, normalizeKey, keyFromBytes, parseInventory, compareFile, reportCsv });
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PhotoCheck = api;
})(globalThis);
