// Content script (ISOLATED world). Tem acesso a chrome.* mas NAO ao escopo
// JS da pagina. Duas responsabilidades:
//   1. Injetar o interceptor no MAIN world (contexto da pagina), pois so la
//      da para sobrescrever window.fetch / XMLHttpRequest da aplicacao.
//   2. Escutar os window.postMessage do interceptor e repassar ao service
//      worker via chrome.runtime.sendMessage.

const SOURCE = 'failwatch-injected';
const RECORD_FAILURE = 'FAILWATCH_RECORD_FAILURE';

// 1) Injeta o interceptor o mais cedo possivel (document_start).
(function injectInterceptor() {
  try {
    const url = chrome.runtime.getURL('src/injected/interceptor.js');
    const script = document.createElement('script');
    script.src = url;
    script.async = false;
    // Remove o elemento apos carregar; o efeito (fetch/XHR sobrescritos) permanece.
    script.onload = function () {
      script.remove();
    };
    const parent = document.head || document.documentElement;
    parent.appendChild(script);
  } catch (_e) {
    /* se falhar, a extensao simplesmente nao captura nesta pagina */
  }
})();

// 2) Ponte de mensagens pagina -> service worker.
window.addEventListener('message', (event) => {
  // So aceitamos mensagens da propria janela e com nossa marca.
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== SOURCE || !data.payload) return;

  try {
    chrome.runtime.sendMessage(
      { type: RECORD_FAILURE, entry: data.payload },
      () => {
        // Ignora chrome.runtime.lastError (ex.: SW reiniciando). Sem retry
        // agressivo para nao impactar a pagina.
        void chrome.runtime.lastError;
      }
    );
  } catch (_e) {
    /* contexto invalidado (extensao recarregada): ignora */
  }
});
