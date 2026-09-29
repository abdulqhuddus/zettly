// Self-hosted Leaflet 1.9.4, built from the official ES module source
// (github.com/Leaflet/Leaflet, tag v1.9.4) instead of the prebuilt UMD
// bundle, since no third-party CDN is used. This entry point re-exports
// everything as the window.L global, matching the public API of the
// official leaflet.js UMD build that this replaces.
import * as L from './lib/Leaflet.js';
window.L = L;
// Module scripts run after the document has parsed (deferred), so the
// classic inline script below — which calls initServiceAreaMap() at the
// top level — may run before this resolves. It listens for this event.
window.dispatchEvent(new Event('leaflet:ready'));
