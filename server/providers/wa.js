import { readResponseJsonCapped } from './common/http.js';

const ARC_GIS_ROOTS = Object.freeze({
  incidents:
    'https://services2.arcgis.com/cHGEnmsJ165IBJRM/arcgis/rest/services/WebEoc_RoadIncidents/FeatureServer/1',
  closures:
    'https://services2.arcgis.com/cHGEnmsJ165IBJRM/arcgis/rest/services/WebEoc_RoadClosures/FeatureServer/4',
  cameras:
    'https://services7.arcgis.com/v8XBa2naYNQGOjlG/arcgis/rest/services/INF_AST_SECURITYCAMERAS_PV/FeatureServer/0',
  mines:
    'https://public-services.slip.wa.gov.au/public/rest/services/SLIP_Public_Services/Industry_and_Mining/MapServer/0',
  bushfires:
    'https://public-services.slip.wa.gov.au/public/rest/services/SLIP_Public_Services/Disaster/MapServer/2',
});

const DATASETS = Object.freeze({
  roads: Object.freeze({ ttlMs: 120_000 }),
  cameras: Object.freeze({ ttlMs: 60 * 60_000 }),
  mines: Object.freeze({ ttlMs: 60 * 60_000 }),
  bushfires: Object.freeze({ ttlMs: 120_000 }),
});

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_COORDINATES_PER_FEATURE = 50_000;

function boundedText(value, maxLength = 240) {
  if (value == null) return '';
  return String(value)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function boundedHttpsUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && !url.username && !url.password
      ? url.href.slice(0, 500)
      : '';
  } catch {
    return '';
  }
}

function boundedDate(value) {
  if (!Number.isFinite(value)) return '';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : '';
}

function coordinate(value) {
  if (!Array.isArray(value) || value.length < 2) return null;
  const lon = Number(value[0]);
  const lat = Number(value[1]);
  if (
    !Number.isFinite(lon) ||
    !Number.isFinite(lat) ||
    Math.abs(lon) > 180 ||
    Math.abs(lat) > 90
  )
    return null;
  return [Number(lon.toFixed(6)), Number(lat.toFixed(6))];
}

function coordinateList(values, minimum, counter) {
  if (!Array.isArray(values) || values.length < minimum) return null;
  const result = [];
  for (const value of values) {
    if (++counter.count > MAX_COORDINATES_PER_FEATURE) return null;
    const point = coordinate(value);
    if (!point) return null;
    result.push(point);
  }
  return result;
}

function closedRing(values, counter) {
  const ring = coordinateList(values, 3, counter);
  if (!ring) return null;
  const first = ring[0];
  const last = ring.at(-1);
  if (first[0] !== last[0] || first[1] !== last[1]) {
    if (++counter.count > MAX_COORDINATES_PER_FEATURE) return null;
    ring.push([...first]);
  }
  return ring.length >= 4 ? ring : null;
}

/** Validate and bound GeoJSON geometry returned by ArcGIS. */
export function normalizeWaGeometry(geometry, allowedTypes) {
  if (!geometry || !allowedTypes.includes(geometry.type)) return null;
  const counter = { count: 0 };
  if (geometry.type === 'Point') {
    const coordinates = coordinate(geometry.coordinates);
    return coordinates ? { type: 'Point', coordinates } : null;
  }
  if (geometry.type === 'LineString') {
    const coordinates = coordinateList(geometry.coordinates, 2, counter);
    return coordinates ? { type: 'LineString', coordinates } : null;
  }
  if (geometry.type === 'MultiLineString') {
    if (!Array.isArray(geometry.coordinates)) return null;
    const coordinates = geometry.coordinates.map((line) =>
      coordinateList(line, 2, counter),
    );
    return coordinates.length > 0 && coordinates.every(Boolean)
      ? { type: 'MultiLineString', coordinates }
      : null;
  }
  const polygon = (rings) => {
    if (!Array.isArray(rings) || rings.length === 0 || rings.length > 100)
      return null;
    const normalized = rings.map((ring) => closedRing(ring, counter));
    return normalized.every(Boolean) ? normalized : null;
  };
  if (geometry.type === 'Polygon') {
    const coordinates = polygon(geometry.coordinates);
    return coordinates ? { type: 'Polygon', coordinates } : null;
  }
  if (!Array.isArray(geometry.coordinates)) return null;
  const coordinates = geometry.coordinates.map(polygon);
  return coordinates.length > 0 && coordinates.every(Boolean)
    ? { type: 'MultiPolygon', coordinates }
    : null;
}

function normalizedId(feature, properties, fallback) {
  return boundedText(
    feature?.id ??
      properties?.OBJECTID ??
      properties?.objectid ??
      properties?.oid ??
      properties?.FID ??
      fallback,
    80,
  );
}

/** Convert one allow-listed ArcGIS response into the small client contract. */
export function normalizeWaArcGis(kind, payload, maxFeatures) {
  if (!Array.isArray(payload?.features) || payload?.exceededTransferLimit)
    throw new Error(`Malformed or truncated ${kind} response`);
  const features = [];
  const ids = new Set();
  for (const [index, feature] of payload.features
    .slice(0, maxFeatures)
    .entries()) {
    const properties = feature?.properties;
    if (!properties || typeof properties !== 'object') continue;
    let normalized = null;
    if (kind === 'incidents') {
      const geometry = normalizeWaGeometry(feature.geometry, ['Point']);
      if (geometry)
        normalized = {
          id: normalizedId(feature, properties, `incident-${index}`),
          category: 'incident',
          title: boundedText(
            properties.Location || properties.Road || 'Road incident',
          ),
          detail: boundedText(
            [
              properties.IncidentTy,
              properties.TrafficCon,
              properties.TrafficImp,
            ]
              .filter(Boolean)
              .join(' · '),
            500,
          ),
          updated: boundedText(properties.UpdateDate, 80),
          url: boundedHttpsUrl(properties.SeeMoreUrl),
          geometry,
        };
    } else if (kind === 'closures') {
      const geometry = normalizeWaGeometry(feature.geometry, [
        'LineString',
        'MultiLineString',
      ]);
      if (geometry)
        normalized = {
          id: normalizedId(feature, properties, `closure-${index}`),
          category: 'closure',
          title: boundedText(
            properties.Location || properties.Road || 'Road closure',
          ),
          detail: boundedText(
            [
              properties.ClosureTyp,
              properties.IncidentTy,
              properties.TrafficImp,
            ]
              .filter(Boolean)
              .join(' · '),
            500,
          ),
          updated: boundedText(properties.UpdateDate, 80),
          url: boundedHttpsUrl(properties.SeeMoreUrl),
          geometry,
        };
    } else if (kind === 'cameras') {
      const geometry = normalizeWaGeometry(feature.geometry, ['Point']);
      if (geometry)
        normalized = {
          id: normalizedId(feature, properties, `camera-${index}`),
          category: 'camera',
          title: boundedText(properties.CAMERA_NUM || 'Public camera', 80),
          detail: 'Coordinate metadata only. No video access.',
          geometry,
        };
    } else if (kind === 'mines') {
      if (boundedText(properties.site_stage, 40).toLowerCase() !== 'operating')
        continue;
      const geometry = normalizeWaGeometry(feature.geometry, ['Point']);
      if (geometry)
        normalized = {
          id: normalizedId(feature, properties, `mine-${index}`),
          category: 'mine',
          title: boundedText(
            properties.site_title || properties.short_name || 'Operating site',
          ),
          detail: boundedText(
            [
              properties.site_type_,
              properties.site_commo,
              properties.target_com,
            ]
              .filter(Boolean)
              .join(' · '),
            300,
          ),
          url: boundedHttpsUrl(properties.web_link),
          geometry,
        };
    } else if (kind === 'bushfires') {
      const geometry = normalizeWaGeometry(feature.geometry, [
        'Polygon',
        'MultiPolygon',
      ]);
      if (geometry)
        normalized = {
          id: normalizedId(feature, properties, `bushfire-${index}`),
          category: 'bushfire',
          title: boundedText(
            properties.fire_numbe
              ? `Fire ${properties.fire_numbe}`
              : properties.feature || 'Bushfire perimeter',
          ),
          detail: boundedText(
            [properties.district, properties.feature]
              .filter(Boolean)
              .join(' · '),
            300,
          ),
          updated: boundedDate(properties.capt_date),
          geometry,
        };
    }
    if (normalized?.id && !ids.has(normalized.id)) {
      ids.add(normalized.id);
      features.push(normalized);
    }
  }
  return features;
}

function queryUrl(root, { where = '1=1', outFields, limit, simplify }) {
  const url = new URL(`${root}/query`);
  url.searchParams.set('where', where);
  url.searchParams.set('outFields', outFields);
  url.searchParams.set('returnGeometry', 'true');
  url.searchParams.set('outSR', '4326');
  url.searchParams.set('resultRecordCount', String(limit));
  if (simplify) url.searchParams.set('maxAllowableOffset', String(simplify));
  url.searchParams.set('f', 'geojson');
  return url;
}

async function fetchArcGis(fetchImpl, root, options) {
  const response = await fetchImpl(queryUrl(root, options), {
    headers: {
      Accept: 'application/geo+json, application/json',
      'User-Agent': 'GodsEyeView/0.1 WA-open-data-proxy',
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`ArcGIS HTTP ${response.status}`);
  const payload = await readResponseJsonCapped(response, MAX_RESPONSE_BYTES);
  if (payload?.error) throw new Error('ArcGIS query failed');
  return payload;
}

/** Create the independently cached acquisition service used by the middleware. */
export function createWaDataService({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  const cache = new Map();
  const inFlight = new Map();

  async function load(dataset) {
    if (dataset === 'roads') {
      const requests = [
        [
          'incidents',
          ARC_GIS_ROOTS.incidents,
          'FID,Location,IncidentTy,TrafficCon,TrafficImp,UpdateDate,Road,SeeMoreUrl',
          2_000,
        ],
        [
          'closures',
          ARC_GIS_ROOTS.closures,
          'FID,Location,IncidentTy,ClosureTyp,TrafficImp,UpdateDate,Road,SeeMoreUrl',
          2_000,
        ],
      ];
      const settled = await Promise.allSettled(
        requests.map(([, root, outFields, limit]) =>
          fetchArcGis(fetchImpl, root, {
            outFields,
            limit,
            simplify: 0.0001,
          }),
        ),
      );
      const features = [];
      const failures = [];
      for (const [index, result] of settled.entries()) {
        const [kind, , , limit] = requests[index];
        if (result.status === 'fulfilled')
          features.push(...normalizeWaArcGis(kind, result.value, limit));
        else failures.push(kind);
      }
      if (failures.length === requests.length)
        throw new Error('Main Roads WA feeds unavailable');
      return { features, partial: failures.length > 0, failures };
    }

    const request =
      dataset === 'cameras'
        ? [
            ARC_GIS_ROOTS.cameras,
            'cameras',
            'OBJECTID,CAMERA_NUM',
            '1=1',
            2_000,
            null,
          ]
        : dataset === 'mines'
          ? [
              ARC_GIS_ROOTS.mines,
              'mines',
              'oid,site_code,site_title,short_name,site_commo,site_type_,site_stage,target_com,web_link',
              "site_stage='Operating'",
              6_000,
              null,
            ]
          : [
              ARC_GIS_ROOTS.bushfires,
              'bushfires',
              'objectid,district,fire_numbe,feature,capt_date,capt_time',
              '1=1',
              500,
              0.0001,
            ];
    const [root, kind, outFields, where, limit, simplify] = request;
    const payload = await fetchArcGis(fetchImpl, root, {
      where,
      outFields,
      limit,
      simplify,
    });
    return {
      features: normalizeWaArcGis(kind, payload, limit),
      partial: false,
      failures: [],
    };
  }

  async function get(dataset) {
    const config = DATASETS[dataset];
    if (!config) throw new TypeError('Unknown WA dataset');
    const current = now();
    const cached = cache.get(dataset);
    if (cached && current - cached.fetchedAt < config.ttlMs)
      return { ...cached.payload, cache: 'hit' };
    if (inFlight.has(dataset)) return inFlight.get(dataset);
    const pending = load(dataset)
      .then((result) => {
        const payload = {
          dataset,
          fetchedAt: now(),
          stale: false,
          ttlMs: config.ttlMs,
          ...result,
        };
        cache.set(dataset, { fetchedAt: payload.fetchedAt, payload });
        return { ...payload, cache: 'miss' };
      })
      .catch((error) => {
        if (cached) return { ...cached.payload, stale: true, cache: 'stale' };
        throw error;
      })
      .finally(() => inFlight.delete(dataset));
    inFlight.set(dataset, pending);
    return pending;
  }

  return Object.freeze({ get });
}

export function waOpenDataProxy(options) {
  const service = createWaDataService(options);
  const install = (server) => {
    server.middlewares.use('/api/wa', async (req, res) => {
      const dataset = String(req.url || '')
        .split('?')[0]
        .replace(/^\/+|\/+$/g, '');
      const send = (status, payload) => {
        res.writeHead(status, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify(payload));
      };
      if (req.method !== 'GET')
        return send(405, { error: 'Method Not Allowed' });
      if (!DATASETS[dataset]) return send(404, { error: 'Unknown WA dataset' });
      try {
        send(200, await service.get(dataset));
      } catch (error) {
        console.warn(
          `[wa-open-data] ${dataset} fetch failed:`,
          error?.message || error,
        );
        send(503, { error: `${dataset} temporarily unavailable` });
      }
    });
  };
  return {
    name: 'wa-open-data-proxy',
    configureServer: install,
    configurePreviewServer: install,
  };
}

export { ARC_GIS_ROOTS, DATASETS };
