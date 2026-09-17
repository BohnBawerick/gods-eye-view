import { applicationHtmlPlugin } from './application-html.js';
import cesium from 'vite-plugin-cesium';

/** Build browser assets with explicit inputs; never load environment or providers. */
export function createBrowserViteConfig({
  plugins = [],
  publicDir,
  googleApiKey,
  cesiumToken,
  host = 'localhost',
  port = 4173,
  allowedHosts = '',
} = {}) {
  // Extra host names (comma-separated) keep Vite's DNS-rebinding guard on when HOST
  // opens the server to the network, for example behind a reverse proxy.
  const extraHosts = String(allowedHosts)
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  return {
    plugins: [cesium(), applicationHtmlPlugin(), ...plugins],
    ...(publicDir === undefined ? {} : { publicDir }),
    server: {
      host: host || 'localhost',
      port: parseInt(port, 10) || 4173,
      allowedHosts: extraHosts.length
        ? ['localhost', '127.0.0.1', '.local', ...extraHosts]
        : host === '0.0.0.0' || host === '::'
          ? true
          : ['localhost', '127.0.0.1', '.local'],
      fs: {
        deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/ENVIRONMENT'],
      },
      // These headers protect the document containing Provider Settings.
      headers: {
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "frame-ancestors 'none'",
      },
    },
    // vite preview does not inherit server.port.
    preview: { port: parseInt(port, 10) || 4173 },
    define: {
      'import.meta.env.GOOGLE_MAPS_API_KEY': JSON.stringify(googleApiKey),
      'import.meta.env.CESIUM_ION_TOKEN': JSON.stringify(cesiumToken),
    },
    build: { chunkSizeWarningLimit: 1500 },
  };
}
