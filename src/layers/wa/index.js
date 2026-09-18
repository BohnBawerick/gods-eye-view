import * as Cesium from 'cesium';
import { waGeometryParts } from './geometry.js';

const LAYERS = Object.freeze([
  Object.freeze({
    id: 'wa-roads',
    dataset: 'roads',
    name: 'WA Road Incidents & Closures',
    icon: '⚠',
    source: 'Main Roads WA',
    updateInterval: 120_000,
    pointColor: '#ff4d4d',
    lineColor: '#ff9f43',
    pointSize: 10,
    distance: 8_000_000,
    legend: Object.freeze([
      Object.freeze({ label: 'Incident', color: '#ff4d4d' }),
      Object.freeze({ label: 'Closure', color: '#ff9f43' }),
    ]),
  }),
  Object.freeze({
    id: 'perth-cameras',
    dataset: 'cameras',
    name: 'Perth Public Cameras',
    icon: '◉',
    source: 'City of Perth',
    updateInterval: 60 * 60_000,
    pointColor: '#00d4ff',
    pointSize: 7,
    distance: 400_000,
    legend: Object.freeze([
      Object.freeze({ label: 'Location only', color: '#00d4ff' }),
    ]),
  }),
  Object.freeze({
    id: 'wa-operating-mines',
    dataset: 'mines',
    name: 'WA Operating Mines',
    icon: '◆',
    source: 'MINEDEX / DMIRS',
    updateInterval: 60 * 60_000,
    pointColor: '#f5c542',
    pointSize: 6,
    distance: 9_000_000,
    legend: Object.freeze([
      Object.freeze({ label: 'Operating site', color: '#f5c542' }),
    ]),
  }),
  Object.freeze({
    id: 'wa-bushfire-perimeters',
    dataset: 'bushfires',
    name: 'WA Bushfire Perimeters',
    icon: '△',
    source: 'Landgate SLIP / DBCA',
    updateInterval: 120_000,
    polygonColor: '#ff5b2e',
    distance: 9_000_000,
    legend: Object.freeze([
      Object.freeze({ label: 'Active perimeter', color: '#ff5b2e' }),
    ]),
  }),
]);

function createWaLayer(config, source) {
  let viewer = null;
  let dataSource = null;
  let request = null;
  let enabled = false;
  let count = 0;
  let lastUpdate = null;
  let error = null;
  let loading = false;
  let stale = false;
  let partial = false;

  const color = (value, alpha = 1) =>
    Cesium.Color.fromCssColorString(value).withAlpha(alpha);

  function entitiesFor(feature) {
    const parts = waGeometryParts(feature.geometry);
    const entities = [];
    const distanceDisplayCondition = new Cesium.DistanceDisplayCondition(
      0,
      config.distance,
    );
    for (const [index, position] of parts.points.entries()) {
      entities.push(
        new Cesium.Entity({
          id: `${config.id}:${feature.category}:${feature.id}:point:${index}`,
          name: feature.title,
          position,
          point: {
            pixelSize: config.pointSize,
            color: color(config.pointColor),
            outlineColor: Cesium.Color.BLACK.withAlpha(0.8),
            outlineWidth: 1,
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            distanceDisplayCondition,
          },
          properties: {
            category: feature.category,
            detail: feature.detail || '',
            updated: feature.updated || '',
            sourceUrl: feature.url || '',
          },
        }),
      );
    }
    for (const [index, positions] of parts.lines.entries()) {
      entities.push(
        new Cesium.Entity({
          id: `${config.id}:${feature.category}:${feature.id}:line:${index}`,
          name: feature.title,
          polyline: {
            positions,
            width: 4,
            material: color(config.lineColor, 0.9),
            clampToGround: true,
            distanceDisplayCondition,
          },
          properties: {
            category: feature.category,
            detail: feature.detail || '',
            updated: feature.updated || '',
            sourceUrl: feature.url || '',
          },
        }),
      );
    }
    for (const [index, hierarchy] of parts.polygons.entries()) {
      entities.push(
        new Cesium.Entity({
          id: `${config.id}:${feature.category}:${feature.id}:polygon:${index}`,
          name: feature.title,
          polygon: {
            hierarchy,
            material: color(config.polygonColor, 0.24),
            outline: true,
            outlineColor: color(config.polygonColor, 0.95),
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            distanceDisplayCondition,
          },
          properties: {
            category: feature.category,
            detail: feature.detail || '',
            updated: feature.updated || '',
          },
        }),
      );
    }
    return entities;
  }

  return {
    id: config.id,
    name: config.name,
    icon: config.icon,
    source: config.source,
    updateInterval: config.updateInterval,

    init(nextViewer) {
      if (viewer) throw new Error(`${config.name} is already initialized`);
      viewer = nextViewer;
      dataSource = new Cesium.CustomDataSource(config.id);
      dataSource.show = false;
      viewer.dataSources.add(dataSource);
    },

    enable() {
      enabled = true;
      error = null;
      if (dataSource) dataSource.show = true;
    },

    disable() {
      request?.abort();
      request = null;
      enabled = false;
      loading = false;
      if (dataSource) dataSource.show = false;
    },

    async update() {
      if (!enabled || !dataSource) return false;
      request?.abort();
      const current = new AbortController();
      request = current;
      loading = true;
      try {
        const payload = await source.getDataset(config.dataset, {
          signal: current.signal,
        });
        if (current.signal.aborted || request !== current || !enabled)
          return false;
        const next = [];
        for (const feature of payload.features)
          next.push(...entitiesFor(feature));
        dataSource.entities.removeAll();
        for (const entity of next) dataSource.entities.add(entity);
        count = payload.features.length;
        lastUpdate = Number(payload.fetchedAt) || Date.now();
        stale = payload.stale === true;
        partial = payload.partial === true;
        error = null;
        return true;
      } catch (cause) {
        if (current.signal.aborted || request !== current || !enabled)
          return false;
        error = cause?.message || `${config.name} unavailable`;
        return false;
      } finally {
        if (request === current) request = null;
        loading = false;
      }
    },

    destroy(nextViewer = viewer) {
      request?.abort();
      request = null;
      enabled = false;
      loading = false;
      if (dataSource) nextViewer?.dataSources?.remove(dataSource, true);
      dataSource = null;
      viewer = null;
      count = 0;
      lastUpdate = null;
      error = null;
      stale = false;
      partial = false;
    },

    getRowControls() {
      return { chips: [], legend: config.legend };
    },

    getStats() {
      return { count, lastUpdate, error, loading, stale, partial };
    },
  };
}

/** Construct the four fixed Western Australia open-data layers. */
export function createWaOpenDataLayers({ source }) {
  if (typeof source?.getDataset !== 'function')
    throw new TypeError('A WA open-data source is required');
  return LAYERS.map((config) => createWaLayer(config, source));
}

export { createWaOpenDataSource } from './source.js';
