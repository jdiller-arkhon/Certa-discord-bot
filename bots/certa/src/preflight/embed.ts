import { Colors } from '@arkhon/shared';
import { EmbedBuilder } from 'discord.js';
import { formatKp } from './assess.js';
import type { MetarObservation } from './metar.js';
import { POSITION_UNKNOWN, type PreflightReport } from './service.js';

export const ADVISORY_FOOTER =
  'Advisory only. Check official sources (1800wxbrief, NOTAMs, tfr.faa.gov) and obtain airspace ' +
  'authorization (LAANC or FAADroneZone) where required before flight.';

const TFR_UNAVAILABLE = 'TFR data unavailable, check tfr.faa.gov';
const FIELD_LIMIT = 1024;

function truncate(text: string, limit = FIELD_LIMIT): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

const relative = (date: Date) => `<t:${Math.floor(date.getTime() / 1000)}:R>`;

function windText(metar: MetarObservation): string {
  if (metar.windSpeedKt === null) return 'n/a';
  if (metar.windSpeedKt === 0) return 'Calm';
  const dir = metar.windDirection === null ? '' : metar.windDirection === 'VRB' ? 'VRB ' : `${String(metar.windDirection).padStart(3, '0')}° `;
  const gust = metar.gustKt !== null ? ` G${metar.gustKt}` : '';
  return `${dir}${metar.windSpeedKt}${gust} kt`;
}

function conditionsText(metar: MetarObservation): string {
  const lines = [
    `**Wind** ${windText(metar)}`,
    `**Visibility** ${metar.visibilitySm === null ? 'n/a' : `${metar.visibilitySm}${metar.visibilitySm >= 10 ? '+' : ''} SM`}`,
    `**Ceiling** ${metar.ceilingFt === null ? 'None' : `${metar.ceilingFt.toLocaleString('en-US')} ft`}`,
  ];
  if (metar.temperatureC !== null) {
    lines.push(`**Temp/Dew** ${metar.temperatureC}°C / ${metar.dewpointC ?? 'n/a'}°C`);
  }
  if (metar.altimeterInHg !== null) lines.push(`**Altimeter** ${metar.altimeterInHg.toFixed(2)} inHg`);
  if (metar.weather) lines.push(`**Weather** ${metar.weather}`);
  if (metar.flightCategory) lines.push(`**Category** ${metar.flightCategory}`);
  return lines.join('\n');
}

export function buildPreflightEmbed(report: PreflightReport): EmbedBuilder {
  const { assessment } = report;
  const metar = report.metar.ok ? report.metar.value : null;
  const title = metar?.name ? `Preflight: ${report.icao} (${metar.name})` : `Preflight: ${report.icao}`;

  const summary =
    assessment.level === 'GO'
      ? '🟢 **GO**: conditions within configured limits'
      : `🟡 **CAUTION**: ${assessment.reasons.join('; ')}`;

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(assessment.level === 'GO' ? Colors.success : Colors.warning)
    .setDescription(truncate(summary, 4096))
    .setTimestamp(report.generatedAt)
    .setFooter({ text: ADVISORY_FOOTER });

  if (!report.metar.ok) {
    embed.addFields({ name: 'METAR', value: `Unavailable (${report.metar.error})` });
  } else if (!metar) {
    embed.addFields({ name: 'METAR', value: 'No recent METAR reported for this station.' });
  } else {
    embed.addFields(
      { name: 'Conditions', value: conditionsText(metar), inline: false },
      { name: `METAR (observed ${relative(metar.observedAt)})`, value: truncate(`\`\`\`${metar.raw}\`\`\``) },
    );
  }

  if (!report.taf.ok) embed.addFields({ name: 'TAF', value: `Unavailable (${report.taf.error})` });
  else if (!report.taf.value) embed.addFields({ name: 'TAF', value: 'No TAF issued for this station.' });
  else embed.addFields({ name: 'TAF', value: truncate(`\`\`\`${report.taf.value.raw}\`\`\``) });

  if (!report.kp.ok || !report.kp.value) {
    embed.addFields({ name: 'Planetary Kp', value: `Unavailable${report.kp.ok ? '' : ` (${report.kp.error})`}`, inline: true });
  } else {
    const { kp, observedAt } = report.kp.value;
    const elevated = assessment.reasons.some((reason) => reason.startsWith('Kp '));
    embed.addFields({
      name: 'Planetary Kp',
      value: `${elevated ? '⚠️ ' : ''}Kp ${formatKp(kp)}${elevated ? ' (elevated: GPS degradation possible)' : ''}\n${relative(observedAt)}`,
      inline: true,
    });
  }

  if (!report.tfrs.ok) {
    const value =
      report.tfrs.error === POSITION_UNKNOWN ? 'Airport position unknown without a METAR; check tfr.faa.gov' : TFR_UNAVAILABLE;
    embed.addFields({ name: 'TFRs', value, inline: false });
  } else if (report.tfrs.value.length === 0) {
    embed.addFields({
      name: 'TFRs',
      value: `No published TFRs within ${report.tfrRadiusNm} NM. Verify at tfr.faa.gov.`,
      inline: false,
    });
  } else {
    const lines = report.tfrs.value
      .slice(0, 6)
      .map((tfr) => `• **${tfr.notamId}** ${tfr.type}${tfr.distanceNm === 0 ? ' (**overhead**)' : `, ${tfr.distanceNm.toFixed(0)} NM`}\n${tfr.title}`);
    if (report.tfrs.value.length > 6) lines.push(`…and ${report.tfrs.value.length - 6} more at tfr.faa.gov`);
    embed.addFields({ name: `⚠️ TFRs nearby (${report.tfrs.value.length})`, value: truncate(lines.join('\n')) });
  }

  return embed;
}
