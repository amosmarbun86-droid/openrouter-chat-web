export const config = { runtime: 'edge' };

// Origin yang boleh memanggil API ini dari browser (CORS).
// Tambahkan domain lain di sini kalau perlu.
const ALLOWED_ORIGINS = [
  'https://amosmarbun86-droid.github.io',
  'https://openrouter-chat-web.vercel.app'
];

function corsHeaders(req) {
  const origin = req.headers.get('origin');
  const h = { 'Vary': 'Origin' };
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
    h['Access-Control-Allow-Headers'] = 'Content-Type';
    h['Access-Control-Max-Age'] = '86400';
  }
  return h;
}

// Model default untuk mode "Generate Gambar".
// Bisa dioverride lewat Environment Variable IMAGE_MODEL di Vercel tanpa ubah kode.
// PENTING: cek dulu di https://openrouter.ai/models (filter "Image" / "modalities: image")
// untuk memastikan nama model yang tersedia saat ini, karena daftar model OpenRouter
// bisa berubah sewaktu-waktu.
const DEFAULT_IMAGE_MODEL = 'google/gemini-2.5-flash-image-preview';

async function mainHandler(req) {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
  }

  try {
    const body = await req.json();
    const { messages, model, stream, password, mode, prompt } = body;

    if (process.env.CHAT_PASSWORD && password !== process.env.CHAT_PASSWORD) {
      return new Response(JSON.stringify({ error: 'Password salah' }), { status: 401 });
    }

    // ===== Mode: Generate Gambar dari Teks =====
    if (mode === 'image') {
      if (!prompt || !prompt.trim()) {
        return new Response(JSON.stringify({ error: 'Prompt gambar kosong' }), { status: 400 });
      }

      const imgModel = process.env.IMAGE_MODEL || DEFAULT_IMAGE_MODEL;

      const upstream = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: imgModel,
          messages: [{ role: 'user', content: prompt }],
          modalities: ['image', 'text'],
          stream: false
        })
      });

      const data = await upstream.json();

      if (!upstream.ok) {
        return new Response(JSON.stringify({ error: data.error?.message || 'Gagal membuat gambar' }), {
          status: upstream.status
        });
      }

      const msg = data.choices?.[0]?.message || {};
      // OpenRouter mengembalikan gambar lewat field message.images (format: [{ image_url: { url: "data:image/..." } }])
      const images = (msg.images || [])
        .map(img => img?.image_url?.url)
        .filter(Boolean);

      return new Response(JSON.stringify({
        text: msg.content || '',
        images: images
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // ===== Mode: Chat biasa (termasuk vision, jika `messages` berisi content multi-part) =====
    const upstream = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: model || 'openai/gpt-4o-mini',
        messages: messages,
        stream: !!stream
      })
    });

    if (!stream) {
      const data = await upstream.json();
      return new Response(JSON.stringify(data), {
        status: upstream.status,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      }
    });

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
}

export default async function handler(req) {
  const cors = corsHeaders(req);

  // Preflight request dari browser
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  const res = await mainHandler(req);
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(cors)) headers.set(k, v);
  return new Response(res.body, { status: res.status, headers });
}
