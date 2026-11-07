# Pandemonium Roster bot

Discord-bot Vercelen (HTTP interactions, nincs állandóan futó folyamat). Élő cím: https://pandemonium-roster.vercel.app

- `/karakter` parancs vagy a #roster **✏️ gombja** → lépésenként: szerep → class (csak a szerephez illők) → main spec → offspec (opcionális) → karakternév (opcionális). Ugyanígy **legfeljebb 4 alt** (➕ gomb; meglévő alt módosítása/törlése a lenyíló listából).
- Mentéskor a bot **beállítja a rangokat**: szerep-rang a main és az offspec alapján (🛡️ Tank / 💚 Healer / 🗡️ DPS), class-rang a main és az összes alt alapján. A klánrangokhoz (Panda, Friends…) nem nyúl.
- A **#roster** két üzenete minden mentéskor frissül: (1) Panda roster a mainekkel (és akik még nem töltötték ki) + **class-eloszlás** (mind a 9 class: darab, arány, sáv, Panda altok száma, hiányzó classok) + a többi rang statisztikája, (2) **Panda alt roster** szerepek szerint. A gombok (✏️, 🔄) az alt roster alatt vannak.
- **Armory-link:** ha a karakternév teljes (Forever: „Név Vezetéknév”, legfeljebb 32 karakter), a rosterben a név a **hivatalos Blizzard Forever armoryra** mutat (`https://worldofwarcraft.blizzard.com/en-gb/forever/eu/armory/character/nev-vezeteknev`). A Foreverben nincsenek realmok, a karaktert a teljes név azonosítja; csak keresztnévhez nincs link. A #roster gombjai között **🏰 Guild armory** gomb is van (Pändemonium guild oldal). Mindkettő cserélhető: `ARMORY_URL` (`{slug}` helyőrzővel), `GUILD_ARMORY_URL`.
- Ami tárolt adatot olvas (parancs, Vissza, összegzés, alt kiválasztása), az halasztott válasszal megy, így hidegindításnál sem lépi túl a Discord 3 mp-es határát. A futásidők a Vercel naplóban `[timing]` sorként látszanak.
- **Napi karbantartás** (03:00 UTC): a szerverről kilépett tagok adatai törlődnek, a roster újraépül.

## Fájlok
| Fájl | Szerep |
|---|---|
| `api/interactions.js` | Discord interakciók (parancs, gombok, menük, modal) |
| `api/setup.js` | `/karakter` regisztrálása + roster üzenet kitétele (`/api/setup?secret=…`) |
| `api/cron.js` | Napi karbantartás |
| `lib/data.js` | Classok, specek, szerepek |
| `lib/roster.js` | A #roster üzenet felépítése |
| `lib/roles.js` | Rangkiosztás |
| `lib/store.js` | Adattárolás (Vercel Blob, privát) |

## Környezeti változók
| Név | Honnan |
|---|---|
| `DISCORD_APP_ID` | Developer Portal → General Information → Application ID |
| `DISCORD_PUBLIC_KEY` | Developer Portal → General Information → Public Key |
| `DISCORD_TOKEN` | Developer Portal → Bot → Reset Token (**titkos**, „Sensitive” típusként add meg) |
| `GUILD_ID` | `374715859727548417` |
| `ROSTER_CHANNEL_ID` | a #roster csatorna azonosítója |
| `SETUP_SECRET`, `CRON_SECRET` | opcionális; ha be vannak állítva, a setup és a cron csak ezzel indítható |
| `BLOB_READ_WRITE_TOKEN` | automatikusan, amikor a Blob tárat a projekthez kötöd |
| `ARMORY_URL`, `GUILD_ARMORY_URL` | opcionális; karakter-armory minta `{slug}` helyőrzővel, illetve a guild armory címe (alapértelmezés: hivatalos Blizzard Forever armory, Pändemonium) |

## Telepítés (egyszer)
1. **Discord Developer Portal** → New Application („Pandemonium Roster”). Bot fülön: **Server Members Intent** bekapcsolása.
2. **Vercel**: a mappából `npx vercel@latest deploy --prod` (projektnév: `pandemonium-roster`).
3. Vercel → Storage → **Blob** tár létrehozása **Private** hozzáféréssel, összekötés a projekttel.
4. Környezeti változók beállítása, majd újratelepítés.
5. Bot meghívása a szerverre (*Manage Roles*, *View Channels*, *Send Messages*, *Embed Links* jog); a bot rangja kerüljön a szerep- és class-rangok **fölé**.
6. Developer Portal → General Information → **Interactions Endpoint URL**: `https://<projekt>.vercel.app/api/interactions`
7. Böngészőben: `https://<projekt>.vercel.app/api/setup` (ha van SETUP_SECRET: `?secret=…`) → regisztrálja a parancsot és kiteszi a rostert.

## Teszt
`npm install && npm test`
