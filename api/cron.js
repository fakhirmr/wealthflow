// WealthFlow — Notifikasi terjadwal ke Telegram (Vercel Cron)
//
// Dipanggil Vercel sesuai jadwal di vercel.json, bukan oleh pengguna.
//   ?job=pagi   → pengingat tagihan; tiap Senin sekalian laporan mingguan
//   ?job=malam  → rekap harian
//
// Environment variables:
//   CRON_SECRET               → wajib; Vercel mengirimnya sebagai Bearer token
//   TELEGRAM_BOT_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  (sudah ada)

export const config = { runtime: 'edge' };

// Semua tanggal dihitung dalam WITA (UTC+8), bukan UTC. Cron berjalan pada jam
// UTC, dan tanpa pergeseran ini "hari ini" bagi pengguna Indonesia bisa meleset
// satu hari pada pekerjaan malam.
var OFFSET_WITA = 8 * 3600 * 1000;

function kini() { return new Date(Date.now() + OFFSET_WITA); }
function tglStr(d) { return d.toISOString().slice(0, 10); }
function hariIni() { return tglStr(kini()); }

function fmtRp(n) {
  var x = Math.round(Number(n) || 0);
  return 'Rp ' + x.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

function sb(url, opts, SB_URL, KEY) {
  opts = opts || {};
  opts.headers = Object.assign({ apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' }, opts.headers || {});
  return fetch(SB_URL + url, opts);
}

function kirim(TOKEN, chatId, teks, tombol) {
  var body = { chat_id: chatId, text: teks, parse_mode: 'HTML', disable_web_page_preview: true };
  if (tombol) body.reply_markup = { inline_keyboard: tombol };
  return fetch('https://api.telegram.org/bot' + TOKEN + '/sendMessage', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  }).catch(function () { });
}

function selisihHari(tanggal, acuan) {
  var a = new Date(tanggal + 'T00:00:00Z').getTime();
  var b = new Date(acuan + 'T00:00:00Z').getTime();
  return Math.round((a - b) / 86400000);
}

// ── Pengingat tagihan ────────────────────────────────────────
async function jobTagihan(TOKEN, SB_URL, KEY, tautan, hari) {
  var terkirim = 0;

  for (var i = 0; i < tautan.length; i++) {
    var t = tautan[i];
    if (!t.notif_tagihan) continue;
    // Sudah diingatkan hari ini (cron terlanjur jalan dua kali) → lewati
    if (t.notif_terakhir === hari) continue;

    var baris = [], tombol = [];

    var dr = await sb('/rest/v1/debts?user_id=eq.' + t.user_id + '&type=eq.hutang&status=eq.active&select=id,name,monthly_payment,remaining_amount,due_date,auto_pay', {}, SB_URL, KEY);
    var utang = await dr.json(); if (!Array.isArray(utang)) utang = [];

    utang.forEach(function (d) {
      if (!d.due_date) return;
      var sisa = selisihHari(d.due_date, hari);
      if (sisa !== 0 && sisa !== 1 && sisa !== 3) return;
      var nilai = Number(d.monthly_payment) || Number(d.remaining_amount) || 0;
      var kapan = sisa === 0 ? '<b>hari ini</b>' : sisa === 1 ? 'besok' : sisa + ' hari lagi';
      // Cicilan yang sudah diatur otomatis tak perlu tombol; ia tercatat sendiri
      baris.push('• ' + d.name + ' — ' + fmtRp(nilai) + ' · ' + kapan + (d.auto_pay ? ' ⚡' : ''));
      if (!d.auto_pay) tombol.push([{ text: '✓ Sudah bayar: ' + d.name, callback_data: 'bayar:' + d.id }]);
    });

    var rr = await sb('/rest/v1/reminders?user_id=eq.' + t.user_id + '&select=id,name,amount,due_date,is_active', {}, SB_URL, KEY);
    var ingat = await rr.json(); if (!Array.isArray(ingat)) ingat = [];
    ingat.forEach(function (r) {
      if (r.is_active === false || !r.due_date) return;
      var sisa = selisihHari(r.due_date, hari);
      if (sisa !== 0 && sisa !== 1 && sisa !== 3) return;
      var kapan = sisa === 0 ? '<b>hari ini</b>' : sisa === 1 ? 'besok' : sisa + ' hari lagi';
      baris.push('• ' + r.name + ' — ' + fmtRp(r.amount) + ' · ' + kapan);
    });

    if (!baris.length) continue;

    await kirim(TOKEN, t.chat_id,
      '🔔 <b>Tagihan mendekat</b>\n\n' + baris.join('\n') +
      '\n\n<i>Matikan lewat /notif</i>',
      tombol.length ? tombol : null);

    await sb('/rest/v1/telegram_links?user_id=eq.' + t.user_id, {
      method: 'PATCH', body: JSON.stringify({ notif_terakhir: hari })
    }, SB_URL, KEY);
    terkirim++;
  }
  return terkirim;
}

// ── Laporan mingguan (Senin) ─────────────────────────────────
async function jobMingguan(TOKEN, SB_URL, KEY, tautan, hari) {
  var terkirim = 0;
  var mulaiIni = tglStr(new Date(new Date(hari + 'T00:00:00Z').getTime() - 7 * 86400000));
  var mulaiLalu = tglStr(new Date(new Date(hari + 'T00:00:00Z').getTime() - 14 * 86400000));

  for (var i = 0; i < tautan.length; i++) {
    var t = tautan[i];
    if (!t.notif_mingguan) continue;

    var tr = await sb('/rest/v1/transactions?user_id=eq.' + t.user_id + '&date=gte.' + mulaiLalu + '&date=lt.' + hari + '&select=type,amount,date,category_id', {}, SB_URL, KEY);
    var txn = await tr.json(); if (!Array.isArray(txn) || !txn.length) continue;

    var keluarIni = 0, masukIni = 0, keluarLalu = 0, perKat = {};
    txn.forEach(function (x) {
      var nilai = Number(x.amount) || 0;
      var mingguIni = x.date >= mulaiIni;
      if (x.type === 'expense') {
        if (mingguIni) { keluarIni += nilai; perKat[x.category_id || '-'] = (perKat[x.category_id || '-'] || 0) + nilai; }
        else keluarLalu += nilai;
      } else if (x.type === 'income' && mingguIni) masukIni += nilai;
    });

    if (keluarIni === 0 && masukIni === 0) continue;

    var cr = await sb('/rest/v1/categories?user_id=eq.' + t.user_id + '&select=id,name', {}, SB_URL, KEY);
    var kat = await cr.json(); if (!Array.isArray(kat)) kat = [];
    var namaKat = {}; kat.forEach(function (c) { namaKat[c.id] = c.name; });

    var atas = Object.keys(perKat).sort(function (a, b) { return perKat[b] - perKat[a]; }).slice(0, 3)
      .map(function (k) { return '• ' + (namaKat[k] || 'Tanpa kategori') + ' — ' + fmtRp(perKat[k]); }).join('\n');

    var banding = '';
    if (keluarLalu > 0) {
      var beda = Math.round((keluarIni - keluarLalu) / keluarLalu * 100);
      banding = beda > 0
        ? '\n\n📈 Naik ' + beda + '% dibanding minggu lalu.'
        : beda < 0 ? '\n\n📉 Turun ' + Math.abs(beda) + '% dibanding minggu lalu. Bagus.' : '';
    }

    await kirim(TOKEN, t.chat_id,
      '📊 <b>Laporan minggu ini</b>\n\n' +
      'Keluar: <b>' + fmtRp(keluarIni) + '</b>\n' +
      'Masuk: <b>' + fmtRp(masukIni) + '</b>\n' +
      'Selisih: <b>' + fmtRp(masukIni - keluarIni) + '</b>\n\n' +
      'Paling banyak:\n' + (atas || '—') + banding +
      '\n\n<i>Matikan lewat /notif</i>');
    terkirim++;
  }
  return terkirim;
}

// ── Rekap harian (malam) ─────────────────────────────────────
async function jobHarian(TOKEN, SB_URL, KEY, tautan, hari) {
  var terkirim = 0;

  for (var i = 0; i < tautan.length; i++) {
    var t = tautan[i];
    if (!t.notif_harian) continue;

    var tr = await sb('/rest/v1/transactions?user_id=eq.' + t.user_id + '&date=eq.' + hari + '&select=type,amount,description', {}, SB_URL, KEY);
    var txn = await tr.json(); if (!Array.isArray(txn)) txn = [];

    var keluar = 0, masuk = 0;
    txn.forEach(function (x) {
      var nilai = Number(x.amount) || 0;
      if (x.type === 'expense') keluar += nilai; else if (x.type === 'income') masuk += nilai;
    });

    var pesan;
    if (!txn.length) {
      // Hari kosong justru saat pengingat paling berguna, tapi nadanya jangan menghakimi
      pesan = '🌙 <b>Belum ada catatan hari ini</b>\n\nAda pengeluaran yang belum sempat dicatat? Ketik saja di sini, misalnya <i>makan siang 30rb</i>.';
    } else {
      pesan = '🌙 <b>Rekap hari ini</b>\n\n' +
        txn.length + ' transaksi tercatat\n' +
        'Keluar: <b>' + fmtRp(keluar) + '</b>' +
        (masuk > 0 ? '\nMasuk: <b>' + fmtRp(masuk) + '</b>' : '') +
        '\n\nAda yang terlewat? Ketik di sini.';
    }

    await kirim(TOKEN, t.chat_id, pesan + '\n\n<i>Matikan lewat /notif</i>');
    terkirim++;
  }
  return terkirim;
}

export default async function handler(req) {
  var TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  var SB_URL = process.env.SUPABASE_URL;
  var KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  var SECRET = process.env.CRON_SECRET;

  if (!TOKEN || !SB_URL || !KEY) return new Response('misconfig', { status: 500 });

  // Tanpa penjagaan ini siapa pun bisa memanggil alamat ini berulang kali dan
  // membanjiri seluruh pengguna dengan notifikasi.
  if (!SECRET) return new Response('misconfig: CRON_SECRET belum diset', { status: 500 });
  if ((req.headers.get('authorization') || '') !== 'Bearer ' + SECRET) {
    return new Response('forbidden', { status: 403 });
  }

  var job = new URL(req.url).searchParams.get('job') || 'pagi';
  var hari = hariIni();

  try {
    var lr = await sb('/rest/v1/telegram_links?linked=eq.true&chat_id=not.is.null&select=user_id,chat_id,notif_tagihan,notif_harian,notif_mingguan,notif_terakhir', {}, SB_URL, KEY);
    var tautan = await lr.json();
    if (!Array.isArray(tautan)) tautan = [];

    var hasil = {};
    if (job === 'malam') {
      hasil.harian = await jobHarian(TOKEN, SB_URL, KEY, tautan, hari);
    } else {
      hasil.tagihan = await jobTagihan(TOKEN, SB_URL, KEY, tautan, hari);
      // getUTCDay pada waktu WITA: 1 = Senin
      if (kini().getUTCDay() === 1) hasil.mingguan = await jobMingguan(TOKEN, SB_URL, KEY, tautan, hari);
    }

    return new Response(JSON.stringify({ ok: true, job: job, hari: hari, pengguna: tautan.length, hasil: hasil }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e && e.message || e) }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
}
