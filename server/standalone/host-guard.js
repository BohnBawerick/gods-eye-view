import net from 'node:net';

/**
 * Whether a Host header passes an allow-list, mirroring Vite's own host check:
 * IP literals and localhost always pass, `.name` entries also match subdomains.
 */
export function isAllowedHost(hostHeader, allowedHosts = []) {
  if (allowedHosts === true) return true;
  if (!hostHeader) return false;
  const host = String(hostHeader).trim();
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    return end > 0 && net.isIP(host.slice(1, end)) === 6;
  }
  const hostname = host.replace(/:\d+$/, '');
  if (net.isIP(hostname) === 4) return true;
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;
  return allowedHosts.some(
    (allowed) =>
      allowed === hostname ||
      (allowed.startsWith('.') &&
        (allowed.slice(1) === hostname || hostname.endsWith(allowed))),
  );
}

/**
 * Apply the allowed-hosts check to every request before the /api providers.
 * Vite installs its own check after plugin middleware, so without this a
 * DNS-rebinding page is refused the app but can still call the key-brokering APIs.
 */
export function hostGuardPlugin() {
  const guard = (allowedHosts, additionalHosts) => (req, res, next) => {
    const allowed =
      allowedHosts === true ? true : [...allowedHosts, ...additionalHosts];
    if (isAllowedHost(req.headers.host, allowed)) return next();
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Blocked request: this host is not allowed.');
  };
  return {
    name: 'gev-host-guard',
    enforce: 'pre',
    configureServer(server) {
      const { config } = server;
      server.middlewares.use(
        guard(config.server.allowedHosts, config.additionalAllowedHosts ?? []),
      );
    },
    configurePreviewServer(server) {
      const { config } = server;
      server.middlewares.use(
        guard(config.preview.allowedHosts, config.additionalAllowedHosts ?? []),
      );
    },
  };
}
