/* global SBDefaults, SBMatcher, SBSettings, SBLock, SBWarnings */
'use strict';

const $ = (id) => document.getElementById(id);
const LIST_FIELDS = ['customBlock', 'allow', 'keywords'];
const MIN_KEYWORD_LENGTH = 3;

async function init() {
  if (await SBLock.isSet()) {
    $('lockScreen').hidden = false;
    $('unlockPassword').focus();
  } else {
    await showSettings();
  }
}

$('unlockForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!(await SBLock.verify($('unlockPassword').value))) {
    $('unlockError').hidden = false;
    $('unlockPassword').select();
    return;
  }
  $('lockScreen').hidden = true;
  $('unlockPassword').value = '';
  await showSettings();
});

async function showSettings() {
  $('main').hidden = false;
  $('welcome').hidden = location.hash !== '#welcome';
  $('version').textContent = browser.runtime.getManifest().version;
  renderSettings(await SBSettings.getSettings());
  await Promise.all([renderListInfo(), renderLockState(), SBWarnings.render($('warnings'))]);
}

function renderSettings(settings) {
  for (const input of document.querySelectorAll('[data-setting]')) {
    input.checked = Boolean(settings[input.dataset.setting]);
  }
  for (const field of LIST_FIELDS) $(field).value = settings[field].join('\n');
  renderDependencies(settings);
}

function renderDependencies(settings) {
  document.body.classList.toggle('builtin-off', !settings.useBuiltinList);
}

async function renderListInfo() {
  const { count, listDate } = await browser.runtime.sendMessage({ type: 'getListInfo' });
  $('builtinCount').textContent = count.toLocaleString();
  if (listDate) {
    const date = new Date(`${listDate}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
    $('builtinDate').textContent = ` (list from ${date})`;
  }
}

function showStatus(id, text, isError = false) {
  const el = $(id);
  el.textContent = text;
  el.classList.toggle('error', isError);
}

// ---- Switches save immediately ----

for (const input of document.querySelectorAll('[data-setting]')) {
  input.addEventListener('change', async () => {
    renderDependencies(await SBSettings.saveSettings({ [input.dataset.setting]: input.checked }));
  });
}

// ---- Lists save on button press ----

function cleanKeywords(lines) {
  const valid = [];
  const invalid = [];
  for (const line of lines) {
    const keyword = line.trim().toLowerCase();
    if (!keyword) continue;
    if (keyword.length < MIN_KEYWORD_LENGTH) invalid.push(keyword);
    else if (!valid.includes(keyword)) valid.push(keyword);
  }
  return { valid, invalid };
}

async function saveList(field) {
  const lines = $(field).value.split(/\r?\n/);
  const { valid, invalid } = field === 'keywords' ? cleanKeywords(lines) : SBMatcher.normalizeRuleList(lines);
  await SBSettings.saveSettings({ [field]: valid });
  $(field).value = valid.join('\n');
  const saved = `Saved ${valid.length} ${valid.length === 1 ? 'entry' : 'entries'}.`;
  if (invalid.length) {
    showStatus(`${field}Status`, `${saved} Ignored: ${invalid.join(', ')}`, true);
  } else {
    showStatus(`${field}Status`, saved);
  }
}

for (const button of document.querySelectorAll('[data-save]')) {
  button.addEventListener('click', () => saveList(button.dataset.save));
}
for (const field of LIST_FIELDS) {
  $(field).addEventListener('input', () => showStatus(`${field}Status`, 'Unsaved changes'));
}

$('keywordsReset').addEventListener('click', async () => {
  $('keywords').value = SBDefaults.DEFAULT_KEYWORDS.join('\n');
  await saveList('keywords');
});

// ---- Password lock ----

async function renderLockState() {
  const isSet = await SBLock.isSet();
  $('lockState').textContent = isSet
    ? 'A password is set. It is needed to open these settings and change what is blocked.'
    : 'No password is set, so anyone using this browser can change what is blocked.';
  $('setPasswordBtn').textContent = isSet ? 'Change password' : 'Set password';
  $('removePasswordBtn').hidden = !isSet;
}

$('passwordForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const password = $('newPassword').value;
  if (password.length < 4) return showStatus('passwordStatus', 'Use at least 4 characters.', true);
  if (password !== $('confirmPassword').value) return showStatus('passwordStatus', "The passwords don't match.", true);
  await SBLock.set(password);
  $('newPassword').value = '';
  $('confirmPassword').value = '';
  showStatus('passwordStatus', 'Password saved.');
  await renderLockState();
});

$('removePasswordBtn').addEventListener('click', async () => {
  await SBLock.set('');
  showStatus('passwordStatus', 'Password removed.');
  await renderLockState();
});

init();
