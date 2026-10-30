'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const exporter = require('../photo-check/export-google-photos.user.js');

function row(id = 'media-1') {
  const value = [id, ['https://unused.example/thumbnail', 100, 80], 1700000000000,
    createHash('sha1').update(id).digest('base64url'), null, 1700000001000, null, [[20]]];
  for (let i = 8; i < 12; i++) value[i] = null;
  value[12] = [];
  value[13] = false;
  return value;
}

test('request uses only library-read RPC with explicit account and archive scope', () => {
  const request = exporter.buildRequest({ SNlM0e: 'test-only', eptZe: '/u/2/_/PhotosUi/', FdrFJe: 'session', cfb2h: 'build' }, '/u/2/photos', 'cursor');
  const url = new URL(request.url);
  assert.equal(url.origin, 'https://photos.google.com');
  assert.equal(url.searchParams.get('rpcids'), 'lcxiM');
  assert.equal(url.searchParams.get('authuser'), '2');
  const wrapper = JSON.parse(new URLSearchParams(request.body).get('f.req'));
  assert.deepEqual(JSON.parse(wrapper[0][0][1]), ['cursor', null, 500, null, 1, 3]);
  assert.throws(() => exporter.buildRequest({ SNlM0e: 'test', eptZe: '//evil.example/' }, '/photos', null));
});

test('decoder handles batchexecute framing and rejects wrong RPC/empty responses', () => {
  const data = [[row()], null, 'timestamp'];
  const envelope = JSON.stringify([['wrb.fr', 'lcxiM', JSON.stringify(data), null]]);
  assert.deepEqual(exporter.decodeResponse(")]}'\n\n1234\n" + envelope + '\n'), data);
  assert.throws(() => exporter.decodeResponse('[]'));
  assert.throws(() => exporter.decodeResponse(JSON.stringify([['wrb.fr', 'wrong', '[]']])));
  assert.throws(() => exporter.decodeResponse(JSON.stringify([['wrb.fr', 'lcxiM', null]])));
});

test('metadata parser omits thumbnail, credentials and malformed rows', () => {
  const page = exporter.parsePage([[row()], null]);
  assert.equal(page.items[0].width, 100);
  assert.ok(!JSON.stringify(page).includes('https://'));
  for (const invalid of [[], {}, [[], 123], [[[]], null], [undefined, null]]) assert.throws(() => exporter.parsePage(invalid));
});

test('collect follows all pages and marks complete only at terminal cursor', async () => {
  const cursors = [];
  const result = await exporter.collect(async cursor => {
    cursors.push(cursor);
    return cursor === null ? [[row('a')], 'next'] : [[row('b')], null];
  }, 'account@example.invalid');
  assert.deepEqual(cursors, [null, 'next']);
  assert.equal(result.complete, true);
  assert.equal(result.items.length, 2);
  assert.equal(result.pages, 2);
});

test('failure after first page retains partial records and never reports completeness', async () => {
  const result = await exporter.collect(async cursor => {
    if (cursor) throw new Error('controlled network error');
    return [[row()], 'next'];
  }, 'account@example.invalid');
  assert.equal(result.complete, false);
  assert.equal(result.items.length, 1);
  assert.equal(result.errors.length, 1);
});

test('repeated page, changed identifier and cancellation stay incomplete', async () => {
  const repeat = await exporter.collect(async () => [[row()], 'same'], 'test@example.invalid');
  assert.equal(repeat.complete, false);
  const changed = await exporter.collect(async cursor => {
    const value = row(); if (cursor) value[3] = 'changed';
    return [[value], cursor ? null : 'next'];
  }, 'test@example.invalid');
  assert.equal(changed.complete, false);
  const cancelled = await exporter.collect(async () => assert.fail('must not request'), 'test@example.invalid', () => {}, () => true);
  assert.equal(cancelled.complete, false);
  assert.equal(cancelled.items.length, 0);
});
