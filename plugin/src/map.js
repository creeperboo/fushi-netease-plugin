'use strict';

function str(v) {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

function sid(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'string' && v.trim() !== '') return v.trim();
  return undefined;
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function nonNegInt(v) {
  const n = num(v);
  return n !== undefined && n >= 0 ? Math.round(n) : undefined;
}

function absUrl(v) {
  const s = str(v);
  if (!s) return undefined;
  const absolute = s.indexOf('//') === 0 ? 'https:' + s : s;
  if (!/^https?:\/\//i.test(absolute)) return undefined;
  return absolute.replace(/^http:\/\/([a-z0-9-]+\.(?:music|vod)\.126\.net\/)/i, 'https://$1');
}

function day(ms) {
  const n = num(ms);
  if (n === undefined || n <= 0) return undefined;
  const d = new Date(n);
  const t = d.getTime();
  if (!Number.isFinite(t) || t <= 0) return undefined;
  const text = d.toISOString().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : undefined;
}

function dateValue(v) {
  if (typeof v === 'string') {
    const s = v.trim();
    if (/^\d{4}(-\d{2})?(-\d{2})?$/.test(s)) return s;
  }
  return day(v);
}

function artistRefs(list) {
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    if (!item || typeof item !== 'object') continue;
    const name = str(item.name) || str(item.nickname);
    if (!name) continue;
    const ref = { name };
    const id = sid(item.id);
    if (id && id !== '0') ref.id = id;
    out.push(ref);
  }
  return out.length ? out : undefined;
}

function pickArtists(raw) {
  const list = Array.isArray(raw.ar) ? raw.ar : Array.isArray(raw.artists) ? raw.artists : [];
  return artistRefs(list);
}

function pickAlbumRef(raw) {
  const al = raw.al && typeof raw.al === 'object' ? raw.al : raw.album && typeof raw.album === 'object' ? raw.album : null;
  if (!al) return undefined;
  const title = str(al.name) || str(al.title);
  if (!title) return undefined;
  const ref = { title };
  const id = sid(al.id);
  if (id && id !== '0') ref.id = id;
  return ref;
}

function pickCover(raw) {
  const al = raw.al && typeof raw.al === 'object' ? raw.al : raw.album && typeof raw.album === 'object' ? raw.album : null;
  return absUrl(al && (al.picUrl || al.pic)) || absUrl(raw.picUrl) || absUrl(raw.coverUrl) || absUrl(raw.cover) || undefined;
}

function privilegeOf(raw, privilegeMap) {
  if (raw && raw.privilege && typeof raw.privilege === 'object') return raw.privilege;
  const id = sid(raw && raw.id);
  if (id && privilegeMap && privilegeMap[id] && typeof privilegeMap[id] === 'object') return privilegeMap[id];
  return null;
}

/// playable / note heuristic. vip = the signed-in account has a paid tier.
function playability(raw, privilegeMap, vip, vipKnown) {
  const p = privilegeOf(raw, privilegeMap);
  const st = num(p && p.st) !== undefined ? num(p.st) : num(raw && raw.st);
  const fee = num(p && p.fee) !== undefined ? num(p.fee) : num(raw && raw.fee);
  if (st !== undefined && st < 0) return { playable: false, note: '无版权' };
  if (fee === 4) return { playable: false, note: '付费' };
  if (fee === 1 && !vip) {
    // 会员状态未知时不要误杀：让播放请求给出真实的会员/版权错误。
    if (vipKnown === false) return { note: 'VIP' };
    return { playable: false, note: 'VIP' };
  }
  return {};
}

function privilegeMapOf(list) {
  const map = Object.create(null);
  for (const p of Array.isArray(list) ? list : []) {
    const id = sid(p && p.id);
    if (id) map[id] = p;
  }
  return map;
}

function mapTrack(raw, opts) {
  if (!raw || typeof raw !== 'object') return null;
  const id = sid(raw.id);
  const title = str(raw.name) || str(raw.title);
  if (!id || !title) return null;
  const options = opts || {};
  const track = { id, title };
  const artists = pickArtists(raw);
  if (artists) track.artists = artists;
  const album = pickAlbumRef(raw);
  if (album) track.album = album;
  const duration = num(raw.dt) !== undefined ? num(raw.dt) : num(raw.duration);
  if (duration !== undefined && duration > 0) track.durationMs = Math.round(duration);
  const cover = pickCover(raw);
  if (cover) track.coverUrl = cover;
  const no = nonNegInt(raw.no);
  if (no !== undefined) track.trackNo = no;
  const disc = nonNegInt(raw.cd) !== undefined ? nonNegInt(raw.cd) : nonNegInt(raw.disc);
  if (disc !== undefined) track.discNo = disc;
  const mv = num(raw.mv);
  if (mv !== undefined && mv > 0) track.mvId = String(mv);
  const flag = playability(raw, options.privileges, !!options.vip, options.vipKnown);
  if (flag.note) track.note = flag.note;
  if (flag.playable === false) {
    track.playable = false;
  } else if (options.markPlayable) {
    track.playable = true;
  }
  return track;
}

function mapTracks(list, opts) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const t = mapTrack(raw, opts);
    if (t) out.push(t);
  }
  return out;
}

function mapAlbum(raw, opts) {
  if (!raw || typeof raw !== 'object') return null;
  const id = sid(raw.id);
  const title = str(raw.name) || str(raw.title);
  if (!id || !title) return null;
  const album = { id, title };
  const artists = pickArtists(raw);
  if (artists) album.artists = artists;
  const cover = absUrl(raw.picUrl) || absUrl(raw.coverUrl) || absUrl(raw.cover);
  if (cover) album.coverUrl = cover;
  const release = day(raw.publishTime);
  if (release) {
    album.releaseDate = release;
    album.year = Number(release.slice(0, 4));
  }
  const count = nonNegInt(raw.size) !== undefined ? nonNegInt(raw.size) : nonNegInt(raw.trackCount);
  if (count !== undefined) album.trackCount = count;
  const company = str(raw.company);
  if (company) album.company = company;
  const description = str(raw.description) || str(raw.briefDesc);
  if (description) album.description = description;
  return album;
}

function mapArtist(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = sid(raw.id);
  const name = str(raw.name);
  if (!id || !name) return null;
  const artist = { id, name };
  const cover = absUrl(raw.picUrl) || absUrl(raw.img1v1Url) || absUrl(raw.cover);
  if (cover) artist.coverUrl = cover;
  const aliases = [];
  const pushAlias = (v) => {
    const s = str(v);
    if (s && aliases.indexOf(s) < 0 && aliases.length < 10) aliases.push(s);
  };
  for (const a of Array.isArray(raw.alias) ? raw.alias : []) pushAlias(a);
  pushAlias(raw.trans);
  if (aliases.length) artist.aliases = aliases;
  const description = str(raw.briefDesc) || str(raw.description);
  if (description) artist.description = description;
  const intro = [];
  for (const p of Array.isArray(raw.introduction) ? raw.introduction : []) {
    if (!p || typeof p !== 'object') continue;
    const text = str(p.txt) || str(p.text);
    if (!text) continue;
    const entry = { text };
    const title = str(p.ti) || str(p.title);
    if (title) entry.title = title;
    intro.push(entry);
  }
  if (intro.length) artist.intro = intro;
  const stats = {};
  const trackCount = nonNegInt(raw.musicSize);
  const albumCount = nonNegInt(raw.albumSize);
  const mvCount = nonNegInt(raw.mvSize);
  const fanCount = nonNegInt(raw.fansCount) !== undefined ? nonNegInt(raw.fansCount) : nonNegInt(raw.fans);
  if (trackCount !== undefined) stats.trackCount = trackCount;
  if (albumCount !== undefined) stats.albumCount = albumCount;
  if (mvCount !== undefined) stats.mvCount = mvCount;
  if (fanCount !== undefined) stats.fanCount = fanCount;
  if (Object.keys(stats).length) artist.stats = stats;
  return artist;
}

function mapMv(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = sid(raw.id);
  const title = str(raw.name) || str(raw.title);
  if (!id || !title) return null;
  const mv = { id, title };
  let artists = pickArtists(raw);
  if (!artists && str(raw.artistName)) {
    const ref = { name: str(raw.artistName) };
    const artistId = sid(raw.artistId);
    if (artistId && artistId !== '0') ref.id = artistId;
    artists = [ref];
  }
  if (artists) mv.artists = artists;
  const cover =
    absUrl(raw.picUrl) || absUrl(raw.cover) || absUrl(raw.img1v1Url) ||
    absUrl(raw.imgurl) || absUrl(raw.imgurl16v9);
  if (cover) mv.coverUrl = cover;
  const duration = num(raw.duration);
  if (duration !== undefined && duration > 0) mv.durationMs = Math.round(duration);
  const playCount = nonNegInt(raw.playCount);
  if (playCount !== undefined) mv.playCount = playCount;
  const publish = dateValue(raw.publishTime);
  if (publish) mv.publishDate = publish;
  return mv;
}

function mapPlaylist(raw, opts) {
  if (!raw || typeof raw !== 'object') return null;
  const id = sid(raw.id);
  const title = str(raw.name) || str(raw.title);
  if (!id || !title) return null;
  const playlist = { id, title };
  const cover = absUrl(raw.coverImgUrl) || absUrl(raw.picUrl) || absUrl(raw.coverUrl);
  if (cover) playlist.coverUrl = cover;
  const trackCount = nonNegInt(raw.trackCount);
  if (trackCount !== undefined) playlist.trackCount = trackCount;
  const creator = raw.creator && typeof raw.creator === 'object' ? raw.creator : null;
  const owner = str(creator && creator.nickname) || str(raw.owner);
  if (owner) playlist.owner = owner;
  const description = str(raw.description);
  if (description) playlist.description = description;
  const playCount = nonNegInt(raw.playCount) !== undefined ? nonNegInt(raw.playCount) : nonNegInt(raw.playcount);
  if (playCount !== undefined) playlist.playCount = playCount;
  const tags = [];
  for (const tag of Array.isArray(raw.tags) ? raw.tags : []) {
    const s = str(tag);
    if (s && tags.indexOf(s) < 0) tags.push(s);
  }
  if (tags.length) playlist.tags = tags;
  const options = opts || {};
  const preview = mapTracks(Array.isArray(options.preview) ? options.preview.slice(0, 3) : [], options);
  if (preview.length) playlist.previewTracks = preview;
  return playlist;
}

module.exports = {
  str,
  sid,
  num,
  nonNegInt,
  absUrl,
  privilegeMapOf,
  mapTrack,
  mapTracks,
  mapAlbum,
  mapArtist,
  mapMv,
  mapPlaylist,
};
