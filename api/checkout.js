// WealthFlow — Buat transaksi pembayaran Midtrans (Vercel Edge Function)
//
// Environment variables:
//   MIDTRANS_SERVER_KEY        → Server Key dari dashboard Midtrans (RAHASIA)
//   MIDTRANS_IS_PRODUCTION     → 'true' untuk live, kosong/'false' untuk sandbox
//   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY → (sudah ada)
//   APP_URL                    → (opsional) mis. https://wealthflow.me, default dipakai kalau kosong

export const config = { runtime: 'edge' };

var PLANS = {
  monthly: { amount: 15000, days: 30, label: 'WealthFlow Premium Bulanan' },
  yearly: { amount: 100000, days: 365, label: 'WealthFlow Premium Tahunan' },
  // Paket uji: untuk memastikan alur bayar → premium aktif benar-benar bekerja
  // di lingkungan Production tanpa mengeluarkan uang berarti. Sengaja TIDAK
  // ditampilkan di aplikasi dan hanya berlaku 1 hari, jadi tak berguna disalahgunakan.
  test: { amount: 1000, days: 1, label: 'WealthFlow Uji Coba Pembayaran' }
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'Content-Type': 'application/json' } });
}

export default async function handler(req) {
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  // Spasi/baris baru ikut tersalin saat menempel kunci — itu saja sudah membuat
  // Midtrans menolak dengan "Access denied ... check client or server key".
  var SERVER_KEY = (process.env.MIDTRANS_SERVER_KEY || '').trim();
  var IS_PROD = process.env.MIDTRANS_IS_PRODUCTION === 'true';
  var SB_URL = process.env.SUPABASE_URL;
  var SB_ANON = process.env.SUPABASE_ANON_KEY;
  var SB_SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
  var APP_URL = process.env.APP_URL || 'https://wealthflow.me';

  if (!SERVER_KEY || !SB_URL || !SB_ANON || !SB_SERVICE) {
    return json({ error: 'server_misconfig', detail: 'Environment variables belum lengkap' }, 500);
  }

  // 1) Verifikasi login
  var authz = req.headers.get('authorization') || '';
  var token = authz.replace(/^Bearer\s+/i, '').trim();
  if (!token) return json({ error: 'unauthorized' }, 401);
  var uid, email;
  try {
    var uRes = await fetch(SB_URL + '/auth/v1/user', { headers: { apikey: SB_ANON, Authorization: 'Bearer ' + token } });
    if (!uRes.ok) return json({ error: 'unauthorized' }, 401);
    var user = await uRes.json();
    uid = user && user.id; email = user && user.email;
    if (!uid) return json({ error: 'unauthorized' }, 401);
  } catch (e) { return json({ error: 'auth_failed' }, 401); }

  // 1b) Periksa kecocokan kunci — ditempatkan SETELAH login agar konfigurasi server
  // tidak terbaca publik. Midtrans sendiri hanya membalas "Access denied" tanpa
  // menyebut mana yang keliru, jadi diperjelas di sini.
  var isClientKey = /^(SB-)?Mid-client-/i.test(SERVER_KEY);
  var isSandboxKey = /^SB-Mid-server-/i.test(SERVER_KEY);
  var isProdKey = /^Mid-server-/i.test(SERVER_KEY);
  // Petunjuk aman: hanya jenis & panjang, bukan isi kuncinya
  var terbaca = 'Yang terbaca server: ' + (isSandboxKey ? 'SB-Mid-server-… (Sandbox)' : isProdKey ? 'Mid-server-… (Production)' : isClientKey ? 'Client key' : 'format tak dikenali')
    + ', panjang ' + SERVER_KEY.length + ' karakter, MIDTRANS_IS_PRODUCTION=' + (IS_PROD ? 'true' : 'false')
    + '. Bila ini bukan yang Anda isi, perubahannya belum diterapkan. Lakukan Redeploy di Vercel.';

  if (isClientKey) {
    return json({ error: 'key_salah', detail: 'Yang terisi adalah CLIENT key. MIDTRANS_SERVER_KEY harus diisi SERVER key. ' + terbaca }, 500);
  }
  if (!isSandboxKey && !isProdKey) {
    return json({ error: 'key_salah', detail: 'Format Server Key tidak dikenali (harus diawali "SB-Mid-server-" atau "Mid-server-"). ' + terbaca }, 500);
  }
  if (IS_PROD && isSandboxKey) {
    return json({ error: 'key_mismatch', detail: 'Kunci SANDBOX tetapi mode Production. Ubah MIDTRANS_IS_PRODUCTION menjadi false. ' + terbaca }, 500);
  }
  if (!IS_PROD && isProdKey) {
    return json({ error: 'key_mismatch', detail: 'Kunci PRODUCTION tetapi mode Sandbox. Ubah MIDTRANS_IS_PRODUCTION menjadi true, atau pakai kunci Sandbox. ' + terbaca }, 500);
  }

  // 2) Validasi paket
  var body;
  try { body = await req.json(); } catch (e) { return json({ error: 'bad_request' }, 400); }
  var plan = PLANS[body && body.plan];
  if (!plan) return json({ error: 'invalid_plan' }, 400);

  var orderId = 'WF-' + Date.now() + '-' + uid.slice(0, 8);
  var sbHeaders = { apikey: SB_SERVICE, Authorization: 'Bearer ' + SB_SERVICE, 'Content-Type': 'application/json' };

  // 3) Catat transaksi pending
  var insRes = await fetch(SB_URL + '/rest/v1/payments', {
    method: 'POST', headers: sbHeaders,
    body: JSON.stringify({ user_id: uid, order_id: orderId, plan: body.plan, amount: plan.amount, status: 'pending' })
  });
  if (!insRes.ok) {
    var insErr = await insRes.text();
    return json({ error: 'db_error', detail: insErr }, 500);
  }

  // 4) Buat transaksi Snap di Midtrans
  var midtransBase = IS_PROD ? 'https://app.midtrans.com' : 'https://app.sandbox.midtrans.com';
  var basicAuth = btoa(SERVER_KEY + ':');
  var snapBody = {
    transaction_details: { order_id: orderId, gross_amount: plan.amount },
    customer_details: { email: email || undefined },
    item_details: [{ id: body.plan, price: plan.amount, quantity: 1, name: plan.label }],
    callbacks: { finish: APP_URL + '/?payment=finish' }
  };

  var mr;
  try {
    mr = await fetch(midtransBase + '/snap/v1/transactions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', Accept: 'application/json', Authorization: 'Basic ' + basicAuth,
        // Alamat notifikasi dikirim per-transaksi, jadi tak bergantung pada pengaturan
        // di dasbor Midtrans (letak menunya berbeda-beda antar versi).
        'X-Override-Notification': APP_URL + '/api/midtrans-webhook'
      },
      body: JSON.stringify(snapBody)
    });
  } catch (e) {
    return json({ error: 'midtrans_unreachable', detail: String(e && e.message || e) }, 502);
  }
  var mj = await mr.json();
  if (!mr.ok) {
    var pesan = [].concat((mj && mj.error_messages) || []).join(' ');
    // "Access denied" saat format kunci & mode SUDAH cocok hampir selalu berarti kuncinya
    // memang belum berlaku — umumnya karena akun Production belum lolos verifikasi Midtrans.
    if (/access denied|unauthorized transaction/i.test(pesan)) {
      return json({
        error: 'midtrans_denied',
        detail: 'Midtrans menolak kunci ini padahal format & modenya sudah cocok (' +
          (isProdKey ? 'Production' : 'Sandbox') + '). Penyebab tersering: akun ' +
          (isProdKey ? 'Production belum lolos verifikasi Midtrans, sehingga kuncinya belum aktif' : 'Sandbox belum disiapkan') +
          '. Periksa status verifikasi di dasbor Midtrans, atau pakai kunci Sandbox dari dashboard.sandbox.midtrans.com untuk menguji lebih dulu.'
      }, 502);
    }
    return json({ error: 'midtrans_error', detail: (mj && mj.error_messages) || mj }, 502);
  }

  return json({ redirect_url: mj.redirect_url, order_id: orderId });
}
