// WealthFlow — Halaman diagnosa (Vercel Edge Function)
//
// Dibuka di peramban:  https://wealthflow.me/api/diag?k=<CRON_SECRET>
//
// Menjawab tiga pertanyaan yang selama ini hanya bisa ditebak:
//   1. Env mana yang benar-benar terpasang di Vercel
//   2. Apakah webhook Telegram masih terdaftar, dan galat terakhirnya apa
//   3. Apakah kunci Gemini sah, dan model apa saja yang tersedia untuknya
//
// Dijaga CRON_SECRET supaya tak jadi jalan pintas mengintip pengaturan.
// Isi env TIDAK PERNAH ditampilkan — hanya ada/tidak dan panjangnya.

export const config = { runtime: 'edge' };

async function fetchTO(url, opts, ms) {
  var ctrl = new AbortController();
  var id = setTimeout(function () { ctrl.abort(); }, ms || 6000);
  try { return await fetch(url, Object.assign({}, opts || {}, { signal: ctrl.signal })); }
  finally { clearTimeout(id); }
}

function petunjuk(v) {
  if (!v) return { ada: false };
  return { ada: true, panjang: String(v).length };
}

export default async function handler(req) {
  var SECRET = process.env.CRON_SECRET;
  var kunciURL = new URL(req.url).searchParams.get('k') || '';

  if (!SECRET) {
    return new Response(JSON.stringify({ error: 'CRON_SECRET belum diset di Vercel, halaman ini tak bisa dijaga.' }, null, 2),
      { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
  if (kunciURL !== SECRET) {
    return new Response(JSON.stringify({ error: 'Kunci salah. Buka dengan ?k=CRON_SECRET' }, null, 2),
      { status: 403, headers: { 'Content-Type': 'application/json' } });
  }

  var TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  var GKEY = process.env.GEMINI_API_KEY;

  var hasil = {
    waktu_server: new Date().toISOString(),
    env: {
      TELEGRAM_BOT_TOKEN: petunjuk(TOKEN),
      TELEGRAM_WEBHOOK_SECRET: petunjuk(process.env.TELEGRAM_WEBHOOK_SECRET),
      GEMINI_API_KEY: petunjuk(GKEY),
      GEMINI_IMAGE_MODEL: { ada: !!process.env.GEMINI_IMAGE_MODEL, nilai: process.env.GEMINI_IMAGE_MODEL || '(pakai bawaan)' },
      SUPABASE_URL: petunjuk(process.env.SUPABASE_URL),
      SUPABASE_ANON_KEY: petunjuk(process.env.SUPABASE_ANON_KEY),
      SUPABASE_SERVICE_ROLE_KEY: petunjuk(process.env.SUPABASE_SERVICE_ROLE_KEY),
      CRON_SECRET: petunjuk(SECRET),
      MIDTRANS_SERVER_KEY: petunjuk(process.env.MIDTRANS_SERVER_KEY)
    },
    telegram: null,
    gemini: null
  };

  // ── Webhook Telegram ──
  if (!TOKEN) {
    hasil.telegram = { error: 'TELEGRAM_BOT_TOKEN kosong, tak bisa diperiksa.' };
  } else {
    try {
      var wr = await fetchTO('https://api.telegram.org/bot' + TOKEN + '/getWebhookInfo', {}, 6000);
      var wj = await wr.json();
      if (wj && wj.ok && wj.result) {
        var w = wj.result;
        hasil.telegram = {
          terdaftar: !!w.url,
          url: w.url || '(kosong, webhook belum didaftarkan)',
          menunggu_diproses: w.pending_update_count || 0,
          pakai_secret: !!w.has_custom_certificate || undefined,
          galat_terakhir: w.last_error_message || '(tidak ada)',
          waktu_galat_terakhir: w.last_error_date ? new Date(w.last_error_date * 1000).toISOString() : '(tidak ada)'
        };
        // Terjemahkan galat yang paling sering, supaya tak perlu ditafsirkan sendiri
        var lem = String(w.last_error_message || '');
        if (/403/.test(lem)) hasil.telegram.artinya = 'Ditolak 403: TELEGRAM_WEBHOOK_SECRET di Vercel BERBEDA dengan yang didaftarkan ke Telegram. Daftarkan ulang webhook-nya.';
        else if (/500/.test(lem)) hasil.telegram.artinya = 'Server membalas 500: biasanya ada env yang kosong. Lihat bagian env di atas.';
        else if (/404/.test(lem)) hasil.telegram.artinya = 'Alamat webhook tidak ditemukan: URL-nya salah atau deploy gagal.';
        else if (!w.url) hasil.telegram.artinya = 'Webhook belum didaftarkan sama sekali, jadi Telegram tak pernah mengirim apa pun ke server.';
        else if (/50[24]/.test(lem)) hasil.telegram.artinya = 'Pernah kehabisan waktu (50x): fungsi melewati batas Vercel sebelum sempat membalas.';
        else if ((w.pending_update_count || 0) > 0) hasil.telegram.artinya = 'Ada pesan menumpuk yang belum berhasil diproses.';
        else hasil.telegram.artinya = 'Webhook sehat.';
        /* Galat yang sudah lewat lebih dari sejam adalah jejak masa lalu, bukan
           keadaan sekarang. Tanpa pembeda ini, galat lama terus terbaca seolah
           masalahnya masih berlangsung. */
        if (w.last_error_date) {
          var umurJam = (Date.now() / 1000 - w.last_error_date) / 3600;
          hasil.telegram.umur_galat = umurJam < 1 ? Math.round(umurJam * 60) + ' menit lalu' : Math.round(umurJam) + ' jam lalu';
          if (umurJam > 1 && (w.pending_update_count || 0) === 0) {
            hasil.telegram.artinya = 'Galat terakhir sudah lama (' + hasil.telegram.umur_galat + ') dan tak ada pesan menumpuk, jadi webhook-nya sekarang sehat. Galat itu jejak masa lalu.';
          }
        }
      } else {
        hasil.telegram = { error: (wj && wj.description) || 'Telegram menolak permintaan.' };
      }
    } catch (e) {
      hasil.telegram = { error: String(e && e.message || e) };
    }
  }

  // ── Kunci & model Gemini ──
  if (!GKEY) {
    hasil.gemini = { error: 'GEMINI_API_KEY kosong, tak bisa diperiksa.' };
  } else {
    try {
      var mr = await fetchTO('https://generativelanguage.googleapis.com/v1beta/models?key=' + GKEY + '&pageSize=200', {}, 8000);
      var mj = await mr.json();
      if (mr.ok && mj && Array.isArray(mj.models)) {
        var chat = mj.models.filter(function (m) {
          return (m.supportedGenerationMethods || []).indexOf('generateContent') >= 0;
        }).map(function (m) { return String(m.name || '').replace('models/', ''); });
        var dipakai = ['gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];
        hasil.gemini = {
          kunci_sah: true,
          jumlah_model_chat: chat.length,
          model_yang_dipakai_kode: dipakai.map(function (nm) { return nm + (chat.indexOf(nm) >= 0 ? ' ✓ ADA' : ' ✗ TIDAK ADA'); }),
          keluarga_flash: chat.filter(function (x) { return x.indexOf('flash') >= 0; }).slice(0, 25)
        };
        var hilang = dipakai.filter(function (nm) { return chat.indexOf(nm) < 0; });
        hasil.gemini.artinya = hilang.length
          ? 'Nama model berikut TIDAK ada di kunci ini: ' + hilang.join(', ') + '. Setel GEMINI_IMAGE_MODEL ke salah satu nama dari keluarga_flash.'
          : 'Kunci sah dan semua model yang dipakai kode memang tersedia.';
      } else {
        hasil.gemini = {
          kunci_sah: false,
          http: mr.status,
          pesan_google: (mj && mj.error && mj.error.message) || '(kosong)',
          artinya: 'Google menolak KUNCINYA sendiri. Masalahnya di GEMINI_API_KEY, bukan kapasitas model.'
        };
      }
    } catch (e) {
      hasil.gemini = { error: String(e && e.message || e) };
    }
  }

  // ── Kesimpulan ringkas, supaya tak perlu membaca seluruh JSON ──
  var catatan = [];
  Object.keys(hasil.env).forEach(function (k) {
    if (k !== 'GEMINI_IMAGE_MODEL' && k !== 'MIDTRANS_SERVER_KEY' && !hasil.env[k].ada) catatan.push('Env ' + k + ' KOSONG.');
  });
  if (hasil.telegram && hasil.telegram.artinya && hasil.telegram.artinya !== 'Webhook sehat.') catatan.push('Telegram: ' + hasil.telegram.artinya);
  if (hasil.gemini && hasil.gemini.artinya && hasil.gemini.kunci_sah !== true) catatan.push('Gemini: ' + hasil.gemini.artinya);
  else if (hasil.gemini && hasil.gemini.artinya && /TIDAK ada/.test(hasil.gemini.artinya)) catatan.push('Gemini: ' + hasil.gemini.artinya);
  hasil.kesimpulan = catatan.length ? catatan : ['Tidak ada masalah yang terdeteksi dari sisi pengaturan.'];

  return new Response(JSON.stringify(hasil, null, 2), {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}
