# OpenRouter AI Chat

Website chat AI pribadi yang terhubung ke [OpenRouter](https://openrouter.ai),
dengan API key yang disimpan aman di backend (bukan di browser). Awalnya
dibuat & diuji coba dari Termux (Android), lalu dikembangkan penuh menjadi
website dengan backend serverless di Vercel.

**Live:** https://openrouter-chat-web.vercel.app

---

## Fitur

- Chat AI dasar dengan percakapan berkelanjutan (context tersimpan dalam satu chat)
- Riwayat chat: New Chat, Delete Chat, Rename, Switch antar chat
- Search/cari di riwayat chat
- Export chat ke file `.txt`
- Pilihan model OpenRouter (dropdown: GPT-4o mini, Claude 3.5 Sonnet, Gemini Flash 1.5, Llama 3.1 8B free)
- Streaming jawaban AI (huruf demi huruf)
- Dark mode (tersimpan di localStorage)
- Tampilan responsif, nyaman dipakai di HP
- Password gate sederhana supaya API key tidak disalahgunakan kalau URL bocor
- Rate limit sederhana (maks 15 pesan/menit, client-side)
- Tombol Copy di tiap balasan AI + indikator "AI sedang mengetik..."
- Pesan error yang ramah (password salah, koneksi putus, server error)
- API key **tidak pernah** ada di frontend — hanya disimpan sebagai Environment
  Variable di Vercel dan diakses lewat backend `api/chat.js`

## Struktur Repo

```
openrouter-chat-web/
├── api/
│   └── chat.js       # Backend, Vercel Edge Function (proxy ke OpenRouter + password check + streaming)
├── index.html         # Frontend, semua fitur ada di satu file ini
└── README.md
```

## Cara Kerja

1. Frontend (`index.html`) mengirim pesan + password ke `/api/chat`.
2. Backend (`api/chat.js`) mengecek password terhadap `CHAT_PASSWORD`, lalu
   meneruskan request ke OpenRouter memakai `OPENROUTER_API_KEY` yang
   tersimpan sebagai Environment Variable — API key tidak pernah terekspos
   ke browser.
3. Kalau `stream: true`, respons OpenRouter di-*passthrough* langsung sebagai
   `text/event-stream` supaya jawaban muncul huruf demi huruf.
4. Semua riwayat chat, model pilihan, dan dark mode disimpan di
   `localStorage` browser (per device, tidak sinkron antar perangkat).

## Environment Variables (Vercel)

Diset lewat **Settings → Environment Variables** di dashboard Vercel:

| Key | Fungsi |
|---|---|
| `OPENROUTER_API_KEY` | API key dari OpenRouter, dipakai backend untuk memanggil OpenRouter |
| `CHAT_PASSWORD` | Password proteksi akses chat, dicek oleh backend sebelum meneruskan request |

> Jangan pernah menampilkan atau membagikan isi variable ini di mana pun.

## Deploy

Repo ini terhubung otomatis ke Vercel (plan Hobby). Setiap commit baru ke
branch `main` otomatis di-build dan di-deploy ulang — tidak perlu perintah
deploy manual.

## Roadmap / Belum Dikerjakan

- **Upload gambar** — kirim foto lalu tanya ke AI (butuh model vision seperti
  `openai/gpt-4o-mini` atau `anthropic/claude-3.5-sonnet`, format `messages`
  perlu diubah jadi multi-part teks + gambar base64/URL)
- **Generate gambar dari teks** — perlu model image-generation terpisah,
  masih perlu dicek dukungan model apa saja yang tersedia di OpenRouter
- Rate limiting yang lebih kuat & persisten di server (Vercel KV / Upstash Redis)
- Custom domain
- Sistem login per-user yang lebih kuat (kalau nanti dipakai banyak orang)

## Catatan

- Versi awal di Termux (`chat.py`) tetap disimpan sebagai riwayat proyek dan
  tidak dihapus.

---

Powered by Amos'rcpdroid86
