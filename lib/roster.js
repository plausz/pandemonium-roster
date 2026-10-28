import { CLASSES, ROLES, ROLE_ORDER, PANDA_RANKS, OTHER_RANKS, describeChar } from './data.js';
import { dc, guildRoles, listMembers, displayName } from './discord.js';
import { allMembers, getConfig, saveConfig } from './store.js';
import { normalize } from './wizard.js';

const PANDA_COLOR = 0x2b7bb9;
const ALT_COLOR = 0x8e6cc4;
const OTHER_COLOR = 0x4f545c;

function clip(text, max) {
  return text.length <= max ? text : text.slice(0, max - 20) + '\n… (rövidítve)';
}

const offRole = (ch) => (ch.off != null ? CLASSES[ch.cls].specs[ch.off][1] : null);

function roleCounts(chars) {
  const main = { T: 0, H: 0, D: 0 };
  const off = { T: 0, H: 0, D: 0 };
  for (const ch of chars) {
    main[ch.role]++;
    if (offRole(ch)) off[offRole(ch)]++;
  }
  return ROLE_ORDER.map((k) => `${ROLES[k].emoji} ${ROLES[k].label}: **${main[k]}**${off[k] ? ` (+${off[k]} off)` : ''}`).join('  ·  ');
}

function classCounts(chars) {
  const counts = new Map();
  for (const ch of chars) counts.set(CLASSES[ch.cls].name, (counts.get(CLASSES[ch.cls].name) ?? 0) + 1);
  return CLASSES.map((c) => c.name).filter((n) => counts.get(n)).map((n) => `${n} ${counts.get(n)}`).join(' · ') || '—';
}

function groupByRole(entries, line) {
  return ROLE_ORDER.flatMap((role) => {
    const group = entries.filter((e) => e.ch.role === role);
    if (!group.length) return [];
    return [`\n__${ROLES[role].emoji} ${ROLES[role].label} (${group.length})__`, ...group.map(line)];
  });
}

const sortChars = (a, b) => ROLE_ORDER.indexOf(a.ch.role) - ROLE_ORDER.indexOf(b.ch.role) || a.ch.cls - b.ch.cls || a.dn.localeCompare(b.dn, 'hu');

// A #roster két üzenetének tartalma: [fő roster, Panda alt roster].
export async function buildRoster() {
  const [records, members, roles] = await Promise.all([allMembers(), listMembers(), guildRoles()]);
  const roleName = Object.fromEntries(roles.map((r) => [r.id, r.name]));
  const byId = new Map(members.filter((m) => !m.user.bot).map((m) => [m.user.id, m]));

  const rankOf = (m) => {
    const names = m.roles.map((id) => roleName[id]);
    if (PANDA_RANKS.some((r) => names.includes(r))) return 'Panda';
    return OTHER_RANKS.find((r) => names.includes(r)) ?? 'Rang nélkül';
  };

  const rows = records
    .map(normalize)
    .filter((r) => r?.main && byId.has(r.userId))
    .map((r) => ({ ...r, rank: rankOf(byId.get(r.userId)), dn: displayName(byId.get(r.userId)) }));

  const pandas = rows.filter((r) => r.rank === 'Panda');
  const filledIds = new Set(rows.map((r) => r.userId));
  const missing = [...byId.values()]
    .filter((m) => rankOf(m) === 'Panda' && !filledIds.has(m.user.id))
    .map(displayName)
    .sort((a, b) => a.localeCompare(b, 'hu'));
  const updated = `Frissítve: ${new Date().toLocaleString('hu-HU', { timeZone: 'Europe/Budapest' })}`;

  // --- Fő roster: Pandák mainjei ---
  const mains = pandas.map((r) => ({ ch: r.main, dn: r.dn, altCount: r.alts.length })).sort(sortChars);
  const pandaLines = groupByRole(mains, (e) => `**${e.dn}** — ${describeChar(e.ch, { withRole: false })}${e.altCount ? ` · _+${e.altCount} alt_` : ''}`);
  const pandaEmbed = {
    title: `🐼 Panda roster — ${pandas.length} kitöltött`,
    color: PANDA_COLOR,
    description: clip(
      [
        roleCounts(mains.map((e) => e.ch)),
        `**Classok:** ${classCounts(mains.map((e) => e.ch))}`,
        ...(pandaLines.length ? pandaLines : ['\n_Még senki nem töltötte ki._']),
        missing.length ? `\n**Még nem töltötte ki (${missing.length}):** ${missing.join(', ')}` : '',
      ].join('\n'),
      4000,
    ),
  };

  // --- Többi rang: tájékoztató statisztika ---
  const others = rows.filter((r) => r.rank !== 'Panda');
  const groups = [...OTHER_RANKS, 'Rang nélkül'].map((rank) => ({ rank, recs: others.filter((r) => r.rank === rank) })).filter((g) => g.recs.length);
  const otherEmbed = {
    title: '📊 Többi rang — tájékoztató',
    color: OTHER_COLOR,
    description: groups.length ? null : '_Még senki nem töltötte ki._',
    fields: groups.slice(0, 25).map((g) => ({
      name: `${g.rank} (${g.recs.length})`,
      value: clip(
        `${roleCounts(g.recs.map((r) => r.main))}\n${classCounts(g.recs.map((r) => r.main))}\n${g.recs.map((r) => `${r.dn}: ${CLASSES[r.main.cls].specs[r.main.spec][0]} ${CLASSES[r.main.cls].name}`).join(' · ')}`,
        1000,
      ),
    })),
    footer: { text: updated },
  };

  // --- Panda alt roster ---
  const alts = pandas.flatMap((r) => r.alts.map((ch) => ({ ch, dn: r.dn }))).sort(sortChars);
  const altLines = groupByRole(alts, (e) => `**${e.dn}** — ${describeChar(e.ch, { withRole: false })}`);
  const altEmbed = {
    title: `🧪 Panda alt roster — ${alts.length} alt, ${pandas.filter((r) => r.alts.length).length} tagtól`,
    color: ALT_COLOR,
    description: clip(
      [
        alts.length ? roleCounts(alts.map((e) => e.ch)) : '',
        alts.length ? `**Classok:** ${classCounts(alts.map((e) => e.ch))}` : '',
        ...(altLines.length ? altLines : ['_Még senki nem adott meg altot._']),
      ].filter(Boolean).join('\n'),
      4000,
    ),
    footer: { text: updated },
  };

  const buttons = {
    type: 1,
    components: [
      { type: 2, style: 1, label: 'Karakterem megadása / módosítása', emoji: { name: '✏️' }, custom_id: 'menu:home' },
      { type: 2, style: 2, label: 'Frissítés', emoji: { name: '🔄' }, custom_id: 'refresh' },
    ],
  };
  return [
    { content: '', embeds: [pandaEmbed, otherEmbed], components: [], allowed_mentions: { parse: [] } },
    { content: '', embeds: [altEmbed], components: [buttons], allowed_mentions: { parse: [] } },
  ];
}

async function upsertMessage(channelId, messageId, payload) {
  if (messageId) {
    try {
      await dc('PATCH', `/channels/${channelId}/messages/${messageId}`, payload);
      return messageId;
    } catch (e) {
      if (e.status !== 404) throw e;
    }
  }
  return (await dc('POST', `/channels/${channelId}/messages`, payload)).id;
}

// Létrehozza vagy frissíti a #roster két üzenetét (fő roster + alt roster, a gombok az utolsón).
export async function publishRoster() {
  const channelId = process.env.ROSTER_CHANNEL_ID;
  if (!channelId) throw new Error('Hiányzó környezeti változó: ROSTER_CHANNEL_ID');
  const [mainPayload, altPayload] = await buildRoster();
  const cfg = await getConfig();
  const sameChannel = cfg.rosterChannelId === channelId;
  const mainId = await upsertMessage(channelId, sameChannel ? cfg.rosterMessageId : null, mainPayload);
  // Ha az alt roster még nem létezik, a fő roster után jön létre, így a sorrend megmarad.
  const altId = await upsertMessage(channelId, sameChannel ? cfg.altMessageId : null, altPayload);
  if (mainId !== cfg.rosterMessageId || altId !== cfg.altMessageId || !sameChannel) {
    await saveConfig({ ...cfg, rosterMessageId: mainId, altMessageId: altId, rosterChannelId: channelId });
  }
  return { mainId, altId };
}
