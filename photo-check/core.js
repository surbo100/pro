(function (root) {
  'use strict';
  const labels = { match: '해시 일치', not_found: '조회에서 미발견', error: '검사 오류' };
  function keyFromBytes(bytes) {
    if (bytes.length !== 20) throw new Error('SHA-1 길이가 아닙니다.');
    return btoa(String.fromCharCode(...bytes));
  }
  function compareFile(file, hash, response) {
    if (!response.hashes.includes(hash)) throw new Error('조회하지 않은 해시입니다.');
    const matches = response.matches.filter(item => item.hash === hash);
    const status = matches.length ? 'match' : 'not_found';
    return { name: file.name, size: file.size, sha1Base64: hash, status, label: labels[status],
      account: response.account, queriedAt: response.queriedAt,
      mediaKeys: [...new Set(matches.map(item => item.mediaKey))],
      detail: matches.length ? '같은 입력 파일의 등록 근거를 찾았습니다. 원본 화질·현재 파일 무결성·휴지통 상태는 확인하지 않습니다.' :
        '선택한 계정의 정상 응답에서 이 해시를 찾지 못했습니다. 편집·압축본의 존재나 미백업 여부를 확정하지 않습니다.' };
  }
  function reportCsv(results) {
    const cell = value => {
      let text = String(value ?? '');
      if (/^[\s]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
      return '"' + text.replace(/"/g, '""') + '"';
    };
    const rows = [['파일명', '바이트', '결과', '설명', 'SHA1_Base64', '포토식별자', '조회계정', '조회시각']];
    for (const row of results) rows.push([row.name, row.size, row.label, row.detail, row.sha1Base64, row.mediaKeys.join(' | '), row.account, row.queriedAt]);
    return '\uFEFF' + rows.map(row => row.map(cell).join(',')).join('\r\n');
  }
  const api = { labels, keyFromBytes, compareFile, reportCsv };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PhotoCheck = api;
})(globalThis);
