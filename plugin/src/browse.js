'use strict';

const { TTL, LIMITS, cacheGet, cacheSet } = require('./state.js');
const net = require('./net.js');
const eapiClient = require('./eapi.js');
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

async function eapiJson(path, data, what) {
  try {
    return await eapiClient.eapi(path, data, { what });
  } catch (e) {
    console.warn(`eapi ${what || path} 失败，回退 plain：` + e.message);
    const res = await net.plainOrWeapi('/api/' + path, data);
    return net.assertOk(res.json, what);
  }
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

  const json = await eapiJson('cloudsearch/pc', {
    s: query,
    type: SEARCH_TYPES[type],
    limit: size,
    offset,
    total: true,
  }, '搜索');
  const result = (json && json.result) || {};
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

async function complexBest(query) {
  try {
    const json = await eapiJson('search/complex/get', {
      keyword: query,
      scene: 'normal',
      limit: 10,
      offset: 0,
    }, '综合搜索');
    const rules = (json.trp && json.trp.rules) || [];
    const ids = {};
    for (const rule of rules) {
      const m = /^search_block_best_match\|(artist|playlist|album)::(\d+)/.exec(String(rule));
      if (m && !ids[m[1]]) ids[m[1]] = m[2];
    }
    if (!Object.keys(ids).length) return null;
    const complete = (json.data && json.data.complete) || {};
    const find = (list, id) => (list || []).find((x) => x && String(x.id) === String(id));
    const out = {};
    if (ids.artist) {
      let raw = find(complete.artist && complete.artist.artists, ids.artist);
      if (!raw) {
        raw = (await eapiJson('v1/artist/' + ids.artist, {}, '最佳匹配艺人').catch(() => null) || {}).artist;
      }
      if (raw) out.artist = mapArtist(raw);
    }
    if (ids.playlist) {
      let raw = find(complete.playList && complete.playList.playLists, ids.playlist);
      if (!raw) {
        raw = (await eapiJson('v6/playlist/detail', { id: ids.playlist, n: 0, s: 0 }, '最佳匹配歌单').catch(() => null) || {}).playlist;
      }
      if (raw) out.playlist = mapPlaylist(raw);
    }
    if (ids.album) {
      let raw = find(complete.album && complete.album.albums, ids.album);
      if (!raw) {
        raw = (await eapiJson('v1/album/' + ids.album, {}, '最佳匹配专辑').catch(() => null) || {}).album;
      }
      if (raw) out.album = mapAlbum(raw);
    }
    return Object.keys(out).length ? out : null;
  } catch (e) {
    console.warn('官方最佳匹配失败，使用本地评分：' + e.message);
    return null;
  }
}

async function searchBest(args) {
  const query = str(args.query);
  if (!query) return null;
  const official = await complexBest(query);
  if (official) return official;
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
  const json = await eapiJson('v1/album/' + encodeURIComponent(id), {}, '专辑');
  const raw = json && json.album;
  if (!raw) throw new net.ApiError('专辑不存在或已下架');
  const album = mapAlbum(raw);
  if (!album) throw new net.ApiError('专辑数据不完整');
  const ids = (Array.isArray(json.songs) ? json.songs : [])
    .map((x) => (x && x.id !== undefined ? String(x.id) : ''))
    .filter(Boolean);
  let tracks = [];
  if (ids.length) {
    const detail = await fetchSongDetails(ids, vs);
    tracks = ids.map((tid) => detail.byId[tid]).filter(Boolean);
  }
  if (!tracks.length) {
    tracks = mapTracks(json.songs, {
      privileges: privilegeMapOf(json.privileges),
      vip: vs.vip,
      vipKnown: vs.known,
      markPlayable: true,
    });
  }
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
    const json = await eapiJson('v3/song/detail', {
      c: JSON.stringify(chunk.map((id) => ({ id: Number(id) }))),
    }, '歌曲详情');
    const priv = privilegeMapOf(json.privileges);
    for (const key of Object.keys(priv)) privileges[key] = priv[key];
    for (const raw of Array.isArray(json.songs) ? json.songs : []) {
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

  const json = await eapiJson('v6/playlist/detail', { id, n: 0, s: 0 }, '歌单');
  const raw = json && json.playlist;
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
  let privMap = privilegeMapOf(json.privileges);
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
  const [json, intro, fans] = await Promise.all([
    eapiJson('v1/artist/' + encodeURIComponent(id), {}, '艺人'),
    eapiJson('artist/introduction', { id }, '艺人介绍').catch(() => null),
    eapiJson('artist/follow/count/get', { id }, '粉丝数').catch(() => null),
  ]);
  const info = mapArtist(json && json.artist);
  if (!info) throw new net.ApiError('艺人不存在');
  const fanCount = fans && fans.data && Number(fans.data.fansCnt);
  if (Number.isFinite(fanCount) && fanCount >= 0) {
    info.stats = Object.assign({}, info.stats, { fanCount });
  }
  const sections = ((intro && intro.introduction) || [])
    .map((x) => ({ title: str(x && x.ti), text: str(x && x.txt) }))
    .filter((x) => x.text);
  let description = str(intro && intro.briefDesc) || str(json.artist && json.artist.briefDesc);
  if (sections.length && !sections[0].title) description = sections.shift().text;
  if (description) info.description = description;
  if (sections.length) info.intro = sections.slice(0, 20).map((x) => (x.title ? x : { text: x.text }));
  const hot = Array.isArray(json.hotSongs) ? json.hotSongs.slice(0, 50) : [];
  let tracks = [];
  if (hot.length) {
    try {
      const detail = await fetchSongDetails(hot.map((x) => String(x.id)), vs);
      tracks = hot.map((x) => detail.byId[String(x.id)]).filter(Boolean);
    } catch (e) {
      console.warn('艺人热门曲详情获取失败：' + e.message);
    }
  }
  if (!tracks.length) {
    tracks = mapTracks(hot, { vip: vs.vip, vipKnown: vs.known, markPlayable: true });
  }
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
  const json = await eapiJson('artist/albums/' + encodeURIComponent(id), {
    limit: size,
    offset,
    total: true,
  }, '艺人专辑');
  const list = Array.isArray(json.hotAlbums) ? json.hotAlbums : [];
  const items = list.map((x) => mapAlbum(x)).filter(Boolean);
  const page = { items, hasMore: !!json.more };
  cacheSet(cacheKey, page, TTL.browse);
  return page;
}

async function artistMvs(args) {
  const id = idArg(args.id, '艺人');
  const { size, offset } = pageArgs(args.page, args.pageSize, 100);
  const cacheKey = `browse:artistMvs:${id}:${offset}:${size}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;
  const json = await eapiJson('artist/mvs', {
    artistId: id,
    limit: size,
    offset,
    total: true,
  }, '艺人 MV');
  const list = Array.isArray(json.mvs) ? json.mvs : [];
  const items = list.map((x) => mapMv(x)).filter(Boolean);
  const page = { items, hasMore: !!json.hasMore };
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
