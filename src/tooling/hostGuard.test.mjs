import assert from 'node:assert/strict';
import test from 'node:test';
import {
  hostGuardPlugin,
  isAllowedHost,
} from '../../server/standalone/host-guard.js';

const LIST = ['localhost', '127.0.0.1', '.local', 'globe.example.com'];

test('isAllowedHost mirrors Vite: listed names, IPs and localhost pass', () => {
  assert.equal(isAllowedHost('globe.example.com', LIST), true);
  assert.equal(isAllowedHost('globe.example.com:443', LIST), true);
  assert.equal(isAllowedHost('printer.local', LIST), true);
  assert.equal(isAllowedHost('10.1.2.3:4173', LIST), true);
  assert.equal(isAllowedHost('[::1]:4173', LIST), true);
  assert.equal(isAllowedHost('app.localhost', LIST), true);
  assert.equal(isAllowedHost('evil.example', LIST), false);
  assert.equal(isAllowedHost('globe.example.com.evil.example', LIST), false);
  assert.equal(isAllowedHost(undefined, LIST), false);
  assert.equal(isAllowedHost('anything.example', true), true);
});

test('host guard refuses a disallowed host before any /api middleware runs', () => {
  const plugin = hostGuardPlugin();
  assert.equal(plugin.enforce, 'pre');
  for (const hook of ['configureServer', 'configurePreviewServer']) {
    let middleware;
    const server = {
      config: {
        server: { allowedHosts: LIST },
        preview: { allowedHosts: LIST },
        additionalAllowedHosts: [],
      },
      middlewares: { use: (fn) => (middleware = fn) },
    };
    plugin[hook](server);
    const res = {
      status: 0,
      writeHead: (code) => (res.status = code),
      end() {},
    };
    let passed = false;
    middleware(
      { headers: { host: 'evil.example' } },
      res,
      () => (passed = true),
    );
    assert.equal(passed, false, hook);
    assert.equal(res.status, 403, hook);
    middleware(
      { headers: { host: 'globe.example.com' } },
      res,
      () => (passed = true),
    );
    assert.equal(passed, true, hook);
  }
});
