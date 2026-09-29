// Leitura/escrita de configuracoes usando chrome.storage.local.
// Settings sao pequenas, entao chrome.storage e adequado (diferente das
// falhas, que vao para IndexedDB).

import { SETTINGS_KEY, DEFAULT_SETTINGS } from './constants.js';

export async function getSettings() {
  try {
    const data = await chrome.storage.local.get(SETTINGS_KEY);
    const stored = data[SETTINGS_KEY] || {};
    // Merge com defaults para tolerar novas chaves adicionadas em updates.
    return {
      ...DEFAULT_SETTINGS,
      ...stored,
      // Arrays: se o usuario nunca configurou, usa o default.
      redactHeaders: Array.isArray(stored.redactHeaders)
        ? stored.redactHeaders
        : DEFAULT_SETTINGS.redactHeaders
    };
  } catch (_e) {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function setSettings(partial) {
  const current = await getSettings();
  const next = { ...current, ...partial };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}
