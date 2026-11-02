'use strict';

const { TTL, cacheGet, cacheSet } = require('./state.js');
const net = require('./net.js');
const auth = require('./auth.js');
const { str, sid } = require('./map.js');

const QUALITY = {
  standard: { br: 128000, level: 'standard', encode: 'mp3' },
  high: { br: 320000, level: 'exhigh', encode: 'mp3' },
  lossless: { br: 999000, level: 'lossless', encode: 'flac' },
  hires: { br: 1900000, level: 'hires', encode: 'flac' },
};

const QUALITY_FALLBACK = {
  standard: ['standard'],
  high: ['high', 'standard'],
  lossless: ['lossless', 'high', 'standard'],
  hires: ['hires', 'lossless', 'high', 'standard'],
};

const MV_R = {
  standard: [480],
  high: [720, 480],
  lossless: [1080, 720, 480],
  hires: [1080, 720, 480],
};

function idArg(id, what) {
  const s = sid(id);
  if (!s || !/^\d+$/.test(s)) throw new net.ApiError(what + ' ID 无效');
  return s;
}

function qualityArg(value) {
  return Object.prototype.hasOwnProperty.call(QUALITY, value) ? value : 'standard';
}

function firstData(json) {
  if (!json || typeof json !== 'object') return null;
  const data = json.data;
  if (Array.isArray(data)) return data.length && data[0] && typeof data[0] === 'object' ? data[0] : null;
  return data && typeof data === 'object' ? data : null;
}

function usable(d) {
  return !!d && typeof d.url === 'string' && /^https?:\/\//i.test(d.url) && !d.freeTrialInfo;
}

function trial(d) {
  return !!d && !!d.freeTrialInfo;
}

function expiry(expi) {
  const n = Number(expi);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  if (n > 1e12) return Math.round(n);
  if (n > 1e10) return Math.round(n * 1000);
  return Date.now() + Math.round(n * 1000);
}

function streamResult(d) {
  const out = { url: d.url, headers: net.mediaHeaders() };
  const exp = expiry(d.expi);
  if (exp) out.expiresAt = exp;
  const codec = str(d.type) || str(d.encodeType);
  if (codec) out.codec = codec.toLowerCase();
  const br = Number(d.br);
  if (Number.isFinite(br) && br > 0) out.bitrateKbps = Math.round(br / 1000);
  const size = Number(d.size);
  if (Number.isFinite(size) && size > 0) out.sizeBytes = Math.round(size);
  return out;
}

async function legacyUrl(id, quality) {
  const q = QUALITY[quality];
  const res = await net.plain('/api/song/enhance/player/url', {
    ids: JSON.stringify([Number(id)]),
    br: q.br,
  });
  net.assertOk(res.json, '取流');
  return firstData(res.json);
}

async function v1Url(id, quality) {
  const q = QUALITY[quality];
  const res = await net.plainOrWeapi('/api/song/enhance/player/url/v1', {
    ids: JSON.stringify([Number(id)]),
    level: q.level,
    encodeType: q.encode,
  });
  net.assertOk(res.json, '取流');
  return firstData(res.json);
}

async function tryQuality(id, quality) {
  const result = { candidate: null, sawTrial: false, needsVip: false, paidAlbum: false, lastError: null };
  for (const fetchUrl of [legacyUrl, v1Url]) {
    try {
      const d = await fetchUrl(id, quality);
      if (trial(d)) result.sawTrial = true;
      if (d && (d.fee === 1 || d.code === -110)) result.needsVip = true;
      if (d && d.fee === 4) result.paidAlbum = true;
      if (usable(d)) {
        result.candidate = d;
        break;
      }
    } catch (e) {
      result.lastError = e;
      console.warn(`${quality} 取流接口失败：` + e.message);
    }
  }
  return result;
}

async function stream(args) {
  const id = idArg(args.id, '歌曲');
  const quality = qualityArg(args.quality);
  const cacheKey = `stream:${id}:${quality}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  let sawTrial = false;
  let needsVip = false;
  let paidAlbum = false;
  let candidate = null;
  let lastError = null;

  for (const candidateQuality of QUALITY_FALLBACK[quality]) {
    const r = await tryQuality(id, candidateQuality);
    if (r.sawTrial) sawTrial = true;
    if (r.needsVip) needsVip = true;
    if (r.paidAlbum) paidAlbum = true;
    if (r.lastError) lastError = r.lastError;
    if (r.candidate) {
      candidate = r.candidate;
      break;
    }
  }

  if (!candidate) {
    if (sawTrial) throw new net.ApiError('该曲目仅提供试听片段，需要网易云会员');
    if (paidAlbum) throw new net.ApiError('该曲目需要购买专辑后才能播放');
    if (needsVip) {
      const vip = await auth.isVip();
      if (!vip) throw new net.ApiError('该曲目需要网易云会员');
    }
    if (lastError && lastError instanceof net.ApiError && (lastError.code === 301 || lastError.code === 401)) {
      throw new net.ApiError('登录已过期，请重新登录');
    }
    throw new net.ApiError('该曲目暂不可播放（可能受版权或地区限制）');
  }

  const out = streamResult(candidate);
  cacheSet(cacheKey, out, TTL.stream);
  return out;
}

async function mvRequest(id, r) {
  const res = await net.plainOrWeapi('/api/song/enhance/play/mv/url', { id: Number(id), r });
  net.assertOk(res.json, 'MV 取流');
  return firstData(res.json);
}

async function mvStream(args) {
  const id = idArg(args.id, 'MV');
  const quality = qualityArg(args.quality);
  const cacheKey = `stream:mv:${id}:${quality}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  let candidate = null;
  for (const r of MV_R[quality]) {
    try {
      const d = await mvRequest(id, r);
      if (usable(d)) {
        candidate = d;
        break;
      }
    } catch (e) {
      console.warn(`MV 取流 ${r}P 失败：` + e.message);
    }
  }
  if (!candidate) throw new net.ApiError('MV 暂不可播放（可能受版权或地区限制）');

  const out = { url: candidate.url, headers: net.mediaHeaders() };
  const exp = expiry(candidate.expi);
  if (exp) out.expiresAt = exp;
  const w = Number(candidate.width);
  const h = Number(candidate.height);
  if (Number.isFinite(w) && w > 0) out.width = Math.round(w);
  if (Number.isFinite(h) && h > 0) out.height = Math.round(h);
  cacheSet(cacheKey, out, TTL.stream);
  return out;
}

module.exports = { stream, mvStream };
