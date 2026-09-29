// Registra uma aba dedicada "FailWatch" dentro do DevTools do navegador.
// O painel reutiliza exatamente a mesma UI do popup (panel.html -> history.js).
chrome.devtools.panels.create(
  'FailWatch',
  null,
  '../ui/panel.html',
  function (_panel) {
    // Nada a fazer no create; a UI se inicializa sozinha ao carregar.
  }
);
