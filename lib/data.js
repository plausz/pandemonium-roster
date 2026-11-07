// Classok és specek (classonként a klasszikus 3 spec; a Feral tankként és DPS-ként is választható).
// Szerepkódok: T = Tank, H = Healer, D = DPS

export const ROLES = {
  T: { label: 'Tank', emoji: '🛡️', match: 'Tank' },
  H: { label: 'Healer', emoji: '💚', match: 'Healer' },
  D: { label: 'DPS', emoji: '🗡️', match: 'DPS' },
};

export const ROLE_ORDER = ['T', 'H', 'D'];

export const CLASSES = [
  { name: 'Warrior', specs: [['Arms', 'D'], ['Fury', 'D'], ['Protection', 'T']] },
  { name: 'Paladin', specs: [['Holy', 'H'], ['Protection', 'T'], ['Retribution', 'D']] },
  { name: 'Hunter', specs: [['Beast Mastery', 'D'], ['Marksmanship', 'D'], ['Survival', 'D']] },
  { name: 'Rogue', specs: [['Assassination', 'D'], ['Combat', 'D'], ['Subtlety', 'D']] },
  { name: 'Priest', specs: [['Discipline', 'H'], ['Holy', 'H'], ['Shadow', 'D']] },
  { name: 'Shaman', specs: [['Elemental', 'D'], ['Enhancement', 'D'], ['Restoration', 'H']] },
  { name: 'Mage', specs: [['Arcane', 'D'], ['Fire', 'D'], ['Frost', 'D']] },
  { name: 'Warlock', specs: [['Affliction', 'D'], ['Demonology', 'D'], ['Destruction', 'D']] },
  { name: 'Druid', specs: [['Balance', 'D'], ['Feral', 'T'], ['Feral', 'D'], ['Restoration', 'H']] },
];

// Hivatalos Blizzard class-színek, a hozzájuk tartozó Blizzard API class-azonosító, és tartalék unicode jel arra
// az esetre, ha a bot saját (színes kör) emojijai még nincsenek feltöltve.
export const CLASS_META = {
  Warrior: { color: 'C69B6D', blizzardId: 1, fallback: '🟫' },
  Paladin: { color: 'F48CBA', blizzardId: 2, fallback: '🩷' },
  Hunter: { color: 'AAD372', blizzardId: 3, fallback: '🟩' },
  Rogue: { color: 'FFF468', blizzardId: 4, fallback: '🟨' },
  Priest: { color: 'FFFFFF', blizzardId: 5, fallback: '⬜' },
  Shaman: { color: '0070DD', blizzardId: 7, fallback: '🟦' },
  Mage: { color: '3FC7EB', blizzardId: 8, fallback: '🩵' },
  Warlock: { color: '8788EE', blizzardId: 9, fallback: '🟪' },
  Druid: { color: 'FF7C0A', blizzardId: 11, fallback: '🟧' },
};
export const emojiName = (className) => `pd_${className.toLowerCase()}`;
export const classByBlizzardId = (id) => CLASSES.findIndex((c) => CLASS_META[c.name].blizzardId === id);

// A bot class-emojijai ({ Warrior: '<:pd_warrior:123>', … }); a roster felépítése előtt állítjuk be a tárolt adatból.
let classIcons = {};
export const setClassIcons = (map) => { classIcons = map ?? {}; };
export const classIcon = (cls) => classIcons[CLASSES[cls].name] ?? CLASS_META[CLASSES[cls].name].fallback;

// A szerverről olvasott klánrangok, prioritási sorrendben (az első egyezés számít).
export const PANDA_RANKS = ['Panda'];
export const OTHER_RANKS = ['OldPanda', 'Friends', 'Vendég'];

export function classesForRole(role) {
  return CLASSES.map((c, i) => ({ ...c, index: i })).filter((c) => c.specs.some(([, r]) => r === role));
}

export function specsFor(classIndex, role) {
  return CLASSES[classIndex].specs
    .map(([name, r], i) => ({ name, role: r, index: i }))
    .filter((s) => !role || s.role === role);
}

export function specLabel(classIndex, specIndex) {
  const [name, role] = CLASSES[classIndex].specs[specIndex];
  const dup = CLASSES[classIndex].specs.filter(([n]) => n === name).length > 1;
  return dup ? `${name} (${ROLES[role].label})` : name;
}

// A karakternév maximális hossza (WoW Forever: keresztnév + vezetéknév, szóközzel).
export const NAME_MAX = 32;

// Armory-link a karakterhez (hivatalos Blizzard Forever armory). A Foreverben nincsenek realmok: a karaktert a
// „Név Vezetéknév” azonosítja (slug: nev-vezeteknev, kisbetűvel, ékezet URL-kódolva), ezért csak kétrészes névhez
// adunk linket. Az ARMORY_URL változóval cserélhető, {slug} helyőrzővel.
export const DEFAULT_ARMORY_URL = 'https://worldofwarcraft.blizzard.com/en-gb/forever/eu/armory/character/{slug}';
export const DEFAULT_GUILD_ARMORY_URL = 'https://worldofwarcraft.blizzard.com/en-gb/forever/eu/armory/guild/p%C3%A4ndemonium';
export const guildArmoryUrl = () => process.env.GUILD_ARMORY_URL || DEFAULT_GUILD_ARMORY_URL;
// „Név Vezetéknév” → „nev-vezeteknev” (kisbetű, ékezet marad); csak kétrészes névre, különben null.
export function nameSlug(name) {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  return parts.length === 2 ? parts.map((p) => p.toLocaleLowerCase('hu')).join('-') : null;
}
export const armoryUrlForSlug = (slug) => (process.env.ARMORY_URL || DEFAULT_ARMORY_URL).replace('{slug}', slug.split('-').map(encodeURIComponent).join('-'));
export function armoryUrl(name) {
  const slug = nameSlug(name);
  return slug ? armoryUrlForSlug(slug) : null;
}

// Egy karakter rekordja: { role, cls, spec, off|null, name|null } – indexekkel tárolva, olvasható mezőkkel kiegészítve.
export function describeChar(ch, { withRole = true, link = false, icon = false, extra = '', url: urlOverride, italicName = false } = {}) {
  if (!ch) return '—';
  const cls = CLASSES[ch.cls];
  const main = `${icon ? `${classIcon(ch.cls)} ` : ''}${cls.specs[ch.spec][0]} ${cls.name}`;
  const role = withRole ? `${ROLES[ch.role].emoji} ` : '';
  const off = ch.off != null ? ` · off: ${specLabel(ch.cls, ch.off)} ${ROLES[cls.specs[ch.off][1]].emoji}` : '';
  const url = link && (urlOverride ?? armoryUrl(ch.name));
  const styled = italicName ? `*${ch.name}*` : `**${ch.name}**`;
  const name = ch.name ? (url ? ` – [${styled}](${url})` : ` – ${styled}`) : '';
  return `${role}${main}${off}${name}${extra}`;
}
