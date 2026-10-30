'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const core = require('../photo-check/core.js');

const hash = data => createHash('sha1').update(data).digest('base64url');
const key = hash('already backed up original');
function inventory(items, overrides = {}) {
  return core.parseInventory(JSON.stringify({
    schema: 'photo-check-inventory-v1', account: 'test@example.invalid',
    exportedAt: new Date().toISOString(), scope: 'library-and-archive',
    complete: true, errors: [], items, ...overrides,
  }));
}
const item = overrides => ({ mediaKey: 'remote-1', dedupKey: key, ...overrides });
const file = { name: 'renamed.jpg', size: 1234 };

test('SHA-1 known vector and alternate Base64 encodings', () => {
  const digest = createHash('sha1').update('abc').digest();
  assert.equal(core.keyFromBytes(digest), 'qZk-NkcGgWq6PiVxeFDCbJzQ2J0');
  assert.equal(core.normalizeKey(digest.toString('base64')), digest.toString('base64url'));
  assert.equal(core.normalizeKey('a'.repeat(26) + 'B'), null);
  assert.equal(core.normalizeKey('media-id-not-a-sha1'), null);
});

test('ten local files: six matches including rename, four not found', () => {
  const contents = Array.from({ length: 10 }, (_, i) => `original media bytes ${i}`);
  const inv = inventory(contents.slice(0, 6).map((content, i) => ({ mediaKey: `cloud-${i}`, dedupKey: hash(content) })));
  const results = contents.map((content, i) => core.compareFile({ name: `different-name-${i}.jpg`, size: content.length }, hash(content), inv));
  assert.equal(results.filter(row => row.status === 'match').length, 6);
  assert.equal(results.filter(row => row.status === 'not_found').length, 4);
  assert.equal(core.compareFile(file, hash(contents[0] + 'changed EXIF'), inv).status, 'not_found');
});

test('identical filename with different bytes does not match', () => {
  const inv = inventory([item({ fileName: file.name })]);
  assert.equal(core.compareFile(file, hash('different bytes'), inv).status, 'not_found');
});

test('incomplete or unreadable inventories never yield not-found verdicts', () => {
  for (const overrides of [{ complete: false }, { errors: ['timeout'] }, { errors: 'timeout' }, { exportedAt: null }, { account: null }, { scope: 'album-only' }]) {
    const inv = inventory([item()], overrides);
    assert.equal(core.compareFile(file, hash('new'), inv).status, 'review');
    assert.equal(core.compareFile(file, key, inv).status, 'match');
  }
  const inv = inventory([item(), { mediaKey: 'unknown', dedupKey: 'unsupported-key' }]);
  assert.equal(inv.invalidCount, 1);
  assert.equal(core.compareFile(file, hash('new'), inv).status, 'review');
});

test('partial upload, trashed and other-owner matches are not treated as usable backups', () => {
  for (const flags of [{ isPartialUpload: true }, { inTrash: true }, { isOwned: false }]) {
    assert.equal(core.compareFile(file, key, inventory([item(flags)])).status, 'review');
  }
  assert.equal(core.compareFile(file, key, inventory([item({ inTrash: true }), item({ mediaKey: 'active' })])).status, 'match');
});

test('original, saver and unknown quality remain distinct', () => {
  assert.match(core.compareFile(file, key, inventory([item({ isOriginalQuality: true })])).detail, /원본 화질 표시/);
  assert.match(core.compareFile(file, key, inventory([item({ isOriginalQuality: false })])).detail, /저장용량 절약/);
  assert.match(core.compareFile(file, key, inventory([item({})])).detail, /확인할 수 없습니다/);
});

test('Toolkit CSV supports BOM, quotes, commas and newlines; coverage remains unknown', () => {
  const inv = core.parseInventory('\uFEFFmediaKey,dedupKey,fileName,isOriginalQuality\r\nremote-1,' + key + ',"a,""quoted""\nname.jpg",false\r\n');
  assert.equal(inv.items[0].fileName, 'a,"quoted"\nname.jpg');
  assert.equal(inv.complete, false);
  assert.equal(core.compareFile(file, key, inv).status, 'match');
  assert.equal(core.compareFile(file, hash('missing'), inv).status, 'review');
});

test('malformed exports are rejected', () => {
  for (const text of ['{}', 'mediaKey,dedupKey\n"unfinished', 'mediaKey,dedupKey\n1,2,3', 'mediaKey,dedupKey,mediaKey\na,b,c']) {
    assert.throws(() => core.parseInventory(text));
  }
});

test('report escapes spreadsheet formulas, retains account and all results', () => {
  const inv = inventory([item()]);
  const result = core.compareFile({ name: '=HYPERLINK("bad")', size: 12 }, key, inv);
  const csv = core.reportCsv([result], inv);
  assert.ok(csv.startsWith('\uFEFF'));
  assert.ok(csv.includes('"\'=HYPERLINK'));
  assert.ok(csv.includes('test@example.invalid'));
});
