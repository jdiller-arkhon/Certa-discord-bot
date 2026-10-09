import type { Db } from '@arkhon/shared';
import type { CertaConfig } from '../config.js';
import type { CertaClient } from './client.js';
import { HttpCertaClient } from './http-client.js';
import { MockCertaClient } from './mock-client.js';

export * from './client.js';
export * from './types.js';
export { HttpCertaClient } from './http-client.js';
export { MockCertaClient } from './mock-client.js';

/** Picks the Certa client implementation from `CERTA_CLIENT`. */
export function createCertaClient(config: CertaConfig, db: Db): CertaClient {
  if (config.env.CERTA_CLIENT === 'mock') {
    return new MockCertaClient(db, { timezone: config.timezone });
  }
  // Presence is guaranteed by the config schema when CERTA_CLIENT=http.
  return new HttpCertaClient({
    baseUrl: config.env.CERTA_API_BASE_URL!,
    token: config.env.CERTA_API_TOKEN!,
  });
}
