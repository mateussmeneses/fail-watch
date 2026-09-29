// Service worker (MV3). Orquestra a captura:
//   - recebe falhas da content script (fetch/XHR injetado)
//   - rede de seguranca via chrome.webRequest (falhas que a injecao nao ve)
//   - aplica filtros: status minimo, erros de rede, regras por dominio
//   - agrupa falhas repetidas (incrementa contador em vez de duplicar)
//   - captura screenshot da aba no momento da falha (opcional)
//   - redige headers sensiveis e trunca corpos grandes
//   - persiste em IndexedDB e mantem o limite maximo
//   - atualiza o badge do icone e notifica as UIs

import {
  MSG,
  applyRedaction,
  truncateBody,
  shouldCaptureDomain,
  groupKeyOf
} from '../shared/constants.js';
import { getSettings, setSettings } from '../shared/settings.js';
import {
  addFailure,
  putFailure,
  getFailures,
  getFailure,
  findByGroupKey,
  deleteFailure,
  clearFailures,
  countFailures,
  pruneToLimit
} from './storage.js';

// ---------------------------------------------------------------------------
// Badge
// ---------------------------------------------------------------------------
async function refreshBadge() {
  try {
    const count = await countFailures();
    const text = count > 999 ? '999+' : count > 0 ? String(count) : '';
    await chrome.action.setBadgeText({ text });
    await chrome.action.setBadgeBackgroundColor({ color: '#d93025' });
  } catch (_e) {
    /* ignore */
  }
}

// Notifica UIs abertas que a lista mudou (elas re-buscam).
function broadcastChange() {
  try {
    chrome.runtime.sendMessage({ type: MSG.FAILURES_CHANGED }, () => {
      void chrome.runtime.lastError; // ninguem ouvindo: ok
    });
  } catch (_e) {
    /* ignore */
  }
}

function genId() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

// ---------------------------------------------------------------------------
// Screenshot (com throttle por aba)
// ---------------------------------------------------------------------------
const lastShotByTab = new Map(); // tabId -> timestamp

async function maybeCaptureScreenshot(tabId, settings) {
  if (!settings.captureScreenshot) return null;
  if (tabId == null) return null;
  const now = Date.now();
  const last = lastShotByTab.get(tabId) || 0;
  if (now - last < (settings.screenshotThrottleMs || 3000)) return null;
  lastShotByTab.set(tabId, now);
  try {
    // Descobre a janela da aba e captura apenas se ela estiver ativa/visivel.
    const tab = await chrome.tabs.get(tabId);
    if (!tab || !tab.active) return null;
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: 'jpeg',
      quality: 60
    });
    return dataUrl || null;
  } catch (_e) {
    // captureVisibleTab falha se a aba nao estiver visivel: ok, ignora.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Dedup para a rede de seguranca (webRequest): evita gravar de novo algo que
// a injecao de fetch/XHR ja capturou (ou vice-versa) na mesma janela curta.
// ---------------------------------------------------------------------------
const recentSeen = new Map(); // dedupKey -> timestamp
const DEDUP_WINDOW_MS = 4000;

function dedupKey(method, url, status) {
  return (method || 'GET').toUpperCase() + ' ' + (url || '') + ' ' + (status || 0);
}

function markSeen(key) {
  recentSeen.set(key, Date.now());
  // Limpeza preguicosa para nao crescer sem limite.
  if (recentSeen.size > 500) {
    const cutoff = Date.now() - DEDUP_WINDOW_MS;
    for (const [k, t] of recentSeen) {
      if (t < cutoff) recentSeen.delete(k);
    }
  }
}

function wasRecentlySeen(key) {
  const t = recentSeen.get(key);
  return t != null && Date.now() - t < DEDUP_WINDOW_MS;
}

// ---------------------------------------------------------------------------
// Nucleo: processa e grava (ou agrega) uma falha.
// `source` = 'inject' | 'webRequest'
// ---------------------------------------------------------------------------
async function processFailure(entry, sender, source) {
  if (!entry || typeof entry !== 'object') return;

  const settings = await getSettings();

  const isNetworkError = entry.errorType != null;
  const status = Number(entry.status) || 0;

  // Filtro: status / erros de rede.
  if (isNetworkError) {
    if (!settings.captureNetworkErrors) return;
  } else if (status < settings.minStatusToCapture) {
    return;
  }

  // Filtro: regras por dominio.
  if (!shouldCaptureDomain(entry.url, settings)) return;

  // Dedup entre fontes (inject x webRequest).
  const dkey = dedupKey(entry.method, entry.url, isNetworkError ? 0 : status);
  if (source === 'webRequest' && wasRecentlySeen(dkey)) {
    // A injecao provavelmente ja pegou com mais detalhe (response body).
    return;
  }
  markSeen(dkey);

  const tabId = (sender && sender.tab && sender.tab.id) != null
    ? sender.tab.id
    : (entry.tabId != null ? entry.tabId : null);

  // Agrupamento: se ja existe uma falha do mesmo grupo, agrega.
  const groupKey = groupKeyOf(entry);
  const existing = await findByGroupKey(groupKey);
  if (existing) {
    existing.count = (existing.count || 1) + 1;
    existing.lastSeen = entry.timestamp || Date.now();
    existing.timestamp = existing.lastSeen; // sobe na lista por recencia
    // Se a nova ocorrencia tem mais detalhe (veio da injecao) e a antiga nao,
    // enriquece o registro guardado.
    if (source === 'inject' && existing.source === 'webRequest') {
      const reqBody = truncateBody(entry.requestBody || '', settings.maxBodyChars);
      const respBody = truncateBody(entry.responseBody || '', settings.maxBodyChars);
      existing.source = 'inject';
      existing.kind = entry.kind || existing.kind;
      existing.requestHeaders = applyRedaction(entry.requestHeaders || {}, settings);
      existing.requestBody = reqBody.text;
      existing.requestBodyTruncated = reqBody.truncated;
      existing.requestBodyOriginalLength = reqBody.originalLength;
      existing.responseHeaders = applyRedaction(entry.responseHeaders || {}, settings);
      existing.responseBody = respBody.text;
      existing.responseBodyTruncated = respBody.truncated;
      existing.responseBodyOriginalLength = respBody.originalLength;
    }
    try {
      await putFailure(existing);
      await refreshBadge();
      broadcastChange();
    } catch (_e) {
      /* ignore */
    }
    return;
  }

  // Novo grupo: cria o registro.
  const reqBody = truncateBody(entry.requestBody || '', settings.maxBodyChars);
  const respBody = truncateBody(entry.responseBody || '', settings.maxBodyChars);

  const screenshot = await maybeCaptureScreenshot(tabId, settings);

  const record = {
    id: entry.id || genId(),
    groupKey,
    count: 1,
    firstSeen: entry.timestamp || Date.now(),
    lastSeen: entry.timestamp || Date.now(),
    source: source || 'inject',
    kind: entry.kind || (source === 'webRequest' ? 'webrequest' : 'fetch'),
    method: entry.method || 'GET',
    url: entry.url || '',
    requestHeaders: applyRedaction(entry.requestHeaders || {}, settings),
    requestBody: reqBody.text,
    requestBodyTruncated: reqBody.truncated,
    requestBodyOriginalLength: reqBody.originalLength,
    status,
    statusText: entry.statusText || '',
    responseHeaders: applyRedaction(entry.responseHeaders || {}, settings),
    responseBody: respBody.text,
    responseBodyTruncated: respBody.truncated,
    responseBodyOriginalLength: respBody.originalLength,
    errorType: entry.errorType || null,
    error: entry.error || null,
    startedAt: entry.startedAt || Date.now(),
    durationMs: Number(entry.durationMs) || 0,
    pageUrl: entry.pageUrl || (sender && sender.tab && sender.tab.url) || '',
    tabId,
    note: '',
    screenshot: screenshot || null,
    timestamp: entry.timestamp || Date.now()
  };

  try {
    await addFailure(record);
    await pruneToLimit(settings.maxEntries);
    await refreshBadge();
    broadcastChange();
  } catch (_e) {
    /* se o add falhar (ex.: id duplicado), ignora */
  }
}

// ---------------------------------------------------------------------------
// Rede de seguranca via chrome.webRequest.
// Nao expoe response body no MV3, mas garante que nenhuma falha de rede ou
// status de erro passe despercebida (inclusive fora do contexto da pagina).
// ---------------------------------------------------------------------------
function installWebRequestListeners() {
  if (!chrome.webRequest) return;
  const filter = { urls: ['<all_urls>'] };

  chrome.webRequest.onCompleted.addListener((details) => {
    // Ignora as proprias requests da extensao.
    if (details.type === 'main_frame' && details.statusCode < 400) return;
    if (details.statusCode < 400) return;
    const entry = {
      id: genId(),
      kind: 'webrequest',
      method: details.method,
      url: details.url,
      requestHeaders: {},
      requestBody: '',
      status: details.statusCode,
      statusText: '',
      responseHeaders: {},
      responseBody: '',
      errorType: null,
      error: null,
      startedAt: details.timeStamp || Date.now(),
      durationMs: 0,
      pageUrl: details.initiator || details.documentUrl || '',
      tabId: details.tabId != null && details.tabId >= 0 ? details.tabId : null,
      timestamp: Date.now()
    };
    processFailure(entry, { tab: { id: entry.tabId } }, 'webRequest');
  }, filter);

  chrome.webRequest.onErrorOccurred.addListener((details) => {
    // net::ERR_ABORTED e comum e raramente util; ignora.
    if (details.error && details.error.indexOf('ERR_ABORTED') >= 0) return;
    const entry = {
      id: genId(),
      kind: 'webrequest',
      method: details.method,
      url: details.url,
      requestHeaders: {},
      requestBody: '',
      status: 0,
      statusText: '',
      responseHeaders: {},
      responseBody: '',
      errorType: 'network',
      error: details.error || 'Network error',
      startedAt: details.timeStamp || Date.now(),
      durationMs: 0,
      pageUrl: details.initiator || details.documentUrl || '',
      tabId: details.tabId != null && details.tabId >= 0 ? details.tabId : null,
      timestamp: Date.now()
    };
    processFailure(entry, { tab: { id: entry.tabId } }, 'webRequest');
  }, filter);
}

// Instala os listeners conforme a setting webRequestFallback.
let webRequestInstalled = false;
async function syncWebRequest() {
  const settings = await getSettings();
  if (settings.webRequestFallback && !webRequestInstalled && chrome.webRequest) {
    installWebRequestListeners();
    webRequestInstalled = true;
  }
  // Observacao: nao removemos listeners em runtime (a API nao suporta bem
  // desregistrar por referencia perdida entre wake-ups do SW). Quando a
  // setting esta desligada, os listeners nao sao instalados. Ao religar,
  // recarregar a extensao aplica. O filtro por status/dominio ja evita ruido.
}

// ---------------------------------------------------------------------------
// Roteador de mensagens.
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return false;

  switch (message.type) {
    case MSG.RECORD_FAILURE:
      processFailure(message.entry, sender, 'inject');
      return false;

    case MSG.GET_FAILURES:
      getFailures({ limit: message.limit })
        .then((list) => sendResponse({ ok: true, failures: list }))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;

    case MSG.GET_FAILURE:
      getFailure(message.id)
        .then((item) => sendResponse({ ok: true, failure: item }))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;

    case MSG.UPDATE_NOTE:
      getFailure(message.id)
        .then(async (item) => {
          if (!item) {
            sendResponse({ ok: false, error: 'not found' });
            return;
          }
          item.note = typeof message.note === 'string' ? message.note : '';
          await putFailure(item);
          broadcastChange();
          sendResponse({ ok: true });
        })
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;

    case MSG.DELETE_FAILURE:
      deleteFailure(message.id)
        .then(async () => {
          await refreshBadge();
          broadcastChange();
          sendResponse({ ok: true });
        })
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;

    case MSG.CLEAR_FAILURES:
      clearFailures()
        .then(async () => {
          await refreshBadge();
          broadcastChange();
          sendResponse({ ok: true });
        })
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;

    case MSG.GET_SETTINGS:
      getSettings()
        .then((s) => sendResponse({ ok: true, settings: s }))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;

    case MSG.SET_SETTINGS:
      setSettings(message.settings || {})
        .then((s) => {
          syncWebRequest();
          sendResponse({ ok: true, settings: s });
        })
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;

    default:
      return false;
  }
});

// Ao iniciar/instalar, sincroniza badge e listeners.
chrome.runtime.onInstalled.addListener(() => {
  refreshBadge();
  syncWebRequest();
});
chrome.runtime.onStartup.addListener(() => {
  refreshBadge();
  syncWebRequest();
});
// Tambem ao acordar o SW.
refreshBadge();
syncWebRequest();
