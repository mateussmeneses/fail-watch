// Constantes e configuracao padrao compartilhadas por toda a extensao.

// Tipos de mensagem trocados entre injected -> content -> service worker.
export const MSG = {
  // injected script -> content script (via window.postMessage)
  CAPTURE: 'FAILWATCH_CAPTURE',
  // qualquer contexto de extensao -> service worker (via chrome.runtime)
  RECORD_FAILURE: 'FAILWATCH_RECORD_FAILURE',
  GET_FAILURES: 'FAILWATCH_GET_FAILURES',
  GET_FAILURE: 'FAILWATCH_GET_FAILURE',
  CLEAR_FAILURES: 'FAILWATCH_CLEAR_FAILURES',
  DELETE_FAILURE: 'FAILWATCH_DELETE_FAILURE',
  UPDATE_NOTE: 'FAILWATCH_UPDATE_NOTE',
  GET_SETTINGS: 'FAILWATCH_GET_SETTINGS',
  SET_SETTINGS: 'FAILWATCH_SET_SETTINGS',
  // service worker -> UIs (broadcast) quando algo muda
  FAILURES_CHANGED: 'FAILWATCH_FAILURES_CHANGED'
};

// Marca usada no window.postMessage para nao colidir com mensagens da pagina.
export const POST_MESSAGE_SOURCE = 'failwatch-injected';

export const SETTINGS_KEY = 'failwatch.settings';

// Modos de filtro por dominio.
export const DOMAIN_MODE = {
  ALL: 'all',
  ALLOWLIST: 'allowlist',
  DENYLIST: 'denylist'
};

// Configuracao padrao. O usuario pode ajustar na pagina de opcoes.
export const DEFAULT_SETTINGS = {
  // Captura falhas HTTP com status >= este valor.
  minStatusToCapture: 400,
  // Captura tambem erros de rede (fetch rejeitado, ERR_*, timeout).
  captureNetworkErrors: true,
  // Numero maximo de falhas guardadas (as mais antigas sao descartadas).
  maxEntries: 500,
  // Tamanho maximo (em caracteres) guardado de cada corpo (req/resp).
  maxBodyChars: 100000,
  // Redige headers sensiveis antes de guardar (nomes em minusculo).
  redactHeaders: ['authorization', 'cookie', 'set-cookie', 'x-api-key', 'proxy-authorization'],
  // Se ligado, guarda apenas o nome do header redigido, sem o valor.
  redactionEnabled: true,

  // --- Rede de seguranca via webRequest ---
  // Usa chrome.webRequest para capturar falhas que a injecao de fetch/XHR
  // nao ve (ex.: requests fora do contexto da pagina). Nao traz response body.
  webRequestFallback: true,

  // --- Regras por dominio ---
  // 'all' | 'allowlist' | 'denylist'
  domainMode: DOMAIN_MODE.ALL,
  // Padroes de dominio (um por linha na UI). Suporta '*' como coringa.
  // Ex.: '*.meu-app.com', 'api.exemplo.com'
  domainPatterns: [],

  // --- Screenshot ---
  // Captura screenshot da aba visivel no momento da falha.
  captureScreenshot: false,
  // Intervalo minimo entre screenshots por aba (ms) para nao sobrecarregar.
  screenshotThrottleMs: 3000
};

// Aplica redacao nos headers conforme as settings. Recebe e devolve um
// objeto simples { nomeHeader: valor }.
export function applyRedaction(headers, settings) {
  if (!settings || !settings.redactionEnabled || !headers) return headers || {};
  const redactSet = new Set((settings.redactHeaders || []).map((h) => h.toLowerCase()));
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = redactSet.has(key.toLowerCase()) ? '«redacted»' : value;
  }
  return out;
}

// Trunca strings grandes preservando o tamanho original para exibicao.
export function truncateBody(body, maxChars) {
  if (typeof body !== 'string') return { text: '', truncated: false, originalLength: 0 };
  if (body.length <= maxChars) {
    return { text: body, truncated: false, originalLength: body.length };
  }
  return {
    text: body.slice(0, maxChars),
    truncated: true,
    originalLength: body.length
  };
}

// Extrai o hostname de uma URL de forma tolerante.
export function hostFromUrl(url) {
  try {
    return new URL(url).hostname;
  } catch (_e) {
    return '';
  }
}

// Casa um hostname contra um padrao com coringa '*'.
// Ex.: pattern '*.exemplo.com' casa 'api.exemplo.com' e 'exemplo.com'.
export function matchDomain(hostname, pattern) {
  if (!hostname || !pattern) return false;
  const h = hostname.toLowerCase();
  const p = pattern.trim().toLowerCase();
  if (!p) return false;
  if (p === '*') return true;
  // '*.dominio' casa o proprio dominio e subdominios.
  if (p.startsWith('*.')) {
    const base = p.slice(2);
    return h === base || h.endsWith('.' + base);
  }
  // Converte coringas internos em regex simples.
  if (p.includes('*')) {
    const escaped = p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp('^' + escaped + '$').test(h);
  }
  return h === p;
}

// Decide se uma URL deve ser capturada conforme o modo de dominio.
export function shouldCaptureDomain(url, settings) {
  const mode = (settings && settings.domainMode) || DOMAIN_MODE.ALL;
  if (mode === DOMAIN_MODE.ALL) return true;
  const host = hostFromUrl(url);
  const patterns = (settings && settings.domainPatterns) || [];
  const matches = patterns.some((p) => matchDomain(host, p));
  if (mode === DOMAIN_MODE.ALLOWLIST) return matches;
  if (mode === DOMAIN_MODE.DENYLIST) return !matches;
  return true;
}

// Normaliza uma URL para agrupamento: remove query e fragmento, e colapsa
// segmentos que parecem IDs (numeros, uuids, hashes) em ':id'. Assim
// '/users/123' e '/users/456' caem no mesmo grupo.
export function normalizeUrlForGrouping(url) {
  let host = '';
  let path = url || '';
  try {
    const u = new URL(url);
    host = u.host;
    path = u.pathname || '/';
  } catch (_e) {
    // mantem 'path' como a string crua
  }
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const normalizedPath = path
    .split('/')
    .map((seg) => {
      if (!seg) return seg;
      if (/^\d+$/.test(seg)) return ':id';
      if (uuidRe.test(seg)) return ':id';
      if (/^[0-9a-f]{16,}$/i.test(seg)) return ':id';
      return seg;
    })
    .join('/');
  return (host ? host : '') + normalizedPath;
}

// Chave de agrupamento de uma falha.
export function groupKeyOf(entry) {
  const method = (entry.method || 'GET').toUpperCase();
  const statusPart = entry.errorType ? 'ERR:' + entry.errorType : 'HTTP:' + (entry.status || 0);
  return method + ' ' + normalizeUrlForGrouping(entry.url) + ' ' + statusPart;
}
