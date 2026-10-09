import { type Logger, UserFacingError } from '@arkhon/shared';
import { DateTime } from 'luxon';
import {
  type CertaClient,
  CertaAuthError,
  CertaInvalidLinkCodeError,
  CertaRejectedError,
  CertaResponseError,
  CertaUnavailableError,
  CertaUserNotFoundError,
} from './certa/index.js';
import type { CertaConfig } from './config.js';
import type { PreflightService } from './preflight/service.js';
import type { CertaStore, Link } from './store.js';

export interface CertaContext {
  config: CertaConfig;
  store: CertaStore;
  certa: CertaClient;
  preflight: PreflightService;
  logger: Logger;
  /** Current time in the bot's configured time zone. */
  now: () => DateTime;
}

export const NOT_LINKED_MESSAGE =
  "Your Discord account isn't linked to Certa yet. In the Certa app, open **Settings → Discord** to get a " +
  'one-time code, then run `/certa link code:<code>`.';

/** Returns the caller's link or throws a friendly "not linked" error. */
export function requireLink(context: CertaContext, discordUserId: string): Link {
  const link = context.store.getLink(discordUserId);
  if (!link) throw new UserFacingError(NOT_LINKED_MESSAGE);
  return link;
}

/**
 * Runs a Certa API call and converts its typed errors into messages the user
 * can act on. Unexpected failures are logged and rethrown as-is.
 */
export async function callCerta<T>(context: CertaContext, action: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof CertaInvalidLinkCodeError) {
      throw new UserFacingError(
        "That link code isn't valid. Codes are single-use and expire; generate a new one in the Certa app and try again.",
      );
    }
    if (error instanceof CertaUserNotFoundError) {
      throw new UserFacingError(
        'Your linked Certa account could not be found. Run `/certa unlink`, then link again with a new code.',
      );
    }
    if (error instanceof CertaRejectedError) {
      throw new UserFacingError(`Certa rejected that request${error.detail ? `: ${error.detail}` : '.'}`);
    }
    if (error instanceof CertaUnavailableError) {
      context.logger.warn('Certa unavailable', { action, error });
      throw new UserFacingError('Certa is not responding right now. Please try again in a few minutes.');
    }
    if (error instanceof CertaAuthError || error instanceof CertaResponseError) {
      context.logger.error('Certa integration error', { action, error });
      throw new UserFacingError('The Certa integration is misconfigured. An admin has been notified in the bot logs.');
    }
    throw error;
  }
}
