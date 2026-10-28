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

// Egy karakter rekordja: { role, cls, spec, off|null, name|null } – indexekkel tárolva, olvasható mezőkkel kiegészítve.
export function describeChar(ch, { withRole = true } = {}) {
  if (!ch) return '—';
  const cls = CLASSES[ch.cls];
  const main = `${cls.specs[ch.spec][0]} ${cls.name}`;
  const role = withRole ? `${ROLES[ch.role].emoji} ` : '';
  const off = ch.off != null ? ` · off: ${specLabel(ch.cls, ch.off)} ${ROLES[cls.specs[ch.off][1]].emoji}` : '';
  const name = ch.name ? ` – **${ch.name}**` : '';
  return `${role}${main}${off}${name}`;
}
