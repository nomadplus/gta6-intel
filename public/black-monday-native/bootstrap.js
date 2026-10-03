const statusEl = document.getElementById('status');

async function loadManifest() {
  const response = await fetch('./asset-manifest.json', { cache: 'no-store' });
  if (!response.ok) throw new Error(`asset manifest HTTP ${response.status}`);
  const manifest = await response.json();
  if (manifest?.schemaVersion !== 1) throw new Error('unsupported asset manifest schema');
  if (manifest?.runtime?.renderer !== 'webgl2') throw new Error('unexpected renderer contract');
  if (!Array.isArray(manifest?.verticalSlice?.requirements)) throw new Error('vertical-slice contract missing');
  return manifest;
}

try {
  statusEl.textContent = 'loading native asset contract…';
  const manifest = await loadManifest();
  window.__BLACK_MONDAY_NATIVE_MANIFEST__ = Object.freeze(manifest);
  statusEl.textContent = `asset contract ready · Mission ${manifest.verticalSlice.mission}`;
  await import('./engine.js');
} catch (error) {
  console.error(error);
  statusEl.textContent = `bootstrap error: ${error?.message || error}`;
}
