import type { ServiceContext } from './types.js';

/** Chunk transport and complete-file budgets are independent of one-call inline input. */
export function binaryChunkLimits(config: ServiceContext['config']) {
  const maxCacheBytes = config.binaryInputs?.maxCacheBytes ?? 67_108_864;
  const fileMaxBytes = Math.min(config.limits.binaryWriteMaxBytes ?? 33_554_432, maxCacheBytes);
  return {
    chunkMaxBytes: Math.min(config.binaryInputs?.chunkMaxBytes ?? 65_536, fileMaxBytes),
    fileMaxBytes,
    maxCacheBytes,
    maxSessions: config.binaryInputs?.maxSessions ?? 4,
    ttlMs: config.binaryInputs?.ttlMs ?? 900_000,
  };
}
