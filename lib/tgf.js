import { dc, GUILD_ID, APP_ID, displayName, guildRoles } from './discord.js';
import { getConfig, saveConfig, getApplication, saveApplication, deleteApplication } from './store.js';

// --- Tagfelvétel (TGF) ---
// A TGF csatornában a bot egy panelt tart „Jelentkezem” gombbal. A gomb felugró ablakot nyit; beküldéskor a bot
// a jelentkezőnek saját privát csatornát nyit, amit csak ő, a TGF_VIEWER_ROLES rangok és a bot lát.
// Az Officerek a csatornában lévő „Lezárás” gombbal zárják le (a csatorna törlődik, opcionálisan naplóba kerül).
// A bot itt sem oszt klánrangot: felvételkor a rangot továbbra is kézzel adja az Officer.

const P = {
  VIEW: 1n << 10n,
  SEND: 1n << 11n,
  EMBED: 1n << 14n,
  HISTORY: 1n << 16n,
};
const perms = (...bits) => String(bits.reduce((a, b) => a | b, 0n));
const GOLD = 0xedb443;

export const DEFAULT_VIEWER_ROLES = ['Panda', 'Officer', 'Klánvezető'];
const viewerRoleNames = () => (process.env.TGF_VIEWER_ROLES ? process.env.TGF_VIEWER_ROLES.split(',') : DEFAULT_VIEWER_ROLES)
  .map((s) => s.trim()).filter(Boolean);
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
        'Szia, örülünk, hogy benéztél! 🐼',
        '',
        'Kattints a **Jelentkezem** gombra, és írj pár sort magadról. A jelentkezésedből egy **privát csatorna** lesz, amit csak te és a klántagjaink látnak – ott tudtok beszélgetni.',
        '',
        'Játékban egyelőre bármelyik tagunk tud invitálni, de bemutatkozással gyorsabban megtaláljuk a helyed.',
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
  const { missing } = await rolesByName([...viewerRoleNames(), pingRoleName()].filter(Boolean));
  return { enabled: true, messageId, missingRoles: missing };
}

// --- Felugró ablak (legfeljebb 5 mező) ---
export const FIELDS = [
  { id: 'char', label: 'Karakterneved (ha már van)', style: 1, required: false, max: 32 },
  { id: 'cls', label: 'Class / spec, amit játszanál', style: 1, required: true, max: 60 },
  { id: 'play', label: 'Mit játszanál? (raid, PvP, társaság…)', style: 1, required: true, max: 100 },
  { id: 'from', label: 'Honnan hallottál rólunk? Ki ajánlott?', style: 1, required: false, max: 100 },
  { id: 'intro', label: 'Pár mondat magadról', style: 2, required: true, max: 1000 },
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

function applicationMessage(userId, name, answers, pingRoleId) {
  const field = (n, v) => ({ name: n, value: clip(v, 1000) || '–', inline: false });
  return {
    content: [`<@${userId}>`, pingRoleId ? `<@&${pingRoleId}>` : ''].filter(Boolean).join(' '),
    allowed_mentions: { users: [userId], roles: pingRoleId ? [pingRoleId] : [] },
    embeds: [{
      title: `Jelentkezés: ${clip(name, 200)}`,
      color: GOLD,
      description: clip(answers.intro, 4000) || '–',
      fields: [
        field('Karakter', answers.char),
        field('Class / spec', answers.cls),
        field('Mit játszana', answers.play),
        field('Honnan hallott rólunk', answers.from),
      ],
      footer: { text: `Discord-azonosító: ${userId}` },
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
    await dc('POST', `/channels/${existing.channelId}/messages`, { ...msg, embeds: [{ ...msg.embeds[0], title: `Frissített jelentkezés: ${clip(name, 200)}` }] });
    await saveApplication({ ...existing, answers, updatedAt: new Date().toISOString() });
    return { content: `Már van nyitott jelentkezésed: <#${existing.channelId}>. A most beküldött adatokat oda is betettem.` };
  }

  const parent = await categoryId();
  const everyone = GUILD_ID();
  const channel = await dc('POST', `/guilds/${GUILD_ID()}/channels`, {
    name: channelName(name, userId),
    type: 0,
    ...(parent ? { parent_id: parent } : {}),
    topic: `Jelentkező: ${name} (<@${userId}>)`,
    permission_overwrites: [
      { id: everyone, type: 0, allow: '0', deny: perms(P.VIEW) },
      { id: userId, type: 1, allow: perms(P.VIEW, P.SEND, P.HISTORY, P.EMBED), deny: '0' },
      { id: APP_ID(), type: 1, allow: perms(P.VIEW, P.SEND, P.HISTORY, P.EMBED), deny: '0' },
      ...viewers.map((r) => ({ id: r.id, type: 0, allow: perms(P.VIEW, P.SEND, P.HISTORY, P.EMBED), deny: '0' })),
    ],
  }, { reason: `TGF jelentkezés: ${name}` });
  await dc('POST', `/channels/${channel.id}/messages`, msg);
  await saveApplication({ userId, channelId: channel.id, name, answers, createdAt: new Date().toISOString() });
  return { content: `✅ Megkaptuk a jelentkezésed! A privát csatornád: <#${channel.id}> – itt tudtok beszélgetni a klántagokkal.` };
}

export function closeConfirm(userId) {
  return {
    flags: 64,
    content: 'Biztosan lezárod a jelentkezést? **A csatorna törlődik.** Ha felvettétek, a klánrangot előtte add meg kézzel.',
    components: [{ type: 1, components: [{ type: 2, style: 4, custom_id: `tgf:close2:${userId}`, label: 'Igen, lezárom', emoji: { name: '🔒' } }] }],
  };
}

// Lezárás: napló (ha TGF_LOG_CHANNEL_ID be van állítva), rekord törlése, csatorna törlése.
export async function closeApplication(userId, channelId, closer) {
  const rec = await getApplication(userId);
  const target = rec?.channelId ?? channelId;
  if (process.env.TGF_LOG_CHANNEL_ID && rec) {
    await dc('POST', `/channels/${process.env.TGF_LOG_CHANNEL_ID}/messages`, {
      allowed_mentions: { parse: [] },
      embeds: [{
        title: `Lezárt jelentkezés: ${clip(rec.name, 200)}`,
        color: 0x99aab5,
        description: clip(rec.answers?.intro, 4000) || '–',
        fields: [
          { name: 'Karakter', value: clip(rec.answers?.char, 1000) || '–' },
          { name: 'Class / spec', value: clip(rec.answers?.cls, 1000) || '–' },
          { name: 'Mit játszana', value: clip(rec.answers?.play, 1000) || '–' },
          { name: 'Honnan hallott rólunk', value: clip(rec.answers?.from, 1000) || '–' },
          { name: 'Lezárta', value: `${closer} · <@${userId}>` },
        ],
        timestamp: new Date().toISOString(),
      }],
    }).catch((e) => console.error('tgf log', e));
  }
  await deleteApplication(userId).catch(() => {});
  if (target) await dc('DELETE', `/channels/${target}`, null, { reason: `TGF lezárva: ${closer}` });
}
