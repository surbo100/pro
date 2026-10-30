(function () {
  'use strict';
  const RPC = 'swbisb';
  const validHash = value => typeof value === 'string' && /^[A-Za-z0-9+/]{27}=$/.test(value) && btoa(atob(value)) === value;
  function parseMatches(data, hashes) {
    // Only an explicit empty array is accepted as a successful empty response.
    // Null/missing payloads are ambiguous and must never mean not_found.
    if (!Array.isArray(data) || !Array.isArray(data[0])) throw new Error('해시 조회 응답 형식을 확인할 수 없습니다.');
    const requested = new Set(hashes), matches = [];
    for (const row of data[0]) {
      if (!Array.isArray(row) || !validHash(row[0]) || !requested.has(row[0]) ||
          !Array.isArray(row[1]) || typeof row[1][0] !== 'string' || !row[1][0]) {
        throw new Error('해시 조회 항목이 불완전하거나 요청과 다릅니다.');
      }
      matches.push({ hash: row[0], mediaKey: row[1][0] });
    }
    return matches;
  }
  function decodeResponse(body) {
    for (const line of body.split('\n')) {
      let batch;
      try { batch = JSON.parse(line); } catch { continue; }
      if (!Array.isArray(batch)) continue;
      const rows = batch.filter(row => Array.isArray(row) && row[0] === 'wrb.fr' && row[1] === RPC);
      if (rows.length) {
        if (rows.length !== 1 || typeof rows[0][2] !== 'string') throw new Error('조회 데이터가 없습니다.');
        return JSON.parse(rows[0][2]);
      }
    }
    throw new Error('예상한 해시 조회 응답이 아닙니다.');
  }
  function buildRequest(wiz, pathname, hashes) {
    if (typeof wiz.SNlM0e !== 'string' || !wiz.SNlM0e || typeof wiz.eptZe !== 'string') {
      throw new Error('로그인한 Google 포토 페이지의 조회 정보를 찾지 못했습니다. 페이지를 새로고침하세요.');
    }
    if (!wiz.eptZe.startsWith('/') || wiz.eptZe.startsWith('//')) throw new Error('조회 경로가 예상과 다릅니다.');
    const url = new URL(wiz.eptZe.replace(/\/?$/, '/') + 'data/batchexecute', 'https://photos.google.com');
    if (url.origin !== 'https://photos.google.com') throw new Error('조회 대상이 Google 포토가 아닙니다.');
    url.search = new URLSearchParams({
      rpcids: RPC, 'source-path': pathname, 'f.sid': String(wiz.FdrFJe || ''),
      bl: String(wiz.cfb2h || ''), pageId: 'none', rt: 'c',
      authuser: pathname.match(/^\/u\/(\d+)(?:\/|$)/)?.[1] || '0',
    }).toString();
    const payload = [hashes, null, 3, 0];
    const body = new URLSearchParams({ 'f.req': JSON.stringify([[[RPC, JSON.stringify(payload), null, 'generic']]]), at: wiz.SNlM0e });
    return { url: url.href, body: body.toString() };
  }


  if (typeof module === 'object' && module.exports) {
    module.exports = { validHash, parseMatches, decodeResponse, buildRequest }; return;
  }
  if (window.__photoCheckHashReader?.version === '0.3.0') return;
  let active = null;
  const reader = {
    version: '0.3.0',
    cancel(id) { if (active?.id === id) { active.cancelled = true; active.controller?.abort(); } },
    async query(expectedAccount, id, hashes) {
      if (active) throw new Error('이미 조회 중입니다.');
      if (!expectedAccount || !Array.isArray(hashes) || !hashes.length || hashes.length > 20 || !hashes.every(validHash)) throw new Error('조회 입력이 올바르지 않습니다.');
      const account = () => window.WIZ_global_data?.oPEP7c;
      const pathname = location.pathname;
      const check = () => {
        if (account() !== expectedAccount || location.pathname !== pathname) throw new Error('조회 계정 또는 페이지가 변경되었습니다.');
        if (active.cancelled) throw new Error('조회가 중단되었습니다.');
      };
      active = { id, cancelled: false, controller: new AbortController() };
      let timer;
      try {
        check();
        const request = buildRequest(window.WIZ_global_data || {}, pathname, hashes);
        timer = setTimeout(() => active?.controller.abort(), 30000);
        const response = await fetch(request.url, {
          method: 'POST', credentials: 'same-origin', redirect: 'error',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
          body: request.body, signal: active.controller.signal,
        });
        check();
        if (!response.ok) throw new Error('Google 포토 조회 실패: HTTP ' + response.status);
        const text = await response.text();
        check();
        const matches = parseMatches(decodeResponse(text), hashes);
        return { schema: 'photo-check-hashes-v1', account: expectedAccount, queriedAt: new Date().toISOString(), hashes, matches };
      } finally { clearTimeout(timer); active = null; }
    },
  };
  window.__photoCheckHashReader = reader;
})();
