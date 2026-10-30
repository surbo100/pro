'use strict';
const $ = id => document.getElementById(id);
let results = [], busy = false, cancelled = false, tabsRequest = 0;
function updateButtons() {
  $('photos').disabled = busy;
  $('photo-tab').disabled = busy;
  $('refresh-tabs').disabled = busy;
  $('sync-run').disabled = busy || !$('photo-tab').selectedOptions[0]?.dataset.account || !$('photos').files.length;
  $('cancel').disabled = !busy;
  $('save').disabled = busy || !results.length;
}
function clearResults() {
  results = []; $('results').replaceChildren(); $('summary').textContent = '';
  $('results-section').hidden = true; $('progress').textContent = ''; updateButtons();
}
function render() {
  $('results').replaceChildren();
  for (const result of results) {
    const tr = document.createElement('tr');
    for (const [i, value] of [result.name, result.label, result.detail].entries()) {
      const td = document.createElement('td'); td.textContent = value;
      if (i === 1) td.className = 'status-' + result.status;
      tr.appendChild(td);
    }
    $('results').appendChild(tr);
  }
  const count = status => results.filter(row => row.status === status).length;
  $('summary').textContent = `일치 ${count('match')} · 미발견 ${count('not_found')} · 오류 ${count('error')} · 미검사 ${$('photos').files.length - results.length}`;
  $('results-section').hidden = false;
}
function errorResult(file, account, detail, hash = '') {
  return { name: file.name, size: file.size, status: 'error', label: PhotoCheck.labels.error,
    detail, sha1Base64: hash, mediaKeys: [], account, queriedAt: new Date().toISOString() };
}
async function refreshTabs() {
  if (busy || !PhotoCheckBridge.available()) return;
  const version = ++tabsRequest;
  $('connection-status').textContent = '로그인한 포토 탭을 찾고 있습니다.';
  try {
    const choices = await PhotoCheckBridge.listTabs();
    if (version !== tabsRequest || busy) return;
    $('photo-tab').replaceChildren(new Option('조회할 계정 선택', ''));
    for (const [index, choice] of choices.entries()) {
      const option = new Option(`${choice.account || '로그인 확인 필요'} · 포토 탭 ${index + 1}`, String(choice.id));
      option.dataset.account = choice.account; option.disabled = !choice.account;
      $('photo-tab').appendChild(option);
    }
    const valid = choices.filter(choice => choice.account);
    if (valid.length === 1) $('photo-tab').value = String(valid[0].id);
    $('connection-status').textContent = valid.length ? '계정을 확인하고 사진을 선택하세요. 조회 중에는 포토 탭을 유지하세요.' : 'Google 포토에 로그인한 뒤 탭을 새로 찾으세요.';
  } catch { $('connection-status').textContent = '포토 탭을 찾지 못했습니다. 확장 권한을 확인하세요.'; }
  updateButtons();
}
$('refresh-tabs').addEventListener('click', () => { clearResults(); refreshTabs(); });
$('photo-tab').addEventListener('change', clearResults);
$('photos').addEventListener('change', clearResults);
$('cancel').addEventListener('click', () => { cancelled = true; PhotoCheckBridge.cancel(); $('progress').textContent = '중단 중입니다.'; });
$('sync-run').addEventListener('click', async () => {
  if (busy || !$('photos').files.length) return;
  const choice = $('photo-tab').selectedOptions[0];
  if (!choice?.dataset.account) return;
  const account = choice.dataset.account, tabId = Number(choice.value), files = [...$('photos').files];
  clearResults(); busy = true; cancelled = false; ++tabsRequest; updateButtons();
  const prepared = [];
  let failed = false;
  try {
    for (const [i, file] of files.entries()) {
      if (cancelled) break;
      $('progress').textContent = `해시 계산 ${i + 1} / ${files.length}: ${file.name}`;
      try {
        if (!file.size || file.size > 256 * 1024 * 1024) throw new Error('빈 파일 또는 256 MiB 초과 파일은 검사하지 못합니다.');
        const hash = PhotoCheck.keyFromBytes(new Uint8Array(await crypto.subtle.digest('SHA-1', await file.arrayBuffer())));
        if (!cancelled) prepared.push({ file, hash });
      } catch { results.push(errorResult(file, account, '파일을 읽거나 해시를 계산하지 못했습니다. 빈 파일·256 MiB 초과 여부를 확인하세요.')); }
    }
    const unique = [...new Set(prepared.map(row => row.hash))];
    for (let offset = 0; offset < unique.length && !cancelled; offset += 20) {
      const hashes = unique.slice(offset, offset + 20);
      $('progress').textContent = `해시 조회 ${offset + 1}–${Math.min(offset + 20, unique.length)} / ${unique.length}`;
      try {
        const response = await PhotoCheckBridge.query(tabId, account, hashes);
        if (cancelled) break;
        for (const row of prepared.filter(row => hashes.includes(row.hash))) results.push(PhotoCheck.compareFile(row.file, row.hash, response));
      } catch {
        if (cancelled) break;
        failed = true;
        // Stop on account/network/schema errors. No pending file is labelled absent.
        for (const row of prepared.filter(row => unique.slice(offset).includes(row.hash))) {
          results.push(errorResult(row.file, account, '조회 실패: 로그인·계정 변경·연결·응답 형식을 확인하세요. 미백업으로 판정하지 않습니다.', row.hash));
        }
        break;
      }
      render();
    }
  } finally {
    busy = false; render(); updateButtons();
    $('progress').textContent = cancelled ? '중단했습니다. 미검사 파일은 판정하지 않았습니다.' : failed ? '조회 오류가 있습니다. 오류 파일은 미백업으로 판정하지 않았습니다.' : '검사를 완료했습니다.';
  }
});
if (PhotoCheckBridge.available()) {
  $('automatic').hidden = false; $('sync-run').hidden = false; $('extension-help').hidden = true; refreshTabs();
}
$('save').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([PhotoCheck.reportCsv(results)], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = 'photo-check-report.csv'; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
