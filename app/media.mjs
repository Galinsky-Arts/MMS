import {HttpError} from './http.mjs';
import {sha256} from './security.mjs';

/** Media is accepted as links to YouTube, Vimeo or SoundCloud, or as small encrypted uploads in Postgres. */
const HOSTS = {
 youtube: ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'],
 vimeo: ['vimeo.com', 'www.vimeo.com', 'player.vimeo.com'],
 soundcloud: ['soundcloud.com', 'www.soundcloud.com', 'm.soundcloud.com'],
};
export function mediaLink(value, {required = false, name = 'Media link'} = {}) {
 const s = String(value ?? '').trim();
 if (!s) { if (required) throw new HttpError(400, `${name} is required`); return null; }
 let u;
 try { u = new URL(s); } catch { throw new HttpError(400, `${name} must be a full https:// link`); }
 if (u.protocol !== 'https:' || u.username || u.password || s.length > 500) throw new HttpError(400, `${name} must be an https link`);
 const host = u.hostname.toLowerCase();
 if (!Object.values(HOSTS).some(list => list.includes(host))) throw new HttpError(400, `${name} must be a YouTube, Vimeo or SoundCloud link`);
 return u.href;
}
/** Returns a privacy-friendly embeddable player URL, or null when the link cannot be embedded. */
export function embedUrl(link) {
 if (!link) return null;
 let u; try { u = new URL(link); } catch { return null; }
 const host = u.hostname.toLowerCase();
 if (HOSTS.youtube.includes(host)) {
  const id = host === 'youtu.be' ? u.pathname.slice(1) : (u.searchParams.get('v') || (/^\/(?:embed|shorts|live)\/([\w-]{6,20})/.exec(u.pathname) || [])[1]);
  return id && /^[\w-]{6,20}$/.test(id) ? 'https://www.youtube-nocookie.com/embed/' + id : null;
 }
 if (HOSTS.vimeo.includes(host)) {
  const id = (/(\d{5,12})/.exec(u.pathname) || [])[1];
  return id ? 'https://player.vimeo.com/video/' + id : null;
 }
 if (HOSTS.soundcloud.includes(host)) return 'https://w.soundcloud.com/player/?url=' + encodeURIComponent(u.href);
 return null;
}
export const FRAME_SOURCES = 'https://www.youtube-nocookie.com https://player.vimeo.com https://w.soundcloud.com';

export const UPLOAD_KINDS = Object.freeze({
 headshot: {mimes: ['image/jpeg', 'image/png', 'image/webp'], label: 'Headshot'},
 resume: {mimes: ['application/pdf'], label: 'Résumé'},
});
function magic(bytes, mime) {
 if (mime === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
 if (mime === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
 if (mime === 'image/webp') return bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP';
 if (mime === 'application/pdf') return bytes.subarray(0, 5).toString() === '%PDF-';
 return false;
}
export function sniff(bytes) {
 for (const mime of ['image/jpeg', 'image/png', 'image/webp', 'application/pdf']) if (magic(bytes, mime)) return mime;
 return null;
}
export function validateUpload(file, kind, maxBytes) {
 if (!file) return null;
 const spec = UPLOAD_KINDS[kind];
 if (!spec) throw new HttpError(400, 'Unsupported upload');
 if (file.data.length > maxBytes) throw new HttpError(413, `${spec.label} exceeds the ${Math.floor(maxBytes / 1024)} KB upload limit; use a link instead.`);
 const mime = sniff(file.data);
 if (!mime || !spec.mimes.includes(mime)) throw new HttpError(400, `${spec.label} must be ${kind === 'resume' ? 'a PDF' : 'a JPEG, PNG or WebP image'}.`);
 return {kind, mime, data: file.data, sha256: sha256(file.data)};
}
export async function storeUpload(db, keys, {ownerId, applicationId, upload}) {
 const aad = `media:${ownerId}:${upload.kind}`;
 const enc = keys.encrypt(upload.data, aad);
 const {rows} = await db.query(`INSERT INTO media(owner_user_id,application_id,kind,mime,size,sha256,iv,tag,ciphertext) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
  [ownerId, applicationId, upload.kind, upload.mime, upload.data.length, upload.sha256, enc.iv, enc.tag, enc.ciphertext]);
 return Number(rows[0].id);
}
export async function loadUpload(db, keys, id) {
 const {rows} = await db.query('SELECT * FROM media WHERE id=$1', [id]);
 const r = rows[0];
 if (!r) return null;
 const data = keys.decrypt({iv: r.iv, tag: r.tag, ciphertext: r.ciphertext}, `media:${r.owner_user_id}:${r.kind}`);
 if (sha256(data) !== r.sha256) return null;
 return {id: Number(r.id), ownerId: Number(r.owner_user_id), applicationId: r.application_id && Number(r.application_id), kind: r.kind, mime: r.mime, data};
}
