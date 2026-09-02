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
/* Model pembaca gambar. Lite dipilih karena tugasnya ekstraksi berformat tetap,
   bukan penalaran, dan lite menjawab jauh lebih cepat. Bisa ditimpa lewat env
   kalau ternyata ketepatannya kurang. */
/* Bawaannya model STABIL, bukan alias -latest. Alias itulah yang ditolak Google
   dengan "experiencing high traffic". Masih bisa ditimpa lewat env kalau perlu. */
var MODEL_GAMBAR = process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-lite';

/* Disusun per potongan 32KB. Versi sebelumnya menyambung string byte demi byte,
   jadi gambar 3MB berarti tiga juta iterasi penyambungan sebelum permintaan ke
   AI bahkan dimulai. */
function b64FromBuffer(buf) {
  var bytes = new Uint8Array(buf), potong = 0x8000, bagian = [];
  for (var i = 0; i < bytes.length; i += potong) {
    bagian.push(String.fromCharCode.apply(null, bytes.subarray(i, i + potong)));
  }
  return btoa(bagian.join(''));
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
function reply(token, chatId, text, tombol) {
  var body = { chat_id: chatId, text: text, parse_mode: 'HTML', disable_web_page_preview: true };
  if (tombol && tombol.length) body.reply_markup = { inline_keyboard: tombol };
  return tgCall(token, 'sendMessage', body);
}

// Telegram menampilkan jam pasir pada tombol sampai callback dijawab; tanpa ini
// tombol terlihat menggantung walau pekerjaannya sudah selesai.
function jawabTombol(token, id, teks) {
  return tgCall(token, 'answerCallbackQuery', { callback_query_id: id, text: teks || '' }).catch(function () { });
}
function ubahPesan(token, chatId, msgId, teks, tombol) {
  var b = { chat_id: chatId, message_id: msgId, text: teks, parse_mode: 'HTML' };
  if (tombol && tombol.length) b.reply_markup = { inline_keyboard: tombol };
  return tgCall(token, 'editMessageText', b).catch(function () { });
}

async function rpc(nama, argumen, SB_URL, KEY) {
  var r = await sb('/rest/v1/rpc/' + nama, { method: 'POST', body: JSON.stringify(argumen) }, SB_URL, KEY);
  if (!r.ok) return null;
  try { return await r.json(); } catch (e) { return null; }
}

// Nilai uang di Indonesia sering ditulis 25rb / 1,5jt. Dipakai perintah cepat
// yang tidak memakai AI sama sekali, jadi tak memakan jatah bulanan.
function angkaId(teks) {
  var m = String(teks || '').toLowerCase().replace(/\s+/g, '').match(/([\d.,]+)(rb|ribu|jt|juta|k|m)?/);
  if (!m) return 0;
  var v = parseFloat(m[1].replace(/\./g, '').replace(',', '.')) || 0;
  var sat = m[2] || '';
  if (sat === 'rb' || sat === 'ribu' || sat === 'k') v *= 1000;
  else if (sat === 'jt' || sat === 'juta' || sat === 'm') v *= 1000000;
  return Math.round(v);
}

function sb(url, opts, SB_URL, KEY) {
  opts = opts || {};
  opts.headers = Object.assign({ apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' }, opts.headers || {});
  return fetch(SB_URL + url, opts);
}

// Panggil Gemini, ekstrak array transaksi dari teks atau gambar
/* Batas waktu WAJIB di sini. Tanpa ini, permintaan yang lama (mis. mutasi
   panjang) membuat fungsi dibunuh Vercel sebelum sempat menjawab 200, lalu
   Telegram MENGIRIM ULANG update yang sama berkali-kali dan bot memulai
   pekerjaan dari nol terus-menerus. Lebih baik gagal cepat dan berkata jujur. */
async function fetchTO(url, opts, ms) {
  var ctrl = new AbortController();
  var id = setTimeout(function () { ctrl.abort(); }, ms || 20000);
  try { return await fetch(url, Object.assign({}, opts, { signal: ctrl.signal })); }
  finally { clearTimeout(id); }
}

/* Membaca balasan penyedia AI, dan MELEMPARKAN galatnya kalau ada.

   Sebelumnya isinya diambil dengan try/catch yang mengubah galat apa pun jadi
   string kosong. Akibatnya, saat Google menolak karena kuota habis atau kena
   batas laju, bot menyimpulkan 'tidak ada transaksi terdeteksi' lalu menyuruh
   pengguna menulis lebih jelas, padahal tulisannya sudah benar. Galat penyedia
   harus terlihat apa adanya; kalau tidak, setiap penelusuran jadi menebak. */
/* Endpoint kompatibel-OpenAI milik Gemini kadang MEMBUNGKUS balasannya dalam
   array: [{ "error": {...} }] dan, pada sebagian jalur, [{ "choices": [...] }].
   Seluruh kode di sini memeriksa d.error dan d.choices seolah balasannya objek,
   dan pada array keduanya undefined. Akibatnya galat asli Google tak pernah
   terbaca, dan balasan yang SUKSES pun dianggap kosong. Bungkusnya dibuka di
   satu tempat supaya tak ada lagi pemeriksaan yang salah sasaran. */
function bukaBungkus(d) {
  if (Array.isArray(d)) return d.length ? d[0] : null;
  return d;
}

function bacaBalasanAI(d, status) {
  d = bukaBungkus(d);
  var e;
  if (d && d.error) {
    var pesan = d.error.message || d.error.status || JSON.stringify(d.error);
    e = new Error(String(pesan).slice(0, 250));
    e.dariAI = true; e.kode = d.error.code || status || 0;
    throw e;
  }
  if (!d || !d.choices || !d.choices[0] || !d.choices[0].message) {
    e = new Error('balasan tanpa isi' + (status ? ' (HTTP ' + status + ')' : ''));
    e.dariAI = true; e.kode = status || 0;
    throw e;
  }
  return d.choices[0].message.content || '';
}

/* Saat SEMUA kandidat gagal, kunci diperiksa langsung ke Google. Endpoint daftar
   model memakai jatah berbeda dari endpoint chat, jadi ia tetap menjawab walau
   chat ditolak. Hasilnya memisahkan tiga kemungkinan yang selama ini tercampur:
   kunci memang tak sah, kunci sah tapi nama modelnya tak ada, atau kunci sah dan
   modelnya ada sehingga penolakannya benar-benar dari sisi kapasitas Google. */
async function periksaKunci(GKEY) {
  try {
    var r = await fetchTO('https://generativelanguage.googleapis.com/v1beta/models?key=' + GKEY + '&pageSize=200', {}, 8000);
    var j = await r.json();
    if (!r.ok || !j || !Array.isArray(j.models)) {
      var pesan = (j && j.error && j.error.message) || ('HTTP ' + r.status);
      return { ok: false, pesan: pesan };
    }
    var chat = j.models.filter(function (mm) {
      return (mm.supportedGenerationMethods || []).indexOf('generateContent') >= 0;
    }).map(function (mm) { return String(mm.name || '').replace('models/', ''); });
    return { ok: true, model: chat };
  } catch (e) { return { ok: false, pesan: String(e && e.message || e) }; }
}

// Menerjemahkan galat penyedia jadi kalimat yang bisa ditindaklanjuti.
function pesanGalatAI(e) {
  var m = String(e && e.message || '').toLowerCase();
  var kode = (e && e.kode) || 0;
  if (kode === 429 || m.indexOf('quota') >= 0 || m.indexOf('rate limit') >= 0 || m.indexOf('exhaust') >= 0) {
    return '🚫 <b>Jatah AI di Google habis atau kena batas laju.</b>\n\nBukan salah tulisanmu. Tunggu beberapa menit, atau aktifkan penagihan di Google AI Studio kalau ini sering terjadi.';
  }
  if (kode >= 500 || m.indexOf('penuh') >= 0 || m.indexOf('overload') >= 0 || m.indexOf('unavailable') >= 0 || m.indexOf('high traffic') >= 0) {
    return '🌧 <b>Semua model AI menolak.</b>\n\nGoogle membalas bahwa modelnya sedang penuh. Ini dari pihak Google, bukan dari tulisanmu.';
  }
  if (kode === 401 || kode === 403 || m.indexOf('api key') >= 0 || m.indexOf('permission') >= 0) {
    return '🔑 <b>Kunci AI ditolak Google.</b> Periksa GEMINI_API_KEY di Vercel.';
  }
  if (m.indexOf('not found') >= 0 || m.indexOf('model') >= 0) {
    return '⚠️ <b>Model AI tidak tersedia.</b>\n\n<code>' + String(e.message).slice(0, 120).replace(/[<>&]/g, '') + '</code>';
  }
  return '❌ <b>AI menolak permintaan.</b>\n\n<code>' + String(e.message).slice(0, 160).replace(/[<>&]/g, '') + '</code>';
}

async function geminiExtract(GKEY, content, maxTok) {
  // Jalur teks ikut dapat coba-ulang; dulu ia menyerah begitu Google membalas 503.
  var txt = await panggilAI(GKEY, content, maxTok || 1500, { model: MODEL_CADANGAN });
  txt = txt.replace(/```json/gi, '').replace(/```/g, '').replace(/^[^\[]*/, '').replace(/[^\]]*$/, '').trim();
  var arr = [];
  try { arr = JSON.parse(txt); } catch (e) { arr = []; }
  return Array.isArray(arr) ? arr : [];
}

/* Mutasi diminta dalam format "tipe|nominal|keterangan|tanggal" satu baris per
   transaksi. JSON menghabiskan sekitar 30 token per baris, format ini sekitar 12,
   dan menghasilkan token itulah bagian paling lambat. Untuk mutasi 30 baris
   selisihnya ratusan token, cukup untuk tidak menabrak batas waktu. */
var BA_KELUAR = ['K', 'KELUAR', 'D', 'DB', 'DEBIT', 'DEBET', 'EXPENSE', 'PENGELUARAN', '-'];
var BA_MASUK = ['M', 'MASUK', 'C', 'CR', 'KREDIT', 'CREDIT', 'INCOME', 'PEMASUKAN', '+'];
function parseBaris(teks) {
  var out = [];
  String(teks || '').split('\n').forEach(function (b0) {
    var b = b0.trim();
    if (!b || b.indexOf('|') < 0) return;
    b = b.replace(/^\|+/, '').replace(/\|+$/, '').trim();
    if (!b || /^[\s|:-]+$/.test(b)) return;
    var f = b.split('|');
    if (f.length < 3) return;
    var tipe = f[0].trim().toUpperCase().replace(/[^A-Z+-]/g, '');
    var masuk = BA_MASUK.indexOf(tipe) >= 0, keluar = BA_KELUAR.indexOf(tipe) >= 0;
    if (!masuk && !keluar) return;
    var nominal = Number(String(f[1] || '').replace(/[^0-9]/g, ''));
    if (!nominal || nominal <= 0) return;
    out.push({ type: masuk ? 'income' : 'expense', amount: nominal, description: (f[2] || '').trim() || 'Transaksi', date: safeDate((f[3] || '').trim()), _kat: (f[4] || '').trim() });
  });
  return out;
}

/* Mengambil balasan AI apa adanya. Jenis gambar tidak lagi ditebak dari
   keterangan yang diketik pengguna, melainkan ditentukan AI sendiri; balasannya
   bisa berupa JSON (struk) atau baris berpipa (mutasi), jadi teksnya diambil
   mentah lalu dicoba kedua pembaca. */
/* Rantai model, dicoba berurutan. Alias -latest ditaruh PALING BELAKANG:
   Google membalas "This model is currently experiencing high traffic" untuknya,
   sebab alias itu menunjuk model terbaru yang kapasitasnya paling diperebutkan.
   Model stabil bernomor versi biasanya jauh lebih lega.

   Kandidat yang namanya tidak dikenal (404) DILEWATI, bukan dianggap gagal, jadi
   rantainya tetap jalan walau salah satu nama sudah dipensiunkan Google. Dengan
   begitu kode tak bergantung pada satu nama yang kebetulan benar hari ini. */
/* Hanya tiga percobaan yang muat di bawah batas Vercel, jadi isinya harus terpilih:
   satu model stabil, lalu alias -latest sebagai jaring terakhir. Alias itu memang
   yang penuh, TAPI ia satu-satunya yang terbukti ada (balasannya 503, bukan 404),
   sementara nama stabil di atas belum terverifikasi. Menyingkirkannya berarti
   bertaruh pada nama yang mungkin salah. */
var RANTAI_MODEL = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-flash-latest'];
var MODEL_CADANGAN = RANTAI_MODEL[0];
function tidur(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

/* HTTP 5xx dari Google berarti servernya sedang penuh, bukan permintaan kita yang
   salah. Menyerah di percobaan pertama membuat bot terasa rusak padahal cukup
   diulang sebentar. Percobaan kedua sengaja memakai model lain, sebab yang penuh
   biasanya satu model tertentu, bukan seluruh layanan.

   Batas waktu per percobaan dipersingkat jadi 9 detik supaya dua percobaan plus
   jeda tetap muat di bawah batas Vercel; satu percobaan 20 detik justru tak
   menyisakan ruang untuk mencoba lagi. */
async function panggilAI(GKEY, content, maxTok, opsi) {
  opsi = opsi || {};
  /* Jejak SETIAP percobaan dicatat. Sebelumnya hanya percobaan terakhir yang
     dilaporkan, sehingga tak bisa dibedakan antara "ketiganya dicoba dan semua
     ditolak" dengan "baru satu yang dicoba". Tanpa itu penelusuran cuma menebak. */
  var jejak = [];
  var utama = opsi.model || MODEL_GAMBAR;
  var urutan = [utama];
  if (!opsi.tanpaCadangan) {
    RANTAI_MODEL.forEach(function (m) { if (urutan.indexOf(m) < 0) urutan.push(m); });
    urutan = urutan.slice(0, 3);   // tiga percobaan, masih muat di bawah batas Vercel
  }
  /* Anggaran waktu dibagi menurut SISA, bukan dipatok mati per percobaan.

     Versi sebelumnya memberi 7 detik ke tiap percobaan seolah semuanya pasti
     memakannya habis. Kenyataannya penolakan 503 datang dalam waktu di bawah
     satu detik, sedangkan panggilan yang benar-benar bekerja perlu 10-15 detik.
     Akibatnya percobaan yang sehat justru dicekik dan permintaan teks sesederhana
     "beli kopi 21rb" pun ikut gagal.

     Sekarang tiap percobaan boleh memakai sampai 12 detik, tapi tak pernah
     melebihi sisa anggaran keseluruhan, jadi rangkaiannya tetap berhenti sebelum
     batas Vercel. Kandidat yang ditolak cepat menyisakan waktu untuk kandidat
     berikutnya, persis yang dibutuhkan saat model pertama sedang penuh. */
  var mulai = Date.now();
  var anggaran = opsi.total || 21000;
  var batasSatuan = opsi.batas || 12000;
  var galat = null;

  for (var i = 0; i < urutan.length; i++) {
    var sisa = anggaran - (Date.now() - mulai);
    // Kurang dari 3 detik tak cukup untuk apa pun; berhenti daripada gagal percuma
    if (sisa < 3000) break;
    var batas = Math.min(batasSatuan, sisa);
    try {
      var body = { model: urutan[i], max_tokens: maxTok || 3072, messages: [{ role: 'user', content: content }] };
      if (!opsi.tanpaPikir) body.reasoning_effort = opsi.pikir || 'low';
      var r = await fetchTO(GEMINI_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + GKEY },
        body: JSON.stringify(body)
      }, batas);
      // Badan balasan hanya boleh dibaca SEKALI. Diambil sebagai teks dulu supaya
      // cuplikannya masih bisa dilaporkan saat penguraian JSON gagal.
      var mentahTeks = '';
      try { mentahTeks = await r.text(); } catch (e2) { mentahTeks = ''; }
      var d = null;
      try { d = mentahTeks ? JSON.parse(mentahTeks) : null; } catch (e2b) { d = null; }

      if (r.status >= 500) {
        // Cuplikan badan balasan disimpan; 503 dari Google sering berbadan kosong,
        // dan mengetahui KOSONG atau berisi apa itu justru petunjuk yang berguna.
        var pesanG = '';
        try { var db2 = bukaBungkus(JSON.parse(mentahTeks || '{}')); pesanG = (db2 && db2.error && db2.error.message) || ''; } catch (eJ) { }
        jejak.push(urutan[i] + ': ' + r.status + (pesanG ? ' ' + pesanG.slice(0, 60) : ''));
        galat = new Error('server AI sedang penuh');
        galat.dariAI = true; galat.kode = r.status; galat.sementara = true;
        throw galat;
      }
      // Nama model tak dikenal: lanjut ke kandidat berikutnya, jangan menyerah
      if (r.status === 404) {
        // Pesan asli Google ikut dibawa; tanpa itu sebabnya hilang saat ditelusuri
        var db = bukaBungkus(d);
        var kataGoogle = (db && db.error && db.error.message) ? (': ' + db.error.message) : '';
        jejak.push(urutan[i] + ': 404 tidak dikenal');
        galat = new Error('model ' + urutan[i] + ' tidak dikenal' + kataGoogle);
        galat.dariAI = true; galat.kode = 404; galat.sementara = true;
        throw galat;
      }
      return bacaBalasanAI(d, r.status);
    } catch (e) {
      galat = e;
      if (/abort/i.test(String(e && e.message || ''))) jejak.push(urutan[i] + ': kehabisan waktu');
      e.jejak = jejak.slice();
      var bolehUlang = !!e.sementara || (e.kode >= 500) || e.kode === 404 || /abort/i.test(String(e && e.message || ''));
      if (i < urutan.length - 1 && bolehUlang) { await tidur(600); continue; }
      throw e;
    }
  }
  throw galat;
}

async function geminiRaw(GKEY, content, maxTok, opsi) {
  return panggilAI(GKEY, content, maxTok, opsi);
}

function parseJsonArr(teks) {
  var t = String(teks || '').replace(/```json/gi, '').replace(/```/g, '').trim();
  var i = t.indexOf('[');
  if (i < 0) return [];
  t = t.slice(i);
  try { var a = JSON.parse(t); if (Array.isArray(a)) return a; } catch (e) { }
  // Balasan terpotong: pungut objek yang kurawalnya sudah tertutup
  var out = [], dalam = 0, awal = -1, diTeks = false, lolos = false;
  for (var k = 0; k < t.length; k++) {
    var c = t[k];
    if (lolos) { lolos = false; continue }
    if (c === '\\') { lolos = true; continue }
    if (c === '"') { diTeks = !diTeks; continue }
    if (diTeks) continue;
    if (c === '{') { if (dalam === 0) awal = k; dalam++ }
    else if (c === '}') { dalam--; if (dalam === 0 && awal >= 0) { try { out.push(JSON.parse(t.slice(awal, k + 1))) } catch (e) { } awal = -1 } }
  }
  return out;
}

function wList(wallets) { return wallets.map(function (w) { return w.id + '=' + w.name; }).join(', '); }
function cList(cats) { return cats.filter(function (c) { return !c.parent_id; }).map(function (c) { return c.id + '=' + c.name + '(' + c.type + ')'; }).join(', '); }
// Sub-kategori beserta induknya — tanpa ini AI tak mungkin mengisi sub_category_id
function sList(cats) {
  var subs = cats.filter(function (c) { return !!c.parent_id; });
  if (!subs.length) return '(tidak ada)';
  return subs.map(function (c) { return c.id + '=' + c.name + '[induk:' + c.parent_id + ']'; }).join(', ');
}
/* Daftar kategori untuk gambar memakai NAMA, bukan UUID.
   Sebelumnya tiap entri berbentuk "uuid=Nama[induk:uuid]", sekitar 23 token per
   sub-kategori; dengan puluhan kategori, daftarnya saja menghabiskan lebih dari
   seribu token. Lebih berat lagi, model harus MENYALIN ULANG UUID 36 karakter
   dengan tepat di jawabannya, dan itu memperpanjang waktu berpikir sampai
   permintaannya menabrak batas waktu. Nama jauh lebih pendek, jauh lebih mudah
   bagi model, dan pemetaan balik ke id dikerjakan di sini. */
function namaKatList(cats, tipe) {
  var indukNama = {};
  cats.forEach(function (c) { if (!c.parent_id) indukNama[c.id] = c.name; });
  var out = [];
  cats.forEach(function (c) {
    if (tipe && c.type && c.type !== tipe && !c.parent_id) return;
    if (c.parent_id) { if (indukNama[c.parent_id]) out.push(indukNama[c.parent_id] + ' > ' + c.name); }
    else out.push(c.name);
  });
  return out.length ? out.join(', ') : '(tidak ada)';
}

function rapi(x) { return String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }

// Mengembalikan {category_id, sub_category_id} dari nama yang ditulis AI.
// Sub dicari lebih dulu: "Kopi" lebih spesifik daripada induknya.
function cocokKategori(nama, cats) {
  var hasil = { category_id: null, sub_category_id: null };
  var teks = rapi(nama);
  if (!teks) return hasil;
  // "Induk > Sub" -> ambil bagian sub-nya saja
  var potong = String(nama).split('>');
  var akhir = rapi(potong[potong.length - 1]);
  var cari = akhir || teks;

  var sub = cats.find(function (c) { return c.parent_id && rapi(c.name) === cari; });
  if (sub) {
    hasil.sub_category_id = sub.id;
    hasil.category_id = sub.parent_id;
    return hasil;
  }
  var induk = cats.find(function (c) { return !c.parent_id && rapi(c.name) === cari; });
  if (induk) { hasil.category_id = induk.id; return hasil; }
  return hasil;
}

// Menyusun daftar transaksi jadi teks yang enak dibaca di chat.
function ringkas(rows, wallets, cats) {
  return rows.map(function (r) {
    var c = cats.find(function (x) { return x.id === r.category_id; });
    var sub = cats.find(function (x) { return x.id === r.sub_category_id; });
    var w = wallets.find(function (x) { return x.id === r.wallet_id; });
    var catTxt = c ? (' · ' + c.name + (sub ? ' › ' + sub.name : '')) : '';
    var dateTxt = r.date !== today() ? ('\n   🗓 ' + r.date) : '';
    return (r.type === 'income' ? '📥' : '📤') + ' <b>' + fmtRp(r.amount) + '</b> ' + (r.description || '-') + catTxt + (w ? ' · ' + w.name : '') + dateTxt;
  }).join('\n');
}

/* Menyusun layar konfirmasi. Dipakai saat pertama tampil DAN tiap kali user
   memilih dompet atau kategori, supaya isinya selalu satu sumber.

   Tombol memakai NOMOR URUT dompet/kategori, bukan UUID: callback_data Telegram
   dibatasi 64 byte, sedangkan 'dompet:' + uuid titipan + ':' + uuid dompet sudah
   80 byte. Urutannya dijaga tetap lewat order=name.asc saat mengambil datanya. */
function layarPratinjau(rows, wallets, cats, pendingId, dariMutasi) {
  var total = rows.reduce(function (a, r) { return a + (r.type === 'income' ? Number(r.amount) : -Number(r.amount)); }, 0);
  var tanpaDompet = rows.filter(function (r) { return !r.wallet_id; }).length;
  var tanpaKat = rows.filter(function (r) { return !r.category_id; }).length;

  var teks = '📋 <b>' + rows.length + ' transaksi terbaca' + (dariMutasi ? ' dari mutasi' : ' dari struk') + '</b>' +
    '\n<i>Belum disimpan. Periksa dulu.</i>\n\n' + ringkas(rows, wallets, cats) +
    '\n\nSelisih: <b>' + fmtRp(total) + '</b>';

  if (tanpaDompet) teks += '\n\n⚠️ <b>' + tanpaDompet + ' transaksi belum berdompet.</b> Saldo tak akan berubah untuk yang itu. Pilih dompetnya di bawah.';
  else teks += '\n✅ Dompet sudah dipilih, saldo akan menyesuaikan.';
  if (tanpaKat) teks += '\n' + (tanpaKat === rows.length ? 'Kategori belum diisi' : tanpaKat + ' belum berkategori') + '. Boleh dipilih di bawah, atau atur nanti di app.';

  var tombol = [];
  if (tanpaDompet && wallets.length) {
    tombol.push([{ text: '— Semua transaksi masuk dompet —', callback_data: 'noop' }]);
    var barisW = [];
    wallets.slice(0, 6).forEach(function (w, i) {
      barisW.push({ text: w.name, callback_data: 'dompet:' + pendingId + ':' + i });
      if (barisW.length === 2) { tombol.push(barisW); barisW = []; }
    });
    if (barisW.length) tombol.push(barisW);
  }
  if (tanpaKat) {
    var indukPas = cats.filter(function (c) { return !c.parent_id; });
    if (indukPas.length) {
      tombol.push([{ text: '— Semua ke kategori —', callback_data: 'noop' }]);
      var barisK = [];
      indukPas.slice(0, 6).forEach(function (c, i) {
        barisK.push({ text: c.name, callback_data: 'katsemua:' + pendingId + ':' + i });
        if (barisK.length === 2) { tombol.push(barisK); barisK = []; }
      });
      if (barisK.length) tombol.push(barisK);
    }
  }
  tombol.push([{ text: '✅ Simpan semua', callback_data: 'simpan:' + pendingId },
               { text: '❌ Buang', callback_data: 'buang:' + pendingId }]);
  return { teks: teks, tombol: tombol };
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

  /* Telegram mengirim ULANG update yang sama bila webhook tak menjawab 200 tepat
     waktu. Update yang sudah pernah masuk dibuang di sini, sebelum apa pun
     dikerjakan, supaya pekerjaan berat tidak diulang dan pesan "Membaca..."
     tidak dikirim berkali-kali. Penandanya kunci utama, jadi dua permintaan
     yang datang bersamaan pun hanya satu yang lolos. */
  if (update && update.update_id != null) {
    try {
      var ir = await sb('/rest/v1/telegram_updates', {
        method: 'POST',
        headers: { Prefer: 'resolution=ignore-duplicates,return=representation' },
        body: JSON.stringify({ update_id: update.update_id })
      }, SB_URL, KEY);
      var baru = [];
      try { baru = await ir.json(); } catch (e) { baru = []; }
      // Array kosong berarti barisnya sudah ada: ini kiriman ulang.
      if (ir.ok && Array.isArray(baru) && baru.length === 0) return new Response('ok');
    } catch (e) { /* tabel belum dipasang: jangan halangi bot bekerja */ }
  }
  /* Tombol di dalam pesan datang sebagai callback_query, bukan message.
     Ditangani lebih dulu dan berhenti di sini supaya tidak jatuh ke alur
     pencatatan transaksi yang memakai AI. */
  if (update.callback_query) {
    var cq = update.callback_query;
    var cChat = cq.message && cq.message.chat && cq.message.chat.id;
    var cMsg = cq.message && cq.message.message_id;
    var data = (cq.data || '').split(':');
    if (!cChat) return new Response('ok');
    try {
      var clr = await sb('/rest/v1/telegram_links?chat_id=eq.' + cChat + '&linked=eq.true&select=user_id', {}, SB_URL, KEY);
      var crows = await clr.json();
      if (!Array.isArray(crows) || !crows[0]) { await jawabTombol(TOKEN, cq.id, 'Akun belum terhubung'); return new Response('ok'); }
      var cuid = crows[0].user_id;

      if (data[0] === 'bayar' && data[1]) {
        var hb = await rpc('bayar_cicilan_bot', { p_user: cuid, p_debt: data[1] }, SB_URL, KEY);
        if (hb && hb.ok) {
          await jawabTombol(TOKEN, cq.id, 'Tercatat');
          await reply(TOKEN, cChat, (hb.lunas ? '🎉 <b>Lunas!</b> ' : '✅ <b>Cicilan tercatat.</b> ') + hb.nama + ' — ' + fmtRp(hb.bayar) + (hb.lunas ? '' : '\nSisa: <b>' + fmtRp(hb.sisa) + '</b>'));
        } else {
          await jawabTombol(TOKEN, cq.id, (hb && hb.pesan) || 'Gagal');
        }
        return new Response('ok');
      }

      if (data[0] === 'batal' && data[1]) {
        var hx = await rpc('batal_transaksi_bot', { p_user: cuid, p_txn: data[1] }, SB_URL, KEY);
        if (hx && hx.ok) {
          await jawabTombol(TOKEN, cq.id, 'Dibatalkan');
          if (cMsg) await ubahPesan(TOKEN, cChat, cMsg, '🗑 <b>Dibatalkan.</b> ' + fmtRp(hx.jumlah) + ' ' + (hx.ket || '') + '\nSaldo dompet sudah dikembalikan.');
        } else {
          await jawabTombol(TOKEN, cq.id, (hx && hx.pesan) || 'Gagal');
        }
        return new Response('ok');
      }

      if (data[0] === 'noop') { await jawabTombol(TOKEN, cq.id, ''); return new Response('ok'); }

      /* Memilih dompet atau kategori untuk SELURUH daftar, lalu layarnya digambar
         ulang. Menyetel per baris lewat chat tak masuk akal untuk mutasi berisi
         puluhan transaksi; yang per baris tetap tersedia di aplikasi. */
      if ((data[0] === 'dompet' || data[0] === 'katsemua') && data[1] && data[2] != null) {
        var pr3 = await sb('/rest/v1/telegram_pending?id=eq.' + encodeURIComponent(data[1]) + '&user_id=eq.' + cuid + '&select=baris', {}, SB_URL, KEY);
        var pj3 = [];
        try { pj3 = await pr3.json(); } catch (e) { }
        var isiTitipan = (Array.isArray(pj3) && pj3[0] && Array.isArray(pj3[0].baris)) ? pj3[0].baris : null;
        if (!isiTitipan) { await jawabTombol(TOKEN, cq.id, 'Daftarnya sudah tidak ada'); return new Response('ok'); }

        var wr3 = await sb('/rest/v1/wallets?user_id=eq.' + cuid + '&select=id,name,balance&order=name.asc', {}, SB_URL, KEY);
        var wall3 = await wr3.json(); if (!Array.isArray(wall3)) wall3 = [];
        var cr3 = await sb('/rest/v1/categories?user_id=eq.' + cuid + '&select=id,name,type,parent_id&order=name.asc', {}, SB_URL, KEY);
        var cats3 = await cr3.json(); if (!Array.isArray(cats3)) cats3 = [];

        var idx = parseInt(data[2], 10);
        var namaPilihan = '';
        if (data[0] === 'dompet') {
          var wp = wall3[idx];
          if (!wp) { await jawabTombol(TOKEN, cq.id, 'Dompet tak dikenal'); return new Response('ok'); }
          isiTitipan.forEach(function (r) { r.wallet_id = wp.id; });
          namaPilihan = wp.name;
        } else {
          var indukList = cats3.filter(function (c) { return !c.parent_id; });
          var cp = indukList[idx];
          if (!cp) { await jawabTombol(TOKEN, cq.id, 'Kategori tak dikenal'); return new Response('ok'); }
          // Hanya yang belum berkategori yang diisi; hasil baca AI jangan ditimpa
          isiTitipan.forEach(function (r) { if (!r.category_id) { r.category_id = cp.id; r.sub_category_id = null; } });
          namaPilihan = cp.name;
        }

        await sb('/rest/v1/telegram_pending?id=eq.' + encodeURIComponent(data[1]), {
          method: 'PATCH', body: JSON.stringify({ baris: isiTitipan })
        }, SB_URL, KEY);

        var layar3 = layarPratinjau(isiTitipan, wall3, cats3, data[1], isiTitipan.length > 1);
        await jawabTombol(TOKEN, cq.id, namaPilihan);
        if (cMsg) await ubahPesan(TOKEN, cChat, cMsg, layar3.teks, layar3.tombol);
        return new Response('ok');
      }

      if (data[0] === 'simpan' && data[1]) {
        var hs = await rpc('simpan_batch_bot', { p_user: cuid, p_pending: data[1] }, SB_URL, KEY);
        if (hs && hs.ok) {
          await jawabTombol(TOKEN, cq.id, hs.jumlah + ' transaksi disimpan');
          var idsBaru = (hs.ids || []).join(',').slice(0, 40);
          if (cMsg) await ubahPesan(TOKEN, cChat, cMsg, '✅ <b>' + hs.jumlah + ' transaksi tersimpan.</b>\n\nSalah? Ketuk Batalkan semua di bawah.');
          // Id transaksi tak muat di callback_data (64 byte), jadi pembatalan
          // borongan memakai id titipannya yang sudah dicatat di riwayat.
          if ((hs.ids || []).length) {
            await sb('/rest/v1/telegram_pending', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ user_id: cuid, chat_id: cChat, baris: hs.ids }) }, SB_URL, KEY)
              .then(function (rr) { return rr.json(); })
              .then(function (rw) {
                if (Array.isArray(rw) && rw[0] && rw[0].id) {
                  return reply(TOKEN, cChat, '↩️ Bisa dibatalkan kalau ada yang keliru.', [[{ text: '↩️ Batalkan semua', callback_data: 'urungkan:' + rw[0].id }]]);
                }
              }).catch(function () { });
          }
        } else {
          await jawabTombol(TOKEN, cq.id, (hs && hs.pesan) || 'Gagal menyimpan');
        }
        return new Response('ok');
      }

      if (data[0] === 'buang' && data[1]) {
        await sb('/rest/v1/telegram_pending?id=eq.' + encodeURIComponent(data[1]) + '&user_id=eq.' + cuid, { method: 'DELETE' }, SB_URL, KEY);
        await jawabTombol(TOKEN, cq.id, 'Dibuang');
        if (cMsg) await ubahPesan(TOKEN, cChat, cMsg, '🗑 <b>Dibuang.</b> Tidak ada yang disimpan.');
        return new Response('ok');
      }

      if (data[0] === 'urungkan' && data[1]) {
        var pr2 = await sb('/rest/v1/telegram_pending?id=eq.' + encodeURIComponent(data[1]) + '&user_id=eq.' + cuid + '&select=baris', {}, SB_URL, KEY);
        var pj2 = [];
        try { pj2 = await pr2.json(); } catch (e) { }
        var daftarId = (Array.isArray(pj2) && pj2[0] && Array.isArray(pj2[0].baris)) ? pj2[0].baris : [];
        if (!daftarId.length) { await jawabTombol(TOKEN, cq.id, 'Sudah tak bisa dibatalkan'); return new Response('ok'); }
        var hu = await rpc('batalkan_transaksi_batch', { p_user: cuid, p_ids: daftarId }, SB_URL, KEY);
        await sb('/rest/v1/telegram_pending?id=eq.' + encodeURIComponent(data[1]), { method: 'DELETE' }, SB_URL, KEY);
        if (hu && hu.ok) {
          await jawabTombol(TOKEN, cq.id, hu.jumlah + ' dibatalkan');
          if (cMsg) await ubahPesan(TOKEN, cChat, cMsg, '↩️ <b>' + hu.jumlah + ' transaksi dibatalkan.</b>\nSaldo dompet sudah dikembalikan.');
        } else {
          await jawabTombol(TOKEN, cq.id, 'Gagal membatalkan');
        }
        return new Response('ok');
      }

      if (data[0] === 'kat' && data[1] && data[2]) {
        var hk = await rpc('set_kategori_bot', { p_user: cuid, p_txn: data[1], p_cat: data[2] }, SB_URL, KEY);
        if (hk && hk.ok) await jawabTombol(TOKEN, cq.id, 'Kategori → ' + hk.nama);
        else await jawabTombol(TOKEN, cq.id, (hk && hk.pesan) || 'Gagal');
        return new Response('ok');
      }

      if (data[0] === 'notif' && data[1]) {
        var kolom = { tagihan: 'notif_tagihan', harian: 'notif_harian', mingguan: 'notif_mingguan' }[data[1]];
        if (kolom) {
          var cur = await sb('/rest/v1/telegram_links?user_id=eq.' + cuid + '&select=' + kolom, {}, SB_URL, KEY);
          var curRows = await cur.json();
          var nilaiBaru = !(Array.isArray(curRows) && curRows[0] && curRows[0][kolom]);
          var patch = {}; patch[kolom] = nilaiBaru;
          await sb('/rest/v1/telegram_links?user_id=eq.' + cuid, { method: 'PATCH', body: JSON.stringify(patch) }, SB_URL, KEY);
          await jawabTombol(TOKEN, cq.id, (nilaiBaru ? 'Dinyalakan' : 'Dimatikan'));
          if (cMsg) await ubahPesan(TOKEN, cChat, cMsg, '🔔 Pengaturan disimpan. Ketik /notif untuk melihat lagi.');
        }
        return new Response('ok');
      }

      await jawabTombol(TOKEN, cq.id, '');
    } catch (e) { try { await jawabTombol(TOKEN, cq.id, 'Ada kesalahan'); } catch (e2) { } }
    return new Response('ok');
  }

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
        await reply(TOKEN, chatId, '✅ <b>Akun WealthFlow terhubung!</b>\n\nCatat transaksi langsung dari sini. Contoh:\n• <i>beli kopi 25rb pakai gopay</i>\n• <i>terima gaji 5jt</i>\n\nAtau kirim <b>foto struk</b> 📷\n\nCoba juga /saldo, /sisa, dan /notif. Ketik /bantuan untuk daftar lengkapnya.');
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

    /* Perintah cepat. Semua dijawab dari basis data langsung, TANPA memanggil AI,
       jadi tidak memakan jatah bulanan pengguna. */
    if (/^\/saldo\b/i.test(text)) {
      var swr = await sb('/rest/v1/wallets?user_id=eq.' + uid + '&select=name,balance&order=balance.desc', {}, SB_URL, KEY);
      var sw = await swr.json(); if (!Array.isArray(sw)) sw = [];
      if (!sw.length) { await reply(TOKEN, chatId, 'Belum ada dompet. Tambahkan dulu di app.'); return new Response('ok'); }
      var tot = sw.reduce(function (a, w) { return a + (Number(w.balance) || 0); }, 0);
      await reply(TOKEN, chatId, '💳 <b>Saldo dompet</b>\n\n' +
        sw.map(function (w) { return '• ' + w.name + ' — <b>' + fmtRp(w.balance) + '</b>'; }).join('\n') +
        '\n\nTotal: <b>' + fmtRp(tot) + '</b>');
      return new Response('ok');
    }

    if (/^\/sisa\b/i.test(text)) {
      var bln = today().slice(0, 7);
      var br = await sb('/rest/v1/budgets?user_id=eq.' + uid + '&select=amount,category_id,is_recurring,month,year', {}, SB_URL, KEY);
      var bud = await br.json(); if (!Array.isArray(bud)) bud = [];
      var kini = new Date(); var blnKini = kini.getMonth() + 1, thnKini = kini.getFullYear();
      var pagu = bud.filter(function (b) {
        if (b.is_recurring === true || b.is_recurring === null || b.is_recurring === undefined) return true;
        return Number(b.month) === blnKini && Number(b.year) === thnKini;
      }).reduce(function (a, b) { return a + (Number(b.amount) || 0); }, 0);
      if (pagu <= 0) { await reply(TOKEN, chatId, 'Belum ada anggaran bulan ini. Atur dulu di app supaya bisa dihitung sisanya.'); return new Response('ok'); }
      var xr = await sb('/rest/v1/transactions?user_id=eq.' + uid + '&type=eq.expense&date=gte.' + bln + '-01&select=amount', {}, SB_URL, KEY);
      var xs = await xr.json(); if (!Array.isArray(xs)) xs = [];
      var pakai = xs.reduce(function (a, x) { return a + (Number(x.amount) || 0); }, 0);
      var sisaAnggaran = pagu - pakai;
      var akhirBln = new Date(thnKini, blnKini, 0).getDate();
      var sisaHari = Math.max(akhirBln - kini.getDate() + 1, 1);
      await reply(TOKEN, chatId, '🎯 <b>Sisa anggaran</b>\n\n' +
        'Pagu: ' + fmtRp(pagu) + '\nTerpakai: ' + fmtRp(pakai) + '\n' +
        'Sisa: <b>' + fmtRp(sisaAnggaran) + '</b>\n\n' +
        (sisaAnggaran > 0
          ? 'Jatah ' + sisaHari + ' hari tersisa: <b>' + fmtRp(sisaAnggaran / sisaHari) + '</b>/hari'
          : '⚠️ Anggaran bulan ini sudah lewat batas.'));
      return new Response('ok');
    }

    if (/^\/notif\b/i.test(text)) {
      var nr = await sb('/rest/v1/telegram_links?user_id=eq.' + uid + '&select=notif_tagihan,notif_harian,notif_mingguan', {}, SB_URL, KEY);
      var nrows = await nr.json();
      var pref = (Array.isArray(nrows) && nrows[0]) ? nrows[0] : { notif_tagihan: true, notif_harian: true, notif_mingguan: true };
      var tik = function (v) { return v ? '🔔 nyala' : '🔕 mati'; };
      await reply(TOKEN, chatId,
        '⚙️ <b>Pengaturan notifikasi</b>\n\nKetuk untuk menyalakan atau mematikan.',
        [
          [{ text: 'Tagihan mendekat · ' + tik(pref.notif_tagihan), callback_data: 'notif:tagihan' }],
          [{ text: 'Rekap malam · ' + tik(pref.notif_harian), callback_data: 'notif:harian' }],
          [{ text: 'Laporan Senin · ' + tik(pref.notif_mingguan), callback_data: 'notif:mingguan' }]
        ]);
      return new Response('ok');
    }

    /* Menguji AI dengan gambar 1 piksel. Kalau ini pun lambat, masalahnya ada di
       layanan AI-nya (mis. kunci masih tier gratis yang diantre), bukan di ukuran
       gambar atau prompt. Tanpa alat ini kita cuma bisa menebak. */
    /* Membandingkan beberapa konfigurasi dengan gambar 1 piksel. Semua tebakan
       soal ukuran gambar sudah gugur (65KB pun kena batas waktu), jadi yang perlu
       dibuktikan sekarang: model mana dan tingkat berpikir mana yang cepat.
       Batas per percobaan 6 detik supaya ketiganya muat dalam satu permintaan. */
    /* Menanyakan langsung ke Google model apa yang tersedia untuk kunci ini.
       Selama ini nama model dipilih dari ingatan dan alias -latest bisa menunjuk
       ke model yang sedang dipensiunkan; menebak-nebak namanya tak ada gunanya
       kalau daftar sebenarnya bisa ditanyakan. */
    if (/^\/model\b/i.test(text)) {
      try {
        var mr = await fetchTO('https://generativelanguage.googleapis.com/v1beta/models?key=' + GKEY + '&pageSize=200', {}, 12000);
        var mj = await mr.json();
        if (!mr.ok || !mj || !Array.isArray(mj.models)) {
          await reply(TOKEN, chatId, '❌ Gagal mengambil daftar model (HTTP ' + mr.status + ').\n\n<code>' + JSON.stringify(mj || {}).slice(0, 200).replace(/[<>&]/g, '') + '</code>');
          return new Response('ok');
        }
        var bisaChat = mj.models.filter(function (mm) {
          return (mm.supportedGenerationMethods || []).indexOf('generateContent') >= 0;
        }).map(function (mm) { return String(mm.name || '').replace('models/', ''); });
        // Yang relevan buat kita: keluarga flash, itu yang dipakai membaca gambar
        var flash = bisaChat.filter(function (x) { return x.indexOf('flash') >= 0; });
        var adaUtama = bisaChat.indexOf(MODEL_GAMBAR) >= 0;
        var adaCadangan = bisaChat.indexOf(MODEL_CADANGAN) >= 0;
        await reply(TOKEN, chatId,
          '🧭 <b>Model tersedia di kunci ini</b>\n\n' +
          'Dipakai sekarang: <code>' + MODEL_GAMBAR + '</code> ' + (adaUtama ? '✅ ada' : '❌ TIDAK ADA') + '\n' +
          'Cadangan: <code>' + MODEL_CADANGAN + '</code> ' + (adaCadangan ? '✅ ada' : '❌ TIDAK ADA') + '\n\n' +
          '<b>Keluarga flash (' + flash.length + '):</b>\n' + (flash.slice(0, 25).join('\n') || '(tidak ada)') +
          '\n\nTotal model chat: ' + bisaChat.length +
          '\n\n<i>Kalau yang dipakai bertanda TIDAK ADA, itu sebab kegagalannya. Setel env GEMINI_IMAGE_MODEL di Vercel ke salah satu nama di atas.</i>');
      } catch (eM) {
        await reply(TOKEN, chatId, '❌ Gagal menghubungi Google: <code>' + String(eM && eM.message || eM).slice(0, 150).replace(/[<>&]/g, '') + '</code>');
      }
      return new Response('ok');
    }

    if (/^\/diag\b/i.test(text)) {
      var px = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
      var isi = [{ type: 'text', text: 'Balas satu kata: OK' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,' + px } }];
      var uji = [
        { nama: 'flash + pikir low', o: { model: 'gemini-flash-latest', pikir: 'low', batas: 6000, tanpaCadangan: true } },
        { nama: 'lite + pikir low', o: { model: 'gemini-flash-lite-latest', pikir: 'low', batas: 6000, tanpaCadangan: true } },
        { nama: 'lite tanpa pikir', o: { model: 'gemini-flash-lite-latest', tanpaPikir: true, batas: 6000, tanpaCadangan: true } }
      ];
      var barisUji = [];
      for (var ui = 0; ui < uji.length; ui++) {
        var t0 = Date.now(), tanda = '';
        try {
          var jw = await geminiRaw(GKEY, isi, 32, uji[ui].o);
          tanda = jw ? '✅' : '⚠️ kosong';
        } catch (eD) {
          tanda = /abort/i.test(String(eD && eD.message || eD)) ? '⏱️ >6s' : '❌ galat';
        }
        barisUji.push(uji[ui].nama + ': <b>' + (Date.now() - t0) + 'ms</b> ' + tanda);
      }
      await reply(TOKEN, chatId, '🩺 <b>Uji kecepatan AI</b>\nGambar uji 1 piksel (70 byte)\n\n' + barisUji.join('\n') +
        '\n\nDipakai sekarang: <code>' + MODEL_GAMBAR + '</code>' +
        '\n\n<i>Kalau ketiganya lambat, yang bermasalah layanan AI-nya, bukan gambar atau prompt.</i>');
      return new Response('ok');
    }


    if (/^\/(bantuan|perintah)\b/i.test(text)) {
      await reply(TOKEN, chatId, '📖 <b>Yang bisa dilakukan</b>\n\n' +
        '<b>Mencatat</b>\n• Ketik langsung: <i>beli kopi 25rb pakai gopay</i>\n• Kirim foto struk 📷\n\n' +
        '<b>Perintah cepat</b> (tak memakai jatah AI)\n' +
        '/saldo — saldo semua dompet\n' +
        '/sisa — sisa anggaran &amp; jatah harian\n' +
        '/notif — atur notifikasi\n' +
        '/model — model AI yang tersedia\n' +
        '/diag — uji kecepatan AI\n' +
        '/bantuan — pesan ini');
      return new Response('ok');
    }

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
    // order dijaga tetap: nomor urut pada tombol harus menunjuk barang yang sama
    var wr = await sb('/rest/v1/wallets?user_id=eq.' + uid + '&select=id,name,balance&order=name.asc', {}, SB_URL, KEY);
    var wallets = await wr.json(); if (!Array.isArray(wallets)) wallets = [];
    var cr = await sb('/rest/v1/categories?user_id=eq.' + uid + '&select=id,name,type,parent_id&order=name.asc', {}, SB_URL, KEY);
    var cats = await cr.json(); if (!Array.isArray(cats)) cats = [];

    // 4) Ekstrak transaksi (foto struk atau teks)
    var txList = [];
    var jam = null;
    /* Gambar bisa datang sebagai photo (terkompresi) atau document (dikirim
       sebagai berkas, kualitas asli). Dulu hanya photo yang diterima, sehingga
       mutasi yang dikirim sebagai berkas tak pernah terbaca. */
    var docFile = null;
    if (msg.document) {
      var mime = (msg.document.mime_type || '').toLowerCase();
      if (mime.indexOf('image/') === 0) docFile = msg.document.file_id;
      else {
        await reply(TOKEN, chatId, '📎 Berkas <b>' + (mime || 'ini') + '</b> belum bisa dibaca.\n\nKirim sebagai <b>gambar</b> ya (screenshot mutasi atau foto struk). PDF belum didukung di chat; unggah lewat app.');
        return new Response('ok');
      }
    }

    /* Jenis gambar ditentukan AI, bukan ditebak dari keterangan yang diketik.
       Versi sebelumnya mensyaratkan pengguna menulis kata "mutasi" di caption;
       yang tidak tahu itu selalu mendapat balasan "membaca struk" walau yang
       dikirim mutasi. Pesan tunggunya kini netral sampai jenisnya diketahui. */
    var modeMutasi = false;

    if (msg.photo && msg.photo.length || docFile) {
      await reply(TOKEN, chatId, '🔍 Membaca gambar...');
      // Diukur supaya kalau lambat, kita tahu tahap MANA yang lambat.
      jam = { mulai: Date.now(), unduh: 0, siap: 0, ai: 0, kb: 0 };
      /* Telegram menyediakan beberapa ukuran. Yang terbesar memperbesar unggahan
         ke AI tanpa menambah ketepatan baca, dan waktunya terpakai percuma.
         Diambil ukuran terbesar yang masih di bawah 1600px. */
      var pilihFoto = null;
      if (!docFile && msg.photo && msg.photo.length) {
        var urut = msg.photo.slice().sort(function (a, b) { return (a.width || 0) - (b.width || 0); });
        for (var pi = 0; pi < urut.length; pi++) {
          if ((urut[pi].width || 0) <= 1600) pilihFoto = urut[pi];
        }
        if (!pilihFoto) pilihFoto = urut[0];
      }
      var fileId = docFile || (pilihFoto && pilihFoto.file_id) || msg.photo[msg.photo.length - 1].file_id;
      var gf = await tgCall(TOKEN, 'getFile', { file_id: fileId });
      var gfj = await gf.json();
      var filePath = gfj.result && gfj.result.file_path;
      if (filePath) {
        var tUnduh = Date.now();
        var img = await fetchTO('https://api.telegram.org/file/bot' + TOKEN + '/' + filePath, {}, 15000);
        var bufGambar = await img.arrayBuffer();
        jam.unduh = Date.now() - tUnduh;
        jam.kb = Math.round(bufGambar.byteLength / 1024);
        var tSiap = Date.now();
        var b64 = b64FromBuffer(bufGambar);
        jam.siap = Date.now() - tSiap;
        /* Satu format untuk kedua jenis gambar. Struk menghasilkan satu baris,
           mutasi menghasilkan banyak. Percabangan dua-format kemarin membuat model
           harus memutuskan bentuk jawaban lebih dulu, dan itu menambah waktu
           berpikir tepat pada bagian yang sudah mepet batas waktu. */
        var gprompt = 'Baca gambar ini. Bisa struk belanja (tulis SATU baris berisi totalnya) atau mutasi rekening/e-wallet (tulis SEMUA transaksinya).\n\n' +
          'Satu transaksi per baris, format persis:\ntipe|nominal|keterangan|tanggal|kategori\n\n' +
          'tipe: M kalau uang masuk, K kalau uang keluar.\n' +
          'nominal: angka saja, tanpa titik/koma/Rp.\n' +
          'keterangan: singkat, maksimal 4 kata.\n' +
          'tanggal: YYYY-MM-DD. Kalau tak terlihat pakai ' + today() + '.\n' +
          'kategori: pilih SATU nama dari daftar di bawah, salin persis. Kalau tak ada yang cocok, kosongkan.\n\n' +
          'Lewati baris saldo dan total. Jangan tulis header, nomor urut, atau penjelasan apa pun.\n' +
          'Kalau tak ada transaksi, balas: KOSONG\n\n' +
          'Kategori: ' + namaKatList(cats);

        var tAI = Date.now();
        var mentah = await geminiRaw(GKEY, [{ type: 'text', text: gprompt }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + b64 } }], 2048);
        jam.ai = Date.now() - tAI;
        txList = parseBaris(mentah);
        // Sesekali model tetap menjawab JSON walau diminta baris
        if (!txList.length) txList = parseJsonArr(mentah);
        // Lebih dari satu baris berarti ini daftar mutasi, bukan struk
        modeMutasi = txList.length > 1;
        // Nama kategori dari AI dipetakan ke id di sini
        txList.forEach(function (tx) {
          if (!tx._kat) return;
          var cc = cocokKategori(tx._kat, cats);
          if (cc.category_id) { tx.category_id = cc.category_id; tx.sub_category_id = cc.sub_category_id; }
          delete tx._kat;
        });


      }
    } else if (text) {
      var tprompt = 'Kamu parser transaksi keuangan Bahasa Indonesia. Ekstrak dari pesan user jadi JSON array. Balas HANYA JSON valid: [{"type":"expense"|"income","amount":number,"description":"singkat","date":"YYYY-MM-DD","category_id":"id atau null","sub_category_id":"id atau null","wallet_id":"id atau null"}].\nATURAN:\n1) uang keluar/beli/bayar = expense; uang masuk/terima/gaji = income.\n2) Cocokkan dompet dari nama yang disebut user.\n3) PENTING: pilih kategori SESPESIFIK mungkin: kalau barang/jasa yang disebut user cocok dengan salah satu SUB-KATEGORI, WAJIB isi sub_category_id dengan sub itu, dan category_id dengan induknya. Contoh: user tulis "kopi" dan ada sub-kategori "Kopi" -> sub_category_id = id sub "Kopi", category_id = id induknya. Jangan biarkan sub_category_id null kalau ada sub yang cocok.\n4) sub_category_id HARUS anak dari category_id yang dipilih (lihat penanda [induk:...]).\n5) description = keterangan tambahan/detail (mis. nama tempat atau merek). Kalau tidak ada detail lain, boleh diisi nama barangnya.\n6) Tanggal default ' + today() + '. Jika bukan transaksi, balas [].\nDompet: ' + wList(wallets) + '\nKategori: ' + cList(cats) + '\nSub-Kategori: ' + sList(cats) + '\n\nPesan: "' + text + '"';
      txList = await geminiExtract(GKEY, [{ type: 'text', text: tprompt }]);
    } else {
      await reply(TOKEN, chatId, 'Kirim teks transaksi atau foto struk ya 🙂\nContoh: <i>bayar parkir 5rb cash</i>');
      return new Response('ok');
    }

    /* Mutasi berasal dari SATU rekening. Kalau nama dompet disebut di keterangan
       gambar (mis. "mutasi bank jago"), dompet itu dipakai untuk semua barisnya.
       Tanpa ini seluruh transaksi masuk tanpa dompet dan saldo tak ikut berubah. */
    if (modeMutasi && txList.length) {
      var sebut = (text || '').toLowerCase();
      var wCocok = wallets.find(function (w) { return w.name && sebut.indexOf(w.name.toLowerCase()) >= 0; });
      if (wCocok) txList.forEach(function (tx) { tx.wallet_id = wCocok.id; });
    }

    // 5) Bersihkan & simpan
    var rows = txList.map(function (tx) {
      var cc = fixCat(tx, cats);
      // Dompet & tanggal WAJIB divalidasi: id/format ngawur dari AI bikin seluruh insert ditolak Postgres
      var wid = tx.wallet_id && wallets.some(function (w) { return w.id === tx.wallet_id; }) ? tx.wallet_id : null;
      return { user_id: uid, type: tx.type === 'income' ? 'income' : 'expense', amount: Number(tx.amount) || 0, description: (tx.description || '').toString().slice(0, 120), date: safeDate(tx.date), wallet_id: wid, category_id: cc.category_id, sub_category_id: cc.sub_category_id };
    }).filter(function (r) { return r.amount > 0; });

    if (!rows.length) {
      await reply(TOKEN, chatId, '⚠️ Tidak terdeteksi transaksi dari pesan itu.\n\nCoba sebut nominalnya jelas, mis: <i>beli makan 30rb pakai cash</i>. Kalau tulisanmu sudah jelas dan ini terus terjadi, ketik /diag untuk memeriksa layanan AI-nya.');
      return new Response('ok');
    }

    /* Gambar TIDAK langsung masuk catatan. Hasil bacanya dititipkan dulu, lalu
       user menyetujui lewat tombol. Sebelumnya bot menyimpan sendiri tanpa bertanya,
       dan kalau bacaannya keliru, membereskannya berarti menghapus satu per satu
       sambil membetulkan saldo. Pesan teks biasa tetap langsung disimpan: isinya
       ditulis sendiri oleh user, jadi tak ada yang perlu dikonfirmasi. */
    var dariGambar = !!(msg.photo && msg.photo.length || docFile);

    if (dariGambar) {
      var pr = await sb('/rest/v1/telegram_pending', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ user_id: uid, chat_id: chatId, baris: rows })
      }, SB_URL, KEY);
      var pRows = [];
      try { pRows = await pr.json(); } catch (e) { }
      if (!pr.ok || !Array.isArray(pRows) || !pRows[0] || !pRows[0].id) {
        // Sebutkan alasan aslinya. Paling sering: tabel telegram_pending belum
        // dipasang, dan itu mustahil ditebak dari pesan yang serba umum.
        var alasan = '';
        try { alasan = JSON.stringify(pRows).slice(0, 200); } catch (e5) { }
        var kurangTabel = /telegram_pending|does not exist|schema cache/i.test(alasan);
        await reply(TOKEN, chatId, kurangTabel
          ? '⚙️ <b>Fitur konfirmasi belum siap di server.</b>\n\nJalankan <code>supabase-telegram-konfirmasi-setup.sql</code> di Supabase, lalu coba lagi.'
          : '❌ Gagal menyiapkan daftar.\n\n<code>' + alasan.replace(/[<>&]/g, '') + '</code>');
        return new Response('ok');
      }
      await sb('/rest/v1/rpc/increment_ai_usage', { method: 'POST', body: JSON.stringify({ p_user: uid, p_period: period }) }, SB_URL, KEY);

      var layar = layarPratinjau(rows, wallets, cats, pRows[0].id, modeMutasi);
      await reply(TOKEN, chatId, layar.teks, layar.tombol);
      return new Response('ok');
    }

    // Jangan pernah bilang "tercatat" tanpa memastikan benar-benar tersimpan
    var insRes = await sb('/rest/v1/transactions', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(rows) }, SB_URL, KEY);
    if (!insRes.ok) {
      var errTxt = '';
      try { errTxt = (await insRes.text() || '').slice(0, 300); } catch (e) { }
      await reply(TOKEN, chatId, '❌ <b>Gagal menyimpan.</b> Transaksi TIDAK tercatat.\n\n<code>' + errTxt.replace(/[<>&]/g, '') + '</code>\n\nCoba lagi, atau catat manual di app.');
      return new Response('ok');
    }
    var tersimpan = [];
    try { tersimpan = await insRes.json(); } catch (e) { }
    if (!Array.isArray(tersimpan)) tersimpan = [];

    await sb('/rest/v1/rpc/increment_ai_usage', { method: 'POST', body: JSON.stringify({ p_user: uid, p_period: period }) }, SB_URL, KEY);

    var deltas = {}; var balFailed = false;
    rows.forEach(function (r) { if (r.wallet_id) deltas[r.wallet_id] = (deltas[r.wallet_id] || 0) + (r.type === 'income' ? r.amount : -r.amount); });
    for (var wid in deltas) {
      var w = wallets.find(function (x) { return x.id === wid; });
      if (w) {
        var balRes = await sb('/rest/v1/wallets?id=eq.' + wid, { method: 'PATCH', body: JSON.stringify({ balance: (Number(w.balance) || 0) + deltas[wid] }) }, SB_URL, KEY);
        if (!balRes.ok) balFailed = true;
      }
    }

    var summary = ringkas(rows, wallets, cats);
    var tombolAksi = null;
    if (tersimpan.length === 1 && tersimpan[0] && tersimpan[0].id) {
      var txId = tersimpan[0].id;
      var jenis = rows[0].type === 'income' ? 'income' : 'expense';
      var pilihanKat = cats.filter(function (c) { return !c.parent_id && c.type === jenis && c.id !== rows[0].category_id; }).slice(0, 3);
      tombolAksi = [[{ text: '↩️ Batalkan', callback_data: 'batal:' + txId }]];
      if (pilihanKat.length) {
        tombolAksi.push(pilihanKat.map(function (c) { return { text: '→ ' + c.name, callback_data: 'kat:' + txId + ':' + c.id }; }));
      }
    }
    await reply(TOKEN, chatId, '✅ <b>Tercatat!</b>\n' + summary + (balFailed ? '\n\n⚠️ Transaksi tersimpan, tapi saldo dompet gagal diperbarui. Cek dan sesuaikan manual di app.' : '') + (tombolAksi ? '\n\n<i>Salah kategori? Ketuk salah satu di bawah.</i>' : ''), tombolAksi);

  } catch (e) {
    // Batas waktu perlu disebut apa adanya, supaya user tahu memotong mutasinya
    // dan tidak mengira botnya rusak lalu mengirim ulang berkali-kali.
    var rinci = '';
    try {
      if (typeof jam !== 'undefined' && jam && jam.mulai) {
        rinci = '\n\n<code>gambar ' + jam.kb + 'KB · unduh ' + jam.unduh + 'ms · siapkan ' + jam.siap +
          'ms · AI ' + (jam.ai || ('>' + (Date.now() - jam.mulai - jam.unduh - jam.siap))) + 'ms</code>';
      }
    } catch (e3) { }
    // Galat dari penyedia AI punya sebab yang jelas; jangan disamarkan jadi
    // 'ada kesalahan' yang tak bisa ditindaklanjuti siapa pun.
    if (e && e.dariAI) {
      try {
        var pesan = pesanGalatAI(e);
        if (e.jejak && e.jejak.length) {
          pesan += '\n\n<b>Yang dicoba:</b>\n<code>' + e.jejak.join('\n').replace(/[<>&]/g, '') + '</code>';
        }
        // Semua kandidat tumbang: periksa kuncinya sekalian, jangan biarkan user menebak
        if (e.jejak && e.jejak.length >= 2) {
          var pk = await periksaKunci(GKEY);
          if (!pk.ok) {
            pesan += '\n\n🔑 <b>Kuncinya sendiri ditolak Google:</b>\n<code>' + String(pk.pesan).slice(0, 140).replace(/[<>&]/g, '') + '</code>\n\nBerarti masalahnya di GEMINI_API_KEY, bukan kapasitas.';
          } else {
            var adaSemua = e.jejak.every(function (b) { return pk.model.indexOf(String(b).split(':')[0]) >= 0; });
            pesan += '\n\n✅ Kunci sah, ' + pk.model.length + ' model tersedia.' +
              (adaSemua
                ? ' Semua model di atas memang ada, jadi penolakannya benar-benar soal kapasitas Google.'
                : ' Tapi sebagian nama di atas TIDAK ada di daftarnya.') +
              '\n\n<b>Yang tersedia:</b>\n<code>' + pk.model.filter(function (x) { return x.indexOf('flash') >= 0 || x.indexOf('pro') >= 0; }).slice(0, 12).join('\n').replace(/[<>&]/g, '') + '</code>';
          }
        }
        await reply(TOKEN, chatId, pesan);
      } catch (e4) { }
      return new Response('ok');
    }
    // Pesan batas waktu dulu selalu berbunyi "membaca gambarnya", padahal pesan
    // teks biasa juga bisa kena. Menyuruh memotong screenshot untuk seseorang yang
    // cuma mengetik "beli kopi 21rb" jelas membingungkan.
    var adaGambar = !!(msg && (msg.photo || msg.document));
    var pesanGagal = /abort|timeout|timed out/i.test(String(e && e.message || e))
      ? (adaGambar
          ? '⏱️ Kelamaan membaca gambarnya. Kalau ini mutasi panjang, potong jadi beberapa screenshot lalu kirim lagi.'
          : '⏱️ AI kelamaan menjawab. Layanannya sedang lambat, bukan tulisanmu yang salah. Coba kirim lagi sebentar.') + rinci
      : '❌ Ada kesalahan memproses. Coba lagi sebentar.' + rinci;
    try { await reply(TOKEN, chatId, pesanGagal); } catch (e2) { }
  }
  return new Response('ok');
}
