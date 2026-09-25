// WealthFlow AI Proxy — Vercel Edge Function (Claude / Anthropic)
// Menyembunyikan ANTHROPIC_API_KEY di server, verifikasi login Supabase,
// dan menegakkan kuota pemakaian per-customer.
//
// Environment variables yang WAJIB diset di Vercel (Project Settings → Environment Variables):
//   ANTHROPIC_API_KEY           → API key dari console.anthropic.com (RAHASIA)
//   SUPABASE_URL                → https://wkhjxgrjkrakfhwckriu.supabase.co
//   SUPABASE_ANON_KEY           → anon key (boleh publik)
//   SUPABASE_SERVICE_ROLE_KEY   → service_role key (SANGAT RAHASIA — jangan pernah taruh di frontend)
//   ANTHROPIC_MODEL             → (opsional) ganti model tanpa menyentuh kode, default claude-opus-5
//   AI_FREE_LIMIT               → (opsional) jatah pesan/bulan tier gratis, default 30
//   AI_PREMIUM_LIMIT            → (opsional) jatah pesan/bulan tier premium (fair-use), default 500

import Anthropic from '@anthropic-ai/sdk';

export const config = { runtime: 'edge' };

var MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-5';
var MAX_TOKENS_CAP = 8192;

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

/* Peramban tetap berbicara dalam bentuk OpenAI: messages dengan role 'system',
   blok image_url, dan balasan choices[0].message.content. Bentuk itu
   DIPERTAHANKAN dengan sengaja, dan seluruh penerjemahannya dikumpulkan di dua
   fungsi di bawah. Alasannya bukan kemalasan: index.html memakai bentuk itu di
   enam tempat, berkasnya 520 KB, dan ia baru saja pulih dari gangguan.
   Menerjemahkan di satu titik di server jauh lebih kecil risikonya daripada
   menyunting enam titik di klien untuk hasil yang sama persis. */
function keClaude(messages) {
  var sistem = [];
  var pesan = [];

  (messages || []).forEach(function (m) {
    if (!m) return;

    // Claude menerima system sebagai parameter TERSENDIRI, bukan sebagai pesan
    if (m.role === 'system') {
      if (typeof m.content === 'string') sistem.push(m.content);
      else if (Array.isArray(m.content)) {
        m.content.forEach(function (b) { if (b && b.type === 'text' && b.text) sistem.push(b.text); });
      }
      return;
    }

    var peran = m.role === 'assistant' ? 'assistant' : 'user';
    if (typeof m.content === 'string') {
      if (m.content) pesan.push({ role: peran, content: m.content });
      return;
    }

    var blok = [];
    (Array.isArray(m.content) ? m.content : []).forEach(function (b) {
      if (!b) return;
      if (b.type === 'text' && b.text) { blok.push({ type: 'text', text: b.text }); return; }
      /* Hanya data URL yang diterima. Klien selalu mengirim gambar sebagai
         base64; menerima URL jarak jauh berarti proxy ini bersedia mengunduh
         dari alamat mana pun yang disodorkan pemanggilnya. */
      if (b.type === 'image_url' && b.image_url && b.image_url.url) {
        var d = /^data:([^;,]+);base64,(.+)$/.exec(String(b.image_url.url));
        if (d) blok.push({ type: 'image', source: { type: 'base64', media_type: d[1], data: d[2] } });
      }
    });
    if (blok.length) pesan.push({ role: peran, content: blok });
  });

  // Percakapan harus dimulai dari user
  while (pesan.length && pesan[0].role !== 'user') pesan.shift();

  /* Dua pesan berperan sama berturut-turut digabung. Riwayat chat di klien bisa
     menghasilkan bentuk itu (mis. saat balasan galat tak ikut masuk riwayat
     asisten), dan bentuk seperti itu ditolak sebagian jalur API. */
  var rapat = [];
  pesan.forEach(function (p) {
    var akhir = rapat[rapat.length - 1];
    if (akhir && akhir.role === p.role) {
      var a = typeof akhir.content === 'string' ? [{ type: 'text', text: akhir.content }] : akhir.content;
      var b = typeof p.content === 'string' ? [{ type: 'text', text: p.content }] : p.content;
      akhir.content = a.concat(b);
      return;
    }
    rapat.push({ role: p.role, content: p.content });
  });

  return { system: sistem.join('\n\n'), messages: rapat };
}

function keOpenAI(resp) {
  var teks = (resp.content || [])
    .filter(function (b) { return b && b.type === 'text'; })
    .map(function (b) { return b.text || ''; })
    .join('');
  return {
    choices: [{ index: 0, message: { role: 'assistant', content: teks }, finish_reason: resp.stop_reason || 'stop' }],
    usage: resp.usage || null
  };
}

/* Galat penyedia diterjemahkan ke kode yang SUDAH dikenali peramban (aiErrMsg
   di index.html). Kodenya sengaja tidak diganti saat pindah penyedia: yang
   berganti penyedianya, bukan arti kegagalannya bagi pengguna. */
function kodeGalat(e) {
  var status = (e && e.status) || 0;
  var pesan = String((e && e.message) || '');
  if (status === 429) return 'ai_kuota';
  if (status === 401 || status === 403 || status === 402) return 'ai_kunci';
  if (status === 404) return 'ai_model';
  if (status >= 500) return 'ai_penuh';
  if (!status && /abort|timeout|network|fetch/i.test(pesan)) return 'ai_penuh';
  return 'ai_gagal';
}

export default async function handler(req) {
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  var AKEY = process.env.ANTHROPIC_API_KEY;
  var SB_URL = process.env.SUPABASE_URL;
  var SB_ANON = process.env.SUPABASE_ANON_KEY;
  var SB_SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
  var FREE_LIMIT = parseInt(process.env.AI_FREE_LIMIT || '30', 10);
  var PREMIUM_LIMIT = parseInt(process.env.AI_PREMIUM_LIMIT || '500', 10);

  /* Menyebut env mana yang kosong, bukan sekadar "belum lengkap". Pesan lama
     benar tapi buntu: pemiliknya tahu ada yang salah dan tidak tahu apa, lalu
     harus membuka /api/diag hanya untuk membaca satu nama. Nama env bukan
     rahasia; isinya yang rahasia, dan isinya tidak pernah ikut ditampilkan. */
  var kurang = [];
  if (!AKEY) kurang.push('ANTHROPIC_API_KEY');
  if (!SB_URL) kurang.push('SUPABASE_URL');
  if (!SB_ANON) kurang.push('SUPABASE_ANON_KEY');
  if (!SB_SERVICE) kurang.push('SUPABASE_SERVICE_ROLE_KEY');
  if (kurang.length) {
    return json({ error: 'server_misconfig', detail: 'Env belum diset di Vercel: ' + kurang.join(', ') }, 500);
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

  // 3) Teruskan ke Claude
  var contentType = req.headers.get('content-type') || '';

  /* Claude tidak menerima audio. Catat-lewat-suara dulu memakai transkripsi
     Gemini, dan itu ikut hilang saat penyedianya pindah. Dijawab jujur di sini
     daripada dibiarkan gagal dengan galat yang tak bisa dimengerti. */
  if (contentType.indexOf('multipart/form-data') >= 0) {
    return json({
      error: 'audio_tak_didukung',
      detail: 'Catat lewat suara belum tersedia. Ketik saja transaksinya, atau kirim foto struk.'
    }, 501);
  }

  var outText, providerOk = false;
  try {
    var body = await req.json();
    if (!body) return json({ error: 'bad_request' }, 400);

    var konv = keClaude(body.messages);
    if (!konv.messages.length) return json({ error: 'bad_request', detail: 'Tidak ada pesan untuk dikirim' }, 400);

    var maxTok = Math.min(Number(body.max_tokens) || 4096, MAX_TOKENS_CAP);

    /* Petunjuk "lite" dari klien dipakai sebagai petunjuk KEDALAMAN, bukan untuk
       memilih model lain. Jalur lite cuma mengekstrak JSON dari satu kalimat;
       menyuruhnya berpikir panjang hanya menambah biaya dan waktu tunggu. */
    var hemat = String(body.model || '').indexOf('lite') >= 0;

    var client = new Anthropic({ apiKey: AKEY, maxRetries: 1, timeout: 22000 });

    var permintaan = {
      model: MODEL,
      max_tokens: maxTok,
      messages: konv.messages,
      output_config: { effort: hemat ? 'low' : 'medium' },
      /* Penolakan penyaring keamanan dialihkan ke model lain oleh server,
         bukan dijatuhkan sebagai galat ke muka pengguna. */
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default'
    };
    if (konv.system) permintaan.system = konv.system;

    var resp = await client.beta.messages.create(permintaan);

    outText = JSON.stringify(keOpenAI(resp));
    providerOk = true;
  } catch (e) {
    var kode = kodeGalat(e);
    return json({ error: kode, http: (e && e.status) || 0, detail: String((e && e.message) || e).slice(0, 200) }, 502);
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
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'X-AI-Quota-Limit': String(LIMIT),
      'X-AI-Quota-Used': String(used),
      'X-AI-Plan': planLabel
    }
  });
}
