// Robot des rappels : lancé toutes les 15 minutes par GitHub Actions.
// Il lit les événements dans Firebase et envoie les notifications au bon moment (heure de Paris) :
//   - la veille, à partir de 19 h : « Demain : … »
//   - le jour J, à partir de 8 h : « C'est aujourd'hui : … »
//   - une heure avant, si l'événement a une heure : « Dans 1 h : … »
// Chaque rappel n'est envoyé qu'une fois (noté dans couples/{code}/sent).
import admin from 'firebase-admin';

const SITE = 'https://rahmani78190.github.io/notre-calendrier/';
const TZ = 'Europe/Paris';

const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!raw) {
  console.log('Clé FIREBASE_SERVICE_ACCOUNT absente : aucun rappel envoyé.');
  process.exit(0);
}
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
const db = admin.firestore();
const fcm = admin.messaging();

function parisNow(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, min: Number(p.hour) * 60 + Number(p.minute) };
}
function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}
function toMin(hhmm) {
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm || '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}
function placeTxt(e) {
  const age = e.age > 0 ? ` · ${e.age} an${e.age > 1 ? 's' : ''}` : '';
  return age + (e.place && e.place.name ? ` · ${e.place.name}` : '');
}
function isLeap(y) { return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; }
// Date d'un événement annuel pour une année donnée (29 février → 28 février hors années bissextiles)
export function occIn(e, y) {
  let md = e.start.slice(5);
  if (md === '02-29' && !isLeap(y)) md = '02-28';
  return `${y}-${md}`;
}

// Quel rappel envoyer pour cet événement, maintenant ?
export function dueReminder(e, now) {
  const tomorrow = addDays(now.date, 1);
  const t = toMin(e.time);
  if (e.start === tomorrow && now.min >= 19 * 60) {
    return { kind: 'veille', title: `Demain : ${e.title}`, body: (e.time ? `À ${e.time}` : 'Toute la journée') + placeTxt(e) };
  }
  if (e.start === now.date) {
    if (t !== null && now.min >= t - 60 && now.min < t) {
      return { kind: 'heure', title: `Dans ${t - now.min <= 45 ? Math.max(5, Math.round((t - now.min) / 5) * 5) + ' min' : '1 h'} : ${e.title}`, body: `À ${e.time}` + placeTxt(e) };
    }
    if (now.min >= 8 * 60 && (t === null || now.min < t - 60)) {
      return { kind: 'jour', title: `C’est aujourd’hui : ${e.title}`, body: (e.time ? `À ${e.time}` : 'Toute la journée') + placeTxt(e) };
    }
  }
  return null;
}

async function run() {
  const now = parisNow();
  const days = [now.date, addDays(now.date, 1)];
  const couples = await db.collection('couples').listDocuments();
  let sent = 0;
  for (const c of couples) {
    const tokSnap = await c.collection('tokens').get();
    if (tokSnap.empty) continue;
    const tokens = tokSnap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((t) => t.token);
    const evSnap = await c.collection('events').where('start', 'in', days).get();
    const yearlySnap = await c.collection('events').where('yearly', '==', true).get();
    const items = [];
    for (const doc of evSnap.docs) if (!doc.data().yearly) items.push({ doc, e: doc.data() });
    for (const doc of yearlySnap.docs) {
      const e = doc.data();
      if (!e.start) continue;
      for (const d of days) {
        if (d >= e.start && occIn(e, Number(d.slice(0, 4))) === d) {
          items.push({ doc, e: { ...e, start: d, end: '', age: Number(d.slice(0, 4)) - Number(e.start.slice(0, 4)) } });
        }
      }
    }
    for (const { doc, e } of items) {
      if (!e.title || !e.start) continue;
      const r = dueReminder(e, now);
      if (!r) continue;
      const sentRef = c.collection('sent').doc(`${doc.id}_${r.kind}_${e.start}`);
      if ((await sentRef.get()).exists) continue;
      const targets = tokens.filter((t) => e.who === 'ab' || !e.who || !t.who || t.who === e.who);
      if (!targets.length) continue;
      const res = await fcm.sendEachForMulticast({
        tokens: targets.map((t) => t.token),
        webpush: {
          notification: { title: r.title, body: r.body, icon: SITE + 'icons/icon-192.png', badge: SITE + 'icons/icon-192.png', tag: `${doc.id}_${r.kind}` },
          fcmOptions: { link: SITE }
        }
      });
      // Les téléphones qui ne sont plus inscrits sont retirés.
      await Promise.all(res.responses.map(async (x, i) => {
        const code = x.error && x.error.code;
        if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token' || code === 'messaging/invalid-argument') {
          await c.collection('tokens').doc(targets[i].id).delete().catch(() => {});
        }
      }));
      await sentRef.set({ at: Date.now(), ok: res.successCount, ko: res.failureCount });
      sent += res.successCount;
      console.log(`${r.kind} « ${e.title} » : ${res.successCount} envoyé(s), ${res.failureCount} échec(s)`);
    }
  }
  console.log(`Terminé (${now.date} ${String(Math.floor(now.min / 60)).padStart(2, '0')}:${String(now.min % 60).padStart(2, '0')} à Paris) : ${sent} rappel(s).`);
}

if (process.argv[2] !== '--test') {
  run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}
