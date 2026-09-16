// Explicit bundled text imports: no runtime network or filesystem lookup.
// Released versioned paths must retain these exact source bytes.
export async function handleRuntimeAssetRequest(request) {
  const path = new URL(request.url).pathname;
  if (path !== '/runtime' && !path.startsWith('/runtime/')) return null;

  const loader = path === '/runtime/loader.js' || path === '/runtime/loader-v0.3.js';
  const engine = path === '/runtime/chinaflow-v0.6.js';
  if (!loader && !engine) {
    return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response(null, {
      status: 405, headers: { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' }
    });
  }

  const headers = {
    'Content-Type': 'application/javascript; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': path === '/runtime/loader.js'
      ? 'no-store' : 'public, max-age=31536000, immutable',
    'Access-Control-Allow-Origin': '*',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Referrer-Policy': 'no-referrer'
  };
  if (request.method === 'HEAD') return new Response(null, { headers });
  const source = loader
    ? await import('../loader-v0.3.js', { with: { type: 'text' } })
    : await import('../chinaflow-v0.6.js', { with: { type: 'text' } });
  return new Response(source.default, { headers });
}
