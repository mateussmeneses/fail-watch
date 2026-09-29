// Interceptor injetado no contexto da PAGINA (MAIN world).
// Aqui NAO existe acesso a chrome.* nem a modules ES importados — este
// arquivo e injetado como <script src> pela content script, entao ele e
// autossuficiente e se comunica via window.postMessage.
//
// Objetivo: sobrescrever window.fetch e XMLHttpRequest para capturar
// requisicao + resposta completas e reportar apenas quando houver falha
// (status HTTP >= limiar OU erro de rede). O filtro fino fica no service
// worker; aqui reportamos tudo que "cheira" a falha para nao perder nada.

(function () {
  'use strict';

  // Evita injecao dupla (ex.: multiplas content scripts em iframes recarregando).
  if (window.__FAILWATCH_INSTALLED__) return;
  window.__FAILWATCH_INSTALLED__ = true;

  const SOURCE = 'failwatch-injected';
  // Limiar minimo local. O service worker reavalia conforme as settings do
  // usuario; usamos 400 aqui so para reduzir ruido no canal de mensagens.
  const LOCAL_MIN_STATUS = 400;
  // Nao capturamos corpos gigantes no contexto da pagina (o SW trunca de novo).
  const MAX_BODY_CHARS = 200000;

  function now() {
    return (performance && performance.now) ? performance.now() : Date.now();
  }

  function genId() {
    return (
      Date.now().toString(36) +
      '-' +
      Math.random().toString(36).slice(2, 10)
    );
  }

  // Reporta uma falha para a content script.
  function report(entry) {
    try {
      window.postMessage({ source: SOURCE, payload: entry }, window.location.origin || '*');
    } catch (_e) {
      // Se o clone estruturado falhar por algum valor exotico, serializamos.
      try {
        window.postMessage(
          { source: SOURCE, payload: JSON.parse(JSON.stringify(entry)) },
          '*'
        );
      } catch (_e2) {
        /* desiste silenciosamente para nunca quebrar a pagina */
      }
    }
  }

  function headersToObject(headers) {
    const obj = {};
    if (!headers) return obj;
    try {
      if (typeof headers.forEach === 'function') {
        headers.forEach((value, key) => {
          obj[key] = obj[key] ? obj[key] + ', ' + value : value;
        });
        return obj;
      }
      if (Array.isArray(headers)) {
        for (const [key, value] of headers) obj[key] = value;
        return obj;
      }
      if (typeof headers === 'object') {
        for (const [key, value] of Object.entries(headers)) obj[key] = String(value);
      }
    } catch (_e) {
      /* ignore */
    }
    return obj;
  }

  // Converte um "raw headers string" de XHR (getAllResponseHeaders) em objeto.
  function parseRawHeaders(raw) {
    const obj = {};
    if (!raw) return obj;
    const lines = raw.trim().split(/[\r\n]+/);
    for (const line of lines) {
      const idx = line.indexOf(':');
      if (idx < 0) continue;
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim();
      if (key) obj[key] = obj[key] ? obj[key] + ', ' + value : value;
    }
    return obj;
  }

  function clampBody(text) {
    if (typeof text !== 'string') return text;
    return text.length > MAX_BODY_CHARS ? text.slice(0, MAX_BODY_CHARS) : text;
  }

  // Tenta extrair um corpo textual de um objeto de request body variado.
  function requestBodyToText(body) {
    if (body == null) return '';
    try {
      if (typeof body === 'string') return clampBody(body);
      if (body instanceof URLSearchParams) return clampBody(body.toString());
      if (typeof FormData !== 'undefined' && body instanceof FormData) {
        const parts = [];
        for (const [k, v] of body.entries()) {
          parts.push(k + '=' + (typeof v === 'string' ? v : '[file]'));
        }
        return clampBody(parts.join('&'));
      }
      if (typeof Blob !== 'undefined' && body instanceof Blob) {
        return '[Blob ' + body.size + ' bytes, type=' + (body.type || 'n/a') + ']';
      }
      if (body instanceof ArrayBuffer) {
        return '[ArrayBuffer ' + body.byteLength + ' bytes]';
      }
      return clampBody(String(body));
    } catch (_e) {
      return '';
    }
  }

  // ---------------------------------------------------------------------------
  // fetch
  // ---------------------------------------------------------------------------
  const nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = function (input, init) {
      const startedAt = now();
      const startWall = Date.now();

      let method = 'GET';
      let url = '';
      let reqHeaders = {};
      let reqBodyText = '';

      try {
        if (typeof Request !== 'undefined' && input instanceof Request) {
          method = (input.method || 'GET').toUpperCase();
          url = input.url;
          reqHeaders = headersToObject(input.headers);
        } else {
          url = String(input);
        }
        if (init) {
          if (init.method) method = String(init.method).toUpperCase();
          if (init.headers) reqHeaders = Object.assign(reqHeaders, headersToObject(init.headers));
          if (init.body != null) reqBodyText = requestBodyToText(init.body);
        }
      } catch (_e) {
        /* ignore parsing errors */
      }

      const promise = nativeFetch.apply(this, arguments);

      promise.then(
        (response) => {
          const status = response.status;
          if (status < LOCAL_MIN_STATUS) return; // sucesso: ignora

          // Clona para ler o corpo sem consumir o da aplicacao.
          let respHeaders = {};
          try {
            respHeaders = headersToObject(response.headers);
          } catch (_e) {
            /* ignore */
          }

          let bodyText = '';
          try {
            bodyText = '';
            response
              .clone()
              .text()
              .then((t) => {
                report({
                  id: genId(),
                  kind: 'fetch',
                  method,
                  url: absolutize(url),
                  requestHeaders: reqHeaders,
                  requestBody: reqBodyText,
                  status,
                  statusText: response.statusText || '',
                  responseHeaders: respHeaders,
                  responseBody: clampBody(t || ''),
                  errorType: null,
                  error: null,
                  startedAt: startWall,
                  durationMs: Math.round(now() - startedAt),
                  pageUrl: window.location.href,
                  timestamp: Date.now()
                });
              })
              .catch(() => {
                report(buildHttpNoBody());
              });
          } catch (_e) {
            report(buildHttpNoBody());
          }

          function buildHttpNoBody() {
            return {
              id: genId(),
              kind: 'fetch',
              method,
              url: absolutize(url),
              requestHeaders: reqHeaders,
              requestBody: reqBodyText,
              status,
              statusText: response.statusText || '',
              responseHeaders: respHeaders,
              responseBody: '',
              errorType: null,
              error: null,
              startedAt: startWall,
              durationMs: Math.round(now() - startedAt),
              pageUrl: window.location.href,
              timestamp: Date.now()
            };
          }
        },
        (error) => {
          // Erro de rede: fetch rejeitou (DNS, CORS, offline, abort, etc.).
          report({
            id: genId(),
            kind: 'fetch',
            method,
            url: absolutize(url),
            requestHeaders: reqHeaders,
            requestBody: reqBodyText,
            status: 0,
            statusText: '',
            responseHeaders: {},
            responseBody: '',
            errorType: 'network',
            error: (error && (error.message || String(error))) || 'Network error',
            startedAt: startWall,
            durationMs: Math.round(now() - startedAt),
            pageUrl: window.location.href,
            timestamp: Date.now()
          });
        }
      );

      return promise;
    };
  }

  // ---------------------------------------------------------------------------
  // XMLHttpRequest
  // ---------------------------------------------------------------------------
  const XHR = window.XMLHttpRequest;
  if (typeof XHR === 'function') {
    const open = XHR.prototype.open;
    const send = XHR.prototype.send;
    const setRequestHeader = XHR.prototype.setRequestHeader;

    XHR.prototype.open = function (method, url) {
      this.__failwatch = {
        method: (method || 'GET').toUpperCase(),
        url: url,
        reqHeaders: {},
        startedAt: now(),
        startWall: Date.now()
      };
      return open.apply(this, arguments);
    };

    XHR.prototype.setRequestHeader = function (name, value) {
      try {
        if (this.__failwatch) {
          const existing = this.__failwatch.reqHeaders[name];
          this.__failwatch.reqHeaders[name] = existing ? existing + ', ' + value : value;
        }
      } catch (_e) {
        /* ignore */
      }
      return setRequestHeader.apply(this, arguments);
    };

    XHR.prototype.send = function (body) {
      const fw = this.__failwatch;
      if (fw) {
        fw.reqBody = requestBodyToText(body);

        const finalize = (errorType) => {
          try {
            const status = this.status;
            const isNetworkError = errorType != null;
            if (!isNetworkError && status < LOCAL_MIN_STATUS) return;

            let respHeaders = {};
            try {
              respHeaders = parseRawHeaders(this.getAllResponseHeaders());
            } catch (_e) {
              /* ignore */
            }

            let respBody = '';
            try {
              // responseType '' ou 'text' expoem responseText.
              if (this.responseType === '' || this.responseType === 'text') {
                respBody = clampBody(this.responseText || '');
              } else if (this.responseType === 'json' && this.response != null) {
                respBody = clampBody(JSON.stringify(this.response));
              } else if (this.response != null) {
                respBody = '[response type: ' + this.responseType + ']';
              }
            } catch (_e) {
              /* ignore */
            }

            report({
              id: genId(),
              kind: 'xhr',
              method: fw.method,
              url: absolutize(fw.url),
              requestHeaders: fw.reqHeaders,
              requestBody: fw.reqBody || '',
              status: isNetworkError ? 0 : status,
              statusText: this.statusText || '',
              responseHeaders: respHeaders,
              responseBody: respBody,
              errorType: errorType,
              error: errorType ? errorType + ' error' : null,
              startedAt: fw.startWall,
              durationMs: Math.round(now() - fw.startedAt),
              pageUrl: window.location.href,
              timestamp: Date.now()
            });
          } catch (_e) {
            /* nunca quebra a pagina */
          }
        };

        this.addEventListener('load', () => finalize(null));
        this.addEventListener('error', () => finalize('network'));
        this.addEventListener('timeout', () => finalize('timeout'));
        this.addEventListener('abort', () => finalize('abort'));
      }
      return send.apply(this, arguments);
    };
  }

  // Resolve URLs relativas contra a pagina atual.
  function absolutize(url) {
    try {
      return new URL(url, window.location.href).href;
    } catch (_e) {
      return String(url);
    }
  }
})();
