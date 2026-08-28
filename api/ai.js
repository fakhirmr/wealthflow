// WealthFlow AI Proxy — Vercel Edge Function (Google Gemini)
// Menyembunyikan GEMINI_API_KEY di server, verifikasi login Supabase,
// dan menegakkan kuota pemakaian per-customer.
//
// Environment variables yang WAJIB diset di Vercel (Project Settings → Environment Variables):
//   GEMINI_API_KEY              → API key Gemini Anda dari aistudio.google.com (RAHASIA)
//   SUPABASE_URL                → https://wkhjxgrjkrakfhwckriu.supabase.co
//   SUPABASE_ANON_KEY           → anon key (boleh publik)
//   SUPABASE_SERVICE_ROLE_KEY   → service_role key (SANGAT RAHASIA — jangan pernah taruh di frontend)
//   AI_FREE_LIMIT               → (opsional) jatah pesan/bulan tier gratis, default 30
//   AI_PREMIUM_LIMIT             → (opsional) jatah pesan/bulan tier premium (fair-use, bukan unlimited penuh), default 500

export const config = { runtime: 'edge' };

// Model yang boleh dipanggil (mencegah customer meminta model mahal).
var ALLOWED_CHAT_MODELS = ['gemini-flash-latest', 'gemini-flash-lite-latest']; // alias rolling — selalu ke model terbaru; flash juga menangani vision
var AUDIO_MODEL = 'gemini-flash-latest';
var MAX_TOKENS_CAP = 8192; // ruang ekstra: Gemini Flash pakai token untuk "thinking"
var GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

function b64FromBuffer(buf) {
  var bytes = new Uint8Array(buf); var bin = '';
  for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

// fetch dengan batas waktu — cegah function dibunuh Vercel (timeout mentah)
async function fetchTO(url, opts, ms) {
  var ctrl = new AbortController();
  var id = setTimeout(function () { ctrl.abort(); }, ms || 24000);
  try { return await fetch(url, Object.assign({}, opts, { signal: ctrl.signal })); }
  finally { clearTimeout(id); }
}

function tidur(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

/* HTTP 5xx dari Google berarti servernya sedang penuh, bukan permintaan kita yang
   salah. Sebelumnya proxy menyerah di percobaan pertama dan meneruskan balasan
   503 apa adanya ke peramban, yang lalu menampilkannya sebagai "Respons AI kosong
   atau terpotong" — pesan yang menyesatkan sebab responsnya tidak kosong,
   melainkan tak pernah ada.

   Dua percobaan, yang kedua memakai model lain sebab yang penuh biasanya satu
   model tertentu. Batas per percobaan 10 detik supaya keduanya plus jeda tetap
   muat di bawah batas Vercel; satu percobaan 24 detik tak menyisakan ruang.
   Galat yang bukan sementara (kunci, kuota) tidak diulang, sebab hasilnya pasti
   sama dan hanya membuang waktu pengguna. */
async function panggilGemini(GKEY, body) {
  var utama = body.model;
  var lain = utama === 'gemini-flash-lite-latest' ? 'gemini-flash-latest' : 'gemini-flash-lite-latest';
  var urutan = [utama, lain];
  var akhir = null;

  for (var i = 0; i < urutan.length; i++) {
    var kirim = Object.assign({}, body, { model: urutan[i] });
    try {
      var r = await fetchTO(GEMINI_BASE + '/openai/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + GKEY },
        body: JSON.stringify(kirim)
      }, 10000);
      var teks = await r.text();
      if (r.status < 500) return { teks: teks, status: r.status, ok: r.ok };
      akhir = { teks: teks, status: r.status, ok: false };
    } catch (e) {
      akhir = { teks: '', status: 0, ok: false, galat: String(e && e.message || e) };
      // Batas waktu tercapai: percobaan kedua boleh, tapi jangan lebih
    }
    if (i < urutan.length - 1) await tidur(500);
  }
  return akhir;
}

export default async function handler(req) {
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  var GKEY = process.env.GEMINI_API_KEY;
  var SB_URL = process.env.SUPABASE_URL;
  var SB_ANON = process.env.SUPABASE_ANON_KEY;
  var SB_SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
  var FREE_LIMIT = parseInt(process.env.AI_FREE_LIMIT || '30', 10);
  var PREMIUM_LIMIT = parseInt(process.env.AI_PREMIUM_LIMIT || '500', 10);

  if (!GKEY || !SB_URL || !SB_SERVICE || !SB_ANON) {
    return json({ error: 'server_misconfig', detail: 'Environment variables belum lengkap' }, 500);
  }

  // 1) Verifikasi token login Supabase
  var authz = req.headers.get('authorization') || '';
  var token = authz.replace(/^Bearer\s+/i, '').trim();
  if (!token) return json({ error: 'unauthorized', detail: 'Login diperlukan' }, 401);

  var uid;
  try {
    var uRes = await fetch(SB_URL + '/auth/v1/user', {
      headers: { apikey: SB_ANON, Authorization: 'Bearer ' + token }
    });
    if (!uRes.ok) return json({ error: 'unauthorized', detail: 'Sesi tidak valid' }, 401);
    var user = await uRes.json();
    uid = user && user.id;
    if (!uid) return json({ error: 'unauthorized' }, 401);
  } catch (e) {
    return json({ error: 'auth_failed' }, 401);
  }

  var period = new Date().toISOString().slice(0, 7); // YYYY-MM

  // 2) Cek status premium (berdasarkan premium_until, bukan sekadar label) & kuota
  //    Premium BUKAN unlimited penuh — tetap ada fair-use cap (PREMIUM_LIMIT) untuk melindungi biaya.
  var sbHeaders = { apikey: SB_SERVICE, Authorization: 'Bearer ' + SB_SERVICE, 'Content-Type': 'application/json' };
  var premiumUntil = null;
  try {
    var pRes = await fetch(SB_URL + '/rest/v1/user_settings?user_id=eq.' + uid + '&select=premium_until', { headers: sbHeaders });
    var pRows = await pRes.json();
    if (Array.isArray(pRows) && pRows[0]) premiumUntil = pRows[0].premium_until;
  } catch (e) { /* default free */ }

  var isPremium = !!(premiumUntil && new Date(premiumUntil) > new Date());
  var LIMIT = isPremium ? PREMIUM_LIMIT : FREE_LIMIT;
  var planLabel = isPremium ? 'premium' : 'free';

  var used = 0;
  try {
    var cRes = await fetch(SB_URL + '/rest/v1/ai_usage?user_id=eq.' + uid + '&period=eq.' + period + '&select=count', { headers: sbHeaders });
    var cRows = await cRes.json();
    if (Array.isArray(cRows) && cRows[0]) used = cRows[0].count || 0;
  } catch (e) { /* treat as 0 */ }

  if (used >= LIMIT) {
    return json({ error: 'quota_exceeded', limit: LIMIT, used: used, plan: planLabel }, 429);
  }

  // 3) Teruskan ke Gemini — bedakan chat/vision (JSON) vs audio (multipart)
  var contentType = req.headers.get('content-type') || '';
  var outText, outStatus, providerOk;
  try {
    if (contentType.indexOf('multipart/form-data') >= 0) {
      // --- AUDIO (transkripsi via Gemini native generateContent) ---
      var form = await req.formData();
      var file = form.get('file');
      if (!file || typeof file.arrayBuffer !== 'function') return json({ error: 'no_audio' }, 400);
      var buf = await file.arrayBuffer();
      var b64 = b64FromBuffer(buf);
      var mime = file.type || 'audio/webm';
      var gBody = {
        contents: [{
          parts: [
            { text: 'Transkripsikan audio ini menjadi teks Bahasa Indonesia. Keluarkan HANYA teksnya, tanpa penjelasan atau tanda kutip.' },
            { inlineData: { mimeType: mime, data: b64 } }
          ]
        }]
      };
      var ar = await fetchTO(GEMINI_BASE + '/models/' + AUDIO_MODEL + ':generateContent?key=' + GKEY, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(gBody)
      }, 20000);
      var aj = await ar.json();
      providerOk = ar.ok; outStatus = ar.status;
      if (!ar.ok) {
        outText = JSON.stringify({ error: { message: (aj && aj.error && aj.error.message) || 'gemini_audio_error' } });
      } else {
        var txt = '';
        try { txt = (aj.candidates[0].content.parts || []).map(function (p) { return p.text || '' }).join('').trim(); } catch (e) { txt = ''; }
        outText = JSON.stringify({ text: txt }); // meniru bentuk respons Whisper agar client tak berubah
      }
    } else {
      // --- CHAT / VISION (endpoint Gemini kompatibel-OpenAI, terbukti stabil) ---
      var body = await req.json();
      if (!body) return json({ error: 'bad_request' }, 400);
      // Normalisasi model: apa pun yang diminta client dipetakan ke Gemini Flash (tahan beda-versi & cegah model mahal)
      body.model = (String(body.model || '').indexOf('lite') >= 0) ? 'gemini-flash-lite-latest' : 'gemini-flash-latest';
      if (body.max_tokens && body.max_tokens > MAX_TOKENS_CAP) body.max_tokens = MAX_TOKENS_CAP;
      body.reasoning_effort = 'low'; // kurangi thinking Gemini (nilai valid); 'none' tidak didukung -> hang
      var hasil = await panggilGemini(GKEY, body);
      outText = hasil.teks; providerOk = hasil.ok; outStatus = hasil.status || 502;

      /* Galat penyedia diterjemahkan ke kode yang dikenali peramban. Meneruskan
         balasan mentah membuat peramban kehilangan sebabnya: badan 503 sering
         kosong, dan yang sampai ke pengguna cuma "respons kosong". */
      if (!providerOk) {
        var pesanGoogle = '';
        try { var pj2 = JSON.parse(outText || '{}'); pesanGoogle = (pj2.error && (pj2.error.message || pj2.error.status)) || ''; } catch (e2) { }
        if (!pesanGoogle && hasil.galat) pesanGoogle = hasil.galat;
        var kodeKita = 'ai_gagal';
        if (outStatus >= 500 || outStatus === 0) kodeKita = 'ai_penuh';
        else if (outStatus === 429 || /quota|rate|exhaust/i.test(pesanGoogle)) kodeKita = 'ai_kuota';
        else if (outStatus === 401 || outStatus === 403) kodeKita = 'ai_kunci';
        else if (outStatus === 404 || /model/i.test(pesanGoogle)) kodeKita = 'ai_model';
        outText = JSON.stringify({ error: kodeKita, http: outStatus, detail: String(pesanGoogle).slice(0, 200) });
        outStatus = 502;
      }
    }
  } catch (e) {
    return json({ error: 'upstream_failed', detail: String(e && e.message || e) }, 502);
  }

  // 4) Hitung pemakaian hanya bila provider sukses (tetap dihitung meski premium — demi fair-use cap)
  if (providerOk) {
    try {
      await fetch(SB_URL + '/rest/v1/rpc/increment_ai_usage', {
        method: 'POST', headers: sbHeaders,
        body: JSON.stringify({ p_user: uid, p_period: period })
      });
      used = used + 1;
    } catch (e) { /* jangan gagalkan request hanya karena logging */ }
  }

  return new Response(outText, {
    status: outStatus,
    headers: {
      'Content-Type': 'application/json',
      'X-AI-Quota-Limit': String(LIMIT),
      'X-AI-Quota-Used': String(used),
      'X-AI-Plan': planLabel
    }
  });
}
