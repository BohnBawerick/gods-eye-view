import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { waGeometryParts } from './geometry.js';

test('WA geometry transforms multiline and polygon holes into Cesium parts', () => {
  const lines = waGeometryParts({
    type: 'MultiLineString',
    coordinates: [
      [
        [115, -32],
        [116, -31],
      ],
      [
        [117, -30],
        [118, -29],
      ],
    ],
  });
  assert.equal(lines.lines.length, 2);
  assert.equal(lines.lines[0].length, 2);
  assert.ok(lines.lines[0][0] instanceof Cesium.Cartesian3);

  const polygons = waGeometryParts({
    type: 'Polygon',
    coordinates: [
      [
        [115, -32],
        [116, -32],
        [116, -31],
        [115, -32],
      ],
      [
        [115.2, -31.8],
        [115.3, -31.8],
        [115.3, -31.7],
        [115.2, -31.8],
      ],
    ],
  });
  assert.equal(polygons.polygons.length, 1);
  assert.equal(polygons.polygons[0].positions.length, 4);
  assert.equal(polygons.polygons[0].holes.length, 1);
});
