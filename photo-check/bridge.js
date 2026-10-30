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

  async function read(tabId, expectedAccount, onProgress = () => {}) {
    if (!available()) throw new Error('자동 연결은 Chrome·Edge 확장으로 연 화면에서 사용할 수 있습니다.');
    if (!Number.isInteger(tabId) || !expectedAccount) throw new Error('로그인한 포토 탭과 계정을 선택하세요.');
    if (activeTabId !== null) throw new Error('이미 포토 목록을 조회하고 있습니다.');
    activeTabId = tabId; activeJobId = crypto.randomUUID(); cancelRequested = false;
    const jobId = activeJobId;
    let timer;
    try {
      await chrome.scripting.executeScript({
        target: { tabId }, world: 'MAIN',
        func: () => { window.__photoCheckBridgeLoad = true; },
      });
      await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', files: ['photo-check/export-google-photos.user.js'] });
      if (cancelRequested) throw new Error('사용자가 조회를 중단했습니다.');
      let polling = false;
      timer = setInterval(async () => {
        if (polling) return;
        polling = true;
        try {
          const state = resultOf(await chrome.scripting.executeScript({
            target: { tabId }, world: 'MAIN', func: () => window.__photoCheckReader?.progress || {},
          }));
          if (activeJobId === jobId && state.jobId === jobId) onProgress(state);
        } catch { /* The main request reports a closed/navigated tab as an error. */ }
        finally { polling = false; }
      }, 700);
      const response = resultOf(await chrome.scripting.executeScript({
        target: { tabId }, world: 'MAIN', args: [expectedAccount, jobId],
        func: async (account, id) => {
          try { return { inventory: await window.__photoCheckReader.readInventory(account, id) }; }
          catch { return { error: '조회 계정이 변경되었거나 포토 조회를 시작하지 못했습니다.' }; }
        },
      }));
      if (response.error) throw new Error(response.error);
      if (cancelRequested) throw new Error('사용자가 조회를 중단했습니다. 이전 목록으로 검사하지 않습니다.');
      const value = response.inventory;
      if (value?.schema !== 'photo-check-inventory-v1' || value.account !== expectedAccount) {
        throw new Error('선택한 계정과 조회 결과가 다릅니다. 목록을 적용하지 않았습니다.');
      }
      return value;
    } catch (error) {
      if (cancelRequested) throw new Error('사용자가 조회를 중단했습니다.');
      if (error.message.startsWith('선택한') || error.message.startsWith('조회 계정')) throw error;
      throw new Error('포토 탭 연결이 끊겼거나 조회하지 못했습니다. 탭을 유지하고 로그인·확장 권한을 확인하세요.');
    } finally {
      clearInterval(timer);
      activeTabId = null;
      activeJobId = null;
    }
  }

  async function cancel() {
    cancelRequested = true;
    if (activeTabId === null) return;
    try {
      await chrome.scripting.executeScript({ target: { tabId: activeTabId }, world: 'MAIN', args: [activeJobId],
        func: id => { window.__photoCheckReader?.cancel(id); } });
    } catch { /* A closed tab has already stopped its reader. */ }
  }

  root.PhotoCheckBridge = { available, listTabs, read, cancel };
})(globalThis);
