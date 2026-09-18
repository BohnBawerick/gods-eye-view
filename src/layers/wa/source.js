const DATASETS = new Set([
  'roads',
  'cameras',
  'mines',
  'bushfires',
  'transit',
  'coastal',
]);

/** Read one server-normalized WA dataset. */
export function createWaOpenDataSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    async getDataset(dataset, { signal } = {}) {
      if (!DATASETS.has(dataset)) throw new TypeError('Unknown WA dataset');
      signal?.throwIfAborted();
      const response = await fetchImpl(`/api/wa/${dataset}`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal,
      });
      if (!response.ok)
        throw new Error(`WA ${dataset} HTTP ${response.status}`);
      const payload = await response.json();
      signal?.throwIfAborted();
      if (
        payload?.dataset !== dataset ||
        !Array.isArray(payload.features) ||
        payload.features.length > 8_000
      )
        throw new Error(`Malformed WA ${dataset} response`);
      return payload;
    },
  };
}
