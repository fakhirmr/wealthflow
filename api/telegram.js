// WealthFlow — Telegram Bot Webhook (Vercel Edge Function)
// Catat keuangan lewat chat: teks natural atau foto struk.
//
// Environment variables (Vercel → Settings → Environment Variables):
//   TELEGRAM_BOT_TOKEN        → token bot dari @BotFather (RAHASIA)
//   TELEGRAM_WEBHOOK_SECRET   → string acak buatan sendiri (RAHASIA) — dipakai saat set webhook
//   GEMINI_API_KEY            → (sudah ada) untuk parse teks/struk
//   SUPABASE_URL              → (sudah ada)
//   SUPABASE_SERVICE_ROLE_KEY → (sudah ada, RAHASIA)
//   AI_FREE_LIMIT             → (opsional) jatah pesan/bulan free, default 30 — SAMA dengan kuota di app
//   AI_PREMIUM_LIMIT          → (opsional) jatah pesan/bulan premium (fair-use), default 500

export const config = { runtime: 'edge' };

var GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';

function b64FromBuffer(buf) {
  var bytes = new Uint8Array(buf), bin = '';
  for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function fmtRp(n) {
  try { return new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(n || 0); }
  catch (e) { return 'Rp ' + (n || 0); }
}
function today() { return new Date().toISOString().slice(0, 10); }
// Normalkan tanggal dari AI ke YYYY-MM-DD. Struk sering DD/MM/YYYY — format asing ditolak
// Postgres dan membatalkan SELURUH insert, jadi apa pun yang meragukan jatuh ke hari ini.
function safeDate(d) {
  if (!d) return today();
  var s = String(d).trim();
  var m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) {
    var alt = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/); // 15/03/2026 atau 15-03-2026
    if (alt) m = [null, alt[3], String(alt[2]).padStart(2, '0'), String(alt[1]).padStart(2, '0')];
  }
  if (!m) return today();
  var y = +m[1], mo = +m[2], da = +m[3];
  if (mo < 1 || mo > 12 || da < 1 || da > 31 || y < 2000 || y > 2100) return today();
  var iso = m[1] + '-' + String(mo).padStart(2, '0') + '-' + String(da).padStart(2, '0');
  var chk = new Date(iso + 'T00:00:00Z');
  if (isNaN(chk.getTime()) || chk.toISOString().slice(0, 10) !== iso) return today(); // tolak 31 Feb dsb
  return iso;
}

async function tgCall(token, method, body) {
  return fetch('https://api.telegram.org/bot' + token + '/' + method, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
function reply(token, chatId, text) { return tgCall(token, 'sendMessage', { chat_id: chatId, text: text, parse_mode: 'HTML' }); }

function sb(url, opts, SB_URL, KEY) {
  opts = opts || {};
  opts.headers = Object.assign({ apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' }, opts.headers || {});
  return fetch(SB_URL + url, opts);
}

// Panggil Gemini, ekstrak array transaksi dari teks atau gambar
async function geminiExtract(GKEY, content) {
  var body = { model: 'gemini-flash-latest', max_tokens: 1500, reasoning_effort: 'low', messages: [{ role: 'user', content: content }] };
  var r = await fetch(GEMINI_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + GKEY }, body: JSON.stringify(body) });
  var d = await r.json();
  var txt = '';
  try { txt = d.choices[0].message.content || ''; } catch (e) { txt = ''; }
  txt = txt.replace(/```json/gi, '').replace(/```/g, '').replace(/^[^\[]*/, '').replace(/[^\]]*$/, '').trim();
  var arr = [];
  try { arr = JSON.parse(txt); } catch (e) { arr = []; }
  return Array.isArray(arr) ? arr : [];
}

function wList(wallets) { return wallets.map(function (w) { return w.id + '=' + w.name; }).join(', '); }
function cList(cats) { return cats.filter(function (c) { return !c.parent_id; }).map(function (c) { return c.id + '=' + c.name + '(' + c.type + ')'; }).join(', '); }
// Sub-kategori beserta induknya — tanpa ini AI tak mungkin mengisi sub_category_id
function sList(cats) {
  var subs = cats.filter(function (c) { return !!c.parent_id; });
  if (!subs.length) return '(tidak ada)';
  return subs.map(function (c) { return c.id + '=' + c.name + '[induk:' + c.parent_id + ']'; }).join(', ');
}
// Rapikan hasil AI: pastikan sub benar-benar anak dari kategori terpilih.
// Kalau sub valid tapi kategori kosong/salah, turunkan kategori dari induk sub tsb.
function fixCat(tx, cats) {
  var catId = tx.category_id || null, subId = tx.sub_category_id || null;
  if (subId) {
    var sub = cats.find(function (c) { return c.id === subId && !!c.parent_id; });
    if (sub) { if (!catId || catId !== sub.parent_id) catId = sub.parent_id; }
    else {
      // AI kadang menaruh kategori induk di kolom sub — selamatkan jadi kategori, jangan dibuang
      var asParent = cats.find(function (c) { return c.id === subId && !c.parent_id; });
      if (asParent && !catId) catId = asParent.id;
      subId = null;
    }
  }
  if (catId && !cats.some(function (c) { return c.id === catId; })) { catId = null; subId = null; }
  return { category_id: catId, sub_category_id: subId };
}

export default async function handler(req) {
  if (req.method !== 'POST') return new Response('ok');
  var TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  var SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;
  var GKEY = process.env.GEMINI_API_KEY;
  var SB_URL = process.env.SUPABASE_URL;
  var KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!TOKEN || !GKEY || !SB_URL || !KEY) return new Response('misconfig', { status: 500 });

  // Verifikasi WAJIB, tak boleh dilewati. Sebelumnya, bila env secret lupa diisi,
  // pemeriksaan ini dilompati sepenuhnya — siapa pun yang tahu alamat webhook bisa
  // mengirim pesan palsu dan menyisipkan transaksi ke akun orang lain.
  if (!SECRET) return new Response('misconfig: webhook secret belum diset', { status: 500 });
  if (req.headers.get('x-telegram-bot-api-secret-token') !== SECRET) return new Response('forbidden', { status: 403 });

  var update;
  try { update = await req.json(); } catch (e) { return new Response('ok'); }
  var msg = update.message || update.edited_message;
  if (!msg || !msg.chat) return new Response('ok');
  var chatId = msg.chat.id;
  var text = (msg.text || msg.caption || '').trim();

  try {
    // 1) Linking: /start CODE atau /link CODE
    var codeMatch = text.match(/^\/(?:start|link)\s+(\S+)/i);
    if (codeMatch) {
      var code = codeMatch[1];
      var r = await sb('/rest/v1/telegram_links?link_code=eq.' + encodeURIComponent(code) + '&select=user_id', {}, SB_URL, KEY);
      var rows = await r.json();
      if (Array.isArray(rows) && rows[0]) {
        await sb('/rest/v1/telegram_links?user_id=eq.' + rows[0].user_id, { method: 'PATCH', body: JSON.stringify({ chat_id: chatId, linked: true, link_code: null }) }, SB_URL, KEY);
        await reply(TOKEN, chatId, '✅ <b>Akun WealthFlow terhubung!</b>\n\nSekarang catat transaksi langsung dari sini. Contoh:\n• <i>beli kopi 25rb pakai gopay</i>\n• <i>terima gaji 5jt</i>\n• <i>bayar listrik 150000</i>\n\nAtau kirim <b>foto struk</b> 📷');
      } else {
        await reply(TOKEN, chatId, '❌ Kode tidak valid atau kedaluwarsa.\n\nBuat kode baru di app WealthFlow → <b>Pengaturan → Hubungkan Telegram</b>.');
      }
      return new Response('ok');
    }
    if (/^\/(start|help)\b/i.test(text)) {
      await reply(TOKEN, chatId, '👋 <b>WealthFlow Bot</b>\n\nHubungkan akunmu dulu: buka app WealthFlow → <b>Pengaturan → Hubungkan Telegram</b>, lalu buka tautannya.\n\nSetelah terhubung, cukup ketik transaksimu atau kirim foto struk.');
      return new Response('ok');
    }

    // 2) Cari user terhubung
    var lr = await sb('/rest/v1/telegram_links?chat_id=eq.' + chatId + '&linked=eq.true&select=user_id', {}, SB_URL, KEY);
    var lrows = await lr.json();
    if (!Array.isArray(lrows) || !lrows[0]) {
      await reply(TOKEN, chatId, 'Akunmu belum terhubung. Buka app WealthFlow → <b>Pengaturan → Hubungkan Telegram</b>.');
      return new Response('ok');
    }
    var uid = lrows[0].user_id;

    // 2b) Cek kuota — kuota GABUNGAN dengan app (sama-sama pakai tabel ai_usage), jadi anti-bocor
    var FREE_LIMIT = parseInt(process.env.AI_FREE_LIMIT || '30', 10);
    var PREMIUM_LIMIT = parseInt(process.env.AI_PREMIUM_LIMIT || '500', 10);
    var period = new Date().toISOString().slice(0, 7);
    var us = await sb('/rest/v1/user_settings?user_id=eq.' + uid + '&select=premium_until', {}, SB_URL, KEY);
    var usRows = await us.json();
    var premiumUntil = (Array.isArray(usRows) && usRows[0]) ? usRows[0].premium_until : null;
    var isPremium = !!(premiumUntil && new Date(premiumUntil) > new Date());
    var QLIMIT = isPremium ? PREMIUM_LIMIT : FREE_LIMIT;
    var uc = await sb('/rest/v1/ai_usage?user_id=eq.' + uid + '&period=eq.' + period + '&select=count', {}, SB_URL, KEY);
    var ucRows = await uc.json();
    var used = (Array.isArray(ucRows) && ucRows[0]) ? (ucRows[0].count || 0) : 0;
    if (used >= QLIMIT) {
      await reply(TOKEN, chatId, '🚫 Jatah AI bulan ini habis (' + used + '/' + QLIMIT + ').' + (isPremium ? '' : '\n\nUpgrade ke <b>Premium</b> di app untuk jatah lebih besar.') + '\nReset otomatis awal bulan depan.');
      return new Response('ok');
    }

    // 3) Ambil dompet + kategori untuk konteks parsing
    var wr = await sb('/rest/v1/wallets?user_id=eq.' + uid + '&select=id,name,balance', {}, SB_URL, KEY);
    var wallets = await wr.json(); if (!Array.isArray(wallets)) wallets = [];
    var cr = await sb('/rest/v1/categories?user_id=eq.' + uid + '&select=id,name,type,parent_id', {}, SB_URL, KEY);
    var cats = await cr.json(); if (!Array.isArray(cats)) cats = [];

    // 4) Ekstrak transaksi (foto struk atau teks)
    var txList = [];
    if (msg.photo && msg.photo.length) {
      await reply(TOKEN, chatId, '📷 Membaca struk...');
      var fileId = msg.photo[msg.photo.length - 1].file_id;
      var gf = await tgCall(TOKEN, 'getFile', { file_id: fileId });
      var gfj = await gf.json();
      var filePath = gfj.result && gfj.result.file_path;
      if (filePath) {
        var img = await fetch('https://api.telegram.org/file/bot' + TOKEN + '/' + filePath);
        var b64 = b64FromBuffer(await img.arrayBuffer());
        var vprompt = 'Ini foto struk belanja. Ekstrak jadi JSON array transaksi pengeluaran. Balas HANYA JSON: [{"type":"expense","amount":number,"description":"nama toko/item","date":"YYYY-MM-DD","category_id":"id atau null","sub_category_id":"id atau null","wallet_id":"id atau null"}]. Gunakan TOTAL akhir sebagai 1 transaksi. Tanggal dari struk; jika tak ada pakai ' + today() + '. Cocokkan dompet bila disebut. PENTING: pilih kategori sespesifik mungkin — kalau isi struk cocok dengan salah satu SUB-KATEGORI, isi sub_category_id dengan sub itu dan category_id dengan induknya (lihat penanda [induk:...]). sub_category_id harus anak dari category_id.\nDompet: ' + wList(wallets) + '\nKategori: ' + cList(cats) + '\nSub-Kategori: ' + sList(cats);
        txList = await geminiExtract(GKEY, [{ type: 'text', text: vprompt }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + b64 } }]);
      }
    } else if (text) {
      var tprompt = 'Kamu parser transaksi keuangan Bahasa Indonesia. Ekstrak dari pesan user jadi JSON array. Balas HANYA JSON valid: [{"type":"expense"|"income","amount":number,"description":"singkat","date":"YYYY-MM-DD","category_id":"id atau null","sub_category_id":"id atau null","wallet_id":"id atau null"}].\nATURAN:\n1) uang keluar/beli/bayar = expense; uang masuk/terima/gaji = income.\n2) Cocokkan dompet dari nama yang disebut user.\n3) PENTING — pilih kategori SESPESIFIK mungkin: kalau barang/jasa yang disebut user cocok dengan salah satu SUB-KATEGORI, WAJIB isi sub_category_id dengan sub itu, dan category_id dengan induknya. Contoh: user tulis "kopi" dan ada sub-kategori "Kopi" -> sub_category_id = id sub "Kopi", category_id = id induknya. Jangan biarkan sub_category_id null kalau ada sub yang cocok.\n4) sub_category_id HARUS anak dari category_id yang dipilih (lihat penanda [induk:...]).\n5) description = keterangan tambahan/detail (mis. nama tempat atau merek). Kalau tidak ada detail lain, boleh diisi nama barangnya.\n6) Tanggal default ' + today() + '. Jika bukan transaksi, balas [].\nDompet: ' + wList(wallets) + '\nKategori: ' + cList(cats) + '\nSub-Kategori: ' + sList(cats) + '\n\nPesan: "' + text + '"';
      txList = await geminiExtract(GKEY, [{ type: 'text', text: tprompt }]);
    } else {
      await reply(TOKEN, chatId, 'Kirim teks transaksi atau foto struk ya 🙂\nContoh: <i>bayar parkir 5rb cash</i>');
      return new Response('ok');
    }

    // 5) Bersihkan & simpan
    var rows = txList.map(function (tx) {
      var cc = fixCat(tx, cats);
      // Dompet & tanggal WAJIB divalidasi: id/format ngawur dari AI bikin seluruh insert ditolak Postgres
      var wid = tx.wallet_id && wallets.some(function (w) { return w.id === tx.wallet_id; }) ? tx.wallet_id : null;
      return { user_id: uid, type: tx.type === 'income' ? 'income' : 'expense', amount: Number(tx.amount) || 0, description: (tx.description || '').toString().slice(0, 120), date: safeDate(tx.date), wallet_id: wid, category_id: cc.category_id, sub_category_id: cc.sub_category_id };
    }).filter(function (r) { return r.amount > 0; });

    if (!rows.length) {
      await reply(TOKEN, chatId, '⚠️ Tidak terdeteksi transaksi. Coba lebih jelas, mis: <i>beli makan 30rb pakai cash</i>');
      return new Response('ok');
    }

    // Jangan pernah bilang "tercatat" tanpa memastikan benar-benar tersimpan
    var insRes = await sb('/rest/v1/transactions', { method: 'POST', body: JSON.stringify(rows) }, SB_URL, KEY);
    if (!insRes.ok) {
      var errTxt = '';
      try { errTxt = (await insRes.text() || '').slice(0, 300); } catch (e) { }
      await reply(TOKEN, chatId, '❌ <b>Gagal menyimpan.</b> Transaksi TIDAK tercatat.\n\n<code>' + errTxt.replace(/[<>&]/g, '') + '</code>\n\nCoba lagi, atau catat manual di app.');
      return new Response('ok');
    }
    await sb('/rest/v1/rpc/increment_ai_usage', { method: 'POST', body: JSON.stringify({ p_user: uid, p_period: period }) }, SB_URL, KEY);

    // Update saldo dompet — HANYA dijalankan setelah insert dipastikan berhasil,
    // supaya saldo tak pernah berubah untuk transaksi yang gagal tersimpan.
    var deltas = {}; var balFailed = false;
    rows.forEach(function (r) { if (r.wallet_id) deltas[r.wallet_id] = (deltas[r.wallet_id] || 0) + (r.type === 'income' ? r.amount : -r.amount); });
    for (var wid in deltas) {
      var w = wallets.find(function (x) { return x.id === wid; });
      if (w) {
        var balRes = await sb('/rest/v1/wallets?id=eq.' + wid, { method: 'PATCH', body: JSON.stringify({ balance: (Number(w.balance) || 0) + deltas[wid] }) }, SB_URL, KEY);
        if (!balRes.ok) balFailed = true;
      }
    }

    // 6) Balas ringkasan
    var summary = rows.map(function (r) {
      var c = cats.find(function (x) { return x.id === r.category_id; });
      var s = cats.find(function (x) { return x.id === r.sub_category_id; });
      var w = wallets.find(function (x) { return x.id === r.wallet_id; });
      var catTxt = c ? (' · ' + c.name + (s ? ' › ' + s.name : '')) : '';
      // Tanggal ditampilkan: kalau struk bertanggal bulan lalu, transaksi tak muncul di
      // tampilan bulan berjalan — user perlu tahu supaya tak mengira gagal tersimpan
      var dateTxt = r.date !== today() ? ('\n   🗓 ' + r.date) : '';
      return (r.type === 'income' ? '📥' : '📤') + ' <b>' + fmtRp(r.amount) + '</b> — ' + (r.description || '-') + catTxt + (w ? ' · ' + w.name : '') + dateTxt;
    }).join('\n');
    await reply(TOKEN, chatId, '✅ <b>Tercatat!</b>\n' + summary + (balFailed ? '\n\n⚠️ Transaksi tersimpan, tapi saldo dompet gagal diperbarui — cek & sesuaikan manual di app.' : ''));
  } catch (e) {
    try { await reply(TOKEN, chatId, '❌ Ada kesalahan memproses. Coba lagi sebentar.'); } catch (e2) { }
  }
  return new Response('ok');
}
