const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const core = require('../photo-check/core');
const reader = require('../photo-check/hash-reader');
const hash = createHash('sha1').update('original').digest('base64');
const other = createHash('sha1').update('new').digest('base64');
test('standard padded Base64 SHA-1 including plus and slash', () => {
  assert.equal(core.keyFromBytes(new Uint8Array(20).fill(255)), '//////////////////////////8=');
  assert.equal(reader.validHash('//////////////////////////8='), true);
  assert.equal(core.keyFromBytes(new Uint8Array(20).fill(251)), Buffer.alloc(20, 251).toString('base64'));
  assert.ok(core.keyFromBytes(new Uint8Array(20).fill(251)).includes('+'));
  assert.equal(reader.validHash('__________________________8'), false);
  assert.equal(reader.validHash('//////////////////////////9='), false);
});
test('response hash controls mapping; renamed bytes match despite unrelated dedupKey', () => {
  const matches = reader.parseMatches([[[hash, ['media', null, null, other]]]], [hash, other]);
  const response = { hashes: [hash, other], matches, account: 'test', queriedAt: 'now' };
  assert.equal(core.compareFile({ name: 'original' }, hash, response).status, 'match');
  assert.equal(core.compareFile({ name: 'renamed' }, hash, response).status, 'match');
  assert.equal(core.compareFile({ name: 'new' }, other, response).status, 'not_found');
});
test('explicit empty list is valid; null and malformed results are errors', () => {
  assert.deepEqual(reader.parseMatches([[]], [hash]), []);
  for (const data of [null, [], [null], {}, [[[hash, null]]], [[[other, ['media']]]]]) {
    assert.throws(() => reader.parseMatches(data, [hash]));
  }
});
test('RPC envelope must be exact, present and valid JSON', () => {
  assert.deepEqual(reader.decodeResponse(")]}'\n42\n" + JSON.stringify([['wrb.fr', 'swbisb', '[[]]']])), [[]]);
  for (const text of ['<html>login</html>', '[["wrb.fr","lcxiM","[[]]"]]', '[["wrb.fr","swbisb",null]]']) assert.throws(() => reader.decodeResponse(text));
});
test('request uses web hash RPC, selected account and standard Base64 only', () => {
  const request = reader.buildRequest({ SNlM0e: 'test', eptZe: '/_/PhotosUi/' }, '/u/2/photos', [hash]);
  assert.equal(new URL(request.url).searchParams.get('authuser'), '2');
  const wrapped = JSON.parse(new URLSearchParams(request.body).get('f.req'));
  assert.equal(wrapped[0][0][0], 'swbisb');
  assert.deepEqual(JSON.parse(wrapped[0][0][1]), [[hash], null, 3, 0]);
  assert.throws(() => reader.buildRequest({ SNlM0e: 'test', eptZe: '//evil.invalid/' }, '/', [hash]));
});
test('CSV protects formulas and includes per-file account and timestamp', () => {
  const response = { hashes: [hash], matches: [], account: 'me', queriedAt: 'today' };
  assert.match(core.reportCsv([core.compareFile({ name: '=formula', size: 1 }, hash, response)]), /'=formula/);
});
