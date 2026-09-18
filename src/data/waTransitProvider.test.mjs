import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import {
  eachCsvRow,
  interpolateTrip,
  parseGtfsTimetable,
  readZipEntries,
  scheduledPositions,
} from '../../server/providers/waTransit.js';
import {
  createWaDataService,
  normalizeWaTransit,
} from '../../server/providers/wa.js';

// Build a deflated ZIP archive the way the upstream feed is packaged.
function zip(files) {
  const locals = [];
  const directory = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBytes = Buffer.from(name);
    const raw = Buffer.from(text);
    const data = deflateRawSync(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    directory.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const directoryBytes = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directoryBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, directoryBytes, end]));
}

// Perth local wall-clock time on Friday 18 September 2026, as epoch ms.
const perth = (hours, minutes = 0) => Date.UTC(2026, 8, 18, hours - 8, minutes);

const GTFS = Object.freeze({
  'routes.txt':
    'route_id,agency_id,route_short_name,route_long_name,route_desc,route_type\n' +
    'R1,A,,Mandurah Line,,2\n' +
    'F1,A,,Ferry,,4\n' +
    'B1,A,,Bus 100,,3\n',
  'trips.txt':
    'route_id,service_id,trip_id,direction_id,trip_headsign\n' +
    'R1,WEEK,T1,0,Mandurah\n' +
    'R1,WEEK,LATE,0,Mandurah\n' +
    'R1,WEEK,BACKWARDS,0,Nowhere\n' +
    'F1,WEEKEND,FERRY,0,Mends St\n' +
    'B1,WEEK,BUS,0,City\n',
  // The real feed pads header names and quotes stop names.
  'stops.txt':
    'location_type, parent_station, stop_id, stop_code, stop_name, stop_lat, stop_lon\n' +
    '0,,S1,S1,"Perth, Stn",-32.0,115.0\n' +
    '0,,S2,S2,"Elizabeth Quay",-32.0,116.0\n' +
    '0,,S3,S3,"Bad",-32.0,999\n',
  'stop_times.txt':
    'trip_id,arrival_time,departure_time,stop_id,stop_sequence\n' +
    'T1,08:10:00,08:10:00,S2,2\n' +
    'T1,08:00:00,08:02:00,S1,1\n' +
    'LATE,24:50:00,24:50:00,S1,1\n' +
    'LATE,25:10:00,25:10:00,S2,2\n' +
    'BACKWARDS,09:00:00,09:00:00,S1,1\n' +
    'BACKWARDS,08:00:00,08:00:00,S2,2\n' +
    'FERRY,08:00:00,08:00:00,S1,1\n' +
    'FERRY,08:10:00,08:10:00,S2,2\n' +
    'BUS,08:00:00,08:00:00,S1,1\n' +
    'BUS,08:10:00,08:10:00,S2,2\n',
  'calendar.txt':
    'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n' +
    'WEEK,1,1,1,1,1,0,0,20260901,20261231\n' +
    'WEEKEND,0,0,0,0,0,1,1,20260901,20261231\n',
  'calendar_dates.txt': 'service_id,date,exception_type\n',
});

test('GTFS ZIP entries inflate within the per-entry byte cap', () => {
  const archive = zip({ 'a.txt': 'hello', 'b.txt': 'x'.repeat(1_000) });
  const entries = readZipEntries(archive, ['a.txt'], 100);
  assert.deepEqual([...entries.keys()], ['a.txt']);
  assert.equal(entries.get('a.txt').toString(), 'hello');
  assert.throws(
    () => readZipEntries(archive, ['b.txt'], 100),
    /b\.txt is too large/,
  );
  assert.throws(
    () => readZipEntries(new Uint8Array(40), ['a.txt'], 100),
    /no ZIP directory/,
  );
});

test('GTFS CSV rows keep quoted commas and trim padded headers', () => {
  const rows = [];
  eachCsvRow(GTFS['stops.txt'], (row) => rows.push(row));
  assert.equal(rows[0].stop_name, 'Perth, Stn');
  assert.equal(rows[0].stop_lat, '-32.0');
});

test('GTFS timetable keeps ordered rail and ferry trips only', () => {
  const timetable = parseGtfsTimetable(GTFS);
  const ids = timetable.trips.map(({ id }) => id).sort();
  assert.deepEqual(ids, ['FERRY', 'LATE', 'T1']);
  const trip = timetable.trips.find(({ id }) => id === 'T1');
  assert.deepEqual(trip.arrivals, [28_800, 29_400]);
  assert.equal(trip.mode, 'rail');
  assert.equal(trip.name, 'Mandurah Line');
});

test('schedule interpolation dwells at stops and moves in a straight line between them', () => {
  const trip = parseGtfsTimetable(GTFS).trips.find(({ id }) => id === 'T1');
  assert.equal(interpolateTrip(trip, 28_799), null);
  assert.deepEqual(interpolateTrip(trip, 28_900), [115, -32]);
  assert.deepEqual(interpolateTrip(trip, 29_160), [115.5, -32]);
  assert.deepEqual(interpolateTrip(trip, 29_400), [116, -32]);
  assert.equal(interpolateTrip(trip, 29_401), null);
});

test('scheduled positions honour the Perth service day, weekday and exceptions', () => {
  const timetable = parseGtfsTimetable(GTFS);
  const at = (ms) =>
    scheduledPositions(timetable, ms, 10).map(({ trip }) => trip.id);
  assert.deepEqual(at(perth(8, 6)), ['T1']);
  // Thursday's 24:50 trip is still running at 01:00 Friday morning.
  assert.deepEqual(at(perth(1, 0)), ['LATE']);
  // The ferry runs weekends only.
  assert.deepEqual(at(Date.UTC(2026, 8, 19, 0, 5)), ['FERRY']);
  const cancelled = parseGtfsTimetable({
    ...GTFS,
    'calendar_dates.txt': 'service_id,date,exception_type\nWEEK,20260918,2\n',
  });
  assert.deepEqual(scheduledPositions(cancelled, perth(8, 6), 10), []);
  assert.equal(scheduledPositions(timetable, perth(8, 6), 0).length, 0);
});

test('scheduled transit output is bounded and labelled as timetable positions', () => {
  const features = normalizeWaTransit([
    {
      trip: {
        id: 'T1'.repeat(100),
        mode: 'rail',
        name: 'Line\u0000'.repeat(100),
        headsign: 'Mandurah',
      },
      position: [115.123456789, -32.1],
    },
    { trip: { id: 'X', mode: 'rail' }, position: [500, 0] },
  ]);
  assert.equal(features.length, 1, 'invalid coordinates are dropped');
  const [feature] = features;
  assert.equal(feature.id.length, 80);
  assert.equal(feature.title.length, 120);
  assert.doesNotMatch(feature.title, /\u0000/);
  assert.deepEqual(feature.geometry.coordinates, [115.123457, -32.1]);
  assert.match(feature.detail, /not live GPS/);
  assert.match(feature.detail, /towards Mandurah/);
});

test('scheduled transit caches the timetable and keeps positions moving when a refresh fails', async () => {
  let time = perth(8, 5);
  let downloads = 0;
  let failing = false;
  const archive = zip(GTFS);
  const service = createWaDataService({
    now: () => time,
    fetchImpl: async () => {
      downloads++;
      if (failing) throw new Error('timetable host down');
      return new Response(archive, { status: 200 });
    },
  });

  const first = await service.get('transit');
  assert.equal(first.cache, 'miss');
  assert.equal(first.stale, false);
  assert.deepEqual(first.features[0].geometry.coordinates, [115.375, -32]);

  assert.equal((await service.get('transit')).cache, 'hit');
  time += 30_001;
  const moved = await service.get('transit');
  assert.equal(moved.cache, 'miss');
  assert.ok(moved.features[0].geometry.coordinates[0] > 115.375);
  assert.equal(downloads, 1);

  // Next day, after the 12 h timetable lifetime, with the host down.
  failing = true;
  time += 24 * 60 * 60_000;
  const stale = await service.get('transit');
  assert.equal(stale.stale, true);
  assert.deepEqual(
    stale.features.map(({ category }) => category),
    ['ferry'],
  );
  assert.equal(downloads, 2);
  time += 30_001;
  await service.get('transit');
  assert.equal(downloads, 2, 'failed refresh backs off before retrying');
});

test('scheduled transit fails alone when the timetable was never loaded', async () => {
  const service = createWaDataService({
    now: () => perth(8, 5),
    fetchImpl: async (url) =>
      String(url).endsWith('.zip')
        ? new Response('not a zip', { status: 200 })
        : new Response(JSON.stringify({ features: [] }), { status: 200 }),
  });
  await assert.rejects(service.get('transit'), /no ZIP directory/);
  assert.deepEqual((await service.get('coastal')).features, []);
});
