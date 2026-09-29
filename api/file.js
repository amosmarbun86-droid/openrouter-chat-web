export const config = { runtime: 'edge' };

// =====================================================
// AMOS FILE MANAGER API
// Simpan folder & file teks di database (Upstash Redis), bukan di browser.
// Semua request wajib menyertakan password yang dicek di server.
//
// Environment Variables (Vercel):
//   FILES_PASSWORD             -> password untuk membuka File Manager
//   UPSTASH_REDIS_REST_URL     -> dari dashboard Upstash (atau KV_REST_API_URL)
//   UPSTASH_REDIS_REST_TOKEN   -> dari dashboard Upstash (atau KV_REST_API_TOKEN)
// =====================================================

// Origin yang boleh memanggil API ini dari browser (CORS).
const ALLOWED_ORIGINS = [
  'https://amosmarbun86-droid.github.io',
  'https://openrouter-chat-web.vercel.app'
];

const META_KEY = 'amos:files:meta';       // id -> JSON { id, type, name, parent, size, updatedAt }
const CONTENT_KEY = 'amos:files:content'; // id -> isi file (teks)

const MAX_NAME_LEN = 80;
const MAX_CONTENT_LEN = 200000; // karakter per file
const MAX_NODES = 2000;         // total folder + file
const MAX_FAILS = 5;            // salah password maksimal per IP
const FAIL_WINDOW_SEC = 600;    // dalam 10 menit

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

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

// Bandingkan string dengan waktu konstan
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// ---------- Redis (Upstash REST) ----------
async function redis(cmd) {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new HttpError(500, 'Database belum dikonfigurasi di server');

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd)
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error || 'Redis error');
  return data.result;
}

async function getAllMeta() {
  const raw = (await redis(['HGETALL', META_KEY])) || [];
  const map = {};
  if (Array.isArray(raw)) {
    for (let i = 0; i < raw.length; i += 2) {
      try { map[raw[i]] = JSON.parse(raw[i + 1]); } catch (e) { /* lewati data rusak */ }
    }
  } else {
    for (const [k, v] of Object.entries(raw)) {
      try { map[k] = typeof v === 'string' ? JSON.parse(v) : v; } catch (e) { /* lewati */ }
    }
  }
  return map;
}

async function getMeta(id) {
  if (typeof id !== 'string' || !id || id.length > 64) throw new HttpError(400, 'ID tidak valid');
  const raw = await redis(['HGET', META_KEY, id]);
  if (!raw) throw new HttpError(404, 'Item tidak ditemukan');
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

// ---------- Validasi ----------
function cleanName(v) {
  const n = String(v === undefined || v === null ? '' : v).trim();
  if (!n) throw new HttpError(400, 'Nama tidak boleh kosong');
  if (n.length > MAX_NAME_LEN) throw new HttpError(400, `Nama maksimal ${MAX_NAME_LEN} karakter`);
  if (/[\/\\]/.test(n)) throw new HttpError(400, 'Nama tidak boleh mengandung / atau \\');
  return n;
}

function assertUniqueName(all, parent, name, ignoreId) {
  const lower = name.toLowerCase();
  const clash = Object.values(all).some(n =>
    n.id !== ignoreId &&
    (n.parent || null) === (parent || null) &&
    n.name.toLowerCase() === lower
  );
  if (clash) throw new HttpError(409, 'Nama sudah dipakai di folder ini');
}

function assertContent(content) {
  if (typeof content !== 'string') throw new HttpError(400, 'Isi file harus berupa teks');
  if (content.length > MAX_CONTENT_LEN) {
    throw new HttpError(413, `Isi file terlalu besar (maks ${MAX_CONTENT_LEN} karakter)`);
  }
}

// ---------- Handler utama ----------
async function mainHandler(req) {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    if (!process.env.FILES_PASSWORD) {
      throw new HttpError(500, 'FILES_PASSWORD belum diset di server');
    }

    let body;
    try { body = await req.json(); } catch (e) { throw new HttpError(400, 'Body tidak valid'); }
    body = body || {};
    const { action, password } = body;

    // Batasi percobaan password salah per IP
    const ip = (req.headers.get('x-forwarded-for') || 'unknown').split(',')[0].trim();
    const failKey = `amos:files:fail:${ip}`;
    const fails = parseInt((await redis(['GET', failKey])) || '0', 10);
    if (fails >= MAX_FAILS) {
      throw new HttpError(429, 'Terlalu banyak percobaan salah. Coba lagi beberapa menit lagi.');
    }
    if (!safeEqual(String(password || ''), process.env.FILES_PASSWORD)) {
      const n = await redis(['INCR', failKey]);
      if (n === 1) await redis(['EXPIRE', failKey, FAIL_WINDOW_SEC]);
      throw new HttpError(401, 'Password salah');
    }
    if (fails > 0) await redis(['DEL', failKey]);

    switch (action) {
      case 'auth':
        return json({ ok: true });

      case 'list': {
        const all = await getAllMeta();
        return json({ nodes: Object.values(all) });
      }

      case 'read': {
        const node = await getMeta(body.id);
        if (node.type !== 'file') throw new HttpError(400, 'Itu bukan file');
        const content = (await redis(['HGET', CONTENT_KEY, node.id])) || '';
        return json({ node, content });
      }

      case 'create': {
        const type = body.type;
        if (type !== 'folder' && type !== 'file') throw new HttpError(400, 'Tipe tidak valid');
        const name = cleanName(body.name);
        const parent = body.parent || null;

        const all = await getAllMeta();
        if (Object.keys(all).length >= MAX_NODES) {
          throw new HttpError(400, 'Batas jumlah item tercapai');
        }
        if (parent) {
          const p = all[parent];
          if (!p || p.type !== 'folder') throw new HttpError(404, 'Folder tujuan tidak ditemukan');
        }
        assertUniqueName(all, parent, name, null);

        let content = '';
        if (type === 'file' && body.content !== undefined) {
          assertContent(body.content);
          content = body.content;
        }

        const node = {
          id: crypto.randomUUID(),
          type,
          name,
          parent,
          size: type === 'file' ? content.length : 0,
          updatedAt: Date.now()
        };
        await redis(['HSET', META_KEY, node.id, JSON.stringify(node)]);
        if (type === 'file' && content) await redis(['HSET', CONTENT_KEY, node.id, content]);
        return json({ node }, 201);
      }

      case 'update': {
        const node = await getMeta(body.id);

        if (body.name !== undefined) {
          const name = cleanName(body.name);
          const all = await getAllMeta();
          assertUniqueName(all, node.parent || null, name, node.id);
          node.name = name;
        }
        if (body.content !== undefined) {
          if (node.type !== 'file') throw new HttpError(400, 'Folder tidak punya isi');
          assertContent(body.content);
          await redis(['HSET', CONTENT_KEY, node.id, body.content]);
          node.size = body.content.length;
        }
        node.updatedAt = Date.now();
        await redis(['HSET', META_KEY, node.id, JSON.stringify(node)]);
        return json({ node });
      }

      case 'delete': {
        const target = await getMeta(body.id);
        const all = await getAllMeta();

        // Kumpulkan item ini + semua isi di dalamnya (rekursif)
        const toDelete = new Set([target.id]);
        let added = true;
        while (added) {
          added = false;
          for (const n of Object.values(all)) {
            if (n.parent && toDelete.has(n.parent) && !toDelete.has(n.id)) {
              toDelete.add(n.id);
              added = true;
            }
          }
        }
        const ids = [...toDelete];
        await redis(['HDEL', META_KEY, ...ids]);
        await redis(['HDEL', CONTENT_KEY, ...ids]);
        return json({ deleted: ids.length });
      }

      default:
        throw new HttpError(400, 'Action tidak dikenal');
    }
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message }, err.status);
    console.error(err);
    return json({ error: 'Terjadi kesalahan di server' }, 500);
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
