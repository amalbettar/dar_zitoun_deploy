// Dar Zitoun — réservations (Netlify Function v2 + Netlify Blobs)
import { getStore } from '@netlify/blobs';
import crypto from 'node:crypto';
import ADMIN_HTML from './admin-html.mjs';

export const config = { path: ['/admin', '/admin/', '/api/reservations', '/api/admin/*'] };

const RX = /^\+212 [67] \d\d \d\d \d\d \d\d$/;
const HOURS = ['19:30', '20:00', '20:30', '21:00', '21:30'];
const GUESTS = ['2', '3', '4', '5', '6', '7 et plus'];
const STATUS = ['nouvelle', 'confirmée', 'annulée'];
const TZ = 'Africa/Casablanca';

const store = () => getStore({ name: 'reservations', consistency: 'strong' });
const limits = () => getStore({ name: 'ratelimit', consistency: 'strong' });

const json = (code, obj, extra = {}) =>
  new Response(JSON.stringify(obj), {
    status: code,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra }
  });

// ---------- Notifications client (Twilio, facultatif) ----------
const env = k => (typeof Netlify !== 'undefined' ? Netlify.env.get(k) : process.env[k]);
const frDate = d => d.split('-').reverse().join('/');
function messageFor(r) {
  const base = 'Bonjour ' + r.name + ', ';
  const when = 'du ' + frDate(r.date) + ' à ' + r.time + ' (convives : ' + r.guests + ')';
  const tel = env('RESTO_PHONE') || '';
  if (r.status === 'confirmée') return 'Dar Zitoun : ' + base + 'votre réservation ' + when + ' est confirmée. À bientôt !';
  if (r.status === 'annulée') return 'Dar Zitoun : ' + base + 'nous sommes au regret de devoir annuler votre réservation ' + when + '.' + (tel ? ' Contactez-nous au ' + tel + '.' : '');
  return '';
}
async function notify(r) {
  const SID = env('TWILIO_ACCOUNT_SID'), TOKEN = env('TWILIO_AUTH_TOKEN'), FROM = env('TWILIO_FROM');
  const channel = (env('NOTIFY_CHANNEL') || 'sms').toLowerCase();
  const out = { status: r.status, channel, at: new Date().toISOString(), ok: false };
  if (!(SID && TOKEN && FROM)) return Object.assign(out, { skipped: true, error: 'Notifications non configurées' });
  const wa = channel === 'whatsapp', pre = x => (wa && !x.startsWith('whatsapp:') ? 'whatsapp:' + x : x);
  try {
    const resp = await fetch('https://api.twilio.com/2010-04-01/Accounts/' + encodeURIComponent(SID) + '/Messages.json', {
      method: 'POST',
      headers: { Authorization: 'Basic ' + Buffer.from(SID + ':' + TOKEN).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ To: pre(r.phone.replace(/ /g, '')), From: pre(FROM), Body: messageFor(r) }),
      signal: AbortSignal.timeout(7000)
    });
    const j = await resp.json().catch(() => ({}));
    if (!resp.ok) return Object.assign(out, { error: j.message || 'Erreur ' + resp.status });
    return Object.assign(out, { ok: true });
  } catch (e) {
    return Object.assign(out, { error: e.name === 'TimeoutError' ? 'Délai dépassé' : 'Envoi impossible' });
  }
}

// ---------- Auth admin ----------
function authOk(req) {
  const PASS = env('ADMIN_PASSWORD');
  if (!PASS || PASS.length < 8) return false;
  const h = req.headers.get('authorization') || '';
  if (!h.startsWith('Basic ')) return false;
  const p = Buffer.from(h.slice(6), 'base64').toString().split(':').slice(1).join(':');
  const a = crypto.createHash('sha256').update(p).digest(), b = crypto.createHash('sha256').update(PASS).digest();
  return crypto.timingSafeEqual(a, b);
}

// ---------- Validation ----------
const clean = s => String(s || '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();
const todayMA = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
function validate(b) {
  if (clean(b.name).length < 2 || clean(b.name).length > 80) return 'Nom invalide.';
  if (!RX.test(String(b.phone || ''))) return 'Format du numéro : +212 6 00 00 00 00';
  const d = String(b.date || '');
  if (!/^\d{4}-\d\d-\d\d$/.test(d) || isNaN(Date.parse(d))) return 'Date invalide.';
  if (d < todayMA()) return 'La date est passée.';
  if (!HOURS.includes(b.time)) return 'Heure invalide.';
  if (!GUESTS.includes(b.guests)) return 'Nombre de convives invalide.';
  return null;
}

// ---------- Anti-spam : 10 demandes / heure / IP ----------
async function limited(ip) {
  const key = crypto.createHash('sha256').update(String(ip)).digest('hex').slice(0, 24) + ':' + Math.floor(Date.now() / 36e5);
  try {
    const s = limits();
    const n = Number((await s.get(key)) || 0) + 1;
    await s.set(key, String(n));
    return n > 10;
  } catch (e) {
    return false; // ne jamais bloquer une vraie réservation si le compteur tombe en panne
  }
}

async function readBody(req) {
  const t = await req.text();
  if (t.length > 5000) throw new Error('Requête trop grande');
  try { return JSON.parse(t || '{}'); } catch (e) { throw new Error('JSON invalide'); }
}

async function listAll() {
  const s = store();
  const { blobs } = await s.list();
  const items = await Promise.all(blobs.map(b => s.get(b.key, { type: 'json' }).catch(() => null)));
  return items.filter(Boolean);
}

export default async (req, context) => {
  try {
    const p = new URL(req.url).pathname.replace(/\/+$/, '') || '/';

    // Public : créer une réservation
    if (p === '/api/reservations') {
      if (req.method !== 'POST') return json(405, { error: 'Méthode non autorisée' });
      if (await limited(context.ip || req.headers.get('x-nf-client-connection-ip') || 'unknown'))
        return json(429, { error: 'Trop de demandes, réessayez plus tard.' });
      const b = await readBody(req), e = validate(b);
      if (e) return json(400, { error: e });
      const r = { id: crypto.randomUUID(), name: clean(b.name), phone: b.phone, date: b.date, time: b.time, guests: b.guests, status: 'nouvelle', createdAt: new Date().toISOString() };
      await store().setJSON(r.id, r);
      console.log('Nouvelle réservation :', r.name, r.date, r.time, r.guests);
      return json(201, { ok: true, id: r.id });
    }

    // Admin (mot de passe)
    if (!authOk(req))
      return new Response('Authentification requise', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="Dar Zitoun admin"', 'Cache-Control': 'no-store' } });

    if (p === '/admin')
      return new Response(ADMIN_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' } });

    if (req.method === 'GET' && p === '/api/admin/reservations') {
      const all = await listAll();
      return json(200, all.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time)).map(x => ({ ...x, msg: messageFor(x) })));
    }

    const m = p.match(/^\/api\/admin\/reservations\/([\w-]+)$/);
    if (!m) return json(404, { error: 'Introuvable' });
    const s = store(), r = await s.get(m[1], { type: 'json' });
    if (!r) return json(404, { error: 'Introuvable' });

    if (req.method === 'PATCH') {
      const b = await readBody(req);
      if (!STATUS.includes(b.status)) return json(400, { error: 'Statut invalide' });
      const retry = !(r.notif && r.notif.ok && r.notif.status === b.status);
      r.status = b.status;
      if (b.status !== 'nouvelle' && b.notify !== false && retry) r.notif = await notify(r);
      await s.setJSON(r.id, r);
      return json(200, r);
    }
    if (req.method === 'DELETE') { await s.delete(r.id); return json(200, { ok: true }); }
    return json(405, { error: 'Méthode non autorisée' });
  } catch (e) {
    console.error(e);
    return json(400, { error: e.message || 'Erreur' });
  }
};
