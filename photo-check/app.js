'use strict';
const $ = id => document.getElementById(id);
let inventory = null, results = [], running = false, syncing = false, cancelled = false, importVersion = 0;

function updateButtons() {
  const busy = running || syncing;
  $('run').disabled = busy || !inventory || !$('account-confirm').checked || !$('photos').files.length;
  $('inventory').disabled = busy;
  $('photos').disabled = busy;
  $('account-confirm').disabled = busy || !inventory;
  $('cancel').disabled = !busy;
  $('save').disabled = busy || !results.length;
  $('photo-tab').disabled = busy;
  $('refresh-tabs').disabled = busy;
  $('sync-run').disabled = busy || !$('photo-tab').selectedOptions[0]?.dataset.account || !$('photos').files.length;
}

function showInventory(parsed, confirmed = false) {
  inventory = parsed;
  $('account-confirm').checked = confirmed;
  const parts = [
    `계정: ${parsed.account || '목록에 기록되지 않음 — 포토에서 직접 확인하세요'}`,
    `조회 시각: ${parsed.exportedAt || '기록되지 않음'}`,
    `항목: ${parsed.items.length.toLocaleString()}개 · 비교할 수 없는 식별자: ${parsed.invalidCount}개`,
    parsed.complete ? '보관처리를 포함한 목록의 마지막 페이지까지 조회했다고 기록되어 있습니다.' : '전체 조회 완료를 확인할 수 없습니다. 미일치 파일은 판정 보류합니다.',
  ];
  if (parsed.errors.length) parts.push('조회 정보: ' + parsed.errors.join(' '));
  if (parsed.exportedAt && Date.now() - Date.parse(parsed.exportedAt) > 86400000) parts.push('24시간 이상 지난 목록입니다. 최근 업로드를 확인하려면 다시 조회하세요.');
  $('inventory-info').className = '';
  $('inventory-info').textContent = parts.join('\n');
}

function clearResults() {
  results = [];
  $('results').replaceChildren();
  $('summary').textContent = '';
  $('results-section').hidden = true;
  $('progress').textContent = '';
  updateButtons();
}

$('inventory').addEventListener('change', async () => {
  const version = ++importVersion;
  inventory = null;
  $('account-confirm').checked = false;
  clearResults();
  $('inventory-info').className = '';
  try {
    const file = $('inventory').files[0];
    if (!file) { $('inventory-info').textContent = '아직 목록을 선택하지 않았습니다.'; return; }
    if (file.size > 100 * 1024 * 1024) throw new Error('목록 파일은 100 MiB 이하로 나누어 주세요.');
    const parsed = PhotoCheck.parseInventory(await file.text());
    if (version !== importVersion) return;
    showInventory(parsed);
  } catch (error) {
    if (version !== importVersion) return;
    $('inventory-info').className = 'error';
    $('inventory-info').textContent = error.message;
  } finally { updateButtons(); }
});
$('account-confirm').addEventListener('change', updateButtons);
$('photos').addEventListener('change', clearResults);
$('cancel').addEventListener('click', () => {
  cancelled = true;
  if (syncing) { PhotoCheckBridge.cancel(); $('progress').textContent = '포토 조회를 중단하고 있습니다.'; }
  else $('progress').textContent = '현재 파일 처리가 끝나면 중단합니다.';
});

function appendResult(result) {
  const tr = document.createElement('tr');
  for (const [i, value] of [result.name, result.label, result.detail].entries()) {
    const td = document.createElement('td');
    td.textContent = value;
    if (i === 1) td.className = 'status-' + result.status;
    tr.appendChild(td);
  }
  $('results').appendChild(tr);
}

async function runComparison() {
  if (running || syncing || !inventory || !$('account-confirm').checked) return;
  clearResults();
  running = true; cancelled = false;
  updateButtons();
  $('results-section').hidden = false;
  const files = [...$('photos').files];
  try {
    for (const [i, file] of files.entries()) {
      if (cancelled) break;
      $('progress').textContent = `${i + 1} / ${files.length}개 읽는 중: ${file.name}`;
      let result;
      try {
        if (!crypto.subtle) throw new Error('이 브라우저에서 로컬 해시 계산을 지원하지 않습니다. 최신 Chrome 또는 Edge를 사용하세요.');
        if (!file.size) throw new Error('빈 파일은 사진 백업으로 판정하지 않습니다.');
        if (file.size > 256 * 1024 * 1024) throw new Error('256 MiB를 초과하여 이 버전에서는 검사하지 못했습니다.');
        const digest = await crypto.subtle.digest('SHA-1', await file.arrayBuffer());
        const key = PhotoCheck.keyFromBytes(new Uint8Array(digest));
        result = PhotoCheck.compareFile(file, key, inventory);
      } catch (error) {
        result = { name: file.name, size: file.size, status: 'error', label: PhotoCheck.labels.error,
          detail: error.message, sha1Base64Url: '', mediaKeys: [] };
      }
      results.push(result); appendResult(result);
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  } finally {
    running = false;
    const counts = Object.fromEntries(Object.keys(PhotoCheck.labels).map(status => [status, results.filter(row => row.status === status).length]));
    const unrun = files.length - results.length;
    $('summary').textContent = `일치 ${counts.match} · 미발견 ${counts.not_found} · 판정 보류 ${counts.review} · 오류 ${counts.error} · 미검사 ${unrun}`;
    $('progress').textContent = unrun ? `${results.length}개 검사 후 중단했습니다. ${unrun}개는 검사하지 않았습니다.` : `${results.length}개 검사를 완료했습니다.`;
    updateButtons();
  }
}
$('run').addEventListener('click', runComparison);

let tabsRequest = 0;
async function refreshTabs() {
  if (running || syncing || !PhotoCheckBridge.available()) return;
  const version = ++tabsRequest;
  const oldChoice = $('photo-tab').selectedOptions[0];
  const previous = oldChoice ? { id: oldChoice.value, account: oldChoice.dataset.account } : null;
  $('connection-status').textContent = '로그인한 포토 탭을 찾고 있습니다.';
  try {
    const choices = await PhotoCheckBridge.listTabs();
    if (version !== tabsRequest || running || syncing) return;
    $('photo-tab').replaceChildren();
    const placeholder = new Option('조회할 계정 선택', '');
    $('photo-tab').appendChild(placeholder);
    for (const [index, choice] of choices.entries()) {
      const option = new Option(`${choice.account || '로그인 확인 필요'} · 포토 탭 ${index + 1}`, String(choice.id));
      option.dataset.account = choice.account;
      option.disabled = !choice.account;
      $('photo-tab').appendChild(option);
    }
    const valid = choices.filter(choice => choice.account);
    if (previous && valid.some(choice => String(choice.id) === previous.id && choice.account === previous.account)) $('photo-tab').value = previous.id;
    else if (valid.length === 1) $('photo-tab').value = String(valid[0].id);
    $('connection-status').textContent = valid.length ? '조회할 계정을 확인한 뒤 사진을 선택하세요. 조회 중에는 포토 탭을 열어 두세요.' : 'Google 포토를 열어 로그인한 뒤 ‘포토 탭 새로 찾기’를 누르세요.';
  } catch { $('connection-status').textContent = '포토 탭을 찾지 못했습니다. 확장의 Google 포토 접근 권한을 확인하세요.'; }
  updateButtons();
}

$('refresh-tabs').addEventListener('click', refreshTabs);
$('photo-tab').addEventListener('change', () => {
  // An old account's inventory must never remain silently active after switching tabs.
  inventory = null; $('account-confirm').checked = false;
  $('inventory-info').textContent = '선택한 포토 탭의 새 목록을 조회할 준비가 되었습니다.';
  clearResults();
});
$('sync-run').addEventListener('click', async () => {
  if (running || syncing || !$('photos').files.length) return;
  const choice = $('photo-tab').selectedOptions[0];
  if (!choice?.dataset.account) return;
  syncing = true; cancelled = false; ++importVersion; ++tabsRequest;
  inventory = null; $('account-confirm').checked = false; $('inventory').value = '';
  clearResults();
  $('inventory-info').textContent = 'Google 포토에서 새 목록을 조회하고 있습니다.';
  $('connection-status').textContent = `조회 중: ${choice.dataset.account}`;
  $('progress').textContent = '포토 목록 조회를 시작합니다.';
  try {
    const result = await PhotoCheckBridge.read(Number(choice.value), choice.dataset.account, state => {
      if (syncing) $('progress').textContent = `포토 조회: ${state.pages || 0}페이지 · ${(state.count || 0).toLocaleString()}개`;
    });
    if (cancelled) throw new Error('조회가 중단되어 검사를 시작하지 않았습니다.');
    showInventory(PhotoCheck.parseInventory(JSON.stringify(result)), true);
    $('connection-status').textContent = inventory.complete ? '최신 목록을 연결했습니다. 선택한 파일을 자동으로 대조합니다.' : '조회가 불완전합니다. 확보한 목록으로 대조하고 미일치는 판정 보류합니다.';
    syncing = false;
    await runComparison();
  } catch (error) {
    inventory = null; $('account-confirm').checked = false;
    $('inventory-info').textContent = '이번 조회가 적용되지 않았습니다. 이전 목록으로 자동 검사하지 않습니다.';
    $('connection-status').textContent = error.message;
    $('progress').textContent = '자동 조회·검사를 완료하지 못했습니다.';
  } finally { syncing = false; updateButtons(); }
});

if (PhotoCheckBridge.available()) {
  $('automatic').hidden = false;
  $('sync-run').hidden = false;
  $('extension-help').hidden = true;
  refreshTabs();
} else $('manual-import').open = true;

$('save').addEventListener('click', () => {
  const blob = new Blob([PhotoCheck.reportCsv(results, inventory)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'photo-check-report.csv'; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
