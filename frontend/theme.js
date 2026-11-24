(() => {
  'use strict';
  const root = document.documentElement;
  const STORAGE_KEY = 'cleantrack-theme';
  const validTheme = value => value === 'light' || value === 'dark';
  let theme = validTheme(root.dataset.theme) ? root.dataset.theme : 'light';

  function syncThemeButtons() {
    document.querySelectorAll('[data-theme-toggle]').forEach(button => {
      const dark = theme === 'dark';
      button.setAttribute('aria-checked', String(dark));
      button.setAttribute('aria-label', dark ? 'Switch to bright mode' : 'Switch to dark mode');
      button.setAttribute('title', dark ? 'Switch to bright mode' : 'Switch to dark mode');
    });
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'dark' ? '#0E140E' : '#FFFFFF');
  }

  function applyTheme(nextTheme, persist = true) {
    theme = validTheme(nextTheme) ? nextTheme : 'light';
    root.dataset.theme = theme;
    if (persist) {
      try { localStorage.setItem(STORAGE_KEY, theme); } catch (_) {}
    }
    syncThemeButtons();
    window.CleanTrackIntro?.refreshThemeColors?.();
    window.dispatchEvent(new CustomEvent('cleantrack:themechange', { detail: { theme } }));
  }

  document.addEventListener('click', event => {
    const button = event.target.closest('[data-theme-toggle]');
    if (!button) return;
    applyTheme(theme === 'dark' ? 'light' : 'dark');
  });

  window.addEventListener('storage', event => {
    if (event.key === STORAGE_KEY && validTheme(event.newValue)) applyTheme(event.newValue, false);
  });

  applyTheme(theme, false);
  window.CleanTrackTheme = { get: () => theme, set: applyTheme, toggle: () => applyTheme(theme === 'dark' ? 'light' : 'dark') };
})();
