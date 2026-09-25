// WealthFlow — Halaman diagnosa (Vercel Edge Function)
//
// Dibuka di peramban:  https://wealthflow.me/api/diag?k=<CRON_SECRET>
//
// Menjawab tiga pertanyaan yang selama ini hanya bisa ditebak:
//   1. Env mana yang benar-benar terpasang di Vercel
//   2. Apakah webhook Telegram masih terdaftar, dan galat terakhirnya apa
//   3. Apakah kunci Anthropic sah, dan model apa saja yang tersedia untuknya
//
// Dijaga CRON_SECRET supaya tak jadi jalan pintas mengintip pengaturan.
// Isi env TIDAK PERNAH ditampilkan — hanya ada/tidak dan panjangnya.

import Anthropic from '@anthropic-ai/sdk';

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
  var AKEY = process.env.ANTHROPIC_API_KEY;

  var hasil = {
    waktu_server: new Date().toISOString(),
    // Penanda bangunan. Tanpa ini, tak ada cara memastikan perbaikan sudah tayang.
    versi_terpasang: '2026-09-03a-kirimtahan',
    env: {
      TELEGRAM_BOT_TOKEN: petunjuk(TOKEN),
      TELEGRAM_WEBHOOK_SECRET: petunjuk(process.env.TELEGRAM_WEBHOOK_SECRET),
      ANTHROPIC_API_KEY: petunjuk(AKEY),
      ANTHROPIC_MODEL: { ada: !!process.env.ANTHROPIC_MODEL, nilai: process.env.ANTHROPIC_MODEL || '(pakai bawaan: claude-opus-5)' },
      SUPABASE_URL: petunjuk(process.env.SUPABASE_URL),
      SUPABASE_ANON_KEY: petunjuk(process.env.SUPABASE_ANON_KEY),
      SUPABASE_SERVICE_ROLE_KEY: petunjuk(process.env.SUPABASE_SERVICE_ROLE_KEY),
      CRON_SECRET: petunjuk(SECRET),
      MIDTRANS_SERVER_KEY: petunjuk(process.env.MIDTRANS_SERVER_KEY)
    },
    telegram: null,
    ai: null
  };

  // ── Webhook Telegram ──
  if (!TOKEN) {
    hasil.telegram = { error: 'TELEGRAM_BOT_TOKEN kosong, tak bisa diperiksa.' };
  } else {
    try {
      /* Kalau token di env ternyata milik bot LAIN daripada yang diajak bicara,
         semua gejalanya persis sama dengan bot bungkam: webhook terdaftar, uji
         kirim berhasil, tapi tak satu pun balasan sampai. Nama botnya disebut di
         sini supaya dugaan itu bisa dicoret dalam sedetik. */
      try {
        var mr = await fetchTO('https://api.telegram.org/bot' + TOKEN + '/getMe', {}, 5000);
        var mj = await mr.json();
        hasil.bot = (mj && mj.ok && mj.result)
          ? { nama: mj.result.first_name, username: '@' + mj.result.username, id: mj.result.id,
              cocokkan: 'Pastikan @' + mj.result.username + ' ADALAH bot yang kamu ajak bicara. Kalau bukan, token di env milik bot lain.' }
          : { error: (mj && mj.description) || 'getMe gagal' };
      } catch (eM2) { hasil.bot = { error: String(eM2 && eM2.message || eM2) }; }
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
          waktu_galat_terakhir: w.last_error_date ? new Date(w.last_error_date * 1000).toISOString() : '(tidak ada)',
          /* allowed_updates hanya muncul bila webhook didaftarkan dengan daftar
             terbatas. Kalau daftarnya tak memuat "message", Telegram TIDAK PERNAH
             mengirim pesan teks, dan itu tak meninggalkan galat maupun antrean
             sehingga tampak sehat sempurna. Bidang ini dulu tak ditampilkan. */
          jenis_update_diizinkan: w.allowed_updates || '(bawaan: semua kecuali beberapa)',
          // Sisanya ditampilkan apa adanya, supaya tak ada lagi yang tersaring diam-diam
          mentah: w
        };
        // Terjemahkan galat yang paling sering, supaya tak perlu ditafsirkan sendiri
        var lem = String(w.last_error_message || '');
        if (/403/.test(lem)) hasil.telegram.artinya = 'Ditolak 403: TELEGRAM_WEBHOOK_SECRET di Vercel BERBEDA dengan yang didaftarkan ke Telegram. Daftarkan ulang webhook-nya.';
        else if (/500/.test(lem)) hasil.telegram.artinya = 'Server membalas 500: biasanya ada env yang kosong. Lihat bagian env di atas.';
        else if (/404/.test(lem)) hasil.telegram.artinya = 'Alamat webhook tidak ditemukan: URL-nya salah atau deploy gagal.';
        else if (!w.url) hasil.telegram.artinya = 'Webhook belum didaftarkan sama sekali, jadi Telegram tak pernah mengirim apa pun ke server.';
        else if (/50[24]/.test(lem)) hasil.telegram.artinya = 'Pernah kehabisan waktu (50x): fungsi melewati batas Vercel sebelum sempat membalas.';
        else if ((w.pending_update_count || 0) > 0) hasil.telegram.artinya = 'Ada pesan menumpuk yang belum berhasil diproses.';
        else if (Array.isArray(w.allowed_updates) && w.allowed_updates.indexOf('message') < 0)
          hasil.telegram.artinya = 'Webhook TIDAK diizinkan menerima "message". Telegram tak pernah mengirim pesan teks ke server, jadi bot mustahil membalas. Daftarkan ulang webhook tanpa membatasi allowed_updates.';
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

  /* Uji KIRIM sungguhan. Selama ini seluruh penelusuran memeriksa apakah pesan
     MASUK, tak pernah apakah bot bisa MENGIRIM. Padahal sendMessage bisa ditolak
     Telegram karena chat diblokir, chat_id keliru, atau bot dikeluarkan dari
     percakapan, dan penolakan itu tak meninggalkan jejak di getWebhookInfo
     maupun di antrean. Dijalankan hanya bila diminta lewat &kirim=1. */
  if (new URL(req.url).searchParams.get('kirim') === '1' && TOKEN && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    hasil.uji_kirim = [];
    try {
      var SBU = process.env.SUPABASE_URL, SBK = process.env.SUPABASE_SERVICE_ROLE_KEY;
      var lr = await fetchTO(SBU + '/rest/v1/telegram_links?linked=eq.true&select=chat_id,user_id', { headers: { apikey: SBK, Authorization: 'Bearer ' + SBK } }, 6000);
      var links = await lr.json();
      if (!Array.isArray(links) || !links.length) {
        hasil.uji_kirim.push({ catatan: 'Tidak ada akun Telegram yang tertaut di basis data. Bot tak punya siapa pun untuk dibalas.' });
      } else {
        for (var li = 0; li < links.length && li < 5; li++) {
          var cid = links[li].chat_id;
          var sr = await fetchTO('https://api.telegram.org/bot' + TOKEN + '/sendMessage', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: cid, text: '🧪 Uji kirim dari halaman diagnosa. Kalau pesan ini sampai, bot bisa mengirim dengan normal.' })
          }, 8000);
          var sj = await sr.json();
          hasil.uji_kirim.push({
            chat_id: cid,
            berhasil: !!(sj && sj.ok),
            http: sr.status,
            jawaban_telegram: (sj && sj.ok) ? 'terkirim' : ((sj && sj.description) || 'tak diketahui'),
            kode: (sj && sj.error_code) || undefined
          });
        }
      }
    } catch (e) { hasil.uji_kirim.push({ error: String(e && e.message || e) }); }
  }

  /* Bukti apakah webhook BENAR-BENAR dijalankan. Tiap update yang diproses
     mencatat penanda di telegram_updates. Kalau ada baris baru beberapa menit
     terakhir, fungsinya jelas berjalan dan masalahnya di dalam pemrosesan.
     Kalau kosong padahal pesan sudah dikirim, Telegram tak pernah memanggil
     kita, dan seluruh penelusuran di sisi kode ini sia-sia. */
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    try {
      var SBU2 = process.env.SUPABASE_URL, SBK2 = process.env.SUPABASE_SERVICE_ROLE_KEY;
      var ur = await fetchTO(SBU2 + '/rest/v1/telegram_updates?select=update_id,created_at&order=created_at.desc&limit=5', { headers: { apikey: SBK2, Authorization: 'Bearer ' + SBK2 } }, 6000);
      var urows = await ur.json();
      if (!ur.ok) {
        hasil.webhook_dipanggil = { error: (urows && urows.message) || ('HTTP ' + ur.status), artinya: 'Tabel telegram_updates tak terbaca. Jalankan supabase-telegram-notif-setup.sql.' };
      } else if (!Array.isArray(urows) || !urows.length) {
        hasil.webhook_dipanggil = { jumlah: 0, artinya: 'BELUM PERNAH ada update tercatat. Kalau kamu sudah mengirim pesan, berarti Telegram tak pernah memanggil server ini.' };
      } else {
        var terbaru = new Date(urows[0].created_at).getTime();
        var menit = Math.round((Date.now() - terbaru) / 60000);
        hasil.webhook_dipanggil = {
          terakhir: urows[0].created_at,
          umur: menit < 60 ? menit + ' menit lalu' : Math.round(menit / 60) + ' jam lalu',
          lima_terakhir: urows.map(function (x) { return x.update_id }),
          artinya: menit < 30 ? 'Webhook BARU SAJA dijalankan, jadi pesan memang masuk dan masalahnya di dalam pemrosesan.' : 'Update terakhir sudah lama; pesan terbaru tampaknya tak sampai ke server.'
        };
      }
    } catch (e) { hasil.webhook_dipanggil = { error: String(e && e.message || e) }; }
  }

  // ── Kunci & model AI ──
  /* Daftar model dipakai sebagai uji kunci karena ia jalur lain dari endpoint
     pesan: ia tetap menjawab walau kuota pesan habis, jadi "kunci tak sah" bisa
     dipisahkan dari "kapasitas penuh" tanpa membakar satu permintaan pesan. */
  var MODEL_DIPAKAI = process.env.ANTHROPIC_MODEL || 'claude-opus-5';
  if (!AKEY) {
    hasil.ai = { error: 'ANTHROPIC_API_KEY kosong, tak bisa diperiksa.' };
  } else {
    try {
      var klien = new Anthropic({ apiKey: AKEY, maxRetries: 0, timeout: 8000 });
      var daftar = await klien.models.list();
      var nama = ((daftar && daftar.data) || []).map(function (m) { return m.id; });
      var ada = nama.indexOf(MODEL_DIPAKAI) >= 0;
      hasil.ai = {
        kunci_sah: true,
        jumlah_model: nama.length,
        model_yang_dipakai_kode: MODEL_DIPAKAI + (ada ? ' ✓ ADA' : ' ✗ TIDAK ADA'),
        tersedia: nama.slice(0, 25),
        artinya: ada
          ? 'Kunci sah dan model yang dipakai kode memang tersedia.'
          : 'Model "' + MODEL_DIPAKAI + '" TIDAK ada di kunci ini. Setel env ANTHROPIC_MODEL ke salah satu nama di daftar tersedia.'
      };
    } catch (e) {
      var st = (e && e.status) || 0;
      hasil.ai = {
        kunci_sah: false,
        http: st,
        pesan_penyedia: String((e && e.message) || e).slice(0, 300),
        /* Saldo habis dan kunci salah dibetulkan di tempat yang berbeda, jadi
           keduanya tidak boleh dijawab dengan kalimat yang sama. */
        artinya: st === 402
          ? 'Saldo kredit Anthropic habis. Kuncinya tidak apa-apa; isi ulang di console.anthropic.com pada menu Billing.'
          : (st === 401 || st === 403)
            ? 'Kunci ditolak. Masalahnya di ANTHROPIC_API_KEY, bukan kapasitas.'
            : 'Gagal menghubungi penyedia AI. Lihat pesan_penyedia.'
      };
    }
  }

  // ── Kesimpulan ringkas, supaya tak perlu membaca seluruh JSON ──
  var catatan = [];
  Object.keys(hasil.env).forEach(function (k) {
    if (k !== 'ANTHROPIC_MODEL' && k !== 'MIDTRANS_SERVER_KEY' && !hasil.env[k].ada) catatan.push('Env ' + k + ' KOSONG.');
  });
  if (hasil.telegram && hasil.telegram.artinya && hasil.telegram.artinya !== 'Webhook sehat.') catatan.push('Telegram: ' + hasil.telegram.artinya);
  if (hasil.ai && hasil.ai.artinya && (hasil.ai.kunci_sah !== true || /TIDAK ada/.test(hasil.ai.artinya))) catatan.push('AI: ' + hasil.ai.artinya);
  if (Array.isArray(hasil.uji_kirim)) {
    hasil.uji_kirim.forEach(function (u) {
      if (u.catatan) catatan.push('Kirim: ' + u.catatan);
      else if (u.berhasil === false) catatan.push('Kirim ke chat ' + u.chat_id + ' DITOLAK Telegram: ' + u.jawaban_telegram);
    });
  }
  hasil.kesimpulan = catatan.length ? catatan : ['Tidak ada masalah yang terdeteksi dari sisi pengaturan.'];

  return new Response(JSON.stringify(hasil, null, 2), {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}
