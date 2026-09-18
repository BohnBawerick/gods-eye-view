import { inflateRawSync } from 'node:zlib';

// Perth observes no daylight saving, so the service day is a fixed UTC+8.
const PERTH_OFFSET_MS = 8 * 60 * 60_000;
const DAY_SECONDS = 24 * 60 * 60;
const MODES = Object.freeze({ 2: 'rail', 4: 'ferry' });

export const GTFS_FILES = Object.freeze([
  'routes.txt',
  'trips.txt',
  'stops.txt',
  'stop_times.txt',
  'calendar.txt',
  'calendar_dates.txt',
]);

/** Extract the named entries from a ZIP archive, inflating each within a byte cap. */
export function readZipEntries(bytes, names, maxEntryBytes) {
  const zip = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65_557); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error('GTFS archive has no ZIP directory');
  const wanted = new Set(names);
  const entries = new Map();
  let offset = zip.readUInt32LE(end + 16);
  for (let index = zip.readUInt16LE(end + 10); index > 0; index--) {
    if (offset + 46 > zip.length || zip.readUInt32LE(offset) !== 0x02014b50)
      throw new Error('GTFS archive directory is corrupt');
    const method = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const size = zip.readUInt32LE(offset + 24);
    const nameLength = zip.readUInt16LE(offset + 28);
    const local = zip.readUInt32LE(offset + 42);
    const name = zip.toString('utf8', offset + 46, offset + 46 + nameLength);
    offset +=
      46 +
      nameLength +
      zip.readUInt16LE(offset + 30) +
      zip.readUInt16LE(offset + 32);
    if (!wanted.has(name)) continue;
    if (size > maxEntryBytes) throw new Error(`GTFS ${name} is too large`);
    if (local + 30 > zip.length || zip.readUInt32LE(local) !== 0x04034b50)
      throw new Error(`GTFS ${name} header is corrupt`);
    const start =
      local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    if (start + compressedSize > zip.length)
      throw new Error(`GTFS ${name} is truncated`);
    const data = zip.subarray(start, start + compressedSize);
    if (method === 0) entries.set(name, data);
    else if (method === 8)
      entries.set(
        name,
        inflateRawSync(data, { maxOutputLength: maxEntryBytes }),
      );
    else throw new Error(`GTFS ${name} uses unsupported compression`);
  }
  return entries;
}

function csvCells(line) {
  if (!line.includes('"')) return line.split(',');
  const cells = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quoted) {
      if (char === '"' && line[i + 1] === '"') cell += line[++i];
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      cells.push(cell);
      cell = '';
    } else cell += char;
  }
  cells.push(cell);
  return cells;
}

/**
 * Visit each CSV row as a header-keyed object. `keep` sees the raw first cell
 * so large files can skip unwanted rows before they are split.
 * ponytail: quoted fields spanning lines are not supported; GTFS feeds here have none.
 */
export function eachCsvRow(text, visit, keep = null) {
  let header = null;
  let start = 0;
  while (start < text.length) {
    let end = text.indexOf('\n', start);
    if (end < 0) end = text.length;
    const line = text.slice(start, end).replace(/\r$/, '');
    start = end + 1;
    if (!line) continue;
    if (!header) {
      header = csvCells(line.replace(/^\uFEFF/, '')).map((name) => name.trim());
      continue;
    }
    if (keep && !keep(line.slice(0, line.indexOf(',')).replace(/"/g, '')))
      continue;
    const cells = csvCells(line);
    const row = {};
    for (const [index, name] of header.entries())
      row[name] = (cells[index] ?? '').trim();
    visit(row);
  }
}

function gtfsSeconds(value) {
  const match = /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(value);
  return match ? +match[1] * 3600 + +match[2] * 60 + +match[3] : null;
}

/**
 * Reduce a GTFS feed to the rail and ferry trips needed for scheduled
 * positions. `files` maps GTFS file names to their text.
 */
export function parseGtfsTimetable(files) {
  const routes = new Map();
  eachCsvRow(files['routes.txt'], (row) => {
    const mode = MODES[row.route_type];
    if (mode)
      routes.set(row.route_id, {
        mode,
        name: row.route_long_name || row.route_short_name,
      });
  });
  const trips = new Map();
  eachCsvRow(files['trips.txt'], (row) => {
    const route = routes.get(row.route_id);
    if (route)
      trips.set(row.trip_id, {
        id: row.trip_id,
        route,
        serviceId: row.service_id,
        headsign: row.trip_headsign,
        calls: [],
      });
  });
  const stops = new Map();
  eachCsvRow(files['stops.txt'], (row) => {
    const lon = Number(row.stop_lon);
    const lat = Number(row.stop_lat);
    if (
      row.stop_lon &&
      row.stop_lat &&
      Math.abs(lon) <= 180 &&
      Math.abs(lat) <= 90
    )
      stops.set(row.stop_id, [lon, lat]);
  });
  eachCsvRow(
    files['stop_times.txt'],
    (row) => {
      const stop = stops.get(row.stop_id);
      const arrival = gtfsSeconds(row.arrival_time);
      const departure = gtfsSeconds(row.departure_time);
      if (stop && arrival != null && departure != null && departure >= arrival)
        trips
          .get(row.trip_id)
          .calls.push([Number(row.stop_sequence), arrival, departure, stop]);
    },
    (tripId) => trips.has(tripId),
  );
  const services = new Map();
  eachCsvRow(files['calendar.txt'], (row) => {
    services.set(row.service_id, {
      days: [
        row.sunday,
        row.monday,
        row.tuesday,
        row.wednesday,
        row.thursday,
        row.friday,
        row.saturday,
      ].map((day) => day === '1'),
      start: row.start_date,
      end: row.end_date,
      exceptions: new Map(),
    });
  });
  eachCsvRow(files['calendar_dates.txt'], (row) => {
    if (!services.has(row.service_id))
      services.set(row.service_id, {
        days: [],
        start: '',
        end: '',
        exceptions: new Map(),
      });
    services.get(row.service_id).exceptions.set(row.date, row.exception_type);
  });

  const timed = [];
  for (const trip of trips.values()) {
    const calls = trip.calls.sort((a, b) => a[0] - b[0]);
    // A trip is usable only when its timetable never runs backwards.
    if (
      calls.length < 2 ||
      calls.some((call, index) => index > 0 && call[1] < calls[index - 1][2])
    )
      continue;
    timed.push({
      id: trip.id,
      mode: trip.route.mode,
      name: trip.route.name,
      headsign: trip.headsign,
      serviceId: trip.serviceId,
      arrivals: calls.map((call) => call[1]),
      departures: calls.map((call) => call[2]),
      points: calls.map((call) => call[3]),
    });
  }
  return { trips: timed, services };
}

function serviceDay(ms) {
  const local = new Date(ms + PERTH_OFFSET_MS);
  return {
    date: local.toISOString().slice(0, 10).replaceAll('-', ''),
    weekday: local.getUTCDay(),
    seconds:
      local.getUTCHours() * 3600 +
      local.getUTCMinutes() * 60 +
      local.getUTCSeconds(),
  };
}

function runsOn(service, { date, weekday }) {
  const exception = service?.exceptions.get(date);
  if (exception === '1') return true;
  if (exception === '2' || !service) return false;
  return (
    service.days[weekday] === true &&
    service.start <= date &&
    date <= service.end
  );
}

/** Place a trip at `seconds` into its service day by straight-line interpolation between stops. */
export function interpolateTrip(trip, seconds) {
  const last = trip.arrivals.length - 1;
  if (seconds < trip.arrivals[0] || seconds > trip.arrivals[last]) return null;
  let low = 0;
  let high = last;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (trip.arrivals[middle] <= seconds) low = middle;
    else high = middle - 1;
  }
  if (low === last || seconds <= trip.departures[low]) return trip.points[low];
  // ponytail: straight line between stops; shapes.txt (79 MB) would follow the track.
  const span = trip.arrivals[low + 1] - trip.departures[low];
  const fraction = span > 0 ? (seconds - trip.departures[low]) / span : 1;
  const [fromLon, fromLat] = trip.points[low];
  const [toLon, toLat] = trip.points[low + 1];
  return [
    fromLon + (toLon - fromLon) * fraction,
    fromLat + (toLat - fromLat) * fraction,
  ];
}

/** List scheduled positions for trips running at `nowMs`, including after-midnight trips of the previous service day. */
export function scheduledPositions(timetable, nowMs, limit) {
  const today = serviceDay(nowMs);
  const yesterday = serviceDay(nowMs - DAY_SECONDS * 1000);
  yesterday.seconds = today.seconds + DAY_SECONDS;
  const days = [today, yesterday];
  const active = days.map(() => new Map());
  const positions = [];
  for (const trip of timetable.trips) {
    if (positions.length >= limit) break;
    for (const [index, day] of days.entries()) {
      if (!active[index].has(trip.serviceId))
        active[index].set(
          trip.serviceId,
          runsOn(timetable.services.get(trip.serviceId), day),
        );
      if (!active[index].get(trip.serviceId)) continue;
      const position = interpolateTrip(trip, day.seconds);
      if (!position) continue;
      positions.push({ trip, position });
      break;
    }
  }
  return positions;
}
