import { CLASSES, ROLES, ROLE_ORDER, PANDA_RANKS, OTHER_RANKS, describeChar } from './data.js';
import { dc, guildRoles, listMembers, displayName } from './discord.js';
import { allMembers, getConfig, saveConfig } from './store.js';

const PANDA_COLOR = 0x2b7bb9;
const OTHER_COLOR = 0x4f545c;

function clip(text, max) {
  return text.length <= max ? text : text.slice(0, max - 20) + '\n… (rövidítve)';
}

function roleCounts(recs) {
  const main = { T: 0, H: 0, D: 0 };
  const off = { T: 0, H: 0, D: 0 };
  for (const r of recs) {
    main[r.main.role]++;
    if (r.main.off != null) off[CLASSES[r.main.cls].specs[r.main.off][1]]++;
  }
  return ROLE_ORDER.map((k) => `${ROLES[k].emoji} ${ROLES[k].label}: **${main[k]}**${off[k] ? ` (+${off[k]} off)` : ''}`).join('  ·  ');
}

function classCounts(recs, { withAlts = false } = {}) {
  const counts = new Map();
  for (const r of recs) {
    const n = CLASSES[r.main.cls].name;
    counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  const alts = new Map();
  if (withAlts) for (const r of recs) if (r.alt) {
    const n = CLASSES[r.alt.cls].name;
    alts.set(n, (alts.get(n) ?? 0) + 1);
  }
  return CLASSES.map((c) => c.name)
    .filter((n) => counts.get(n) || alts.get(n))
    .map((n) => `${n} ${counts.get(n) ?? 0}${alts.get(n) ? ` (+${alts.get(n)} alt)` : ''}`)
    .join(' · ') || '—';
}

// Felépíti a #roster üzenet tartalmát a tárolt adatokból és a szerver aktuális taglistájából.
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
    .filter((r) => r.main && byId.has(r.userId))
    .map((r) => ({ ...r, member: byId.get(r.userId), rank: rankOf(byId.get(r.userId)), dn: displayName(byId.get(r.userId)) }))
    .sort((a, b) => ROLE_ORDER.indexOf(a.main.role) - ROLE_ORDER.indexOf(b.main.role) || a.main.cls - b.main.cls || a.dn.localeCompare(b.dn, 'hu'));

  const pandas = rows.filter((r) => r.rank === 'Panda');
  const filledIds = new Set(rows.map((r) => r.userId));
  const missing = [...byId.values()]
    .filter((m) => rankOf(m) === 'Panda' && !filledIds.has(m.user.id))
    .map(displayName)
    .sort((a, b) => a.localeCompare(b, 'hu'));

  const pandaLines = ROLE_ORDER.flatMap((role) => {
    const group = pandas.filter((r) => r.main.role === role);
    if (!group.length) return [];
    return [
      `\n__${ROLES[role].emoji} ${ROLES[role].label} (${group.length})__`,
      ...group.map((r) => `**${r.dn}** — ${describeChar(r.main, { withRole: false })}${r.alt ? `\n  ↳ alt: ${describeChar(r.alt)}` : ''}`),
    ];
  });

  const pandaEmbed = {
    title: `🐼 Panda roster — ${pandas.length} kitöltött`,
    color: PANDA_COLOR,
    description: clip(
      [
        roleCounts(pandas),
        `**Classok:** ${classCounts(pandas, { withAlts: true })}`,
        ...(pandaLines.length ? pandaLines : ['\n_Még senki nem töltötte ki._']),
        missing.length ? `\n**Még nem töltötte ki (${missing.length}):** ${missing.join(', ')}` : '',
      ].join('\n'),
      4000,
    ),
  };

  const others = rows.filter((r) => r.rank !== 'Panda');
  const groups = [...OTHER_RANKS, 'Rang nélkül'].map((rank) => ({ rank, recs: others.filter((r) => r.rank === rank) })).filter((g) => g.recs.length);
  const otherEmbed = {
    title: '📊 Többi rang — tájékoztató',
    color: OTHER_COLOR,
    description: groups.length ? null : '_Még senki nem töltötte ki._',
    fields: groups.slice(0, 25).map((g) => ({
      name: `${g.rank} (${g.recs.length})`,
      value: clip(
        `${roleCounts(g.recs)}\n${classCounts(g.recs)}\n${g.recs.map((r) => `${r.dn}: ${CLASSES[r.main.cls].specs[r.main.spec][0]} ${CLASSES[r.main.cls].name}`).join(' · ')}`,
        1000,
      ),
    })),
    footer: { text: `Frissítve: ${new Date().toLocaleString('hu-HU', { timeZone: 'Europe/Budapest' })}` },
  };

  return {
    content: '',
    embeds: [pandaEmbed, otherEmbed],
    components: [
      {
        type: 1,
        components: [
          { type: 2, style: 1, label: 'Karakterem megadása / módosítása', emoji: { name: '✏️' }, custom_id: 'menu:home' },
          { type: 2, style: 2, label: 'Frissítés', emoji: { name: '🔄' }, custom_id: 'refresh' },
        ],
      },
    ],
    allowed_mentions: { parse: [] },
  };
}

// Létrehozza vagy frissíti a #roster üzenetet.
export async function publishRoster() {
  const channelId = process.env.ROSTER_CHANNEL_ID;
  if (!channelId) throw new Error('Hiányzó környezeti változó: ROSTER_CHANNEL_ID');
  const payload = await buildRoster();
  const cfg = await getConfig();
  if (cfg.rosterMessageId && cfg.rosterChannelId === channelId) {
    try {
      await dc('PATCH', `/channels/${channelId}/messages/${cfg.rosterMessageId}`, payload);
      return cfg.rosterMessageId;
    } catch (e) {
      if (e.status !== 404) throw e;
    }
  }
  const msg = await dc('POST', `/channels/${channelId}/messages`, payload);
  await saveConfig({ ...cfg, rosterMessageId: msg.id, rosterChannelId: channelId });
  return msg.id;
}
