'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const M = require('../../extension/lib/matcher.js');
const D = require('../../extension/lib/defaults.js');

// The built-in distraction list; the list files themselves are covered in lists.test.js.
const BUILTIN = M.parseHostList(fs.readFileSync(path.join(__dirname, '../../extension/lists/distractions.txt'), 'utf8'));

const defaultMatcher = (overrides = {}) => M.createMatcher({
  lists: [{ id: 'builtin', hosts: BUILTIN }],
  keywords: D.DEFAULT_KEYWORDS,
  keywordBlocking: true,
  searchBlocking: true,
  ...overrides,
});

test('parseEntry accepts the common ways of writing a site', () => {
  const cases = {
    'Example.COM': 'example.com',
    'https://www.example.com/': 'example.com',
    'http://user@example.com:8080/a?b#c': 'example.com/a',
    '*.example.com': 'example.com',
    '.example.com': 'example.com',
    '0.0.0.0 example.com': 'example.com',
    '127.0.0.1   example.com # tracker': 'example.com',
    '||example.com^': 'example.com',
    'reddit.com/r/Gaming/': 'reddit.com/r/gaming',
    'example.com?x=1': 'example.com',
    'example.com.': 'example.com',
    '127.0.0.1/members': '127.0.0.1/members',
  };
  for (const [input, expected] of Object.entries(cases)) {
    const entry = M.parseEntry(input);
    assert.ok(entry, `parsed ${input}`);
    assert.equal(M.formatEntry(entry), expected, input);
  }
});

test('parseEntry rejects comments and junk', () => {
  for (const input of ['', '   ', '# comment', '! adblock comment', 'two words', 'http://', 'exa mple.com', 'bad$host.com']) {
    assert.equal(M.parseEntry(input), null, JSON.stringify(input));
  }
});

test('normalizeRuleList de-duplicates and reports bad lines', () => {
  const { valid, invalid } = M.normalizeRuleList(['example.com', 'www.example.com', 'https://example.com/', '', 'not valid', 'b.com']);
  assert.deepEqual(valid, ['example.com', 'b.com']);
  assert.deepEqual(invalid, ['not valid']);
});

test('parseHostList reads hosts files and skips placeholders', () => {
  const text = [
    '# Title: test',
    '127.0.0.1 localhost',
    '0.0.0.0 0.0.0.0',
    '::1 ip6-localhost',
    '0.0.0.0 game-site.com',
    '0.0.0.0 www.game-site.com',
    '0.0.0.0 other.net # comment',
    'plain-domain.org',
    '',
  ].join('\r\n');
  assert.deepEqual(M.parseHostList(text).sort(), ['game-site.com', 'other.net', 'plain-domain.org']);
});

test('distracting sites are blocked, including www and subdomains', () => {
  const m = defaultMatcher();
  for (const url of [
    'https://tiktok.com/',
    'https://www.tiktok.com/@someone/video/1',
    'https://vm.tiktok.com/abc/',
    'https://www.instagram.com/explore/',
    'https://web.snapchat.com/',
    'https://www.twitch.tv/directory',
    'https://www.roblox.com/games',
    'wss://pubsub-edge.twitch.tv/v1',
  ]) {
    const verdict = m.check(url, { mainFrame: true });
    assert.ok(verdict, url);
    assert.equal(verdict.reason, 'list', url);
  }
});

test('study and everyday sites are not blocked (no keyword false positives)', () => {
  const m = defaultMatcher();
  for (const url of [
    'https://www.google.com/',
    'https://www.youtube.com/watch?v=abc',
    'https://en.wikipedia.org/wiki/Photosynthesis',
    'https://www.khanacademy.org/math',
    'https://www.bbc.co.uk/bitesize',
    'https://github.com/',
    'https://www.redditch.gov.uk/',
    'https://www.xbox.com/',
    'https://max.com/',
    'https://www.amazon.co.uk/',
  ]) {
    assert.equal(m.check(url, { mainFrame: true }), null, url);
  }
});

test('keywords in the site address block unknown look-alike sites', () => {
  const m = defaultMatcher();
  assert.deepEqual(m.check('https://tiktok-viewer.example/', { mainFrame: true }),
    { reason: 'keyword', rule: 'tiktok', host: 'tiktok-viewer.example' });
  assert.equal(m.check('https://instagram-stories.example/').reason, 'keyword');
  assert.equal(defaultMatcher({ keywordBlocking: false }).check('https://tiktok-viewer.example/'), null);
});

test('searches containing keywords are blocked on main-frame loads only', () => {
  const m = defaultMatcher();
  const verdict = m.check('https://www.google.co.uk/search?q=TikTok+trends', { mainFrame: true });
  assert.deepEqual(verdict, { reason: 'search', rule: 'tiktok', host: 'google.co.uk', engine: 'Google' });
  assert.equal(m.check('https://www.bing.com/images/search?q=instagram', { mainFrame: true }).engine, 'Bing');
  assert.equal(m.check('https://duckduckgo.com/?q=snapchat', { mainFrame: true }).engine, 'DuckDuckGo');
  assert.equal(m.check('https://www.youtube.com/results?search_query=tiktok', { mainFrame: true }).engine, 'YouTube');
  assert.equal(m.check('https://search.yahoo.com/search?p=tiktok', { mainFrame: true }).engine, 'Yahoo');
  assert.equal(m.check('https://www.google.com/search?q=tiktok', { mainFrame: false }), null);
  assert.equal(m.check('https://www.google.com/search?q=tiktok'), null);
  assert.equal(m.check('https://www.google.com/search?q=weather+london', { mainFrame: true }), null);
  assert.equal(m.check('https://www.youtube.com/watch?search_query=tiktok', { mainFrame: true }), null, 'YouTube only on /results');
  assert.equal(defaultMatcher({ searchBlocking: false }).check('https://www.google.com/search?q=tiktok', { mainFrame: true }), null);
});

test('custom block rules cover subdomains, and path rules respect boundaries', () => {
  const m = defaultMatcher({ customBlock: ['example.com', 'youtube.com/shorts'] });
  assert.equal(m.check('https://example.com/').reason, 'custom');
  assert.equal(m.check('https://a.b.example.com/x').rule, 'example.com');
  assert.equal(m.check('https://notexample.com/'), null);
  assert.equal(m.check('https://www.youtube.com/shorts/abc123').rule, 'youtube.com/shorts');
  assert.equal(m.check('https://m.youtube.com/Shorts/xyz').reason, 'custom');
  assert.equal(m.check('https://www.youtube.com/shortsfilm'), null);
  assert.equal(m.check('https://www.youtube.com/watch?v=abc'), null);
});

test('specificity ranks domain depth first, then path depth', () => {
  assert.ok(M.specificity('a.example.com') > M.specificity('example.com'));
  assert.ok(M.specificity('example.com/videos') > M.specificity('example.com'));
  assert.ok(M.specificity('example.com/a/b') > M.specificity('example.com/a'));
  assert.ok(M.specificity('a.example.com') > M.specificity('example.com/a/b/c'));
  assert.equal(M.specificity('example.com'), M.specificity('other.org'));
});

test('priority rule 1: the more specific entry wins, whichever list it is on', () => {
  const lists = [{ id: 'builtin', hosts: ['games.example', 'bad.example.org', 'listed.net'] }];
  const m = defaultMatcher({
    lists,
    allow: ['maths.games.example', 'example.org', 'mail.example.net', 'listed.net/safe'],
    customBlock: ['sub.example.org', 'example.net', 'example.org/private'],
  });
  // exception more specific than a list entry
  assert.equal(m.check('https://maths.games.example/'), null, 'exception beats the whole-site list entry');
  assert.equal(m.check('https://arcade.games.example/').reason, 'list');
  // list entry more specific than an exception
  assert.equal(m.check('https://example.org/'), null);
  assert.equal(m.check('https://ok.example.org/'), null, 'exception covers subdomains');
  assert.deepEqual(m.check('https://bad.example.org/'), { reason: 'list', list: 'builtin', rule: 'bad.example.org', host: 'bad.example.org' });
  // your own entries
  assert.equal(m.check('https://sub.example.org/').reason, 'custom', 'more specific block wins');
  assert.equal(m.check('https://example.org/private/x').reason, 'custom', 'path block beats whole-site exception');
  assert.equal(m.check('https://example.net/').reason, 'custom');
  assert.equal(m.check('https://mail.example.net/'), null, 'more specific exception wins');
  // path exception inside a listed site
  assert.equal(m.check('https://listed.net/safe/page'), null, 'path exception beats whole-site list entry');
  assert.equal(m.check('https://listed.net/other').reason, 'list');
});

test('priority rule 2: exact ties block for your own list, allow for the built-in list', () => {
  const lists = [{ id: 'builtin', hosts: ['reddit.com', 'shared.com'] }];
  assert.equal(defaultMatcher({ lists, allow: ['reddit.com'] }).check('https://www.reddit.com/'), null, 'exception fixes a list entry');
  assert.equal(defaultMatcher({ lists, allow: ['reddit.com'] }).check('https://old.reddit.com/'), null, 'and its subdomains');
  assert.equal(defaultMatcher({ allow: ['a.com'], customBlock: ['a.com'] }).check('https://a.com/').reason, 'custom', 'your block beats your exception');
  assert.equal(defaultMatcher({ lists, allow: ['shared.com'], customBlock: ['shared.com'] }).check('https://shared.com/').reason, 'custom',
    'an entry on both your list and the built-in list still beats the exception');
});

test('priority rule 3: exceptions switch off address keywords but not search blocking', () => {
  const m = defaultMatcher({ allow: ['tiktoktutorials.example', 'google.com'] });
  assert.equal(m.check('https://www.tiktoktutorials.example/'), null);
  assert.equal(m.check('https://tiktokclips.example/').reason, 'keyword');
  assert.equal(m.check('https://www.google.com/search?q=tiktok', { mainFrame: true }).reason, 'search');
});

test('non-web and malformed URLs are ignored', () => {
  const m = defaultMatcher({ customBlock: ['example.com'] });
  for (const url of ['about:blank', 'moz-extension://abc/pages/blocked.html', 'file:///C:/tiktok.html', 'data:text/html,tiktok', 'not a url', '']) {
    assert.equal(m.check(url, { mainFrame: true }), null, url);
  }
});

test('an empty keyword list disables keyword and search blocking', () => {
  const m = defaultMatcher({ keywords: [] });
  assert.equal(m.check('https://tiktok-viewer.example/'), null);
  assert.equal(m.check('https://www.google.com/search?q=tiktok', { mainFrame: true }), null);
});
