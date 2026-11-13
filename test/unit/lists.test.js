'use strict';

// Tests for the packaged list data in extension/lists/, independent of the blocking logic.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const M = require('../../extension/lib/matcher.js');
const L = require('../../extension/lib/lists.js');

const EXT = path.join(__dirname, '../../extension');
const read = (file) => fs.readFileSync(path.join(EXT, file), 'utf8');
const readFile = async (file) => read(file);
const entries = (file) => read(file).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

let list;
test.before(async () => {
  list = await L.loadBuiltinList(readFile);
});

test('every list file holds one canonical, unique domain per line', () => {
  for (const file of [...L.BUILTIN_FILES, L.NEVER_BLOCK_FILE]) {
    const seen = new Set();
    for (const line of entries(file)) {
      const entry = M.parseEntry(line);
      assert.ok(entry && !entry.path, `${file}: "${line}" is not a plain domain`);
      assert.equal(entry.host, line, `${file}: "${line}" is not in canonical form`);
      assert.ok(!seen.has(line), `${file}: duplicate "${line}"`);
      seen.add(line);
    }
  }
});

test('the distraction list header gives the date the list was last reviewed', () => {
  const meta = L.readHeader(read(L.BUILTIN_FILES[0]));
  assert.match(meta['list-date'], /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(list.listDate, meta['list-date']);
});

test('the distraction list has no entries already covered by a parent entry', () => {
  const domains = new Set(entries(L.BUILTIN_FILES[0]));
  const redundant = [...domains].filter((d) => {
    const dot = d.indexOf('.');
    return dot !== -1 && M.findDomain(d.slice(dot + 1), domains);
  });
  assert.deepEqual(redundant, []);
});

test('the built-in list loads every distraction without any download', () => {
  assert.ok(list.count >= 30, `only ${list.count} sites`);
  for (const domain of entries(L.BUILTIN_FILES[0])) {
    assert.ok(list.hosts.has(domain), `entry ${domain} missing`);
  }
  for (const domain of ['tiktok.com', 'instagram.com', 'snapchat.com']) {
    assert.ok(list.hosts.has(domain), `${domain} should be on the list`);
  }
});

test('no study or work essential is blocked by the built-in list', () => {
  const neverBlock = entries(L.NEVER_BLOCK_FILE);
  assert.ok(neverBlock.length > 20);
  for (const domain of neverBlock) {
    assert.equal(M.findDomain(domain, list.hosts), null, `${domain} would be blocked`);
  }
});

test('domain matching follows label boundaries, not text similarity', () => {
  const m = M.createMatcher({ lists: [{ id: 'builtin', hosts: list.hosts }], keywordBlocking: false });
  const blocked = (host) => m.check(`https://${host}/`) !== null;
  // Listed sites and their subdomains are blocked...
  for (const host of ['tiktok.com', 'www.tiktok.com', 'vm.tiktok.com', 'instagram.com', 'www.twitch.tv', 'x.com']) {
    assert.ok(blocked(host), `${host} should be blocked`);
  }
  // ...but names that merely contain a listed name are not.
  for (const host of [
    'tiktok.com.example', 'nottiktok.example', 'redditch.gov.uk', 'xbox.com', 'max.com',
    'netflix.com.example', 'robloxian.example', 'bbc.co.uk', 'en.wikipedia.org',
  ]) {
    assert.ok(!blocked(host), `${host} should not be blocked`);
  }
});

test('lookups stay fast', () => {
  const m = M.createMatcher({ lists: [{ id: 'builtin', hosts: list.hosts }], keywords: ['tiktok'], keywordBlocking: true });
  const urls = ['https://a.b.c.example.co.uk/path?q=1', 'https://www.tiktok.com/', 'https://en.wikipedia.org/wiki/X'];
  const start = process.hrtime.bigint();
  for (let i = 0; i < 100000; i++) m.check(urls[i % urls.length], { mainFrame: true });
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  assert.ok(ms < 3000, `100,000 checks took ${ms.toFixed(0)} ms`);
});
