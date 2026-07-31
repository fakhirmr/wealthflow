// WealthFlow — Webhook notifikasi pembayaran Midtrans (Vercel Edge Function)
// Dipanggil LANGSUNG oleh server Midtrans (bukan browser) setelah status transaksi berubah.
// Verifikasi signature wajib — jangan pernah percaya isi payload begitu saja.
//
// Environment variables: MIDTRANS_SERVER_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (semua sudah ada)
//   AI_PREMIUM_LIMIT (opsional) → cuma dipakai di api/ai.js & api/telegram.js, disebut di sini untuk referensi

export const config = { runtime: 'edge' };

var PLAN_DAYS = { monthly: 30, yearly: 365 };

function sb(url, opts, SB_URL, KEY) {
  opts = opts || {};
  opts.headers = Object.assign({ apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' }, opts.headers || {});
  return fetch(SB_URL + url, opts);
}

async function sha512hex(str) {
  var buf = await crypto.subtle.digest('SHA-512', new TextEncoder().encode(str));
  var bytes = new Uint8Array(buf), hex = '';
  for (var i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return hex;
}

export default async function handler(req) {
  if (req.method !== 'POST') return new Response('ok');

  var SERVER_KEY = process.env.MIDTRANS_SERVER_KEY;
  var SB_URL = process.env.SUPABASE_URL;
  var KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SERVER_KEY || !SB_URL || !KEY) return new Response('misconfig', { status: 500 });

  var notif;
  try { notif = await req.json(); } catch (e) { return new Response('bad request', { status: 400 }); }

  var orderId = notif.order_id, statusCode = notif.status_code, grossAmount = notif.gross_amount, signatureKey = notif.signature_key;
  var transactionStatus = notif.transaction_status, fraudStatus = notif.fraud_status;
  if (!orderId || !statusCode || !grossAmount || !signatureKey) return new Response('bad request', { status: 400 });

  // 1) Verifikasi signature (SHA512 dari order_id+status_code+gross_amount+ServerKey) — WAJIB
  var expected = await sha512hex(orderId + statusCode + grossAmount + SERVER_KEY);
  if (expected !== signatureKey) return new Response('invalid signature', { status: 403 });

  // 2) Ambil transaksi terkait
  var pr = await sb('/rest/v1/payments?order_id=eq.' + encodeURIComponent(orderId) + '&select=*', {}, SB_URL, KEY);
  var prows = await pr.json();
  if (!Array.isArray(prows) || !prows[0]) return new Response('order not found', { status: 404 });
  var payment = prows[0];

  // 3) Idempotency — kalau sudah diproses sukses, jangan diproses lagi (Midtrans bisa kirim notif berulang)
  if (payment.status === 'paid') return new Response('ok');

  var isSuccess = transactionStatus === 'settlement' || (transactionStatus === 'capture' && fraudStatus === 'accept');
  var isFailed = transactionStatus === 'deny' || transactionStatus === 'cancel' || transactionStatus === 'expire';

  if (isSuccess) {
    var days = PLAN_DAYS[payment.plan] || 30;
    // Perpanjang dari premium_until saat ini kalau masih aktif, bukan dari "sekarang" (agar tak rugi kalau bayar lebih awal)
    var usr = await sb('/rest/v1/user_settings?user_id=eq.' + payment.user_id + '&select=premium_until', {}, SB_URL, KEY);
    var usrRows = await usr.json();
    var now = new Date();
    var base = now;
    if (Array.isArray(usrRows) && usrRows[0] && usrRows[0].premium_until) {
      var cur = new Date(usrRows[0].premium_until);
      if (cur > now) base = cur;
    }
    var newUntil = new Date(base.getTime() + days * 86400000);

    await sb('/rest/v1/user_settings?on_conflict=user_id', {
      method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify({ user_id: payment.user_id, premium_until: newUntil.toISOString(), ai_plan: 'premium' })
    }, SB_URL, KEY);

    await sb('/rest/v1/payments?order_id=eq.' + encodeURIComponent(orderId), {
      method: 'PATCH', body: JSON.stringify({ status: 'paid', paid_at: now.toISOString(), midtrans_transaction_id: notif.transaction_id || null, raw_notification: notif })
    }, SB_URL, KEY);
  } else if (isFailed) {
    await sb('/rest/v1/payments?order_id=eq.' + encodeURIComponent(orderId), {
      method: 'PATCH', body: JSON.stringify({ status: 'failed', raw_notification: notif })
    }, SB_URL, KEY);
  }
  // status lain (pending, dll) — biarkan, tidak perlu diapa-apakan

  return new Response('ok');
}
