import * as Cesium from 'cesium';

function positions(coordinates) {
  return Cesium.Cartesian3.fromDegreesArray(coordinates.flat());
}

function hierarchy(rings) {
  return new Cesium.PolygonHierarchy(
    positions(rings[0]),
    rings.slice(1).map((ring) => new Cesium.PolygonHierarchy(positions(ring))),
  );
}

/** Split normalized GeoJSON into Cesium-ready point, line and polygon parts. */
export function waGeometryParts(geometry) {
  if (geometry?.type === 'Point')
    return {
      points: [Cesium.Cartesian3.fromDegrees(...geometry.coordinates)],
      lines: [],
      polygons: [],
    };
  if (geometry?.type === 'LineString')
    return {
      points: [],
      lines: [positions(geometry.coordinates)],
      polygons: [],
    };
  if (geometry?.type === 'MultiLineString')
    return {
      points: [],
      lines: geometry.coordinates.map(positions),
      polygons: [],
    };
  if (geometry?.type === 'Polygon')
    return {
      points: [],
      lines: [],
      polygons: [hierarchy(geometry.coordinates)],
    };
  if (geometry?.type === 'MultiPolygon')
    return {
      points: [],
      lines: [],
      polygons: geometry.coordinates.map(hierarchy),
    };
  return { points: [], lines: [], polygons: [] };
}
