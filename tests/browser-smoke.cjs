'use strict';
const { chromium } = require('playwright');
const { createHash } = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const assert = require('node:assert/strict');

(async () => {
  // This managed browser blocks file:// URLs. Test the same static files over
  // loopback HTTP; do not change browser policy to work around that restriction.
  const staticFiles = new Map(['index.html', 'core.js', 'bridge.js', 'app.js'].map(name => ['/' + name, name]));
  const server = http.createServer((request, response) => {
    const name = staticFiles.get(request.url);
    if (!name) { response.writeHead(404); response.end(); return; }
    response.setHeader('Content-Type', name.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8');
    response.end(fs.readFileSync(path.resolve(__dirname, '../photo-check', name)));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const executablePath = process.env.PHOTO_CHECK_BROWSER_PATH || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
  let browser;
  try {
    browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage();
    const errors = [], externalRequests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (/^https?:/.test(request.url()) && !request.url().startsWith(base + '/')) externalRequests.push(request.url()); });
    await page.goto(base + '/index.html');
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=', 'base64');
    const files = Array.from({ length: 10 }, (_, i) => ({
      name: `사진-${i}.png`, mimeType: 'image/png', buffer: Buffer.concat([png, Buffer.from(`fixture-${i}`)]),
    }));
    const inventory = {
      schema: 'photo-check-inventory-v1', account: 'test@example.invalid',
      exportedAt: new Date().toISOString(), scope: 'library-and-archive', complete: true, errors: [],
      items: files.slice(0, 6).map((file, i) => ({
        mediaKey: `media-${i}`, dedupKey: createHash('sha1').update(file.buffer).digest('base64url'),
        isOriginalQuality: i === 0 ? false : true,
      })),
    };
    async function loadInventory(value) {
      await page.locator('#inventory').setInputFiles({ name: 'inventory.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(value)) });
      await page.locator('#account-confirm').waitFor({ state: 'visible' });
      await page.waitForFunction(() => !document.getElementById('account-confirm').disabled);
    }
    await loadInventory(inventory);
    await page.locator('#photos').setInputFiles(files);
    assert.equal(await page.locator('#run').isDisabled(), true);
    await page.locator('#account-confirm').check();
    await page.locator('#run').click();
    await page.waitForFunction(() => document.getElementById('summary').textContent.includes('일치 6 · 미발견 4'));
    assert.equal(await page.locator('#results tr').count(), 10);
    assert.match(await page.locator('#results tr').first().innerText(), /저장용량 절약/);
    const downloadPromise = page.waitForEvent('download');
    await page.locator('#save').click();
    const download = await downloadPromise;
    assert.equal(download.suggestedFilename(), 'photo-check-report.csv');
    await loadInventory({ ...inventory, complete: false, errors: ['Interrupted'] });
    await page.locator('#account-confirm').check();
    await page.locator('#run').click();
    await page.waitForFunction(() => document.getElementById('summary').textContent.includes('일치 6 · 미발견 0 · 판정 보류 4'));
    // Empty local files and failed inventory imports are explicit errors, never a negative match.
    await page.locator('#photos').setInputFiles([{ name: 'empty.jpg', mimeType: 'image/jpeg', buffer: Buffer.alloc(0) }]);
    await page.locator('#run').click();
    await page.waitForFunction(() => document.getElementById('summary').textContent.includes('오류 1'));
    await page.locator('#inventory').setInputFiles({ name: 'broken.json', mimeType: 'application/json', buffer: Buffer.from('{}') });
    await page.waitForFunction(() => document.getElementById('inventory-info').classList.contains('error'));
    assert.equal(await page.locator('#run').isDisabled(), true);
    assert.deepEqual(errors, []);
    assert.deepEqual(externalRequests, []);
    console.log('PASS: local HTTP launch, 10-photo comparison (6 match / 4 not found), incomplete export (4 review), empty-file error, bad inventory rejection, report download, zero external requests.');
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
