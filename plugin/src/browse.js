'use strict';

const { TTL, LIMITS, cacheGet, cacheSet } = require('./state.js');
const net = require('./net.js');
const auth = require('./auth.js');
const {
  str, sid, privilegeMapOf, mapTrack, mapTracks, mapAlbum, mapArtist, mapMv, mapPlaylist,
} = require('./map.js');

const SEARCH_TYPES = { song: 1, album: 10, artist: 100, playlist: 1000 };

function idArg(id, what) {
  const s = sid(id);
  if (!s || !/^\d+$/.test(s)) throw new net.ApiError(what + ' ID 无效');
  return s;
}

function pageArgs(page, pageSize, maxSize) {
  const p = Number(page);
  const s = Number(pageSize);
  const pg = Number.isFinite(p) && p > 0 ? Math.floor(p) : 0;
  const size = Math.max(1, Math.min(maxSize, Number.isFinite(s) && s > 0 ? Math.floor(s) : 10));
  return { page: pg, size, offset: pg * size };
}

async function vipState() {
  const session = await auth.getSession();
  return {
    vip: session.vipType === 10 || session.vipType === 11,
    known: session.vipKnown !== false,
  };
}

function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[\s\-_\/·.,，。!！?？'"“”‘’()（）\[\]【】&+]+/g, '');
}

function scoreName(name, aliases, q) {
  const names = [name].concat(Array.isArray(aliases) ? aliases : []).map(normalizeName).filter(Boolean);
  if (names.indexOf(q) >= 0) return 2;
  for (const n of names) {
    if (n.indexOf(q) >= 0 || (q.length > 1 && q.indexOf(n) >= 0)) return 1;
  }
  return 0;
}

async function search(args) {
  const query = str(args.query);
  const type = args.type;
  if (!Object.prototype.hasOwnProperty.call(SEARCH_TYPES, type)) {
    throw new net.ApiError('不支持的搜索类型');
  }
  const { size, offset } = pageArgs(args.page, args.pageSize, LIMITS.searchPageMax);
  if (!query) return { items: [], hasMore: false, total: 0 };
  const state = await vipState();
  const cacheKey = `search:${type}:${size}:${offset}:${state.vip ? 1 : 0}:${state.known ? 1 : 0}:${query}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const res = await net.plainOrWeapi('/api/cloudsearch/pc', {
    s: query,
    type: SEARCH_TYPES[type],
    limit: size,
    offset,
    total: true,
  });
  net.assertOk(res.json, '搜索');
  const result = (res.json && res.json.result) || {};
  let rawItems = [];
  let count = 0;
  if (type === 'song') {
    rawItems = Array.isArray(result.songs) ? result.songs : [];
    count = Number(result.songCount) || rawItems.length;
  } else if (type === 'album') {
    rawItems = Array.isArray(result.albums) ? result.albums : [];
    count = Number(result.albumCount) || rawItems.length;
  } else if (type === 'artist') {
    rawItems = Array.isArray(result.artists) ? result.artists : [];
    count = Number(result.artistCount) || rawItems.length;
  } else {
    rawItems = Array.isArray(result.playlists) ? result.playlists : [];
    count = Number(result.playlistCount) || rawItems.length;
  }

  const options = { vip: state.vip, vipKnown: state.known, markPlayable: true };
  let items;
  if (type === 'song') items = mapTracks(rawItems, options);
  else if (type === 'album') items = rawItems.map((x) => mapAlbum(x)).filter(Boolean);
  else if (type === 'artist') items = rawItems.map((x) => mapArtist(x)).filter(Boolean);
  else items = rawItems.map((x) => mapPlaylist(x, options)).filter(Boolean);

  const page = {
    items,
    hasMore: offset + rawItems.length < count,
    total: count,
  };
  cacheSet(cacheKey, page, TTL.search);
  return page;
}

async function searchBest(args) {
  const query = str(args.query);
  if (!query) return null;
  const q = normalizeName(query);
  if (!q) return null;
  const safe = (type) => search({ query, type, page: 0, pageSize: 5 }).catch(() => null);
  const [songPage, artistPage, playlistPage, albumPage] = await Promise.all([
    safe('song'), safe('artist'), safe('playlist'), safe('album'),
  ]);

  const best = (page, scoreOf) => {
    let winner = null;
    let winScore = 0;
    for (const item of (page && page.items) || []) {
      const s = scoreOf(item);
      if (s > winScore) {
        winScore = s;
        winner = item;
      }
    }
    return winner;
  };

  const artist = best(artistPage, (a) => scoreName(a.name, a.aliases, q));
  const playlist = best(playlistPage, (p) => scoreName(p.title, null, q));
  const albumFromSearch = best(albumPage, (a) => scoreName(a.title, null, q));
  let album = albumFromSearch;
  if (!album && songPage && songPage.items.length) {
    const withAlbum = songPage.items.find((t) => t.album && t.album.id);
    if (withAlbum) {
      const found = await albumDetail(withAlbum.album.id, null).catch(() => null);
      if (found) album = found.album;
    }
  }

  if (artist) {
    const out = { artist };
    if (playlist) out.playlist = playlist;
    return out;
  }
  if (album) return { album };
  if (playlist) return { playlist };
  return null;
}

async function albumDetail(id, state) {
  const vs = state || (await vipState());
  const cacheKey = `browse:album:${id}:${vs.vip ? 1 : 0}:${vs.known ? 1 : 0}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;
  const res = await net.plainOrWeapi('/api/v1/album/' + encodeURIComponent(id), {});
  net.assertOk(res.json, '专辑');
  const raw = res.json && res.json.album;
  if (!raw) throw new net.ApiError('专辑不存在或已下架');
  const album = mapAlbum(raw);
  if (!album) throw new net.ApiError('专辑数据不完整');
  const map = privilegeMapOf(res.json.privileges);
  const tracks = mapTracks(res.json.songs, {
    privileges: map,
    vip: vs.vip,
    vipKnown: vs.known,
    markPlayable: true,
  });
  const out = { album, tracks };
  cacheSet(cacheKey, out, TTL.browse);
  return out;
}

async function album(args) {
  const id = idArg(args.id, '专辑');
  return albumDetail(id, null);
}

async function fetchSongDetails(ids, state) {
  const byId = Object.create(null);
  const privileges = Object.create(null);
  for (let i = 0; i < ids.length; i += LIMITS.detailChunk) {
    const chunk = ids.slice(i, i + LIMITS.detailChunk);
    const res = await net.plainOrWeapi('/api/v3/song/detail', {
      c: JSON.stringify(chunk.map((id) => ({ id: Number(id) }))),
    });
    net.assertOk(res.json, '歌曲详情');
    const priv = privilegeMapOf(res.json.privileges);
    for (const key of Object.keys(priv)) privileges[key] = priv[key];
    for (const raw of Array.isArray(res.json.songs) ? res.json.songs : []) {
      const track = mapTrack(raw, {
        privileges,
        vip: state.vip,
        vipKnown: state.known,
        markPlayable: true,
      });
      if (track) byId[track.id] = track;
    }
  }
  return { byId, privileges };
}

async function playlist(args) {
  const id = idArg(args.id, '歌单');
  const vs = await vipState();
  const vip = vs.vip;
  const vipKnown = vs.known;
  const cacheKey = `browse:playlist:${id}:${vip ? 1 : 0}:${vipKnown ? 1 : 0}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const res = await net.plain('/api/v6/playlist/detail', { id, n: 0, s: 8 });
  net.assertOk(res.json, '歌单');
  const raw = res.json && res.json.playlist;
  if (!raw) throw new net.ApiError('歌单不存在或已下架');

  const order = [];
  for (const item of Array.isArray(raw.trackIds) ? raw.trackIds : []) {
    const tid = item && item.id !== undefined ? String(item.id) : '';
    if (/^\d+$/.test(tid)) order.push(tid);
    if (order.length >= LIMITS.playlistTracks) break;
  }
  if (!order.length) {
    for (const item of Array.isArray(raw.tracks) ? raw.tracks : []) {
      if (item && item.id !== undefined) order.push(String(item.id));
      if (order.length >= LIMITS.playlistTracks) break;
    }
  }

  let tracks = [];
  let privMap = privilegeMapOf(res.json.privileges);
  if (order.length) {
    try {
      const detail = await fetchSongDetails(order, vs);
      tracks = order.map((tid) => detail.byId[tid]).filter(Boolean);
      privMap = detail.privileges;
    } catch (e) {
      console.warn('歌单歌曲详情获取失败，退回歌单自带曲目：' + e.message);
      tracks = mapTracks(raw.tracks, { privileges: privMap, vip, vipKnown, markPlayable: true });
    }
  } else {
    tracks = mapTracks(raw.tracks, { privileges: privMap, vip, vipKnown, markPlayable: true });
  }

  const playlistInfo = mapPlaylist(raw, {
    preview: Array.isArray(raw.tracks) && raw.tracks.length ? raw.tracks : tracks,
    privileges: privMap,
    vip,
    vipKnown,
    markPlayable: true,
  });
  if (!playlistInfo) throw new net.ApiError('歌单数据不完整');
  const out = { playlist: playlistInfo, tracks };
  cacheSet(cacheKey, out, TTL.browse);
  return out;
}

async function artist(args) {
  const id = idArg(args.id, '艺人');
  const vs = await vipState();
  const cacheKey = `browse:artist:${id}:${vs.vip ? 1 : 0}:${vs.known ? 1 : 0}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;
  const res = await net.plain('/api/v1/artist/' + encodeURIComponent(id), {});
  net.assertOk(res.json, '艺人');
  const info = mapArtist(res.json && res.json.artist);
  if (!info) throw new net.ApiError('艺人不存在');
  const hot = Array.isArray(res.json.hotSongs) ? res.json.hotSongs.slice(0, 50) : [];
  const tracks = mapTracks(hot, { vip: vs.vip, vipKnown: vs.known, markPlayable: true });
  const out = { artist: info, tracks };
  cacheSet(cacheKey, out, TTL.browse);
  return out;
}

async function artistAlbums(args) {
  const id = idArg(args.id, '艺人');
  const { size, offset } = pageArgs(args.page, args.pageSize, LIMITS.artistPageMax);
  const cacheKey = `browse:artistAlbums:${id}:${offset}:${size}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;
  const res = await net.plainOrWeapi('/api/artist/albums/' + encodeURIComponent(id), {
    limit: size,
    offset,
    total: true,
  });
  net.assertOk(res.json, '艺人专辑');
  const list = Array.isArray(res.json.hotAlbums) ? res.json.hotAlbums : [];
  const items = list.map((x) => mapAlbum(x)).filter(Boolean);
  const page = { items, hasMore: !!res.json.more };
  cacheSet(cacheKey, page, TTL.browse);
  return page;
}

async function artistMvs(args) {
  const id = idArg(args.id, '艺人');
  const { size, offset } = pageArgs(args.page, args.pageSize, 100);
  const cacheKey = `browse:artistMvs:${id}:${offset}:${size}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;
  const res = await net.plainOrWeapi('/api/artist/mvs', {
    artistId: id,
    limit: size,
    offset,
    total: true,
  });
  net.assertOk(res.json, '艺人 MV');
  const list = Array.isArray(res.json.mvs) ? res.json.mvs : [];
  const items = list.map((x) => mapMv(x)).filter(Boolean);
  const page = { items, hasMore: !!res.json.hasMore };
  cacheSet(cacheKey, page, TTL.browse);
  return page;
}

module.exports = {
  search,
  searchBest,
  album,
  playlist,
  artist,
  artistAlbums,
  artistMvs,
};
