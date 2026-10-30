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
    files[1].buffer = files[0].buffer; // renamed byte-identical copy
    const known = new Set(files.slice(0, 6).map(file => createHash('sha1').update(file.buffer).digest('base64')));
    let mode = 'complete', requests = 0;
    const requestBodies = [], unexpected = [], pageErrors = [], downloads = [];
    await context.route('https://photos.google.com/**', async route => {
      const request = route.request();
      if (request.method() === 'GET' && new URL(request.url()).pathname === '/u/1/photos') {
        const wiz = { oPEP7c: account, SNlM0e: 'synthetic-token', eptZe: '/u/1/_/PhotosUi/', FdrFJe: 'synthetic-session', cfb2h: 'build' };
        await route.fulfill({ contentType: 'text/html', body: `<!doctype html><title>Test Photos</title><script>window.WIZ_global_data=${JSON.stringify(wiz)}</script><p>Mock Google Photos</p>` });
        return;
      }
      assert.equal(request.method(), 'POST');
      assert.equal(new URL(request.url()).searchParams.get('rpcids'), 'swbisb');
      assert.equal(new URL(request.url()).searchParams.get('authuser'), '1');
      const params = new URLSearchParams(request.postData());
      const payload = JSON.parse(JSON.parse(params.get('f.req'))[0][0][1]);
      assert.deepEqual(payload.slice(1), [null, 3, 0]);
      assert.ok(payload[0].length <= 20);
      requests++;
      requestBodies.push(request.postData());
      if (mode === 'failure' || (mode === 'batch-failure' && payload[0].length === 5)) { await route.fulfill({ status: 403, body: 'failure' }); return; }
      if (mode === 'slow') await new Promise(resolve => setTimeout(resolve, 1500));
      const rows = payload[0].filter(hash => known.has(hash)).map(hash => [hash, ['media-' + hash, null, null, 'NOT_THE_HASH']]);
      const data = mode === 'malformed' ? [null] : [rows];
      await route.fulfill({ contentType: 'text/plain', body: ")]}'\n\n" + JSON.stringify([['wrb.fr', 'swbisb', JSON.stringify(data)]]) + '\n' });
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
        assert.deepEqual(request.files, ['photo-check/hash-reader.js']);
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
    assert.equal(requests, 1);
    mode = 'failure';
    await app.locator('#sync-run').click();
    await app.waitForFunction(() => document.getElementById('summary').textContent.includes('일치 0 · 미발견 0 · 오류 10'));
    mode = 'malformed';
    await app.locator('#sync-run').click();
    await app.waitForFunction(() => !document.getElementById('sync-run').disabled);
    assert.match(await app.locator('#summary').innerText(), /오류 10/);
    mode = 'slow';
    const beforeSlow = requests;
    await app.locator('#sync-run').click();
    for (let i = 0; i < 100 && requests === beforeSlow; i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(requests > beforeSlow);
    await app.locator('#cancel').click();
    await app.waitForFunction(() => !document.getElementById('sync-run').disabled);
    assert.equal(await app.locator('#results tr').count(), 0);
    const before = requests;
    await photos.evaluate(() => { window.WIZ_global_data.oPEP7c = 'other@example.invalid'; });
    await app.locator('#sync-run').click();
    await app.waitForFunction(() => !document.getElementById('sync-run').disabled);
    assert.equal(requests, before);
    assert.match(await app.locator('#summary').innerText(), /일치 0 · 미발견 0 · 오류 10/);
    await photos.evaluate(() => { window.WIZ_global_data.oPEP7c = 'test@example.invalid'; });
    const many = Array.from({ length: 25 }, (_, i) => ({ name: `batch-${i}.png`, mimeType: 'image/png', buffer: Buffer.concat([png, Buffer.from(`batch-${i}`)]) }));
    mode = 'batch-failure';
    const beforeBatch = requests;
    await app.locator('#photos').setInputFiles(many);
    await app.locator('#sync-run').click();
    await app.waitForFunction(() => !document.getElementById('sync-run').disabled);
    assert.equal(requests - beforeBatch, 2);
    assert.match(await app.locator('#summary').innerText(), /일치 0 · 미발견 20 · 오류 5/);
    assert.deepEqual(downloads, []);
    assert.deepEqual(unexpected, []);
    assert.deepEqual(pageErrors, []);
    // Hashes are intentionally sent; local bytes and file names are not.
    for (const file of files) for (const body of requestBodies) {
      assert.ok(!decodeURIComponent(body).includes(file.name));
      assert.ok(!body.includes(file.buffer.toString('base64')));
    }
    console.log('PASS: direct web hash query, 10 files including renamed duplicate, hash mapping, 403, malformed response, cancellation, changed account, no photo transfer.');
  } finally {
    await context?.close();
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
