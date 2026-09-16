(function () {
  'use strict';
  const loaderElement = document.currentScript;
  const REGISTRY = '__chinaflowSelfServiceRuntime';
  const RELEASE = 'loader-0.3/engine-0.6';
  const existing = document[REGISTRY];

  function disable(registry) {
    if (!registry) return;
    registry.state = 'disabled';
    registry.generation++;
    try { registry.shutdown?.(); } catch (_) { /* Fail closed. */ }
    registry.observer?.disconnect();
    registry.engineElement?.remove();
    registry.installKey = null;
    registry.runtimeOrigin = null;
    registry.configUrl = null;
    registry.engineElement = null;
    registry.shutdown = null;
    registry.onMutation = null;
  }

  let installKey, runtimeOrigin;
  try {
    if (!(loaderElement instanceof HTMLScriptElement) ||
        loaderElement.ownerDocument !== document || !loaderElement.isConnected ||
        !['', 'text/javascript', 'application/javascript'].includes(loaderElement.type) ||
        !loaderElement.getAttribute('src')) throw new Error();
    const src = new URL(loaderElement.src);
    if (src.protocol !== 'https:' || src.username || src.password) throw new Error();
    runtimeOrigin = src.origin;
    installKey = loaderElement.getAttribute('data-chinaflow-install');
    if (!/^cfi_[0-9a-f]{32}$/.test(installKey)) throw new Error();
  } catch (_) {
    disable(existing);
    return;
  }

  if (existing) {
    if (existing.state === 'disabled') return;
    if (existing.release !== RELEASE || existing.installKey !== installKey) disable(existing);
    return;
  }

  const configUrl = new URL('/v1/config', runtimeOrigin);
  configUrl.searchParams.set('install_key', installKey);
  const registry = document[REGISTRY] = {
    release: RELEASE, installKey, runtimeOrigin, configUrl: configUrl.href,
    engineElement: null, generation: 0, state: 'loading', shutdown: null,
    observer: null, onMutation: null, disable: null
  };
  registry.disable = () => disable(registry);

  // Immutable loaders mark their engines with data-chinaflow-loader="true".
  // Recognizable legacy filenames are conservatively rejected on any host.
  // This detects mixing; it cannot undo independently executed legacy code.
  function legacyScript(element) {
    if (!(element instanceof HTMLScriptElement) || element === loaderElement ||
        element === registry.engineElement) return false;
    if (element.getAttribute('data-chinaflow-loader') === 'true') return true;
    try {
      const path = new URL(element.src).pathname;
      return /\/(?:loader(?:-v0\.2)?|chinaflow(?:-v0\.[1-5](?:-test)?)?)\.js$/.test(path);
    } catch (_) { return false; }
  }
  function hasLegacy() {
    return Array.from(document.scripts).some(legacyScript);
  }
  if (hasLegacy()) { registry.disable(); return; }

  // One document observer serves both mixed-install detection and SPA reevaluation.
  registry.observer = new MutationObserver(records => {
    if (registry.state === 'disabled') return;
    const addedLegacy = records.some(record => Array.from(record.addedNodes).some(node =>
      legacyScript(node) || (node.querySelectorAll &&
        Array.from(node.querySelectorAll('script')).some(legacyScript))));
    if (addedLegacy || hasLegacy()) { registry.disable(); return; }
    registry.onMutation?.(records);
  });
  registry.observer.observe(document.documentElement, {
    childList: true, subtree: true, attributes: true,
    attributeFilter: ['src', 'data-chinaflow-loader']
  });

  const engine = document.createElement('script');
  engine.src = new URL('/runtime/chinaflow-v0.6.js', runtimeOrigin).href;
  engine.async = true;
  registry.engineElement = engine;
  engine.onerror = () => registry.disable();
  (document.head || document.documentElement).appendChild(engine);
})();
