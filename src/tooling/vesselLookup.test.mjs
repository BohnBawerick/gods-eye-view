import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { aisLiveProxy } from '../../server/providers/vessels/ais-live.js';
import * as store from '../../server/providers/vessels/ais-store.js';

function position(mmsi, name, epoch, imo = '') {
  return {
    MessageType: 'PositionReport',
    MetaData: {
      MMSI: mmsi,
      ShipName: name,
      latitude: -32.03579,
      longitude: 115.66655,
      time_utc: new Date(epoch).toISOString(),
    },
    Message: { PositionReport: { UserID: mmsi, Sog: 0.5, ImoNumber: imo } },
  };
}

test('AIS HTTP lookup searches outside the row window; pins persist, age and resist cross-origin writes', async (t) => {
  mkdirSync('.gev-logs', { recursive: true });
  const directory = mkdtempSync(resolve('.gev-logs/watch-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const previous = { ...process.env };
  delete process.env.AISSTREAM_API_KEY;
  process.env.GEV_VESSEL_WATCHLIST_FILE = resolve(directory, 'watchlist.json');
  process.env.GEV_VESSEL_WATCHLIST = '259069000';
  t.after(() => {
    process.env = previous;
  });
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  let handler;
  const plugin = aisLiveProxy();
  plugin.configureServer({
    middlewares: {
      use(_path, callback) {
        handler = callback;
      },
    },
  });
  const server = createServer((req, res) => {
    req.url = req.url.replace('/api/ais-live', '');
    void handler(req, res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    plugin.closeBundle();
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${server.address().port}/api/ais-live`;
  const get = async (path) => (await fetch(base + path)).json();
  store.ingestAisStreamEnvelope(
    position('259069000', 'SKANDI PEREGRINO', now - 3600000, '9447627'),
  );
  store.ingestAisStreamEnvelope(position('710120300', 'PEREGRINO C', now));
  store.ingestAisStreamEnvelope(
    position('333333333', 'OUTSIDE WINDOW', now, '1234567'),
  );
  now += 1000;
  for (let i = 0; i < 12001; i++)
    store.ingestAisStreamEnvelope(
      position(String(400000000 + i), `FIXTURE ${i}`, now),
    );
  const rows = await get('?maxRows=12000');
  assert.equal(
    rows.rows.length,
    12001,
    'watch pins are extra, not competing for normal slots',
  );
  assert.ok(
    rows.rows.some(
      (row) => row.mmsi === '259069000' && row.pinned && row.stale,
    ),
  );
  assert.ok(!rows.rows.some((row) => row.mmsi === '333333333'));
  for (const q of ['333333333', '1234567', 'OUTSIDE WINDOW']) {
    const result = await get(`/vessel?q=${encodeURIComponent(q)}`);
    assert.equal(result.total, 1);
    assert.equal(result.candidates[0].mmsi, '333333333');
  }
  assert.equal((await get('/vessel?q=PEREGRINO')).total, 2);
  assert.equal(
    (await get('/vessel?q=IMO%209447627')).candidates[0].mmsi,
    '259069000',
  );
  assert.equal((await fetch(base + '/vessel?q=')).status, 400);
  assert.equal(
    (await fetch(base + '/vessel?q=' + 'x'.repeat(121))).status,
    400,
  );
  assert.equal((await fetch(base + '/unknown')).status, 404);
  const pinUrl = base + '/watchlist?mmsi=333333333';
  assert.equal((await fetch(pinUrl, { method: 'PUT' })).status, 403);
  assert.equal(
    (
      await fetch(pinUrl, {
        method: 'PUT',
        headers: {
          'X-GEV-Watchlist': '1',
          Origin: 'https://elsewhere.invalid',
        },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(base + '/watchlist?mmsi=invalid', {
        method: 'PUT',
        headers: { 'X-GEV-Watchlist': '1' },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await fetch(pinUrl, {
        method: 'PUT',
        headers: { 'X-GEV-Watchlist': '1' },
      })
    ).status,
    200,
  );
  now += 2 * 24 * 60 * 60 * 1000;
  assert.equal(
    (await get('/vessel?q=710120300')).total,
    0,
    'ordinary quiet vessels expire',
  );
  const watched = await get('/watchlist');
  assert.equal(watched.entries.length, 2);
  assert.ok(watched.entries.every((entry) => entry.vessel.stale));
  const savedEpoch = watched.entries[0].vessel.last_position_epoch;
  store.ingestAisStreamEnvelope({
    MessageType: 'ShipStaticData',
    MetaData: { MMSI: '259069000', latitude: 10, longitude: 20 },
    Message: {
      ShipStaticData: {
        UserID: '259069000',
        Name: 'SKANDI PEREGRINO',
        ImoNumber: 9447627,
      },
    },
  });
  assert.equal(
    (await get('/vessel?q=259069000')).candidates[0].last_position_epoch,
    savedEpoch,
    'static traffic cannot make an old position fresh',
  );
  store.flushAisWatchlist();
  const restarted = await import(
    `../../server/providers/vessels/ais-store.js?restart=${now}`
  );
  assert.equal(
    restarted.lookupAisVessels('9447627').candidates[0].last_position_epoch,
    savedEpoch,
  );
  assert.equal(restarted.aisStreamRows(1).length, 2);
  const removed = await fetch(pinUrl, {
    method: 'DELETE',
    headers: { 'X-GEV-Watchlist': '1' },
  });
  assert.equal((await removed.json()).entries.length, 1);
  now += 6 * 24 * 60 * 60 * 1000;
  assert.equal(
    (await get('/vessel?q=259069000')).total,
    0,
    'pins do not keep positions beyond seven days',
  );
  assert.equal((await get('/watchlist')).entries[0].vessel, null);
  store.flushAisWatchlist();
});
