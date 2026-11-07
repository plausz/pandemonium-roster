import { dc, GUILD_ID, APP_ID, displayName, guildRoles } from './discord.js';
import { getConfig, saveConfig, getApplication, saveApplication, deleteApplication } from './store.js';

// --- Tagfelvétel (TGF) ---
// A TGF csatornában a bot egy panelt tart „Jelentkezem” gombbal. A gomb felugró ablakot nyit; beküldéskor a bot
// a jelentkezőnek saját privát csatornát nyit, amit csak ő, a TGF_VIEWER_ROLES rangok és a bot lát.
// Az Officerek a csatornában lévő „Lezárás” gombbal zárják le, döntéssel (Felvettük / Nem vettük fel).
// Felvételnél a bot ellenőrzi, hogy a tag megkapta-e már a klánrangot (TGF_MEMBER_ROLES), de maga nem oszt rangot:
// a rangot az Officer adja kézzel. Lezáráskor a csatorna törlődik, az összefoglaló a naplóba kerül (TGF_LOG_CHANNEL_ID).

const P = {
  VIEW: 1n << 10n,
  SEND: 1n << 11n,
  EMBED: 1n << 14n,
  HISTORY: 1n << 16n,
};
const perms = (...bits) => String(bits.reduce((a, b) => a | b, 0n));
const GOLD = 0xedb443;

const list = (env, def) => (process.env[env] ? process.env[env].split(',') : def).map((s) => s.trim()).filter(Boolean);
export const DEFAULT_VIEWER_ROLES = ['Panda', 'Officer', 'Klánvezető'];
export const DEFAULT_MEMBER_ROLES = ['Panda', 'Friends', 'OldPanda'];
const viewerRoleNames = () => list('TGF_VIEWER_ROLES', DEFAULT_VIEWER_ROLES);
const memberRoleNames = () => list('TGF_MEMBER_ROLES', DEFAULT_MEMBER_ROLES);
const pingRoleName = () => (process.env.TGF_PING_ROLE ?? 'Officer').trim();

// Rangok név szerint (kis-/nagybetű és ékezet nem számít, a jelek/emojik sem).
const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
async function rolesByName(names) {
  const roles = await guildRoles();
  const found = [];
  const missing = [];
  for (const n of names) {
    const r = roles.find((x) => norm(x.name) === norm(n));
    if (r) found.push(r);
    else missing.push(n);
  }
  return { found, missing };
}

export function channelName(name, userId) {
  const slug = (name ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  return `tgf-${slug || userId}`;
}

const clip = (s, max) => {
  const t = (s ?? '').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

// --- Panel a TGF csatornában ---
export function panelPayload() {
  return {
    embeds: [{
      title: '📝 Tagfelvétel – Pändemonium',
      color: GOLD,
      description: [
        'Szia, örülünk, hogy benéztél! 🐼 Így megy a jelentkezés:',
        '',
        '**1. Jelentkezés** – kattints lent a **Jelentkezem** gombra, és töltsd ki a rövid űrlapot (hogyan szólítsunk, karakternév, class, mit játszanál, pár mondat magadról).',
        '**2. Privát csatorna** – a jelentkezésedből egy saját csatorna lesz, amit csak te és a klántagjaink látnak. Itt tudtok beszélgetni, kérdezni.',
        '**3. Elbírálás** – az Officerek átnézik a jelentkezést, és a csatornában jelzik a döntést.',
        '**4. Lezárás** – ha felveszünk, megkapod a klánrangot, és a jelentkezés lezárul (a csatorna eltűnik). Utána a `/karakter` paranccsal add meg a karaktereidet.',
        '',
        '🎮 Játékban is kérhetsz invet bármelyik tagunktól, de érdemes itt jelentkezned: így előbb megismerünk, és hamarabb megtaláljuk, hova illesz a csapatban.',
      ].join('\n'),
    }],
    components: [{ type: 1, components: [{ type: 2, style: 3, custom_id: 'tgf:apply', label: 'Jelentkezem', emoji: { name: '📝' } }] }],
  };
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

// A setup hívja: kiteszi vagy frissíti a panelt. TGF_CHANNEL_ID nélkül a funkció ki van kapcsolva.
export async function publishTgfPanel() {
  const channelId = process.env.TGF_CHANNEL_ID;
  if (!channelId) return { enabled: false };
  const cfg = await getConfig();
  const same = cfg.tgfChannelId === channelId;
  const messageId = await upsertMessage(channelId, same ? cfg.tgfMessageId : null, panelPayload());
  if (!same || messageId !== cfg.tgfMessageId) await saveConfig({ ...cfg, tgfChannelId: channelId, tgfMessageId: messageId });
  const { missing } = await rolesByName([...new Set([...viewerRoleNames(), ...memberRoleNames(), pingRoleName()])].filter(Boolean));
  return { enabled: true, messageId, missingRoles: missing };
}

// --- Felugró ablak (a Discord legfeljebb 5 mezőt enged) ---
export const FIELDS = [
  { id: 'nick', label: 'Hogyan szólítsunk?', style: 1, required: true, max: 40 },
  { id: 'char', label: 'Karakterneved', style: 1, required: true, max: 32 },
  { id: 'cls', label: 'Class / spec, amit játszanál', style: 1, required: true, max: 60 },
  { id: 'play', label: 'Mit játszanál? (raid, PvP, társaság…)', style: 1, required: true, max: 100 },
  { id: 'intro', label: 'Magadról + honnan hallottál rólunk?', style: 2, required: true, max: 1000 },
];

export function applyModal() {
  return {
    custom_id: 'tgf:submit',
    title: 'Jelentkezés – Pändemonium',
    components: FIELDS.map((f) => ({
      type: 1,
      components: [{ type: 4, custom_id: f.id, label: f.label, style: f.style, required: f.required, max_length: f.max }],
    })),
  };
}

const answerFields = (a) => [
  { name: 'Szólítsuk', value: clip(a?.nick, 1000) || '–', inline: true },
  { name: 'Karakter', value: clip(a?.char, 1000) || '–', inline: true },
  { name: 'Class / spec', value: clip(a?.cls, 1000) || '–', inline: true },
  { name: 'Mit játszana', value: clip(a?.play, 1000) || '–', inline: false },
];

function applicationMessage(userId, name, answers, pingRoleId) {
  return {
    content: [`<@${userId}>`, pingRoleId ? `<@&${pingRoleId}>` : ''].filter(Boolean).join(' '),
    allowed_mentions: { users: [userId], roles: pingRoleId ? [pingRoleId] : [] },
    embeds: [{
      title: `Jelentkezés: ${clip(answers.nick || name, 200)}`,
      color: GOLD,
      description: clip(answers.intro, 4000) || '–',
      fields: answerFields(answers),
      footer: { text: `Discord: ${name} · ${userId}` },
      timestamp: new Date().toISOString(),
    }],
    components: [{ type: 1, components: [{ type: 2, style: 4, custom_id: `tgf:close:${userId}`, label: 'Lezárás (Officer)', emoji: { name: '🔒' } }] }],
  };
}

async function channelExists(channelId) {
  try {
    await dc('GET', `/channels/${channelId}`);
    return true;
  } catch (e) {
    if (e.status === 404) return false;
    throw e;
  }
}

// Kategória: TGF_CATEGORY_ID, különben a TGF csatorna kategóriája (ha van).
async function categoryId() {
  if (process.env.TGF_CATEGORY_ID) return process.env.TGF_CATEGORY_ID;
  if (!process.env.TGF_CHANNEL_ID) return null;
  const ch = await dc('GET', `/channels/${process.env.TGF_CHANNEL_ID}`);
  return ch.parent_id ?? null;
}

// Beküldött jelentkezés → privát csatorna (vagy a meglévő frissítése). Visszaadja az ephemeral választ.
export async function submitApplication(member, answers) {
  const userId = member.user.id;
  const name = displayName(member);
  const [{ found: viewers }, { found: [pingRole] }] = await Promise.all([
    rolesByName(viewerRoleNames()),
    rolesByName(pingRoleName() ? [pingRoleName()] : []),
  ]);
  const msg = applicationMessage(userId, name, answers, pingRole?.id);

  const existing = await getApplication(userId);
  if (existing?.channelId && await channelExists(existing.channelId)) {
    await dc('POST', `/channels/${existing.channelId}/messages`, { ...msg, embeds: [{ ...msg.embeds[0], title: `Frissített jelentkezés: ${clip(answers.nick || name, 200)}` }] });
    await saveApplication({ ...existing, answers, updatedAt: new Date().toISOString() });
    return { content: `Már van nyitott jelentkezésed: <#${existing.channelId}>. A most beküldött adatokat oda is betettem.` };
  }

  const parent = await categoryId();
  const channel = await dc('POST', `/guilds/${GUILD_ID()}/channels`, {
    name: channelName(answers.char || name, userId),
    type: 0,
    ...(parent ? { parent_id: parent } : {}),
    topic: `Jelentkező: ${answers.nick || name} (<@${userId}>) · karakter: ${answers.char || '–'}`,
    permission_overwrites: [
      { id: GUILD_ID(), type: 0, allow: '0', deny: perms(P.VIEW) },
      { id: userId, type: 1, allow: perms(P.VIEW, P.SEND, P.HISTORY, P.EMBED), deny: '0' },
      { id: APP_ID(), type: 1, allow: perms(P.VIEW, P.SEND, P.HISTORY, P.EMBED), deny: '0' },
      ...viewers.map((r) => ({ id: r.id, type: 0, allow: perms(P.VIEW, P.SEND, P.HISTORY, P.EMBED), deny: '0' })),
    ],
  }, { reason: `TGF jelentkezés: ${name}` });
  await dc('POST', `/channels/${channel.id}/messages`, msg);
  await saveApplication({ userId, channelId: channel.id, name, answers, createdAt: new Date().toISOString() });
  return { content: `✅ Megkaptuk a jelentkezésed! A privát csatornád: <#${channel.id}> – itt tudtok beszélgetni a klántagokkal, itt kapod meg a döntést is.` };
}

// --- Lezárás ---
export function closeConfirm(userId, note = '') {
  return {
    flags: 64,
    content: [
      note,
      'Mi a döntés? **A csatorna lezáráskor törlődik**, a jelentkezés összefoglalója a naplóba kerül.',
      '• **Felvettük:** előbb add meg a tagnak a klánrangot (Panda / Friends / OldPanda) – a bot ellenőrzi.',
      '• **Nem vettük fel:** előtte írd meg a döntést a csatornában, hogy a jelentkező lássa.',
    ].filter(Boolean).join('\n'),
    components: [{
      type: 1,
      components: [
        { type: 2, style: 3, custom_id: `tgf:close2:${userId}:ok`, label: 'Felvettük', emoji: { name: '✅' } },
        { type: 2, style: 4, custom_id: `tgf:close2:${userId}:no`, label: 'Nem vettük fel', emoji: { name: '❌' } },
      ],
    }],
  };
}

// Felvételnél: megvan-e már a klánrang? Visszaadja a tag klánrangjainak nevét (üres tömb = még nincs), vagy null-t, ha a tag már nincs a szerveren.
export async function memberClanRanks(userId) {
  let member;
  try {
    member = await dc('GET', `/guilds/${GUILD_ID()}/members/${userId}`);
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
  const { found } = await rolesByName(memberRoleNames());
  return found.filter((r) => member.roles?.includes(r.id)).map((r) => r.name);
}

// Lezárás: napló (ha TGF_LOG_CHANNEL_ID be van állítva), rekord törlése, csatorna törlése.
export async function closeApplication(userId, channelId, closer, { outcome = 'no', ranks = [] } = {}) {
  const rec = await getApplication(userId);
  const target = rec?.channelId ?? channelId;
  if (process.env.TGF_LOG_CHANNEL_ID && rec) {
    const accepted = outcome === 'ok';
    await dc('POST', `/channels/${process.env.TGF_LOG_CHANNEL_ID}/messages`, {
      allowed_mentions: { parse: [] },
      embeds: [{
        title: `${accepted ? '✅ Felvéve' : '❌ Nem vettük fel'}: ${clip(rec.answers?.nick || rec.name, 200)}`,
        color: accepted ? 0x57f287 : 0x99aab5,
        description: clip(rec.answers?.intro, 4000) || '–',
        fields: [
          ...answerFields(rec.answers),
          ...(accepted ? [{ name: 'Klánrang', value: ranks.join(', ') || '–', inline: true }] : []),
          { name: 'Lezárta', value: `${closer} · <@${userId}>`, inline: false },
        ],
        timestamp: new Date().toISOString(),
      }],
    }).catch((e) => console.error('tgf log', e));
  }
  await deleteApplication(userId).catch(() => {});
  if (target) await dc('DELETE', `/channels/${target}`, null, { reason: `TGF lezárva (${outcome === 'ok' ? 'felvéve' : 'nem vettük fel'}): ${closer}` });
}
