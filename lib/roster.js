import { CLASSES, ROLES, ROLE_ORDER, PANDA_RANKS, OTHER_RANKS, describeChar, guildArmoryUrl, classIcon, setClassIcons, nameSlug, armoryUrlForSlug } from './data.js';
import { dc, guildRoles, listMembers, displayName } from './discord.js';
import { allMembers, getConfig, saveConfig, getGuild } from './store.js';
import { ensureClassEmojis } from './emojis.js';
import { normalize } from './wizard.js';

const PANDA_COLOR = 0x2b7bb9;
const ALT_COLOR = 0x8e6cc4;
const OTHER_COLOR = 0x4f545c;
const DIST_COLOR = 0x3ba55d;
const GUILD_COLOR = 0xc79c6e;

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
  return CLASSES.map((c, i) => [c.name, i]).filter(([n]) => counts.get(n)).map(([n, i]) => `${classIcon(i)} ${n} ${counts.get(n)}`).join(' · ') || '—';
}

// Class-eloszlás a Panda mainek között: mind a 9 class (a hiányzók is), Blizzard-színű ikon, sáv, darab, arány
// és az altok száma. A sáv és a számok inline kódban vannak, hogy egymás alá essenek.
export function classDistribution(mains, alts) {
  const total = mains.length;
  const count = (list) => CLASSES.map((_, i) => list.filter((ch) => ch.cls === i).length);
  const m = count(mains);
  const a = count(alts);
  const max = Math.max(1, ...m);
  const lines = CLASSES.map((c, i) => {
    const bar = '█'.repeat(Math.round((m[i] / max) * 10)).padEnd(10, '░');
    const pct = total ? `${Math.round((m[i] / total) * 100)}%` : '–';
    const alt = a[i] ? ` · _+${a[i]} alt_` : '';
    return `${classIcon(i)} \`${bar} ${String(m[i]).padStart(2)} ${pct.padStart(4)}\` **${c.name}**${alt}`;
  });
  const missing = CLASSES.filter((_, i) => !m[i]).map((c) => c.name);
  return {
    title: `📊 Class-eloszlás — Panda mainek (${total} fő)`,
    color: DIST_COLOR,
    description: [
      ...lines,
      missing.length && total ? `\n**Nincs még main:** ${missing.join(', ')}` : '',
      alts.length ? `_Az „alt” a Panda altokat mutatja (${alts.length} db), az arányba nem számít bele._` : '',
    ].filter(Boolean).join('\n'),
  };
}

// Guild a Blizzard armory szerint (ha a szinkron be van kapcsolva): class-megoszlás, szintek, és a rosterben nem
// szereplő guildkarakterek. A rosterben szereplő név: bármely tag mainje vagy altja, teljes névvel.
export function guildEmbed(guild, rosterSlugs) {
  if (!guild?.members?.length) return null;
  const ms = guild.members;
  const byCls = CLASSES.map((_, i) => ms.filter((x) => x.cls === i).length);
  const classLine = CLASSES.map((c, i) => (byCls[i] ? `${classIcon(i)} ${byCls[i]}` : null)).filter(Boolean).join('  ');
  const maxLevel = Math.max(...ms.map((x) => x.level ?? 0));
  const atMax = ms.filter((x) => x.level === maxLevel).length;
  const missing = ms.filter((x) => !rosterSlugs.has(x.slug)).sort((x, y) => (y.level ?? 0) - (x.level ?? 0));
  const missingText = missing.map((x) => `${x.cls >= 0 ? classIcon(x.cls) : '▫️'} ${x.name} (${x.level ?? '?'})`).join(', ');
  return {
    title: `🏰 Guild a Blizzard armory szerint — ${ms.length} karakter`,
    url: guildArmoryUrl(),
    color: GUILD_COLOR,
    description: clip([
      classLine,
      `Legmagasabb szint: **${maxLevel}** (${atMax} karakter)`,
      missing.length ? `\n**Nincs a rosterben (${missing.length}):** ${missingText}` : '\n✅ Minden guildkarakter szerepel a rosterben.',
      '_Párosítás: teljes név, vagy egyértelmű keresztnév. Névütközésnél (pl. két „Power”) add meg a teljes nevet; az altokat is vedd fel a rosterbe._',
    ].join('\n'), 4000),
    footer: { text: `Blizzard szinkron: ${new Date(guild.syncedAt).toLocaleString('hu-HU', { timeZone: 'Europe/Budapest' })}` },
  };
}

function groupByRole(entries, line) {
  return ROLE_ORDER.flatMap((role) => {
    const group = entries.filter((e) => e.ch.role === role);
    if (!group.length) return [];
    return [`\n__${ROLES[role].emoji} ${ROLES[role].label} (${group.length})__`, ...group.map(line)];
  });
}

const sortChars = (a, b) => ROLE_ORDER.indexOf(a.ch.role) - ROLE_ORDER.indexOf(b.ch.role) || a.ch.cls - b.ch.cls || a.dn.localeCompare(b.dn, 'hu');

// Rosterbeli karakternév → guildkarakter (Blizzard). Sorrend: pontos teljes név → teljes név ékezet nélkül →
// keresztnév; az utóbbi kettő csak akkor, ha egyértelmű (egy guildkarakter felel meg neki, és csak egy rosterbeli
// karakter hivatkozik rá). Így a csak keresztnévvel megadott karakterek is párosulnak, ha nincs névütközés.
const fold = (s) => s.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('hu');
export function makeGuildMatcher(guildMembers, rosterNames) {
  const exact = new Map(guildMembers.map((m) => [m.slug, m]));
  const group = (keyOf) => {
    const map = new Map();
    for (const m of guildMembers) {
      const k = keyOf(m);
      if (k) map.set(k, [...(map.get(k) ?? []), m]);
    }
    return map;
  };
  const byFolded = group((m) => fold(m.slug));
  const byFirst = group((m) => fold(m.name.trim().split(/\s+/)[0] ?? ''));
  const resolve = (name) => {
    if (!name?.trim()) return null;
    const slug = nameSlug(name);
    if (slug && exact.has(slug)) return { m: exact.get(slug), exact: true };
    const f = slug && byFolded.get(fold(slug));
    if (f?.length === 1) return { m: f[0], exact: false };
    const c = byFirst.get(fold(name.trim().split(/\s+/)[0]));
    return c?.length === 1 ? { m: c[0], exact: false } : null;
  };
  // Ha több rosterbeli karakter is ugyanarra a guildkarakterre esne nem pontos egyezéssel, egyiket sem párosítjuk.
  const claims = new Map();
  for (const n of rosterNames) {
    const r = resolve(n);
    if (r && !r.exact) claims.set(r.m.slug, (claims.get(r.m.slug) ?? 0) + 1);
  }
  return (name) => {
    const r = resolve(name);
    if (!r) return null;
    return r.exact || claims.get(r.m.slug) === 1 ? r.m : null;
  };
}

// A #roster két üzenetének tartalma: [fő roster, Panda alt roster].
export async function buildRoster({ icons, guild } = {}) {
  setClassIcons(icons);
  const [records, members, roles, guildData] = await Promise.all([allMembers(), listMembers(), guildRoles(), guild === undefined ? getGuild().catch(() => null) : guild]);
  const allChars = records.flatMap((r) => [r.main, ...(r.alts ?? (r.alt ? [r.alt] : []))]).filter(Boolean);
  const matchGuild = makeGuildMatcher(guildData?.members ?? [], allChars.map((ch) => ch.name));
  // Szint, item level és armory-link a párosított guildkarakterből.
  const show = (ch) => {
    const g = matchGuild(ch.name);
    const extra = g ? ` · ${g.level ?? '?'}. szint${g.ilvl ? ` · ilvl ${g.ilvl}` : ''}` : '';
    return describeChar(ch, { withRole: false, link: true, icon: true, extra, url: g ? armoryUrlForSlug(g.slug) : undefined });
  };
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
  const pandaLines = groupByRole(mains, (e) => `**${e.dn}** — ${show(e.ch)}${e.altCount ? ` · _+${e.altCount} alt_` : ''}`);
  const pandaEmbed = {
    title: `🐼 Panda roster — ${pandas.length} kitöltött`,
    color: PANDA_COLOR,
    description: clip(
      [
        roleCounts(mains.map((e) => e.ch)),
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
        `${roleCounts(g.recs.map((r) => r.main))}\n${classCounts(g.recs.map((r) => r.main))}\n${g.recs.map((r) => `${classIcon(r.main.cls)} ${r.dn}: ${CLASSES[r.main.cls].specs[r.main.spec][0]} ${CLASSES[r.main.cls].name}`).join(' · ')}`,
        1000,
      ),
    })),
    footer: { text: updated },
  };

  // --- Panda alt roster ---
  const alts = pandas.flatMap((r) => r.alts.map((ch) => ({ ch, dn: r.dn }))).sort(sortChars);
  const altLines = groupByRole(alts, (e) => `**${e.dn}** — ${show(e.ch)}`);
  const distEmbed = classDistribution(mains.map((e) => e.ch), alts.map((e) => e.ch));
  const rosterSlugs = new Set(rows.flatMap((r) => [r.main, ...r.alts]).map((ch) => matchGuild(ch?.name)?.slug).filter(Boolean));
  const gEmbed = guildEmbed(guildData, rosterSlugs);
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
      { type: 2, style: 5, label: 'Guild armory', emoji: { name: '🏰' }, url: guildArmoryUrl() },
    ],
  };
  // A Discord egy üzenet összes embedjére 6000 karakteres felső határt szab (az armory-linkek is beleszámítanak).
  const embedSize = (e) => (e.title?.length ?? 0) + (e.description?.length ?? 0) + (e.footer?.text?.length ?? 0) + (e.fields ?? []).reduce((n, f) => n + f.name.length + f.value.length, 0);
  const over = embedSize(pandaEmbed) + embedSize(distEmbed) + embedSize(otherEmbed) - 5900;
  if (over > 0) pandaEmbed.description = clip(pandaEmbed.description, pandaEmbed.description.length - over);
  if (gEmbed) {
    const overAlt = embedSize(altEmbed) + embedSize(gEmbed) - 5900;
    if (overAlt > 0) gEmbed.description = clip(gEmbed.description, Math.max(200, gEmbed.description.length - overAlt));
    const still = embedSize(altEmbed) + embedSize(gEmbed) - 5900;
    if (still > 0) altEmbed.description = clip(altEmbed.description, altEmbed.description.length - still);
  }

  const out = [
    { content: '', embeds: [pandaEmbed, distEmbed, otherEmbed], components: [], allowed_mentions: { parse: [] } },
    { content: '', embeds: gEmbed ? [altEmbed, gEmbed] : [altEmbed], components: [buttons], allowed_mentions: { parse: [] } },
  ];
  out.matched = guildData?.members?.length ? { matched: rosterSlugs.size, guild: guildData.members.length } : null;
  return out;
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
  let cfg = await getConfig();
  // A class-emojik egyszer töltődnek fel; ha hiányoznak, most pótoljuk (hiba esetén a tartalék jelek maradnak).
  if (!cfg.classEmojis || Object.keys(cfg.classEmojis).length < CLASSES.length) {
    try {
      cfg = { ...cfg, classEmojis: await ensureClassEmojis() };
      await saveConfig(cfg);
    } catch (e) {
      console.error('class emojis', e);
    }
  }
  const built = await buildRoster({ icons: cfg.classEmojis });
  const [mainPayload, altPayload] = built;
  const sameChannel = cfg.rosterChannelId === channelId;
  const mainId = await upsertMessage(channelId, sameChannel ? cfg.rosterMessageId : null, mainPayload);
  // Ha az alt roster még nem létezik, a fő roster után jön létre, így a sorrend megmarad.
  const altId = await upsertMessage(channelId, sameChannel ? cfg.altMessageId : null, altPayload);
  if (mainId !== cfg.rosterMessageId || altId !== cfg.altMessageId || !sameChannel) {
    await saveConfig({ ...cfg, rosterMessageId: mainId, altMessageId: altId, rosterChannelId: channelId });
  }
  return { mainId, altId, matched: built.matched };
}
