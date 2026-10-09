import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { isRecognizedAisEnvelope } from '../../../src/data/aisStreamAdapter.js';
export const AISSTREAM_CACHE_MAX = 50000;
export const AISSTREAM_STALE_MS = 30 * 60 * 1000;
export const AIS_WATCH_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const WATCH_LIMIT = 100;
let watchlist;
let watchFile;
let watchDirty = false;
let watchTimer = null;
let persistenceError = null;
let writeError = null;
// Per-MMSI recent-path ring buffers (PRD WS-F F3). Float32 lat/lon (~1m
// precision, fine for 25m thinning) + Uint32 epoch seconds ≈ 12B/sample;
// 64 samples × 50k MMSIs worst case ≈ 38MB. Tracks exist only while the dev
// server runs — this is "recent path", not voyage history.
const AIS_TRACK_SAMPLES = 64;
const AIS_TRACK_MIN_GAP_SEC = 30;
const AIS_TRACK_MIN_MOVE_M = 25;
/** @type {Map<string,object>} */
const _aisStreamVessels = new Map();
/** @type {Map<string,object>} */
const _aisStreamStatic = new Map();
/** @type {Map<string,{lats:Float32Array,lons:Float32Array,times:Uint32Array,head:number,len:number}>} mmsi -> track ring buffer */
const _aisStreamTracks = new Map();
/** @type {Map<string,{lat:number,lon:number,epochSec:number}>} mmsi -> first fix awaiting second (lazy buffer allocation) */
const _aisStreamTrackPending = new Map();

/**
 * Store one parsed AIS envelope.
 *
 * The return value is the feed's ONLY liveness proof, so it is true strictly
 * when the envelope carried a real AIS record. Malformed frames and error
 * envelopes never reach here — the adapter classifies those — and a JSON
 * object without an MMSI proves nothing about the feed.
 *
 * @param {Object} envelope Parsed, non-error AIS envelope.
 * @returns {boolean} True when an AIS record was recognised.
 */
export function ingestAisStreamEnvelope(envelope) {
  // Single shared recognition rule (also used by the adapter's tests), so the
  // liveness predicate that ships is the one under test. An envelope carrying
  // only an MMSI is not proof the feed works.
  if (!isRecognizedAisEnvelope(envelope)) return false;
  loadWatchlist();

  const messageType = envelope?.MessageType;
  const message = envelope?.Message?.[messageType] || {};
  const metadata = envelope?.MetaData || envelope?.Metadata || {};
  const mmsi = stringValue(
    metadata.MMSI ?? message.UserID ?? message.UserId ?? message.Mmsi,
  );
  if (!mmsi) return false;

  if (messageType === 'ShipStaticData' || messageType === 'StaticDataReport') {
    const staticData = {
      name: vesselNameFromAis(metadata, message, _aisStreamStatic.get(mmsi)),
      type: vesselTypeFromAis(message, _aisStreamStatic.get(mmsi)),
      destination: stringValue(
        message.Destination ?? _aisStreamStatic.get(mmsi)?.destination,
      ),
      imo: stringValue(
        message.ImoNumber ?? message.IMO ?? _aisStreamStatic.get(mmsi)?.imo,
      ),
    };
    _aisStreamStatic.set(mmsi, staticData);
    mergeAisStaticIntoLiveVessel(mmsi, staticData);
    rememberWatchedVessel(mmsi);
    return true;
  }

  const lat = numberValue(
    metadata.latitude ?? metadata.Latitude ?? message.Latitude,
  );
  const lon = numberValue(
    metadata.longitude ?? metadata.Longitude ?? message.Longitude,
  );
  // A positionless but well-formed record (static data) is still the feed
  // delivering AIS traffic, so it counts as liveness.
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    Math.abs(lat) > 90 ||
    Math.abs(lon) > 180
  )
    return true;
  const positionEpoch = aisEpochSeconds(metadata.time_utc ?? metadata.TimeUtc);
  if (positionEpoch < (_aisStreamVessels.get(mmsi)?.last_position_epoch || 0))
    return true;

  const staticData = _aisStreamStatic.get(mmsi) || {};
  _aisStreamVessels.set(mmsi, {
    lat,
    lon,
    name: vesselNameFromAis(metadata, message, staticData) || `MMSI ${mmsi}`,
    mmsi,
    imo: stringValue(message.ImoNumber ?? message.IMO ?? staticData.imo),
    type: vesselTypeFromAis(message, staticData),
    destination: stringValue(message.Destination ?? staticData.destination),
    speed: numberValue(message.Sog ?? message.SOG),
    course: numberValue(message.Cog ?? message.COG),
    heading: normalizedHeading(message.TrueHeading ?? message.Heading),
    last_position_UTC: normalizeAisTimestamp(
      metadata.time_utc ?? metadata.TimeUtc,
    ),
    // Use the AIS message's own report time, not server ingest wall-clock —
    // trail spacing and dead reckoning depend on true fix epochs.
    last_position_epoch: positionEpoch,
    _updatedAt: Date.now(),
  });

  appendAisTrackSample(
    mmsi,
    lat,
    lon,
    aisEpochSeconds(metadata.time_utc ?? metadata.TimeUtc),
  );

  rememberWatchedVessel(mmsi);
  pruneAisStreamCache();
  return true;
}

/**
 * Parses an AISStream UTC timestamp into epoch seconds (fallback: now).
 */
function aisEpochSeconds(value) {
  const ms = Date.parse(normalizeAisTimestamp(value));
  return Number.isFinite(ms)
    ? Math.floor(ms / 1000)
    : Math.floor(Date.now() / 1000);
}

/**
 * Appends a thinned position sample to a vessel's track ring buffer.
 * Buffers allocate lazily on the second fix (most MMSIs are seen once);
 * samples are kept only when >=AIS_TRACK_MIN_GAP_SEC and
 * >=AIS_TRACK_MIN_MOVE_M from the previous stored sample, so anchored
 * vessels collapse to a single point.
 */
function appendAisTrackSample(mmsi, lat, lon, epochSec) {
  let track = _aisStreamTracks.get(mmsi);
  if (!track) {
    const pending = _aisStreamTrackPending.get(mmsi);
    if (!pending) {
      _aisStreamTrackPending.set(mmsi, { lat, lon, epochSec });
      return;
    }
    if (epochSec - pending.epochSec < AIS_TRACK_MIN_GAP_SEC) return;
    if (
      approxMetersBetween(pending.lat, pending.lon, lat, lon) <
      AIS_TRACK_MIN_MOVE_M
    )
      return;
    track = {
      lats: new Float32Array(AIS_TRACK_SAMPLES),
      lons: new Float32Array(AIS_TRACK_SAMPLES),
      times: new Uint32Array(AIS_TRACK_SAMPLES),
      head: 0,
      len: 0,
    };
    _aisStreamTracks.set(mmsi, track);
    _aisStreamTrackPending.delete(mmsi);
    writeAisTrackSample(track, pending.lat, pending.lon, pending.epochSec);
    writeAisTrackSample(track, lat, lon, epochSec);
    return;
  }

  const lastIdx = (track.head - 1 + AIS_TRACK_SAMPLES) % AIS_TRACK_SAMPLES;
  const lastEpoch = track.times[lastIdx];
  if (epochSec - lastEpoch < AIS_TRACK_MIN_GAP_SEC) return;
  if (
    approxMetersBetween(track.lats[lastIdx], track.lons[lastIdx], lat, lon) <
    AIS_TRACK_MIN_MOVE_M
  )
    return;
  writeAisTrackSample(track, lat, lon, epochSec);
}

function writeAisTrackSample(track, lat, lon, epochSec) {
  track.lats[track.head] = lat;
  track.lons[track.head] = lon;
  track.times[track.head] = epochSec;
  track.head = (track.head + 1) % AIS_TRACK_SAMPLES;
  track.len = Math.min(track.len + 1, AIS_TRACK_SAMPLES);
}

/**
 * Reads a vessel's accumulated track in chronological order.
 * @returns {Array<{lat:number,lon:number,t:number}>}
 */
export function readAisTrack(mmsi) {
  const track = _aisStreamTracks.get(mmsi);
  if (!track || !track.len) return [];
  const samples = [];
  const start =
    (track.head - track.len + AIS_TRACK_SAMPLES) % AIS_TRACK_SAMPLES;
  for (let i = 0; i < track.len; i++) {
    const idx = (start + i) % AIS_TRACK_SAMPLES;
    samples.push({
      lat: track.lats[idx],
      lon: track.lons[idx],
      t: track.times[idx],
    });
  }
  return samples;
}

/** Equirectangular distance approximation — plenty for 25m thinning. */
function approxMetersBetween(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * 111320;
  const dLon =
    (lon2 - lon1) * 111320 * Math.cos(((lat1 + lat2) / 2) * (Math.PI / 180));
  return Math.hypot(dLat, dLon);
}

function mergeAisStaticIntoLiveVessel(mmsi, staticData) {
  const existing = _aisStreamVessels.get(mmsi);
  if (!existing) return;
  if (staticData.name && (!existing.name || existing.name === `MMSI ${mmsi}`))
    existing.name = staticData.name;
  if (staticData.type && !existing.type) existing.type = staticData.type;
  if (staticData.destination && !existing.destination)
    existing.destination = staticData.destination;
  if (staticData.imo && !existing.imo) existing.imo = staticData.imo;
}

function vesselNameFromAis(metadata, message, staticData = {}) {
  return stringValue(
    metadata.ShipName ??
      message.Name ??
      message.ShipName ??
      message.ReportA?.Name ??
      staticData.name,
  );
}

function vesselTypeFromAis(message, staticData = {}) {
  return stringValue(
    message.Type ??
      message.ShipType ??
      message.ReportB?.ShipType ??
      staticData.type,
  );
}

/** Return the ordinary row window plus every retained watched position. */
export function aisStreamRows(maxRows) {
  loadWatchlist();
  pruneAisStreamCache();
  const rows = [..._aisStreamVessels.values()].sort(
    (a, b) => b._updatedAt - a._updatedAt,
  );
  const selected = new Map(
    rows.slice(0, maxRows).map((row) => [row.mmsi, row]),
  );
  for (const mmsi of watchlist.keys()) {
    const row = _aisStreamVessels.get(mmsi);
    if (row) selected.set(mmsi, row);
  }
  return [...selected.values()].map(publicVessel);
}

function publicVessel({ _updatedAt, ...row }) {
  const ageMs = Math.max(0, Date.now() - row.last_position_epoch * 1000);
  return {
    ...row,
    pinned: watchlist.has(row.mmsi),
    ageMs,
    stale: ageMs > AISSTREAM_STALE_MS,
  };
}

/** Search the full retained cache, not the browser's row window. */
export function lookupAisVessels(query) {
  loadWatchlist();
  pruneAisStreamCache();
  const q = String(query || '')
    .trim()
    .toUpperCase();
  if (!q || q.length > 120)
    throw new Error('Enter a vessel name, MMSI or IMO (up to 120 characters).');
  const numeric = /^(?:MMSI\s*|IMO\s*)?\d+$/i.test(q);
  const number = q.replace(/^(MMSI|IMO)\s*/i, '');
  const matches = [];
  for (const row of _aisStreamVessels.values()) {
    const name = row.name.toUpperCase();
    const rank = numeric
      ? row.mmsi === number ||
        (row.imo && row.imo !== '0' && row.imo === number)
        ? 0
        : -1
      : name === q
        ? 0
        : name.startsWith(q)
          ? 1
          : name.includes(q)
            ? 2
            : -1;
    if (rank >= 0) matches.push({ row, rank });
  }
  matches.sort(
    (a, b) =>
      a.rank - b.rank ||
      b.row.last_position_epoch - a.row.last_position_epoch ||
      a.row.mmsi.localeCompare(b.row.mmsi),
  );
  return {
    query,
    candidates: matches.slice(0, 25).map(({ row }) => publicVessel(row)),
    total: matches.length,
    source: 'AISStream',
  };
}

function loadWatchlist() {
  if (watchlist) return;
  watchFile = resolve(
    process.env.GEV_VESSEL_WATCHLIST_FILE || '.gev-cache/vessel-watchlist.json',
  );
  watchlist = new Map();
  try {
    const saved = JSON.parse(readFileSync(watchFile, 'utf8'));
    if (!Array.isArray(saved) || saved.length > WATCH_LIMIT)
      throw new Error('Invalid vessel watchlist file');
    for (const entry of saved) {
      if (!/^\d{9}$/.test(entry?.mmsi)) throw new Error('Invalid watched MMSI');
      const row = entry.row;
      const valid =
        row?.mmsi === entry.mmsi &&
        Number.isFinite(row.lat) &&
        Math.abs(row.lat) <= 90 &&
        Number.isFinite(row.lon) &&
        Math.abs(row.lon) <= 180 &&
        Number.isFinite(row.last_position_epoch) &&
        typeof row.name === 'string';
      const retained =
        valid &&
        Date.now() - row.last_position_epoch * 1000 <= AIS_WATCH_RETENTION_MS;
      watchlist.set(entry.mmsi, retained ? row : null);
      if (valid && !retained) scheduleWatchlistSave();
      if (retained) {
        _aisStreamVessels.set(entry.mmsi, row);
        _aisStreamStatic.set(entry.mmsi, row);
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      persistenceError =
        'Cannot read vessel watchlist. Repair the cache file before changing pins.';
      console.warn('[AISStream]', persistenceError);
    }
    for (const mmsi of (process.env.GEV_VESSEL_WATCHLIST ?? '259069000')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => /^\d{9}$/.test(s))
      .slice(0, WATCH_LIMIT))
      watchlist.set(mmsi, null);
  }
}

function rememberWatchedVessel(mmsi) {
  if (!watchlist.has(mmsi)) return;
  const row = _aisStreamVessels.get(mmsi);
  if (!row) return;
  watchlist.set(mmsi, row);
  scheduleWatchlistSave();
}

function scheduleWatchlistSave() {
  watchDirty = true;
  if (!watchTimer) {
    watchTimer = setTimeout(() => {
      watchTimer = null;
      try {
        flushAisWatchlist();
      } catch (error) {
        writeError = `Vessel positions are not saved to disk: ${error.message}`;
        console.warn('[AISStream]', writeError);
      }
    }, 1000);
    watchTimer.unref?.();
  }
}

/** Persist a small watchlist atomically; called on updates and server shutdown. */
export function flushAisWatchlist() {
  if (watchTimer) clearTimeout(watchTimer);
  watchTimer = null;
  if (!watchDirty) return;
  if (persistenceError) throw new Error(persistenceError);
  mkdirSync(dirname(watchFile), { recursive: true });
  const temp = `${watchFile}.${process.pid}.tmp`;
  writeFileSync(
    temp,
    JSON.stringify([...watchlist].map(([mmsi, row]) => ({ mmsi, row }))),
    { mode: 0o600 },
  );
  renameSync(temp, watchFile);
  watchDirty = false;
  writeError = null;
}

/** Read pins even before AIS has received their first position. */
export function readAisWatchlist() {
  loadWatchlist();
  pruneAisStreamCache();
  return {
    entries: [...watchlist].map(([mmsi, saved]) => ({
      mmsi,
      name: saved?.name || `MMSI ${mmsi}`,
      vessel: _aisStreamVessels.has(mmsi)
        ? publicVessel(_aisStreamVessels.get(mmsi))
        : null,
    })),
    source: 'AISStream',
    retentionMs: AIS_WATCH_RETENTION_MS,
    error: persistenceError || writeError,
  };
}

/** Change one deployment-wide pin. A failed disk write never reports success. */
export function setAisVesselPinned(mmsi, pinned) {
  loadWatchlist();
  if (!/^\d{9}$/.test(mmsi)) throw new Error('A nine-digit MMSI is required.');
  if (pinned && !watchlist.has(mmsi) && watchlist.size >= WATCH_LIMIT)
    throw new Error('Watchlist limit reached (100 vessels).');
  const before = new Map(watchlist);
  if (pinned)
    watchlist.set(
      mmsi,
      _aisStreamVessels.get(mmsi) || watchlist.get(mmsi) || null,
    );
  else watchlist.delete(mmsi);
  watchDirty = true;
  try {
    flushAisWatchlist();
  } catch (error) {
    watchlist = before;
    throw new Error(`Could not save vessel watchlist: ${error.message}`);
  }
  return readAisWatchlist();
}

function pruneAisStreamCache() {
  const cutoff = Date.now() - AISSTREAM_STALE_MS;
  for (const [mmsi, row] of _aisStreamVessels) {
    const expired = watchlist?.has(mmsi)
      ? Date.now() - row.last_position_epoch * 1000 > AIS_WATCH_RETENTION_MS
      : row._updatedAt < cutoff;
    if (expired) {
      if (watchlist?.has(mmsi)) {
        watchlist.set(mmsi, null);
        scheduleWatchlistSave();
      }
      _aisStreamVessels.delete(mmsi);
      _aisStreamTracks.delete(mmsi);
      _aisStreamTrackPending.delete(mmsi);
    }
  }
  // Pending single-fix entries for vessels never seen again must not leak
  const pendingCutoffSec = Math.floor(cutoff / 1000);
  for (const [mmsi, pending] of _aisStreamTrackPending) {
    if (pending.epochSec < pendingCutoffSec)
      _aisStreamTrackPending.delete(mmsi);
  }
  if (_aisStreamVessels.size <= AISSTREAM_CACHE_MAX) return;
  const ordered = [..._aisStreamVessels.entries()]
    .filter(([mmsi]) => !watchlist?.has(mmsi))
    .sort((a, b) => a[1]._updatedAt - b[1]._updatedAt);
  for (const [mmsi] of ordered.slice(
    0,
    _aisStreamVessels.size - AISSTREAM_CACHE_MAX,
  )) {
    _aisStreamVessels.delete(mmsi);
    _aisStreamTracks.delete(mmsi);
    _aisStreamTrackPending.delete(mmsi);
  }
}

export function newestAisPositionAt(rows) {
  return rows.reduce(
    (newest, row) =>
      row.last_position_UTC > (newest || '') ? row.last_position_UTC : newest,
    null,
  );
}

function stringValue(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim().slice(0, 512);
}

function numberValue(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizedHeading(value) {
  const heading = numberValue(value);
  return heading !== null && heading >= 0 && heading <= 360 ? heading : null;
}

function normalizeAisTimestamp(value) {
  const text = stringValue(value);
  if (!text) return new Date().toISOString();
  const normalized = text.replace(' +0000 UTC', 'Z').replace(' UTC', 'Z');
  const date = new Date(normalized);
  return Number.isNaN(date.getTime())
    ? new Date().toISOString()
    : date.toISOString();
}
