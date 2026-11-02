'use strict';

const { TTL, cacheGet, cacheSet, cacheDel } = require('./state.js');
const net = require('./net.js');
const auth = require('./auth.js');
const { mapTracks, mapPlaylist, sid } = require('./map.js');

function pageArgs(page, pageSize) {
  const p = Number(page);
  const s = Number(pageSize);
  const size = Math.max(1, Math.min(100, Number.isFinite(s) && s > 0 ? Math.floor(s) : 50));
  const pg = Number.isFinite(p) && p > 0 ? Math.floor(p) : 0;
  return { page: pg, size, offset: pg * size };
}

function section(id, title, kind, items) {
  if (!Array.isArray(items) || !items.length) return null;
  return { id, title, kind, items };
}

async function dailySection(vip, vipKnown) {
  const res = await net.plainOrWeapi('/api/v3/discovery/recommend/songs', {});
  net.assertOk(res.json, '每日推荐');
  const data = res.json && res.json.data;
  const list = data && Array.isArray(data.dailySongs) ? data.dailySongs.slice(0, 50) : [];
  return section('daily', '每日推荐', 'tracks', mapTracks(list, { vip, vipKnown, markPlayable: true }));
}

async function recommendPlaylists() {
  const res = await net.plainOrWeapi('/api/personalized/playlist', { limit: 12 });
  net.assertOk(res.json, '推荐歌单');
  const list = Array.isArray(res.json && res.json.result) ? res.json.result.slice(0, 12) : [];
  return section('recommend-playlists', '推荐歌单', 'playlists', list.map((x) => mapPlaylist(x)).filter(Boolean));
}

async function newSongs(vip, vipKnown) {
  const res = await net.plainOrWeapi('/api/personalized/newsong', { type: 'recommend', limit: 12 });
  net.assertOk(res.json, '新歌速递');
  const list = Array.isArray(res.json && res.json.result) ? res.json.result.slice(0, 12) : [];
  const raws = list.map((x) => (x && typeof x === 'object' && x.song && typeof x.song === 'object' ? x.song : x));
  return section('new-songs', '新歌速递', 'tracks', mapTracks(raws, { vip, vipKnown, markPlayable: true }));
}

async function toplists(vip, vipKnown) {
  const res = await net.plainOrWeapi('/api/toplist/detail', {});
  net.assertOk(res.json, '排行榜');
  const list = Array.isArray(res.json && res.json.list) ? res.json.list.slice(0, 6) : [];
  const items = list
    .map((x) =>
      mapPlaylist(x, {
        preview: Array.isArray(x && x.tracks) ? x.tracks : [],
        vip,
        vipKnown,
        markPlayable: true,
      }),
    )
    .filter(Boolean);
  return section('toplists', '排行榜', 'playlists', items);
}

async function home(args) {
  if (args && args.refresh) cacheDel('home:');
  const session = await auth.getSession();
  const loggedIn = !!(session.account && session.account.loggedIn);
  const vip = session.vipType === 10 || session.vipType === 11;
  const vipKnown = session.vipKnown !== false;
  const cacheKey = `home:${loggedIn ? 1 : 0}:${vip ? 1 : 0}:${vipKnown ? 1 : 0}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const tasks = [];
  if (loggedIn) tasks.push(dailySection(vip, vipKnown));
  tasks.push(recommendPlaylists(), newSongs(vip, vipKnown), toplists(vip, vipKnown));
  const results = await Promise.all(
    tasks.map((p) =>
      p.catch((e) => {
        console.warn('首页分区加载失败：' + e.message);
        return null;
      }),
    ),
  );
  const out = { sections: results.filter(Boolean) };
  cacheSet(cacheKey, out, TTL.home);
  return out;
}

async function userPlaylistsRaw(uid, limit, offset) {
  const res = await net.plainOrWeapi('/api/user/playlist', {
    uid,
    limit,
    offset,
    includeVideo: true,
  });
  net.assertOk(res.json, '用户歌单');
  return res.json;
}

async function library(args) {
  const session = await auth.getSession();
  if (!session.account || !session.account.loggedIn || !session.uid) {
    return { items: [], hasMore: false };
  }
  const { page, size, offset } = pageArgs(args.page, args.pageSize);
  const json = await userPlaylistsRaw(session.uid, size, offset);
  const raw = Array.isArray(json.playlist) ? json.playlist : [];
  const pairs = raw.map((x) => ({ raw: x, item: mapPlaylist(x) })).filter((x) => x.item);
  if (page === 0) {
    const at = pairs.findIndex((x) => x.raw && x.raw.specialType === 5);
    if (at > 0) {
      const first = pairs.splice(at, 1)[0];
      pairs.unshift(first);
    }
  }
  return {
    items: pairs.map((x) => x.item),
    hasMore: typeof json.more === 'boolean' ? json.more : raw.length >= size,
  };
}

async function likedPlaylist(uid) {
  try {
    const json = await userPlaylistsRaw(uid, 50, 0);
    const raw = Array.isArray(json.playlist) ? json.playlist : [];
    const liked = raw.find((x) => x && x.specialType === 5);
    return liked ? mapPlaylist(liked) : undefined;
  } catch (e) {
    console.warn('读取「我喜欢」歌单失败：' + e.message);
    return undefined;
  }
}

async function likeList() {
  const session = await auth.getSession();
  if (!session.account || !session.account.loggedIn || !session.uid) return null;
  const cacheKey = `like:${session.uid}`;
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) return cached;

  let ids = [];
  try {
    const res = await net.plain('/api/song/like/get', { uid: session.uid });
    net.assertOk(res.json, '喜欢列表');
    const raw = Array.isArray(res.json && res.json.ids) ? res.json.ids : [];
    ids = raw.map((x) => sid(x)).filter(Boolean);
  } catch (e) {
    console.warn('读取喜欢列表失败：' + e.message);
    return { ids: [] };
  }
  const out = { ids };
  const playlist = await likedPlaylist(session.uid);
  if (playlist) out.playlist = playlist;
  cacheSet(cacheKey, out, TTL.like);
  return out;
}

async function likedIds(uid) {
  const res = await net.plain('/api/song/like/get', { uid });
  net.assertOk(res.json, '喜欢列表');
  return Array.isArray(res.json.ids) ? res.json.ids.map((x) => sid(x)).filter(Boolean) : [];
}

async function likedPlaylistId(uid) {
  try {
    const json = await userPlaylistsRaw(uid, 50, 0);
    const list = Array.isArray(json.playlist) ? json.playlist : [];
    const hit = list.find((x) => x && x.specialType === 5);
    return hit ? sid(hit.id) : null;
  } catch (e) {
    console.warn('读取「我喜欢」歌单失败：' + e.message);
    return null;
  }
}

async function tryLikeRequest(name, path, data, attempts) {
  try {
    const res = await net.plainOrWeapi(path, data);
    const json = res.json || {};
    const code = typeof json.code === 'number' ? json.code : 200;
    attempts.push({ api: name, code, keys: Object.keys(json) });
    return code;
  } catch (e) {
    attempts.push({ api: name, error: e.message, code: e.code });
    return null;
  }
}

async function likeSet(args) {
  const session = await auth.getSession();
  if (!session.account || !session.account.loggedIn) {
    throw new net.ApiError('请先登录网易云账号');
  }
  const id = sid(args.id);
  if (!id || !/^\d+$/.test(id)) throw new net.ApiError('歌曲 ID 无效');
  const expected = args.liked === true;
  const csrf = net.csrfToken();
  const attempts = [];
  const pid = await likedPlaylistId(session.uid);
  const clearCaches = () => {
    cacheDel('like:');
    if (pid) cacheDel(`browse:playlist:${pid}:`);
  };
  const verify = async () => {
    const ids = await likedIds(session.uid);
    return (ids.indexOf(id) >= 0) === expected;
  };

  await tryLikeRequest(
    'radio',
    '/api/radio/like',
    { alg: 'itembased', trackId: Number(id), like: expected, time: '3', csrf_token: csrf },
    attempts,
  );
  if (await verify()) {
    clearCaches();
    return null;
  }

  await tryLikeRequest(
    'song',
    '/api/song/like',
    { trackId: Number(id), like: expected, csrf_token: csrf },
    attempts,
  );
  if (await verify()) {
    clearCaches();
    return null;
  }

  if (pid) {
    await tryLikeRequest(
      'playlist',
      '/api/playlist/manipulate/tracks',
      {
        op: expected ? 'add' : 'del',
        pid,
        trackIds: JSON.stringify([Number(id)]),
        imme: 'true',
        csrf_token: csrf,
      },
      attempts,
    );
    if (await verify()) {
      clearCaches();
      return null;
    }
  }

  try {
    await fushi.storage.set('ne:like-debug', JSON.stringify({ csrfLen: csrf.length, attempts }));
  } catch (e) {
    console.warn('记录喜欢诊断失败：' + e.message);
  }
  throw new net.ApiError(expected ? '网易云没有确认喜欢操作，请稍后重试' : '网易云没有确认取消喜欢，请稍后重试');
}

async function like(args) {
  if (args && args.op === 'set') return likeSet(args);
  if (args && args.op === 'list') return likeList();
  throw new net.ApiError('不支持的喜欢操作');
}

module.exports = { home, library, like };
