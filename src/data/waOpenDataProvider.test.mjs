import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createWaDataService,
  normalizeWaArcGis,
  normalizeWaGeometry,
} from '../../server/providers/wa.js';

function pointFeature(properties = {}, id = 1) {
  return {
    type: 'Feature',
    id,
    geometry: { type: 'Point', coordinates: [115.86, -31.95] },
    properties,
  };
}

test('WA provider filters mines to operating records and bounds text', () => {
  const longName = 'A'.repeat(400);
  const features = normalizeWaArcGis(
    'mines',
    {
      type: 'FeatureCollection',
      features: [
        pointFeature({
          site_stage: 'Operating',
          site_title: longName,
          site_type_: 'Mine',
          web_link: 'javascript:alert(1)',
        }),
        pointFeature({ site_stage: 'Care and Maintenance' }, 2),
      ],
    },
    10,
  );
  assert.equal(features.length, 1);
  assert.equal(features[0].title.length, 240);
  assert.equal(features[0].url, '');
  assert.equal(features[0].category, 'mine');
});

test('WA provider drops duplicate IDs and invalid capture dates', () => {
  const polygon = {
    type: 'Polygon',
    coordinates: [
      [
        [115, -32],
        [116, -32],
        [116, -31],
        [115, -32],
      ],
    ],
  };
  const features = normalizeWaArcGis(
    'bushfires',
    {
      type: 'FeatureCollection',
      features: [
        {
          id: 7,
          geometry: polygon,
          properties: { capt_date: Number.MAX_VALUE },
        },
        { id: 7, geometry: polygon, properties: {} },
      ],
    },
    10,
  );
  assert.equal(features.length, 1);
  assert.equal(features[0].updated, '');
});

test('WA geometry normalization closes polygons and rejects invalid coordinates', () => {
  const polygon = normalizeWaGeometry(
    {
      type: 'Polygon',
      coordinates: [
        [
          [115, -32],
          [116, -32],
          [116, -31],
        ],
      ],
    },
    ['Polygon'],
  );
  assert.deepEqual(polygon.coordinates[0].at(-1), [115, -32]);
  assert.equal(polygon.coordinates[0].length, 4);
  assert.equal(
    normalizeWaGeometry({ type: 'Point', coordinates: [220, -32] }, ['Point']),
    null,
  );
});

test('WA roads share a 120-second cache and keep one failed feed local', async () => {
  let time = 1_000;
  let calls = 0;
  let failClosures = true;
  const fetchImpl = async (url) => {
    calls++;
    const closure = String(url).includes('RoadClosures');
    if (closure && failClosures) throw new Error('closure feed down');
    const feature = closure
      ? {
          type: 'Feature',
          id: 2,
          geometry: {
            type: 'LineString',
            coordinates: [
              [115.8, -31.9],
              [115.9, -31.8],
            ],
          },
          properties: { Location: 'Closure' },
        }
      : pointFeature({ Location: 'Incident' });
    return new Response(
      JSON.stringify({ type: 'FeatureCollection', features: [feature] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  };
  const service = createWaDataService({ fetchImpl, now: () => time });
  const first = await service.get('roads');
  assert.equal(first.partial, true);
  assert.deepEqual(first.failures, ['closures']);
  assert.equal(first.features.length, 1);
  assert.equal(calls, 2);

  const cached = await service.get('roads');
  assert.equal(cached.cache, 'hit');
  assert.equal(calls, 2);

  time += 120_001;
  failClosures = false;
  const refreshed = await service.get('roads');
  assert.equal(refreshed.partial, false);
  assert.equal(refreshed.features.length, 2);
  assert.equal(calls, 4);
});
