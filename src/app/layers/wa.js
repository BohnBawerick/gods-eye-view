import { createWaOpenDataLayers } from '../../layers/wa/index.js';

/** Construct the fixed Western Australia public-data layers. */
export function createApplicationWaLayers({ source }) {
  return createWaOpenDataLayers({ source });
}
