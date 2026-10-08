export const config = { runtime: 'edge' };

// =====================================================
// AMOS FILE MANAGER API  (VERSI DEBUG: error server menampilkan penyebab asli)
// Simpan folder & file teks di database (Upstash Redis), bukan di browser.
// Semua request wajib menyertakan password yang dicek di server.
//
// Environment Variables (Vercel):
//   FILES_PASSWORD             -> password untuk membuka File Manager
//   UPSTASH_REDIS_REST_URL     -> dari dashboard Upstash (atau KV_REST_API_URL)
//   UPSTASH_REDIS_REST_TOKEN   -> dari dashboard Upstash (atau KV_REST_API_TOKEN)
//   SUPABASE_URL               -> https://ID-PROJECT.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY  -> kunci rahasia Supabase (HANYA di Vercel)
//   SUPABASE_BUCKET            -> (opsional) nama bucket private, default: amos-files
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
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MB per file unggahan
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  if (!res.ok || data.error) throw new Error('Redis: ' + (data.error || ('status ' + res.status)));
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

// ---------- Supabase Storage (bucket private) ----------
function supabaseConfig() {
  const url = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const bucket = process.env.SUPABASE_BUCKET || 'amos-files';
  if (!url || !key) {
    throw new HttpError(500, 'Penyimpanan file (Supabase) belum dikonfigurasi di server');
  }
  return { url, key, bucket };
}

// Kunci baru (sb_secret_...) hanya dikirim lewat header apikey;
// kunci lama berformat JWT (eyJ...) juga dikirim sebagai Bearer.
function supabaseHeaders(key) {
  const h = { 'apikey': key, 'Content-Type': 'application/json' };
  if (key.startsWith('eyJ')) h['Authorization'] = `Bearer ${key}`;
  return h;
}

async function supabase(method, path, body) {
  const { url, key } = supabaseConfig();
  const res = await fetch(`${url}/storage/v1${path}`, {
    method,
    headers: supabaseHeaders(key),
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let data = null;
  try { data = await res.json(); } catch (e) { /* tidak ada body JSON */ }
  if (!res.ok) {
    console.error('Supabase error', res.status, data);
    const why = data && (data.message || data.error) ? String(data.message || data.error).slice(0, 150) : '';
    throw new HttpError(502, `Penyimpanan file gagal merespons (${res.status}${why ? ': ' + why : ''})`);
  }
  return data;
}

function absStorageUrl(rel) {
  const { url } = supabaseConfig();
  return /^https?:/i.test(rel) ? rel : `${url}/storage/v1${rel}`;
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

  let currentAction = 'unknown';
  let authed = false; // detail error hanya ditampilkan setelah password benar

  try {
    if (!process.env.FILES_PASSWORD) {
      throw new HttpError(500, 'FILES_PASSWORD belum diset di server');
    }

    let body;
    try { body = await req.json(); } catch (e) { throw new HttpError(400, 'Body tidak valid'); }
    body = body || {};
    const { action, password } = body;
    currentAction = String(action);

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
    authed = true;

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
          if (node.type !== 'file') throw new HttpError(400, 'Hanya file teks yang punya isi');
          assertContent(body.content);
          await redis(['HSET', CONTENT_KEY, node.id, body.content]);
          node.size = body.content.length;
        }
        node.updatedAt = Date.now();
        await redis(['HSET', META_KEY, node.id, JSON.stringify(node)]);
        return json({ node });
      }

      case 'upload-init': {
        const name = cleanName(body.name);
        const parent = body.parent || null;
        const size = Number(body.size);
        if (!Number.isFinite(size) || size <= 0) throw new HttpError(400, 'Ukuran file tidak valid');
        if (size > MAX_UPLOAD_BYTES) throw new HttpError(413, 'File terlalu besar (maks 50 MB)');

        const all = await getAllMeta();
        if (Object.keys(all).length >= MAX_NODES) throw new HttpError(400, 'Batas jumlah item tercapai');
        if (parent) {
          const p = all[parent];
          if (!p || p.type !== 'folder') throw new HttpError(404, 'Folder tujuan tidak ditemukan');
        }
        assertUniqueName(all, parent, name, null);

        const { bucket } = supabaseConfig();
        const id = crypto.randomUUID();
        const data = await supabase('POST', `/object/upload/sign/${encodeURIComponent(bucket)}/${id}`, {});
        if (!data || !data.url) throw new HttpError(502, 'Penyimpanan file gagal membuat izin unggah');
        return json({ id, uploadUrl: absStorageUrl(data.url) });
      }

      case 'upload-commit': {
        const id = body.id;
        if (typeof id !== 'string' || !UUID_RE.test(id)) throw new HttpError(400, 'ID tidak valid');
        const name = cleanName(body.name);
        const parent = body.parent || null;
        const mime = (typeof body.mime === 'string' && body.mime && body.mime.length <= 100)
          ? body.mime : 'application/octet-stream';

        const all = await getAllMeta();
        if (all[id]) throw new HttpError(409, 'File sudah tercatat');
        if (Object.keys(all).length >= MAX_NODES) throw new HttpError(400, 'Batas jumlah item tercapai');
        if (parent) {
          const p = all[parent];
          if (!p || p.type !== 'folder') throw new HttpError(404, 'Folder tujuan tidak ditemukan');
        }
        assertUniqueName(all, parent, name, null);

        // Pastikan file benar-benar sudah ada di penyimpanan
        const { bucket } = supabaseConfig();
        let info = null;
        try {
          info = await supabase('GET', `/object/info/${encodeURIComponent(bucket)}/${id}`);
        } catch (e) {
          // Cadangan: cari lewat daftar objek (endpoint info bisa berbeda antar versi Supabase)
          try {
            const found = await supabase('POST', `/object/list/${encodeURIComponent(bucket)}`, { prefix: '', search: id, limit: 5 });
            const obj = Array.isArray(found) ? found.find((o) => o.name === id) : null;
            if (obj) info = { size: obj.metadata && obj.metadata.size };
          } catch (e2) { /* diabaikan, ditangani di bawah */ }
        }
        if (!info) throw new HttpError(400, 'File belum terunggah ke penyimpanan');
        let size = Number(info && info.size);
        if (!Number.isFinite(size)) size = Number(body.size) || 0;
        if (size > MAX_UPLOAD_BYTES) throw new HttpError(413, 'File terlalu besar (maks 50 MB)');

        const node = { id, type: 'upload', name, parent, size, mime, updatedAt: Date.now() };
        await redis(['HSET', META_KEY, node.id, JSON.stringify(node)]);
        return json({ node }, 201);
      }

      case 'download-url': {
        const node = await getMeta(body.id);
        if (node.type !== 'upload') throw new HttpError(400, 'Itu bukan file unggahan');
        const { bucket } = supabaseConfig();
        const expiresIn = body.download ? 300 : 3600;
        const data = await supabase('POST', `/object/sign/${encodeURIComponent(bucket)}/${node.id}`, { expiresIn });
        const rel = data && (data.signedURL || data.signedUrl);
        if (!rel) throw new HttpError(502, 'Penyimpanan file gagal membuat link');
        let url = absStorageUrl(rel);
        if (body.download) {
          url += (url.includes('?') ? '&' : '?') + 'download=' + encodeURIComponent(node.name);
        }
        return json({ url });
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

        // Hapus juga file unggahan di Supabase (sebelum catatannya dihapus)
        const uploadIds = ids.filter(i => all[i] && all[i].type === 'upload');
        if (uploadIds.length) {
          const { bucket } = supabaseConfig();
          await supabase('DELETE', `/object/${encodeURIComponent(bucket)}`, { prefixes: uploadIds });
        }

        await redis(['HDEL', META_KEY, ...ids]);
        await redis(['HDEL', CONTENT_KEY, ...ids]);
        return json({ deleted: ids.length });
      }

      default:
        throw new HttpError(400, 'Action tidak dikenal');
    }
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message }, err.status);
    console.error('files api error [' + currentAction + ']', err);
    // DEBUG: tampilkan penyebab asli, tapi hanya kalau password sudah benar
    const detail = authed
      ? ' [' + currentAction + '] ' + String((err && err.message) || err).slice(0, 200)
      : '';
    return json({ error: 'Terjadi kesalahan di server' + detail }, 500);
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
