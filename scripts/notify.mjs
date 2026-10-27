// Robot des rappels : lancé toutes les 15 minutes par GitHub Actions.
// - Rappels choisis dans chaque événement (heure de Paris) :
//     veille : la veille à 19 h · jour : le matin à 8 h · 1s : une semaine avant
//     1j : un jour avant · 1h : une heure avant · 10m : dix minutes avant
//   (sans choix enregistré : veille, jour et 1h)
// - Événements répétés : chaque semaine, toutes les 2 semaines, chaque mois, chaque année.
// - Quand l'un ajoute un événement, l'autre reçoit « Gaby a ajouté : … ».
// Chaque rappel n'est envoyé qu'une fois (noté dans couples/{code}/sent).
import admin from 'firebase-admin';

const SITE = 'https://rahmani78190.github.io/notre-calendrier/';
const TZ = 'Europe/Paris';
const DEFAULT_REM = ['veille', 'jour', '1h'];
const REPEATS = ['weekly', 'biweekly', 'monthly', 'yearly'];
const GRACE = 180; // minutes de retard tolérées (GitHub lance parfois le robot en retard)

/* ---------- Dates ---------- */
export function parisNow(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, min: Number(p.hour) * 60 + Number(p.minute) };
}
const dayIdx = (s) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d) / 86400000; };
const fromIdx = (i) => new Date(i * 86400000).toISOString().slice(0, 10);
export const addDays = (s, n) => fromIdx(dayIdx(s) + n);
const abs = (day, min) => dayIdx(day) * 1440 + min;
function toMin(hhmm) { const m = /^(\d{1,2}):(\d{2})/.exec(hhmm || ''); return m ? Number(m[1]) * 60 + Number(m[2]) : null; }
const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const pad = (n) => String(n).padStart(2, '0');
const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const fmtDay = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
const dayTxt = (s) => fmtDay.format(new Date(dayIdx(s) * 86400000));

export function repeatOf(e) { return REPEATS.includes(e.repeat) ? e.repeat : (e.yearly ? 'yearly' : ''); }
export function occursOn(e, day) {
  const r = repeatOf(e);
  if (!r) return e.start === day;
  if (day < e.start || (e.until && day > e.until)) return false;
  const diff = dayIdx(day) - dayIdx(e.start);
  const y = Number(day.slice(0, 4)), m = Number(day.slice(5, 7));
  if (r === 'weekly') return diff % 7 === 0;
  if (r === 'biweekly') return diff % 14 === 0;
  if (r === 'monthly') return `${y}-${pad(m)}-${pad(Math.min(Number(e.start.slice(8)), daysIn(y, m)))}` === day;
  let md = e.start.slice(5);
  if (md === '02-29' && !isLeap(y)) md = '02-28';
  return `${y}-${md}` === day;
}

/* ---------- Rappels ---------- */
function details(e, day, withDate) {
  const age = repeatOf(e) === 'yearly' ? Number(day.slice(0, 4)) - Number(e.start.slice(0, 4)) : 0;
  return (withDate ? `${dayTxt(day).replace(/^./, (c) => c.toUpperCase())}${e.time ? ` à ${e.time}` : ''}` : (e.time ? `À ${e.time}` : 'Toute la journée')) +
    (age > 0 ? ` · ${age} an${age > 1 ? 's' : ''}` : '') +
    (e.place && e.place.name ? ` · ${e.place.name}` : '');
}
// Rappel dû maintenant pour l'événement e qui a lieu le jour « day » ?
export function dueReminders(e, day, nowAbs) {
  const t = toMin(e.time);
  const startAbs = t === null ? abs(day, 24 * 60) : abs(day, t);
  const kinds = Array.isArray(e.reminders) ? e.reminders : DEFAULT_REM;
  const out = [];
  for (const k of kinds) {
    let trig = null;
    if (k === 'veille') trig = abs(addDays(day, -1), 19 * 60);
    else if (k === 'jour') trig = t !== null && t < 8 * 60 + 30 ? null : abs(day, 8 * 60);
    else if (k === '1s') trig = abs(addDays(day, -7), t ?? 9 * 60);
    else if (k === '1j') trig = abs(addDays(day, -1), t ?? 9 * 60);
    else if (k === '1h') trig = t === null ? null : startAbs - 60;
    else if (k === '10m') trig = t === null ? null : startAbs - 10;
    if (trig === null || nowAbs < trig || nowAbs >= trig + GRACE || nowAbs >= startAbs) continue;
    let title;
    if (k === 'veille' || k === '1j') title = `Demain : ${e.title}`;
    else if (k === 'jour') title = `C’est aujourd’hui : ${e.title}`;
    else if (k === '1s') title = `Dans une semaine : ${e.title}`;
    else {
      const left = startAbs - nowAbs;
      title = `Dans ${left >= 50 ? '1 h' : `${Math.max(1, Math.round(left / 5) * 5)} min`} : ${e.title}`;
    }
    out.push({ kind: k, trig, title, body: details(e, day, k === '1s') });
  }
  return out.sort((x, y) => x.trig - y.trig);
}

/* ---------- Envoi ---------- */
async function send(c, targets, title, body, tag) {
  if (!targets.length) return 0;
  const res = await admin.messaging().sendEachForMulticast({
    tokens: targets.map((t) => t.token),
    webpush: {
      notification: { title, body, icon: SITE + 'icons/icon-192.png', badge: SITE + 'icons/icon-192.png', tag },
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
  console.log(`« ${title} » : ${res.successCount} envoyé(s), ${res.failureCount} échec(s)`);
  return res.successCount;
}

async function run() {
  const db = admin.firestore();
  const now = parisNow();
  const nowAbs = abs(now.date, now.min);
  const days = Array.from({ length: 9 }, (_, i) => addDays(now.date, i));
  const couples = await db.collection('couples').listDocuments();
  let sent = 0;
  for (const c of couples) {
    const tokSnap = await c.collection('tokens').get();
    if (tokSnap.empty) continue;
    const tokens = tokSnap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((t) => t.token);
    const cfg = (await c.collection('meta').doc('config').get()).data() || {};
    const names = { a: cfg.a || 'L’un', b: cfg.b || 'L’autre' };
    const evSnap = await c.collection('events').get();

    for (const doc of evSnap.docs) {
      const e = doc.data();
      if (!e.title || !e.start) continue;
      const forWho = (t) => e.who === 'ab' || !e.who || !t.who || t.who === e.who;

      // 1. Nouvel événement ajouté par l'autre
      if (e.notifyNew) {
        if (e.createdBy && Date.now() - (e.createdAt || 0) < 2 * 86400000) {
          const targets = tokens.filter((t) => t.who && t.who !== e.createdBy);
          sent += await send(c, targets, `${names[e.createdBy] || 'L’autre'} a ajouté : ${e.title}`, details(e, e.start, true), `${doc.id}_new`);
        }
        await doc.ref.update({ notifyNew: admin.firestore.FieldValue.delete() });
      }

      // 2. Rappels
      for (const day of days) {
        if (!occursOn(e, day)) continue;
        // Si plusieurs rappels tombent en même temps (robot en retard), on n'envoie que le plus récent.
        const due = [];
        for (const r of dueReminders(e, day, nowAbs)) {
          const ref = c.collection('sent').doc(`${doc.id}_${r.kind}_${day}`);
          if (!(await ref.get()).exists) due.push({ r, ref });
        }
        if (!due.length) continue;
        const last = due[due.length - 1].r;
        const ok = await send(c, tokens.filter(forWho), last.title, last.body, `${doc.id}_${day}`);
        await Promise.all(due.map(({ ref }) => ref.set({ at: Date.now(), ok })));
        sent += ok;
      }
    }
  }
  console.log(`Terminé (${now.date} ${pad(Math.floor(now.min / 60))}:${pad(now.min % 60)} à Paris) : ${sent} notification(s).`);
}

if (process.argv[2] !== '--test') {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) {
    console.log('Clé FIREBASE_SERVICE_ACCOUNT absente : aucun rappel envoyé.');
    process.exit(0);
  }
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
  run().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
}
