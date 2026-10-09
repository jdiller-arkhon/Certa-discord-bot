import type { Logger } from '@arkhon/shared';
import { DateTime } from 'luxon';
import { createCertaClient } from './certa/index.js';
import type { CertaConfig } from './config.js';
import type { CertaContext } from './context.js';
import { openCertaDatabase } from './db.js';
import { PreflightService } from './preflight/service.js';
import { CertaStore } from './store.js';

/** Wires config, storage, the Certa client, and preflight into one context. */
export function createContext(config: CertaConfig, logger: Logger): CertaContext {
  const db = openCertaDatabase(config.env.CERTA_DB_PATH);
  return {
    config,
    store: new CertaStore(db),
    certa: createCertaClient(config, db),
    preflight: new PreflightService({ thresholds: config.thresholds, tfrRadiusNm: config.tfrRadiusNm, logger }),
    logger,
    now: () => DateTime.now().setZone(config.timezone),
  };
}
