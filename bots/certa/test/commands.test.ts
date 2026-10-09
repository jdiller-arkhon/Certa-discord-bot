import { readFileSync } from 'node:fs';
import { createInteractionRouter, silentLogger } from '@arkhon/shared';
import type { Interaction } from 'discord.js';
import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { MockCertaClient } from '../src/certa/mock-client.js';
import { createCommands, createComponents } from '../src/commands/index.js';
import { type CertaConfig, loadCertaConfig } from '../src/config.js';
import { type CertaContext, NOT_LINKED_MESSAGE } from '../src/context.js';
import { openCertaDatabase } from '../src/db.js';
import { ADVISORY_FOOTER } from '../src/preflight/embed.js';
import { PreflightService } from '../src/preflight/service.js';
import { CertaStore } from '../src/store.js';

const USER = '123456789012345678';
const FLIGHT_LOGS = '234567890123456789';

const fixtureText = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

interface Reply {
  content?: string;
  embeds?: { toJSON(): { title?: string; description?: string; fields?: { name: string; value: string }[] } }[];
  components?: unknown[];
  flags?: number;
}

/** Records what a handler sent back, mimicking discord.js reply state. */
class FakeInteraction {
  deferred = false;
  replied = false;
  ephemeral = false;
  replies: Reply[] = [];
  modal: { toJSON(): { custom_id: string } } | undefined;
  user = { id: USER, displayName: 'Ava' };

  constructor(readonly kind: 'command' | 'modal' | 'button', readonly props: Record<string, unknown>) {
    Object.assign(this, props);
  }

  isChatInputCommand() {
    return this.kind === 'command';
  }
  isModalSubmit() {
    return this.kind === 'modal';
  }
  isButton() {
    return this.kind === 'button';
  }
  async reply(reply: Reply) {
    this.replied = true;
    this.ephemeral = Boolean(reply.flags);
    this.replies.push(reply);
  }
  async deferReply(options?: { flags?: number }) {
    this.deferred = true;
    this.ephemeral = Boolean(options?.flags);
  }
  async editReply(reply: Reply | string) {
    this.replies.push(typeof reply === 'string' ? { content: reply } : reply);
  }
  async followUp(reply: Reply) {
    this.replies.push(reply);
  }
  async showModal(modal: FakeInteraction['modal']) {
    this.modal = modal;
  }
  async update(reply: Reply) {
    this.replies.push(reply);
  }

  get last(): Reply {
    return this.replies.at(-1) ?? {};
  }
  get lastEmbed() {
    return this.last.embeds?.[0]?.toJSON();
  }
}

function command(name: string, options: Record<string, string> = {}, subcommand?: string) {
  return new FakeInteraction('command', {
    commandName: name,
    options: {
      getSubcommand: () => subcommand ?? null,
      getString: (key: string) => options[key] ?? null,
    },
  });
}

function setup() {
  const now = DateTime.fromISO('2026-10-09T12:00', { zone: 'America/Denver' });
  const db = openCertaDatabase(':memory:');
  const config: CertaConfig = loadCertaConfig({
    DISCORD_TOKEN: 'token',
    DISCORD_APPLICATION_ID: '345678901234567890',
    CERTA_CLIENT: 'mock',
    CERTA_FLIGHT_LOGS_CHANNEL_ID: FLIGHT_LOGS,
  });
  const fetches: string[] = [];
  const fetchFn = (async (url: string) => {
    fetches.push(String(url));
    if (url.includes('/metar')) return new Response(fixtureText('metar-kden.json'));
    if (url.includes('/taf')) return new Response(fixtureText('taf-kden.json'));
    if (url.includes('k-index')) return new Response(fixtureText('kp-index.json'));
    return new Response('<html>down for maintenance</html>', { status: 200 });
  }) as unknown as typeof fetch;

  const context: CertaContext = {
    config,
    store: new CertaStore(db),
    certa: new MockCertaClient(db, { timezone: 'America/Denver', now: () => now }),
    preflight: new PreflightService({
      thresholds: config.thresholds,
      tfrRadiusNm: 30,
      logger: silentLogger,
      fetchFn,
      now: () => new Date('2026-10-09T22:00:00Z'),
    }),
    logger: silentLogger,
    now: () => now,
  };
  const route = createInteractionRouter({
    commands: createCommands(context),
    components: createComponents(context),
    logger: silentLogger,
  });
  const run = async (interaction: FakeInteraction) => {
    await route(interaction as unknown as Interaction);
    return interaction;
  };
  return { context, run, fetches };
}

describe('Certa commands with the mock client', () => {
  it('reply ephemerally when the user is not linked', async () => {
    const { run } = setup();
    for (const interaction of [command('hours'), command('currency'), command('log', { mission: 'Training' })]) {
      await run(interaction);
      expect(interaction.ephemeral).toBe(true);
      expect(interaction.last.content).toBe(NOT_LINKED_MESSAGE);
    }
    const reminders = await run(command('certa', { state: 'off' }, 'reminders'));
    expect(reminders.last.content).toMatch(/isn't linked/);
  });

  it('runs the full pilot flow end to end', async () => {
    const { run, context } = setup();
    const sent: unknown[] = [];

    const link = await run(command('certa', { code: 'abc-123' }, 'link'));
    expect(link.ephemeral).toBe(true);
    expect(link.last.content).toMatch(/Linked to Certa as \*\*Pilot 5678\*\*/);
    expect(context.store.getLink(USER)?.certaUserId).toBe(`mock-${USER}`);

    const reused = await run(command('certa', { code: 'ABC-123' }, 'link'));
    expect(reused.last.content).toMatch(/isn't valid/);

    const log = await run(command('log', { mission: 'Inspection' }));
    expect(log.modal?.toJSON().custom_id).toBe('certa-log:Inspection');

    const fields: Record<string, string> = {
      date: '2026-10-09',
      location: '1200 Pearl St, Boulder, CO',
      aircraft: 'DJI Mavic 3E',
      duration: '42',
      notes: 'Roof inspection',
    };
    const submit = await run(
      new FakeInteraction('modal', {
        customId: 'certa-log:Inspection',
        fields: { getTextInputValue: (id: string) => fields[id] ?? '' },
      }),
    );
    expect(submit.ephemeral).toBe(true);
    expect(submit.lastEmbed?.title).toBe('✅ Flight logged to Certa');
    expect(submit.last.components).toHaveLength(1);
    const flightId = /Certa flight ID ([\w-]+)/.exec(JSON.stringify(submit.lastEmbed))?.[1];
    expect(flightId).toBeDefined();

    const button = () =>
      new FakeInteraction('button', {
        customId: `certa-share:${flightId}`,
        component: { type: 2, style: 2, custom_id: `certa-share:${flightId}`, label: 'Share to #flight-logs' },
        client: {
          channels: {
            fetch: async (id: string) =>
              id === FLIGHT_LOGS ? { name: 'flight-logs', isSendable: () => true, send: async (m: unknown) => sent.push(m) } : null,
          },
        },
      });
    const share = await run(button());
    expect(sent).toHaveLength(1);
    const shared = JSON.stringify((sent[0] as Reply).embeds?.[0]?.toJSON());
    expect(shared).toContain('Boulder, CO');
    expect(shared).not.toContain('1200 Pearl');
    expect(shared).not.toContain('Roof inspection');
    expect(share.replies).toHaveLength(1);
    const again = await run(button());
    expect(again.last.content).toMatch(/already been shared/);
    expect(sent).toHaveLength(1);

    const hours = await run(command('hours'));
    expect(hours.lastEmbed?.description).toContain('**1** total flight');
    expect(hours.lastEmbed?.fields?.[0]?.value).toContain('0.7 h');

    const currency = await run(command('currency'));
    expect(currency.lastEmbed?.description).toMatch(/Due soon/);
    expect(currency.lastEmbed?.fields?.find((f) => f.name === 'Due date')?.value).toBe('Nov 30, 2026');
    expect(currency.lastEmbed?.fields?.find((f) => f.name === 'Days remaining')?.value).toBe('52');

    const board = await run(command('leaderboard'));
    expect(board.lastEmbed?.title).toContain('October 2026');
    expect(board.lastEmbed?.description).toContain(`<@${USER}>`);

    const off = await run(command('certa', { state: 'off' }, 'reminders'));
    expect(off.last.content).toMatch(/\*\*off\*\*/);
    expect(context.store.getLink(USER)?.remindersEnabled).toBe(false);

    const unlink = await run(command('certa', {}, 'unlink'));
    expect(unlink.last.content).toMatch(/no longer linked/);
    expect((await run(command('hours'))).last.content).toBe(NOT_LINKED_MESSAGE);
  });

  it('rejects invalid flight forms without calling Certa', async () => {
    const { run, context } = setup();
    await run(command('certa', { code: 'ABC123' }, 'link'));
    const submit = await run(
      new FakeInteraction('modal', {
        customId: 'certa-log:Training',
        fields: { getTextInputValue: (id: string) => ({ date: '2030-01-01', location: 'KBJC', aircraft: 'X', duration: 'ten' })[id] ?? '' },
      }),
    );
    expect(submit.ephemeral).toBe(true);
    expect(submit.last.content).toMatch(/Flight not logged/);
    expect(submit.last.content).toMatch(/future/);
    expect(submit.last.content).toMatch(/whole number/);
    expect((await context.certa.getTotals(`mock-${USER}`)).totalFlights).toBe(0);
  });

  it('/preflight builds one embed and degrades TFRs gracefully', async () => {
    const { run, fetches } = setup();
    const preflight = await run(command('preflight', { icao: 'kden' }));
    const embed = preflight.lastEmbed!;
    expect(embed.title).toBe('Preflight: KDEN (Denver Intl, CO, US)');
    // Recorded KDEN wind is 17 kt, above the 15 kt default.
    expect(embed.description).toMatch(/CAUTION.*Wind 17 kt exceeds 15 kt/);
    expect(embed.fields?.find((f) => f.name === 'TFRs')?.value).toBe('TFR data unavailable, check tfr.faa.gov');
    expect(embed.fields?.find((f) => f.name === 'Planetary Kp')?.value).toContain('Kp 1.33');
    expect(JSON.stringify(embed)).toContain(ADVISORY_FOOTER);

    const before = fetches.length;
    await run(command('preflight', { icao: 'KDEN' }));
    // METAR, TAF and Kp are cached; only the failed TFR fetch is retried.
    expect(fetches.slice(before).every((url) => url.includes('geoserver'))).toBe(true);

    const invalid = await run(command('preflight', { icao: 'K1' }));
    expect(invalid.ephemeral).toBe(true);
    expect(invalid.last.content).toMatch(/4-character ICAO/);
  });
});
