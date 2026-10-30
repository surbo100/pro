'use strict';
const { chromium } = require('playwright');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const assert = require('node:assert/strict');

(async () => {
  const root = path.resolve(__dirname, '..');
  const staticFiles = new Map(['index.html', 'core.js', 'bridge.js', 'app.js'].map(name => ['/' + name, name]));
  const server = http.createServer((request, response) => {
    const name = staticFiles.get(request.url);
    if (!name) { response.writeHead(404); response.end(); return; }
    response.setHeader('Content-Type', name.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8');
    response.end(fs.readFileSync(path.join(root, 'photo-check', name)));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let browser, context;
  try {
    browser = await chromium.launch({ executablePath: process.env.PHOTO_CHECK_BROWSER_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    context = await browser.newContext();
    const account = 'test@example.invalid';
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=', 'base64');
    const files = Array.from({ length: 10 }, (_, i) => ({ name: `사진-${i}.png`, mimeType: 'image/png', buffer: Buffer.concat([png, Buffer.from(`fixture-${i}`)]) }));
    const rows = files.slice(0, 6).map((file, i) => {
      const row = [`media-${i}`, ['https://unused.invalid/thumbnail', 1, 1], 1700000000000,
        createHash('sha1').update(file.buffer).digest('base64url'), null, 1700000001000, null, [[20]], null, null, null, null, [], false];
      return row;
    });
    let mode = 'complete', requests = 0, secondPageStarted = false;
    const requestBodies = [], unexpected = [], pageErrors = [], downloads = [];
    await context.route('https://photos.google.com/**', async route => {
      const request = route.request();
      if (request.method() === 'GET' && new URL(request.url()).pathname === '/u/1/photos') {
        const wiz = { oPEP7c: account, SNlM0e: 'synthetic-token', eptZe: '/u/1/_/PhotosUi/', FdrFJe: 'synthetic-session', cfb2h: 'build' };
        await route.fulfill({ contentType: 'text/html', body: `<!doctype html><title>Test Photos</title><script>window.WIZ_global_data=${JSON.stringify(wiz)}</script><p>Mock Google Photos</p>` });
        return;
      }
      assert.equal(request.method(), 'POST');
      assert.equal(new URL(request.url()).searchParams.get('rpcids'), 'lcxiM');
      assert.equal(new URL(request.url()).searchParams.get('authuser'), '1');
      const params = new URLSearchParams(request.postData());
      const wrapped = JSON.parse(params.get('f.req'));
      const payload = JSON.parse(wrapped[0][0][1]);
      assert.equal(payload[5], 3);
      requests++;
      requestBodies.push(request.postData());
      const cursor = payload[0];
      if (cursor) {
        secondPageStarted = true;
        if (mode === 'failure') { await route.fulfill({ status: 403, body: 'synthetic failure' }); return; }
        if (mode === 'slow') await new Promise(resolve => setTimeout(resolve, 1500));
      }
      const data = cursor ? [rows.slice(3), null, 'timestamp'] : [rows.slice(0, 3), 'page-2', 'timestamp'];
      await route.fulfill({ contentType: 'text/plain', body: ")]}'\n\n" + JSON.stringify([['wrb.fr', 'lcxiM', JSON.stringify(data)]]) + '\n' });
    });
    await context.route(/https?:\/\/(?!photos\.google\.com\/)/, route => { if (route.request().url().startsWith(base + '/')) return route.continue(); unexpected.push(route.request().url()); return route.abort(); });
    const photos = await context.newPage();
    await photos.goto('https://photos.google.com/u/1/photos');
    const app = await context.newPage();
    app.on('pageerror', error => pageErrors.push(error.message));
    app.on('download', value => downloads.push(value.suggestedFilename()));
    photos.on('download', value => downloads.push(value.suggestedFilename()));
    // Only the extension transport is simulated. Real app/bridge/reader source runs
    // in separate browser pages and all Google requests are fulfilled with fixtures.
    await app.exposeFunction('__testChromeHost', async request => {
      if (request.op === 'tabs') return [{ id: 101 }];
      assert.equal(request.target.tabId, 101);
      if (request.files) {
        assert.deepEqual(request.files, ['photo-check/export-google-photos.user.js']);
        await photos.addScriptTag({ content: fs.readFileSync(path.join(root, request.files[0]), 'utf8') });
        return [{ frameId: 0 }];
      }
      const result = await photos.evaluate(async ({ code, args }) => {
        const fn = (0, eval)('(' + code + ')');
        return await fn(...args);
      }, { code: request.code, args: request.args || [] });
      return [{ frameId: 0, result }];
    });
    await app.addInitScript(() => {
      window.chrome = {
        runtime: { id: 'simulated-extension' },
        tabs: { query: () => window.__testChromeHost({ op: 'tabs' }) },
        scripting: { executeScript: spec => window.__testChromeHost({
          op: 'execute', target: spec.target, files: spec.files, code: spec.func?.toString(), args: spec.args,
        }) },
      };
    });
    await app.goto(base + '/index.html');
    await app.waitForFunction(() => document.querySelector('#photo-tab option[data-account]')?.dataset.account === 'test@example.invalid');
    await app.locator('#photos').setInputFiles(files);
    await app.locator('#sync-run').click();
    await app.waitForFunction(() => document.getElementById('summary').textContent.includes('일치 6 · 미발견 4'), { timeout: 15000 });
    assert.equal(await app.locator('#results tr').count(), 10);
    assert.equal(await app.locator('#inventory').inputValue(), '');
    assert.equal(await app.locator('#account-confirm').isChecked(), true);
    assert.equal(requests, 2);
    assert.equal(await photos.locator('#photo-check-export-panel').count(), 0);
    // A fresh scan must replace the prior complete inventory, even on page failure.
    mode = 'failure';
    await app.locator('#sync-run').click();
    await app.waitForFunction(() => document.getElementById('summary').textContent.includes('일치 3 · 미발견 0 · 판정 보류 7'));
    assert.match(await app.locator('#inventory-info').innerText(), /HTTP 403/);
    // Cancellation after a partial page must not trigger a comparison with old data.
    mode = 'slow'; secondPageStarted = false;
    await app.locator('#sync-run').click();
    await app.waitForFunction(() => !document.getElementById('cancel').disabled);
    for (let i = 0; i < 100 && !secondPageStarted; i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(secondPageStarted, true);
    await app.locator('#cancel').click();
    await app.waitForFunction(() => document.getElementById('progress').textContent.includes('완료하지 못했습니다'));
    assert.equal(await app.locator('#results tr').count(), 0);
    assert.equal(await app.locator('#run').isDisabled(), true);
    // Refuse a stale account selection without sending a request under the new account.
    const before = requests;
    await photos.evaluate(() => { window.WIZ_global_data.oPEP7c = 'other@example.invalid'; });
    await app.locator('#sync-run').click();
    await app.waitForFunction(() => document.getElementById('connection-status').textContent.includes('조회 계정'));
    assert.equal(requests, before);
    assert.equal(await app.locator('#results tr').count(), 0);
    assert.deepEqual(downloads, []);
    assert.deepEqual(unexpected, []);
    assert.deepEqual(pageErrors, []);
    // Only cursors and session fields go to the mocked Google endpoint, never local file hashes/names/bytes.
    for (const file of files) for (const body of requestBodies) {
      assert.ok(!body.includes(file.name));
      assert.ok(!body.includes(createHash('sha1').update(file.buffer).digest('base64url')));
    }
    console.log('PASS: simulated extension transport + real app/bridge/reader + mocked Google pages, account selection, 2-page automatic transfer, 10-file comparison, partial failure, cancellation, changed-account refusal, zero JSON downloads, no local photo data sent.');
  } finally {
    await context?.close();
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
