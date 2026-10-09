/** Maximum retention of missing records during an incomplete refresh. */
export const PARTIAL_RETENTION_MS = 5 * 60 * 1000;

/** Complete refreshes a selected-but-missing vessel remains pinned. */
export const SELECTED_PIN_REFRESHES = 3;

export const AIS_FIRST_CONNECT_LABEL = 'awaiting first AIS position…';

/** Human-readable age of an observed position, never a claim of current location. */
export function formatVesselLastSeen(observedAtMs, now = Date.now()) {
  if (!Number.isFinite(observedAtMs)) return 'Position time unknown';
  const minutes = Math.max(0, Math.floor((now - observedAtMs) / 60000));
  const age =
    minutes < 1
      ? 'less than 1m'
      : minutes < 60
        ? `${minutes}m`
        : minutes < 1440
          ? `${Math.floor(minutes / 60)}h ${minutes % 60}m`
          : `${Math.floor(minutes / 1440)}d ${Math.floor((minutes % 1440) / 60)}h`;
  return `Last seen ${age} ago`;
}

/** Cached watch positions age independently of successful snapshot polls. */
export function isVesselStale(record, now = Date.now()) {
  return (
    record.stale === true ||
    (record.missedRefreshes || 0) > 0 ||
    (record.pinned === true &&
      (!Number.isFinite(record.lastPositionEpoch) ||
        now - record.lastPositionEpoch * 1000 > 30 * 60 * 1000))
  );
}
