import type { ComponentHandler, SlashCommand } from '@arkhon/shared';
import type { CertaContext } from '../context.js';
import { certaCommand } from './certa.js';
import { logCommand, logComponents } from './log.js';
import { preflightCommand } from './preflight.js';
import { currencyCommand, hoursCommand, leaderboardCommand } from './stats.js';

export function createCommands(context: CertaContext): SlashCommand[] {
  return [
    certaCommand(context),
    logCommand(context),
    hoursCommand(context),
    currencyCommand(context),
    preflightCommand(context),
    leaderboardCommand(context),
  ];
}

export function createComponents(context: CertaContext): ComponentHandler[] {
  return logComponents(context);
}
