// ============================================================
// RMA Blaster — Debug logging switch
//
// PDF parsing is the part most likely to need inspection when a
// form comes out wrong, but its logging is far too noisy to leave
// on for everyday use. So it's off unless you ask for it.
//
// To turn it on, in the browser console:
//     RMADebug.on()      then reload and reproduce the problem
//     RMADebug.off()     when finished
//
// The setting is per-browser and survives reloads.
// ============================================================

const RMADebug = (() => {
  const KEY = 'rmaDebugLogging';

  function enabled() {
    try { return localStorage.getItem(KEY) === '1'; }
    catch (_) { return false; }
  }

  // Verbose diagnostics — silent unless debugging is switched on.
  // Warnings and errors are never suppressed; they use console directly.
  function log(...args) {
    if (enabled()) console.log(...args);
  }

  function on()  { localStorage.setItem(KEY, '1'); console.log('[RMADebug] Verbose logging ON — reload to capture everything.'); }
  function off() { localStorage.removeItem(KEY);   console.log('[RMADebug] Verbose logging OFF.'); }

  return { log, on, off, enabled };
})();
