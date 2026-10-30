(function (root) {
  'use strict';
  const available = () => Boolean(root.chrome?.runtime?.id && root.chrome?.scripting?.executeScript);
  let activeTabId = null;
  let activeJobId = null;
  let cancelRequested = false;

  function resultOf(results) {
    const frame = results?.find(result => result.frameId === 0);
    if (!frame || frame.error || !frame.result) throw new Error('포토 탭에서 응답을 받지 못했습니다. 로그인 상태를 확인하세요.');
    return frame.result;
  }

  async function listTabs() {
    if (!available()) return [];
    const tabs = await chrome.tabs.query({ url: 'https://photos.google.com/*' });
    const choices = [];
    for (const tab of tabs) {
      try {
        const info = resultOf(await chrome.scripting.executeScript({
          target: { tabId: tab.id }, world: 'MAIN',
          func: () => ({ account: window.WIZ_global_data?.oPEP7c || '', path: location.pathname }),
        }));
        choices.push({ id: tab.id, account: typeof info.account === 'string' ? info.account : '', path: info.path });
      } catch { /* Closed, loading or restricted tabs cannot be used. */ }
    }
    return choices;
  }

  async function query(tabId, expectedAccount, hashes) {
    if (!available()) throw new Error('Chrome·Edge 확장에서 열어 주세요.');
    if (!Number.isInteger(tabId) || !expectedAccount || activeTabId !== null) throw new Error('조회할 포토 계정을 확인하세요.');
    activeTabId = tabId; activeJobId = crypto.randomUUID(); cancelRequested = false;
    try {
      await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', files: ['photo-check/hash-reader.js'] });
      if (cancelRequested) throw new Error('조회가 중단되었습니다.');
      const response = resultOf(await chrome.scripting.executeScript({
        target: { tabId }, world: 'MAIN', args: [expectedAccount, activeJobId, hashes],
        func: async (account, id, values) => {
          try { return { value: await window.__photoCheckHashReader.query(account, id, values) }; }
          catch { return { error: '조회 실패: 로그인·계정 변경·응답 형식·연결 상태를 확인하세요. 미백업으로 판정하지 않습니다.' }; }
        },
      }));
      if (cancelRequested) throw new Error('조회가 중단되었습니다.');
      if (response.error) throw new Error(response.error);
      const value = response.value;
      if (value?.schema !== 'photo-check-hashes-v1' || value.account !== expectedAccount ||
          JSON.stringify(value.hashes) !== JSON.stringify(hashes) || !Array.isArray(value.matches)) {
        throw new Error('조회 계정 또는 응답이 요청과 다릅니다.');
      }
      return value;
    } finally { activeTabId = null; activeJobId = null; }
  }

  async function cancel() {
    cancelRequested = true;
    if (activeTabId === null) return;
    try {
      await chrome.scripting.executeScript({ target: { tabId: activeTabId }, world: 'MAIN', args: [activeJobId],
        func: id => { window.__photoCheckHashReader?.cancel(id); } });
    } catch { /* A closed tab has already stopped its reader. */ }
  }

  root.PhotoCheckBridge = { available, listTabs, query, cancel };
})(globalThis);
