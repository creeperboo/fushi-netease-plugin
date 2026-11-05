'use strict';

const { TTL, LIMITS, cacheGet, cacheSet } = require('./state.js');
const net = require('./net.js');
const eapiClient = require('./eapi.js');
const { str, sid } = require('./map.js');
const browse = require('./browse.js');

const TIME_TAG = /\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]/;

function idArg(id, what) {
  const s = sid(id);
  if (!s || !/^\d+$/.test(s)) throw new net.ApiError(what + ' ID 无效');
  return s;
}

function stripCredits(text) {
  let s = String(text || '').replace(/^\uFEFF/, '');
  if (s.charAt(0) !== '{') return s;
  const nl = s.indexOf('\n');
  const first = nl >= 0 ? s.slice(0, nl) : s;
  if (!/^\{\s*"t"\s*:/.test(first)) return s;
  try {
    JSON.parse(first);
    return nl >= 0 ? s.slice(nl + 1) : '';
  } catch (e) {
    return s;
  }
}

function cleanLyric(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^(?:\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\])+$/.test(trimmed)) continue;
    out.push(line);
  }
  return out.join('\n').trim();
}

function lyricText(text, prefer) {
  const cleaned = cleanLyric(text);
  if (!cleaned) return null;
  const format = prefer || (TIME_TAG.test(cleaned) ? 'lrc' : 'txt');
  return { format, text: cleaned };
}

function getLrc(obj, v1) {
  if (!obj || typeof obj !== 'object' || typeof obj.lyric !== 'string') return '';
  return cleanLyric(v1 ? stripCredits(obj.lyric) : obj.lyric);
}

async function classicRaw(id) {
  try {
    return await eapiClient.eapi('song/lyric', { id, lv: -1, kv: -1, tv: -1, rv: -1 }, { what: '歌词' });
  } catch (e) {
    console.warn('eapi 歌词接口失败，回退 plain：' + e.message);
    const res = await net.plain('/api/song/lyric', { id, lv: -1, kv: -1, tv: -1, rv: -1 });
    net.assertOk(res.json, '歌词');
    return res.json;
  }
}

async function v1Raw(id) {
  const data = {
    id: Number(id),
    cp: false,
    lv: 0,
    kv: 0,
    tv: 0,
    rv: 0,
    yv: 0,
    ytv: 0,
    yrv: 0,
  };
  try {
    return await eapiClient.eapi('song/lyric/v1', data, { what: '逐字歌词' });
  } catch (e) {
    console.warn('eapi 逐字歌词接口失败，回退 plain：' + e.message);
    const res = await net.plainOrWeapi('/api/song/lyric/v1', data);
    net.assertOk(res.json, '逐字歌词');
    return res.json;
  }
}

function pickRomanization(v1) {
  const candidates = [getLrc(v1 && v1.yromalrc, true), getLrc(v1 && v1.romalrc, true)];
  for (const text of candidates) {
    if (text) return text;
  }
  return '';
}

async function fetchLyrics(id) {
  const cacheKey = `lyrics:${id}`;
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) return cached;

  let classic = null;
  let v1 = null;
  let failures = 0;
  await Promise.all([
    classicRaw(id)
      .then((json) => {
        classic = json;
      })
      .catch((e) => {
        failures++;
        console.warn('经典歌词接口失败：' + e.message);
      }),
    v1Raw(id)
      .then((json) => {
        v1 = json;
      })
      .catch((e) => {
        failures++;
        console.warn('逐字歌词接口失败：' + e.message);
      }),
  ]);
  if (!classic && !v1) throw new net.ApiError('歌词获取失败，请稍后重试');
  if (failures > 0) console.warn('部分歌词接口不可用，已使用另一个接口');

  const yrcText = getLrc(v1 && v1.yrc, false);
  const classicLrc = getLrc(classic && classic.lrc, false);
  const v1Lrc = getLrc(v1 && v1.lrc, true);

  let original = null;
  if (yrcText) original = lyricText(yrcText, 'yrc');
  else if (classicLrc) original = lyricText(classicLrc, TIME_TAG.test(classicLrc) ? 'lrc' : 'txt');
  else if (v1Lrc) original = lyricText(v1Lrc, TIME_TAG.test(v1Lrc) ? 'lrc' : 'txt');

  if (!original) {
    cacheSet(cacheKey, null, TTL.lyrics);
    return null;
  }

  const result = { original };
  const romaText = pickRomanization(v1);
  if (romaText && romaText !== original.text && (original.format === 'txt' || TIME_TAG.test(romaText))) {
    result.romanization = lyricText(romaText, TIME_TAG.test(romaText) ? original.format : 'txt');
  }

  cacheSet(cacheKey, result, TTL.lyrics);
  return result;
}

async function lyrics(args) {
  const id = idArg(args.id, '歌曲');
  return fetchLyrics(id);
}

async function lyricsSearch(args) {
  const title = str(args.title) || str(args.query) || '';
  const artist = str(args.artist) || '';
  const query = (title + ' ' + artist).trim() || str(args.query) || '';
  if (!query) return { items: [] };
  const duration = Number(args.durationMs);
  const page = await browse.search({ query, type: 'song', page: 0, pageSize: 10 });
  const items = [];
  for (const track of page.items) {
    if (!track || !track.id) continue;
    if (Number.isFinite(duration) && duration > 0 && track.durationMs) {
      if (Math.abs(track.durationMs - duration) > 10000) continue;
    }
    const entry = { title: track.title, ref: String(track.id) };
    if (track.artists && track.artists.length) {
      entry.artist = track.artists.map((a) => a.name).join(' / ');
    }
    if (track.durationMs) entry.durationMs = track.durationMs;
    items.push(entry);
    if (items.length >= LIMITS.lyricsCandidates) break;
  }
  return { items };
}

function refId(ref) {
  if (typeof ref === 'number' && Number.isFinite(ref)) return String(ref);
  if (typeof ref === 'string') {
    const s = ref.trim().replace(/^song:/i, '');
    return /^\d+$/.test(s) ? s : null;
  }
  if (ref && typeof ref === 'object') {
    for (const key of ['id', 'songId', 'trackId']) {
      const v = ref[key];
      if (typeof v === 'number' && Number.isFinite(v)) return String(v);
      if (typeof v === 'string' && /^\d+$/.test(v.trim())) return v.trim();
    }
  }
  return null;
}

async function lyricsFetch(args) {
  const id = refId(args.ref);
  if (!id) return null;
  return fetchLyrics(id);
}

module.exports = { lyrics, lyricsSearch, lyricsFetch };
