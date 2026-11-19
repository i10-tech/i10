import type { Template } from "../types.js"
import { authoring } from "./define.js"

const t = authoring("id")

/** Indonesian: Anda throughout. */
export const ID: Template[] = [
  t(
    "password-reset",
    "consumer-friendly",
    ["Atur ulang kata sandi {product} Anda", "Pulihkan akses ke akun {product} Anda"],
    [
      "Halo {first},",
      "Kami menerima permintaan untuk mengatur ulang kata sandi akun {product} Anda.",
      { cta: "Atur ulang kata sandi", url: "{link:reset}" },
      "Tautan ini berlaku selama {minutes} menit. Jika Anda tidak merasa memintanya, abaikan email ini dan kata sandi Anda tidak akan berubah.",
      "{product} tidak pernah meminta kata sandi Anda lewat email.",
    ],
  ),
  t(
    "email-verification",
    "dev-terse",
    ["Konfirmasi email Anda di {product}"],
    [
      "Halo {first}, selamat datang di {product}.",
      "Konfirmasi bahwa {email} adalah alamat Anda untuk mengaktifkan akun.",
      { cta: "Konfirmasi email", url: "{link:verify}" },
      "Tautan berlaku selama {hours} jam. Jika Anda tidak membuat akun, abaikan pesan ini.",
    ],
  ),
  t(
    "otp-code",
    "formal-bank",
    ["{code} adalah kode keamanan {product} Anda", "Kode verifikasi {product} Anda"],
    [
      "Yth. {name},",
      "Kode verifikasi Anda adalah:",
      { code: "{code}" },
      "Kode berlaku selama {minutes} menit. Jangan berikan kepada siapa pun: {product} tidak pernah memintanya lewat email, telepon, atau pesan singkat.",
      "Jika Anda tidak mencoba masuk, abaikan pesan ini.",
    ],
  ),
  t(
    "magic-link",
    "consumer-friendly",
    ["Tautan masuk Anda ke {product}"],
    [
      "Halo {first},",
      "Ketuk tombol di bawah untuk masuk tanpa kata sandi.",
      { cta: "Masuk", url: "{link:magic}" },
      "Tautan hanya bisa dipakai sekali dan berlaku selama {minutes} menit. Jika bukan Anda yang memintanya, abaikan email ini.",
    ],
  ),
  t(
    "new-device-alert",
    "formal-bank",
    [
      "Login baru ke akun {product} Anda",
      "Pemberitahuan keamanan: login dari perangkat baru",
    ],
    [
      "Yth. {name},",
      "Kami mendeteksi login ke akun Anda dari perangkat yang belum pernah kami lihat.",
      {
        rows: [
          ["Perangkat", "{device}"],
          ["Perkiraan lokasi", "{location}"],
          ["Tanggal dan waktu", "{date}, {time}"],
        ],
      },
      "Jika itu Anda, tidak ada yang perlu dilakukan. Jika Anda tidak mengenali aktivitas ini, segera ganti kata sandi Anda.",
      { cta: "Periksa keamanan akun", url: "{link:security}" },
      "{product} tidak pernah meminta kata sandi atau kode Anda lewat email.",
    ],
  ),
  t(
    "password-changed",
    "consumer-friendly",
    ["Kata sandi {product} Anda telah diubah"],
    [
      "Halo {first},",
      "Kata sandi akun Anda ({email}) diubah pada {date}.",
      "Jika itu Anda, tidak ada yang perlu dilakukan. Jika bukan, atur ulang kata sandi dan hubungi kami di {support}.",
      { cta: "Atur ulang kata sandi", url: "{link:reset}" },
    ],
  ),
  t(
    "receipt",
    "formal-bank",
    ["Tanda terima pembayaran {product} Anda", "Konfirmasi pembayaran {invoice}"],
    [
      "Yth. {name},",
      "Terima kasih atas pembayaran Anda. Berikut rinciannya:",
      {
        rows: [
          ["Faktur", "{invoice}"],
          ["Tanggal", "{date}"],
          ["Paket", "{plan} (per {period})"],
          ["Total", "{amount}"],
        ],
      },
      { cta: "Unduh faktur", url: "{link:invoices}" },
      "Jika ada pertanyaan tentang tagihan ini, tulis ke {support}.",
    ],
  ),
  t(
    "team-invitation",
    "consumer-friendly",
    [
      "{inviter} mengundang Anda ke {team}",
      "Undangan bergabung dengan {team} di {product}",
    ],
    [
      "Halo,",
      "{inviter} mengundang Anda untuk bergabung dengan tim {team} di {product}.",
      { cta: "Terima undangan", url: "{link:invite}" },
      "Undangan berlaku selama {days} hari. Jika Anda tidak mengenal {inviter}, abaikan email ini.",
    ],
  ),
  t(
    "welcome",
    "small-shop",
    ["Selamat datang di {product}", "{first}, akun {product} Anda sudah siap"],
    [
      "Halo {first},",
      "Akun {product} Anda sudah siap. Untuk memulai, kami sarankan:",
      {
        list: ["Lengkapi profil Anda", "Undang tim Anda", "Baca panduan memulai"],
      },
      { cta: "Mulai", url: "{link:start}" },
      "Butuh bantuan? Tulis ke {support}.",
    ],
  ),
  t(
    "urgent-security-alert",
    "formal-bank",
    [
      "Peringatan keamanan: satu upaya login diblokir",
      "Tindakan diperlukan: aktivitas mencurigakan di akun Anda",
    ],
    [
      "Yth. {name},",
      "Kami memblokir upaya login ke akun Anda dari {location} ({ip}).",
      "Jika itu bukan Anda, ganti kata sandi Anda dalam {hours} jam.",
      { cta: "Amankan akun saya", url: "{link:security}" },
      "{product} tidak pernah meminta kata sandi, PIN, atau kode Anda lewat email maupun telepon.",
    ],
  ),
]
