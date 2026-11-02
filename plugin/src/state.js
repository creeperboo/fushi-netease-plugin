'use strict';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const TTL = {
  search: 5 * 60 * 1000,
  browse: 30 * 60 * 1000,
  lyrics: 24 * 60 * 60 * 1000,
  stream: 5 * 60 * 1000,
  home: 10 * 60 * 1000,
  account: 60 * 1000,
  like: 5 * 60 * 1000,
};

const LIMITS = {
  playlistTracks: 2000,
  detailChunk: 500,
  searchPageMax: 100,
  artistPageMax: 50,
  lyricsCandidates: 5,
};

const KEYS = {
  jar: 'ne:cookiejar',
  login: 'login_cookie',
};

const mem = new Map();

function cacheGet(key) {
  const hit = mem.get(key);
  if (!hit) return undefined;
  if (hit.exp <= Date.now()) {
    mem.delete(key);
    return undefined;
  }
  return hit.value;
}

function cacheSet(key, value, ttl) {
  mem.set(key, { value, exp: Date.now() + ttl });
  return value;
}

function cacheDel(prefix) {
  for (const key of Array.from(mem.keys())) {
    if (key.indexOf(prefix) === 0) mem.delete(key);
  }
}

function clearAll() {
  mem.clear();
}

module.exports = { UA, TTL, LIMITS, KEYS, cacheGet, cacheSet, cacheDel, clearAll };
