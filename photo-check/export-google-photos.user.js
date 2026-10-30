// ==UserScript==
// @name         포토 업로드 전 확인 — 목록 내보내기
// @namespace    photo-check-local
// @version      0.2.0
// @description  Google 포토의 비교용 메타데이터만 JSON으로 저장합니다.
// @match        https://photos.google.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';
  // The only RPC used here is the library/archived-library read operation.
  // The request shape is based on public Google-Photos-Toolkit source.
  // No original or thumbnail URL is fetched or included in the export.
  const RPC = 'lcxiM';

  function decodeResponse(body) {
    for (const line of body.split('\n')) {
      if (!line.trim().startsWith('[')) continue;
      let batch;
      try { batch = JSON.parse(line); } catch { continue; }
      if (!Array.isArray(batch)) continue;
      const record = batch.find(row => Array.isArray(row) && row[0] === 'wrb.fr' && row[1] === RPC);
      if (record) {
        if (typeof record[2] !== 'string') throw new Error('목록 응답에 데이터가 없습니다.');
        return JSON.parse(record[2]);
      }
    }
    throw new Error('예상한 Google 포토 목록 응답이 아닙니다.');
  }

  function parsePage(data) {
    if (!Array.isArray(data) || data.length < 2) throw new Error('목록 응답 형식이 변경되었거나 불완전합니다.');
    if (data[0] !== null && !Array.isArray(data[0])) throw new Error('사진 목록을 해석할 수 없습니다.');
    if (data[1] !== null && typeof data[1] !== 'string') throw new Error('다음 페이지 정보를 해석할 수 없습니다.');
    const items = (data[0] || []).map(row => {
      if (!Array.isArray(row) || typeof row[0] !== 'string' || !row[0] || typeof row[3] !== 'string' || !row[3]) {
        throw new Error('식별자가 없는 항목이 있어 목록의 완전성을 확인할 수 없습니다.');
      }
      const flags = row.at(-1);
      const quality = flags && !Array.isArray(flags) ? flags[318563170]?.[0]?.[2] : undefined;
      return {
        mediaKey: row[0], dedupKey: row[3],
        takenAtMs: typeof row[2] === 'number' ? row[2] : null,
        uploadedAtMs: typeof row[5] === 'number' ? row[5] : null,
        width: typeof row[1]?.[1] === 'number' ? row[1][1] : null,
        height: typeof row[1]?.[2] === 'number' ? row[1][2] : null,
        isPartialUpload: row[12]?.[0] === 20,
        isArchived: row[13] === true || row[13] === 1,
        isOwned: Array.isArray(row[7]) ? !row[7].some(flag => Array.isArray(flag) && flag.includes(27)) : null,
        isOriginalQuality: quality === 2 ? true : quality === 1 ? false : null,
      };
    });
    return { items, nextPage: data[1] || null };
  }

  function buildRequest(wiz, pathname, cursor) {
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
    const payload = [cursor, null, 500, null, 1, 3]; // 3 = library and archive
    const body = new URLSearchParams({ 'f.req': JSON.stringify([[[RPC, JSON.stringify(payload), null, 'generic']]]), at: wiz.SNlM0e });
    return { url: url.href, body: body.toString() };
  }

  async function collect(readPage, account, onProgress = () => {}, shouldStop = () => false) {
    const result = {
      schema: 'photo-check-inventory-v1', source: 'Google Photos web library metadata',
      account, scope: 'library-and-archive',
      excluded: ['trash', 'locked-folder', 'shared-items-not-saved-to-library'],
      startedAt: new Date().toISOString(), exportedAt: null, complete: false,
      errors: [], items: [], pages: 0,
    };
    const visited = new Set(), media = new Map();
    let cursor = null;
    try {
      if (typeof account !== 'string' || !account.trim()) throw new Error('조회 계정을 식별할 수 없습니다.');
      while (true) {
        if (shouldStop()) throw new Error('사용자가 조회를 중단했습니다.');
        const page = parsePage(await readPage(cursor));
        for (const item of page.items) {
          if (media.has(item.mediaKey) && media.get(item.mediaKey).dedupKey !== item.dedupKey) {
            throw new Error('조회 중 항목이 변경되었습니다. 새 목록으로 다시 확인하세요.');
          }
          if (!media.has(item.mediaKey)) { media.set(item.mediaKey, item); result.items.push(item); }
        }
        result.pages++;
        onProgress(result);
        if (shouldStop()) throw new Error('사용자가 조회를 중단했습니다.');
        if (!page.nextPage) { result.complete = true; break; }
        if (visited.has(page.nextPage)) throw new Error('같은 페이지가 반복되어 조회를 중단했습니다.');
        visited.add(page.nextPage);
        cursor = page.nextPage;
        if (result.pages >= 10000) throw new Error('조회 한도에 도달했습니다. 목록은 불완전합니다.');
      }
    } catch (error) {
      // Only controlled messages are provided by readPage. Never save raw HTTP responses/tokens.
      result.errors.push(error.message);
    }
    result.exportedAt = new Date().toISOString();
    return result;
  }

  if (typeof module === 'object' && module.exports) {
    module.exports = { decodeResponse, parsePage, buildRequest, collect }; return;
  }
  if (location.origin !== 'https://photos.google.com') return;
  const bridgeMode = window.__photoCheckBridgeLoad === true;
  delete window.__photoCheckBridgeLoad;
  if (bridgeMode && window.__photoCheckReader?.version === '0.2.0') return;
  const account = () => typeof window.WIZ_global_data?.oPEP7c === 'string' ? window.WIZ_global_data.oPEP7c : '';
  let stopped = false, controller = null, busy = false, activeJobId = null;
  const reader = {
    version: '0.2.0', progress: {},
    cancel(jobId) { if (jobId === activeJobId) { stopped = true; controller?.abort(); } },
    readInventory,
  };
  window.__photoCheckReader = reader;

  async function readInventory(expectedAccount, jobId, onProgress = () => {}) {
    const selectedAccount = account(), selectedPath = location.pathname;
    if (busy) throw new Error('이 포토 탭에서 다른 조회가 진행 중입니다.');
    if (!selectedAccount || selectedAccount !== expectedAccount) throw new Error('선택한 조회 계정과 현재 계정이 다릅니다.');
    busy = true; stopped = false; activeJobId = jobId;
    reader.progress = { jobId, pages: 0, count: 0 };
    const readPage = async cursor => {
      if (account() !== selectedAccount || location.pathname !== selectedPath) throw new Error('조회 중 계정 또는 페이지가 바뀌었습니다.');
      const request = buildRequest(window.WIZ_global_data, selectedPath, cursor);
      for (let attempt = 0; attempt < 3; attempt++) {
        if (stopped) throw new Error('사용자가 조회를 중단했습니다.');
        controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000);
        let response;
        try {
          response = await fetch(request.url, {
            method: 'POST', credentials: 'same-origin', redirect: 'error',
            headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
            body: request.body, signal: controller.signal,
          });
          if (response.status === 429 || response.status >= 500) {
            if (attempt < 2) { await new Promise(resolve => setTimeout(resolve, 2000 * (attempt + 1))); continue; }
          }
          if (!response.ok) throw new Error('HTTP_STATUS_' + response.status);
          const decoded = decodeResponse(await response.text());
          if (account() !== selectedAccount || location.pathname !== selectedPath) throw new Error('계정 또는 페이지 변경');
          await new Promise(resolve => setTimeout(resolve, 300));
          return decoded;
        } catch (error) {
          if (stopped) throw new Error('사용자가 조회를 중단했습니다.');
          if (error.message.startsWith('HTTP_STATUS_')) throw new Error('Google 포토 조회 실패: HTTP ' + response.status);
          throw new Error('목록 응답을 읽지 못했습니다. 연결·로그인 또는 웹 인터페이스 변경을 확인하세요.');
        } finally { clearTimeout(timeout); }
      }
      throw new Error('Google 포토 조회 재시도 횟수를 초과했습니다.');
    };
    try {
      return await collect(readPage, selectedAccount, state => {
        reader.progress = { jobId, pages: state.pages, count: state.items.length };
        onProgress(state);
      }, () => stopped);
    } finally { busy = false; activeJobId = null; }
  }

  if (bridgeMode || document.getElementById('photo-check-export-panel')) return;
  const panel = document.createElement('div');
  panel.id = 'photo-check-export-panel';
  panel.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;background:#fff;color:#182c3b;padding:18px;border:1px solid #b7c9c3;border-radius:12px;box-shadow:0 6px 30px #0003;font:14px/1.6 system-ui;max-width:350px';
  const title = document.createElement('strong'); title.textContent = '비교용 목록';
  const note = document.createElement('div'); note.textContent = '사진 대신 식별자 목록을 저장합니다.';
  const accountText = document.createElement('div');
  const start = document.createElement('button'); start.textContent = '목록 내보내기';
  const stop = document.createElement('button'); stop.textContent = '중단'; stop.disabled = true;
  const dismiss = document.createElement('button'); dismiss.textContent = '닫기';
  const progress = document.createElement('div'); progress.setAttribute('role', 'status');
  for (const button of [start, stop, dismiss]) button.style.cssText = 'margin:8px 5px 8px 0;padding:6px 10px;cursor:pointer';
  accountText.textContent = '조회 계정: ' + (account() || '확인되지 않음');
  panel.append(title, note, accountText, start, stop, dismiss, progress);
  document.body.appendChild(panel);
  const manualJobId = crypto.randomUUID();
  stop.onclick = () => reader.cancel(manualJobId);
  dismiss.onclick = () => { reader.cancel(manualJobId); panel.remove(); };
  start.onclick = async () => {
    accountText.textContent = '조회 계정: ' + (account() || '확인되지 않음');
    start.disabled = true; stop.disabled = false;
    try {
      const result = await reader.readInventory(account(), manualJobId,
        state => { progress.textContent = `${state.pages}페이지 / ${state.items.length}개 조회 중`; });
      const blob = new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob), link = document.createElement('a');
      link.href = url; link.download = `photo-inventory-${result.complete ? 'complete' : 'partial'}-${Date.now()}.json`;
      link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      progress.textContent = result.complete ? `${result.items.length}개 목록 저장 완료.` : `불완전한 목록: ${result.errors.join(' ')}`;
    } catch (error) { progress.textContent = error.message; }
    finally { start.disabled = false; stop.disabled = true; }
  };
})();
