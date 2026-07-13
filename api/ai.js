// WealthFlow AI Proxy — Vercel Edge Function
// Menyembunyikan GROQ_API_KEY di server, verifikasi login Supabase,
// dan menegakkan kuota pemakaian per-customer.
//
// Environment variables yang WAJIB diset di Vercel (Project Settings → Environment Variables):
//   GROQ_API_KEY                → API key Groq milik Anda (RAHASIA)
//   SUPABASE_URL                → https://wkhjxgrjkrakfhwckriu.supabase.co
//   SUPABASE_ANON_KEY           → anon key (boleh publik)
//   SUPABASE_SERVICE_ROLE_KEY   → service_role key (SANGAT RAHASIA — jangan pernah taruh di frontend)
//   AI_FREE_LIMIT               → (opsional) jatah pesan/bulan tier gratis, default 30

export const config = { runtime: 'edge' };

// Hanya model ini yang boleh dipanggil (mencegah customer meminta model mahal).
// Kalau Groq mengubah nama model, sesuaikan di sini.
var ALLOWED_CHAT_MODELS = [
  'llama-3.3-70b-versatile',
  'llama-3.1-8b-instant',
  'meta-llama/llama-4-scout-17b-16e-instruct' // vision — untuk baca struk
];
var ALLOWED_AUDIO_MODELS = ['whisper-large-v3', 'whisper-large-v3-turbo'];
var MAX_TOKENS_CAP = 2048; // mutasi bisa berisi banyak transaksi

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

export default async function handler(req) {
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  var GROQ_KEY = process.env.GROQ_API_KEY;
  var SB_URL = process.env.SUPABASE_URL;
  var SB_ANON = process.env.SUPABASE_ANON_KEY;
  var SB_SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
  var LIMIT = parseInt(process.env.AI_FREE_LIMIT || '30', 10);

  if (!GROQ_KEY || !SB_URL || !SB_SERVICE || !SB_ANON) {
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

  // 2) Cek plan & kuota (service role — bypass RLS)
  var sbHeaders = { apikey: SB_SERVICE, Authorization: 'Bearer ' + SB_SERVICE, 'Content-Type': 'application/json' };
  var plan = 'free';
  var used = 0;
  try {
    var pRes = await fetch(SB_URL + '/rest/v1/user_settings?user_id=eq.' + uid + '&select=ai_plan', { headers: sbHeaders });
    var pRows = await pRes.json();
    if (Array.isArray(pRows) && pRows[0] && pRows[0].ai_plan) plan = pRows[0].ai_plan;
  } catch (e) { /* default free */ }

  if (plan !== 'premium' && plan !== 'unlimited') {
    try {
      var cRes = await fetch(SB_URL + '/rest/v1/ai_usage?user_id=eq.' + uid + '&period=eq.' + period + '&select=count', { headers: sbHeaders });
      var cRows = await cRes.json();
      if (Array.isArray(cRows) && cRows[0]) used = cRows[0].count || 0;
    } catch (e) { /* treat as 0 */ }

    if (used >= LIMIT) {
      return json({ error: 'quota_exceeded', limit: LIMIT, used: used, plan: plan }, 429);
    }
  }

  // 3) Teruskan ke Groq — bedakan chat/vision (JSON) vs audio (multipart)
  var contentType = req.headers.get('content-type') || '';
  var groqRes;
  try {
    if (contentType.indexOf('multipart/form-data') >= 0) {
      // --- AUDIO (transcription) ---
      var form = await req.formData();
      var amodel = form.get('model') || 'whisper-large-v3-turbo';
      if (ALLOWED_AUDIO_MODELS.indexOf(String(amodel)) < 0) return json({ error: 'model_not_allowed' }, 400);
      var fwd = new FormData();
      var entries = form.entries();
      for (var pair = entries.next(); !pair.done; pair = entries.next()) {
        fwd.append(pair.value[0], pair.value[1]);
      }
      groqRes = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + GROQ_KEY },
        body: fwd
      });
    } else {
      // --- CHAT / VISION ---
      var body = await req.json();
      if (!body || ALLOWED_CHAT_MODELS.indexOf(body.model) < 0) return json({ error: 'model_not_allowed', model: body && body.model }, 400);
      if (body.max_tokens && body.max_tokens > MAX_TOKENS_CAP) body.max_tokens = MAX_TOKENS_CAP;
      groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + GROQ_KEY },
        body: JSON.stringify(body)
      });
    }
  } catch (e) {
    return json({ error: 'upstream_failed', detail: String(e && e.message || e) }, 502);
  }

  var payload = await groqRes.text();

  // 4) Hitung pemakaian hanya bila Groq sukses
  if (groqRes.ok && plan !== 'premium' && plan !== 'unlimited') {
    try {
      await fetch(SB_URL + '/rest/v1/rpc/increment_ai_usage', {
        method: 'POST', headers: sbHeaders,
        body: JSON.stringify({ p_user: uid, p_period: period })
      });
      used = used + 1;
    } catch (e) { /* jangan gagalkan request hanya karena logging */ }
  }

  return new Response(payload, {
    status: groqRes.status,
    headers: {
      'Content-Type': 'application/json',
      'X-AI-Quota-Limit': String(LIMIT),
      'X-AI-Quota-Used': String(used),
      'X-AI-Plan': plan
    }
  });
}
