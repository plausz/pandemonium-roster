import crypto from 'node:crypto';

const API = 'https://discord.com/api/v10';
const env = (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`Hiányzó környezeti változó: ${k}`);
  return v;
};

export const GUILD_ID = () => env('GUILD_ID');
export const APP_ID = () => env('DISCORD_APP_ID');

// Ed25519 aláírás-ellenőrzés a Discord interakciókhoz (külső csomag nélkül).
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
let pubKey;
export function verifySignature(rawBody, signature, timestamp) {
  if (!signature || !timestamp) return false;
  try {
    pubKey ??= crypto.createPublicKey({
      key: Buffer.concat([SPKI_PREFIX, Buffer.from(env('DISCORD_PUBLIC_KEY'), 'hex')]),
      format: 'der',
      type: 'spki',
    });
    return crypto.verify(null, Buffer.from(timestamp + rawBody), pubKey, Buffer.from(signature, 'hex'));
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function dc(method, path, body, { reason, auth = true } = {}) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const headers = { 'Content-Type': 'application/json' };
    if (auth) headers.Authorization = `Bot ${env('DISCORD_TOKEN')}`;
    if (reason) headers['X-Audit-Log-Reason'] = encodeURIComponent(reason);
    const res = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    if (res.status === 429) {
      const j = await res.json().catch(() => ({}));
      await sleep(Math.ceil((j.retry_after ?? 1) * 1000) + 50);
      continue;
    }
    if (!res.ok) {
      const text = await res.text();
      const err = new Error(`${method} ${path} → ${res.status} ${text}`);
      err.status = res.status;
      throw err;
    }
    return res.status === 204 ? null : res.json();
  }
  throw new Error(`${method} ${path} → túl sok 429`);
}

// Az interakció eredeti (ephemeral) üzenetének utólagos szerkesztése.
export function editOriginal(token, { flags, ...payload }) {
  return dc('PATCH', `/webhooks/${APP_ID()}/${token}/messages/@original`, payload, { auth: false });
}

export function displayName(member) {
  return member?.nick || member?.user?.global_name || member?.user?.username || 'ismeretlen';
}

let rolesCache;
export async function guildRoles() {
  rolesCache ??= await dc('GET', `/guilds/${GUILD_ID()}/roles`);
  return rolesCache;
}

export async function listMembers() {
  const out = [];
  let after = '0';
  for (;;) {
    const page = await dc('GET', `/guilds/${GUILD_ID()}/members?limit=1000&after=${after}`);
    out.push(...page);
    if (page.length < 1000) break;
    after = page[page.length - 1].user.id;
  }
  return out;
}
