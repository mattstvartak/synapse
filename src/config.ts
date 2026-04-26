import { join } from 'node:path';
import { homedir } from 'node:os';
import type { SynapseConfig } from './types.js';
import { DEFAULT_CONFIG } from './types.js';

export function loadConfig(overrides?: Partial<SynapseConfig>): SynapseConfig {
  const config: SynapseConfig = {
    ...DEFAULT_CONFIG,
    dataDir: process.env.SYNAPSE_DATA_DIR ?? join(homedir(), '.claude', 'synapse'),
    ...overrides,
  };

  if (process.env.SYNAPSE_TTL_SECONDS) {
    const parsed = parseInt(process.env.SYNAPSE_TTL_SECONDS, 10);
    if (Number.isFinite(parsed) && parsed > 0) config.defaultTtlSeconds = parsed;
  }

  if (process.env.SYNAPSE_PEER_TIMEOUT_SECONDS) {
    const parsed = parseInt(process.env.SYNAPSE_PEER_TIMEOUT_SECONDS, 10);
    if (Number.isFinite(parsed) && parsed > 0) config.peerHeartbeatTimeoutSeconds = parsed;
  }

  return config;
}
