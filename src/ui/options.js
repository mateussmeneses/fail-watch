// Pagina de opcoes: le e grava as settings via service worker.
import { MSG, DEFAULT_SETTINGS } from '../shared/constants.js';

function $(id) {
  return document.getElementById(id);
}

function sendMessage(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (resp) => {
        void chrome.runtime.lastError;
        resolve(resp || { ok: false });
      });
    } catch (_e) {
      resolve({ ok: false });
    }
  });
}

function fillForm(s) {
  $('minStatus').value = s.minStatusToCapture;
  $('captureNetworkErrors').checked = !!s.captureNetworkErrors;
  $('maxEntries').value = s.maxEntries;
  $('maxBodyChars').value = s.maxBodyChars;
  $('redactionEnabled').checked = !!s.redactionEnabled;
  $('redactHeaders').value = (s.redactHeaders || []).join('\n');
  $('webRequestFallback').checked = !!s.webRequestFallback;
  $('domainMode').value = s.domainMode || 'all';
  $('domainPatterns').value = (s.domainPatterns || []).join('\n');
  $('captureScreenshot').checked = !!s.captureScreenshot;
  $('screenshotThrottleMs').value = s.screenshotThrottleMs;
  syncDomainVisibility();
}

function syncDomainVisibility() {
  const mode = $('domainMode').value;
  $('domainPatternsField').style.display = mode === 'all' ? 'none' : 'block';
}

function readForm() {
  const redactHeaders = $('redactHeaders')
    .value.split('\n')
    .map((l) => l.trim().toLowerCase())
    .filter(Boolean);

  const domainPatterns = $('domainPatterns')
    .value.split('\n')
    .map((l) => l.trim().toLowerCase())
    .filter(Boolean);

  return {
    minStatusToCapture: clampInt($('minStatus').value, 100, 599, 400),
    captureNetworkErrors: $('captureNetworkErrors').checked,
    maxEntries: clampInt($('maxEntries').value, 10, 10000, 500),
    maxBodyChars: clampInt($('maxBodyChars').value, 1000, 5000000, 100000),
    redactionEnabled: $('redactionEnabled').checked,
    redactHeaders,
    webRequestFallback: $('webRequestFallback').checked,
    domainMode: $('domainMode').value,
    domainPatterns,
    captureScreenshot: $('captureScreenshot').checked,
    screenshotThrottleMs: clampInt($('screenshotThrottleMs').value, 500, 60000, 3000)
  };
}

function clampInt(value, min, max, fallback) {
  let n = parseInt(value, 10);
  if (Number.isNaN(n)) n = fallback;
  return Math.max(min, Math.min(max, n));
}

let noteTimer = null;
function showSaved() {
  const note = $('saveNote');
  note.classList.add('show');
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => note.classList.remove('show'), 1500);
}

async function init() {
  const resp = await sendMessage({ type: MSG.GET_SETTINGS });
  fillForm((resp && resp.ok && resp.settings) || DEFAULT_SETTINGS);

  $('domainMode').addEventListener('change', syncDomainVisibility);

  $('save').addEventListener('click', async () => {
    const settings = readForm();
    await sendMessage({ type: MSG.SET_SETTINGS, settings });
    fillForm(settings);
    showSaved();
  });

  $('reset').addEventListener('click', async () => {
    await sendMessage({ type: MSG.SET_SETTINGS, settings: { ...DEFAULT_SETTINGS } });
    fillForm({ ...DEFAULT_SETTINGS });
    showSaved();
  });
}

init();
