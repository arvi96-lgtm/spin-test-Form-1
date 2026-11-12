const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const DB_FILE = process.env.DB_PATH || path.join(__dirname, 'entries.json');
const ADMIN_KEY = process.env.ADMIN_KEY || '';   // set this to download the list

// entries are keyed by a random id stored in the customer's browser cookie
let entries = {};
try { entries = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { entries = {}; }
function save() {
  fs.writeFileSync(DB_FILE + '.tmp', JSON.stringify(entries, null, 2));
  fs.renameSync(DB_FILE + '.tmp', DB_FILE);
}

// --- Google Sheets backup (optional): set SHEET_URL and SHEET_SECRET in the host's environment ---
const SHEET_URL = process.env.SHEET_URL || '';
const SHEET_SECRET = process.env.SHEET_SECRET || '';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function pushToSheet(e) {
  if (!SHEET_URL) return;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(SHEET_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret: SHEET_SECRET, name: e.name, phone: e.phone, bill: e.bill,
                               prize: e.prize || '', registeredAt: e.registeredAt || '', spunAt: e.spunAt || '' }) });
      if ((await r.text()).trim() === 'OK') return;
      throw new Error('sheet replied ' + r.status);
    } catch (err) { console.error('Sheet push failed:', err.message); await sleep(1500 * (i + 1)); }
  }
}

// EDIT: your 10 products + weight (higher = more likely). Weight 0 = never won.
const PRIZES = [
  { name: 'Free Pen', weight: 20 }, { name: 'Keychain', weight: 15 },
  { name: '5% Discount', weight: 15 }, { name: 'Sticker Pack', weight: 15 },
  { name: 'Notebook', weight: 10 }, { name: '10% Discount', weight: 10 },
  { name: 'Water Bottle', weight: 6 }, { name: 'Cap', weight: 4 },
  { name: 'T-Shirt', weight: 3 }, { name: 'Gift Voucher', weight: 2 },
];
function pickPrize() {
  let r = Math.random() * PRIZES.reduce((s, p) => s + p.weight, 0);
  for (let i = 0; i < PRIZES.length; i++) if ((r -= PRIZES[i].weight) < 0) return i;
  return PRIZES.length - 1;
}
function cleanPhone(p) {
  let d = String(p || '').replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return d;
}
const normBill = b => String(b || '').trim().replace(/\s+/g, '').toUpperCase();

// --- who is this visitor? (cookie, not IP, so shop Wi-Fi sharing is fine) ---
function getSid(req) {
  const m = /(?:^|;\s*)sid=([a-f0-9]{32})/.exec(req.headers.cookie || '');
  return m ? m[1] : null;
}
function ensureSid(req, res) {
  let sid = getSid(req);
  if (!sid) {
    sid = crypto.randomBytes(16).toString('hex');
    res.cookie('sid', sid, { maxAge: 365 * 24 * 3600 * 1000, httpOnly: true, sameSite: 'lax', secure: req.secure });
  }
  return sid;
}

app.get('/api/prizes', (req, res) => {
  const sid = ensureSid(req, res);
  const e = entries[sid];
  res.json({ prizes: PRIZES.map(p => p.name), registered: !!e, name: e?.name,
             alreadySpun: !!e?.prize, prize: e?.prize });
});

app.post('/api/register', (req, res) => {
  const sid = ensureSid(req, res);
  const name = String(req.body.name || '').trim().replace(/\s+/g, ' ');
  const bill = String(req.body.bill || '').trim();
  const phone = cleanPhone(req.body.phone);
  if (name.length < 2 || name.length > 60) return res.status(400).json({ error: 'Please enter your name.' });
  if (!/^[6-9]\d{9}$/.test(phone)) return res.status(400).json({ error: 'Enter a valid 10-digit mobile number.' });
  if (bill.length < 1 || bill.length > 40) return res.status(400).json({ error: 'Please enter your bill number.' });

  if (entries[sid]?.prize) return res.json({ ok: true });   // already spun: go to the wheel

  const others = Object.entries(entries).filter(([k]) => k !== sid);
  const samePhone = others.find(([, v]) => v.phone === phone);
  if (samePhone) {
    if (samePhone[1].prize) return res.status(409).json({ error: 'This mobile number has already been used.' });
    // registered earlier but never spun (e.g. changed browser): let them continue under this browser
    delete entries[samePhone[0]];
  }
  if (others.some(([k, v]) => k !== samePhone?.[0] && normBill(v.bill) === normBill(bill)))
    return res.status(409).json({ error: 'This bill number has already been used.' });

  entries[sid] = { ...(samePhone?.[1] || {}), ...entries[sid], name, phone, bill,
                   registeredAt: entries[sid]?.registeredAt || samePhone?.[1]?.registeredAt || new Date().toISOString() };
  try { save(); } catch (err) { console.error(err); return res.status(500).json({ error: 'Could not save. Please try again.' }); }
  pushToSheet(entries[sid]);   // not awaited: the customer never waits for Google
  res.json({ ok: true });
});

app.post('/api/spin', (req, res) => {
  const sid = getSid(req);
  const e = sid && entries[sid];
  if (!e) return res.status(403).json({ error: 'not_registered' });
  if (e.prize) return res.status(409).json({ error: 'already_spun', prize: e.prize });
  const index = pickPrize();
  e.prize = PRIZES[index].name;
  e.spunAt = new Date().toISOString();
  try { save(); } catch (err) { console.error(err); delete e.prize; delete e.spunAt; return res.status(500).json({ error: 'save_failed' }); }
  pushToSheet(e);
  res.json({ index, prize: e.prize });
});

// Download everyone: /admin/entries.csv?key=YOUR_ADMIN_KEY
app.get('/admin/entries.csv', (req, res) => {
  if (!ADMIN_KEY || req.query.key !== ADMIN_KEY) return res.status(404).send('Not found');
  const esc = v => { v = String(v ?? ''); if (/^[=+\-@]/.test(v)) v = "'" + v; return '"' + v.replace(/"/g, '""') + '"'; };
  const rows = [['Name', 'Mobile', 'Bill No', 'Prize', 'Registered', 'Spun']];
  Object.values(entries).forEach(e => rows.push([e.name, e.phone, e.bill, e.prize, e.registeredAt, e.spunAt]));
  res.type('text/csv').set('Content-Disposition', 'attachment; filename=entries.csv')
     .send('\ufeff' + rows.map(r => r.map(esc).join(',')).join('\n'));
});

// Re-send everything to the Google Sheet (use after a restart wiped nothing, or to fill the sheet the first time)
app.get('/admin/sync', (req, res) => {
  if (!ADMIN_KEY || req.query.key !== ADMIN_KEY) return res.status(404).send('Not found');
  if (!SHEET_URL) return res.status(400).send('SHEET_URL is not set');
  const list = Object.values(entries);
  (async () => { for (const e of list) await pushToSheet(e); console.log('Sheet sync done'); })();
  res.send('Sync started for ' + list.length + ' entries. Check your sheet in a minute.');
});

app.listen(process.env.PORT || 3000, () => console.log('Running'));
