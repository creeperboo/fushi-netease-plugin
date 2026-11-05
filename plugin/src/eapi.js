'use strict';

const net = require('./net.js');

const BASE = 'https://interface.music.163.com/eapi/';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/91.0.4472.164 NeteaseMusicDesktop/3.0.18.203152';
const APPVER = '3.0.18.203152';
const EAPI_KEY = 'e82ckenh8dichen8';
const SEP = '-36cd479b6b5-';

let devicePromise = null;

function formEncode(data) {
  const parts = [];
  for (const key of Object.keys(data || {})) {
    const value = data[key];
    if (value === undefined || value === null) continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.join('&');
}

function parseCookieHeader(text) {
  const out = Object.create(null);
  for (const part of String(text || '').split(';')) {
    const at = part.indexOf('=');
    if (at <= 0) continue;
    out[part.slice(0, at).trim()] = part.slice(at + 1).trim();
  }
  return out;
}

async function deviceId() {
  if (devicePromise) return devicePromise;
  devicePromise = (async () => {
    try {
      const saved = await fushi.storage.get('ne:deviceId');
      if (typeof saved === 'string' && /^[0-9A-F]{32}$/.test(saved)) return saved;
    } catch (e) {
      console.warn('读取 deviceId 失败：' + e.message);
    }
    const id = fushi.encoding.hexEncode(fushi.crypto.randomBytes(16)).toUpperCase();
    try {
      await fushi.storage.set('ne:deviceId', id);
    } catch (e) {
      console.warn('保存 deviceId 失败：' + e.message);
    }
    return id;
  })();
  return devicePromise;
}

function encrypt(path, data) {
  const text = JSON.stringify(data);
  const digest = fushi.encoding.hexEncode(
    fushi.crypto.md5('nobody' + path + 'use' + text + 'md5forencrypt'),
  );
  const plain = path + SEP + text + SEP + digest;
  const encrypted = fushi.crypto.aes({
    mode: 'ecb',
    key: EAPI_KEY,
    data: fushi.encoding.utf8Encode(plain),
  });
  return fushi.encoding.hexEncode(encrypted).toUpperCase();
}

async function eapi(path, data, opts) {
  const o = opts || {};
  const id = await deviceId();
  const header = {
    os: 'pc',
    appver: APPVER,
    osver: 'Microsoft-Windows-10-Professional-build-19045-64bit',
    deviceId: id,
    requestId: String(Date.now()) + '_' + String(Math.floor(Math.random() * 1000)).padStart(4, '0'),
  };

  let sessionCookies = Object.create(null);
  if (o.cookies === null) {
    sessionCookies = Object.create(null);
  } else if (o.cookies && typeof o.cookies === 'object') {
    sessionCookies = o.cookies;
  } else {
    await net.ensureLoaded();
    sessionCookies = parseCookieHeader(net.cookieHeader());
  }
  if (sessionCookies.MUSIC_U) header.MUSIC_U = sessionCookies.MUSIC_U;
  if (sessionCookies.__csrf) header.__csrf = sessionCookies.__csrf;

  const cookieMap = Object.assign(Object.create(null), header, sessionCookies);
  const cookieText = Object.keys(cookieMap)
    .map((name) => `${name}=${cookieMap[name]}`)
    .join('; ');
  const payload = Object.assign({}, data, { header: JSON.stringify(header), e_r: false });
  const body = formEncode({ params: encrypt('/api/' + path, payload) });

  let res;
  try {
    res = await fushi.http.request({
      url: BASE + path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': UA,
        Referer: 'https://music.163.com/',
        Cookie: cookieText,
      },
      body,
      responseType: 'text',
      timeoutMs: Number(o.timeoutMs) || 15000,
    });
  } catch (e) {
    throw new net.ApiError('网络请求失败：' + e.message);
  }

  if (res.status < 200 || res.status >= 300) {
    throw new net.ApiError(`网易云接口暂不可用（HTTP ${res.status}）`);
  }
  let json = null;
  try {
    json = res.text ? JSON.parse(res.text) : null;
  } catch (e) {
    throw new net.ApiError('网易云接口返回了无法解析的内容');
  }
  const result = { json, setCookies: res.setCookies || [], status: res.status };
  if (o.raw) return result;
  return assertOk(json, o.what || path);
}

function assertOk(json, what) {
  if (!json || typeof json !== 'object') throw new net.ApiError('网易云接口返回异常');
  const code = typeof json.code === 'number' ? json.code : undefined;
  if (code === undefined || code === 200) return json;
  if (code === 301 || code === 401) throw new net.ApiError('登录已过期，请重新登录', code);
  if (code === 8821) throw new net.ApiError('网易云要求安全验证（8821），请稍后重试', code);
  if (code === -460 || code === -462) {
    throw new net.ApiError('网易云风控拦截，请稍后重试', code);
  }
  if (code === 404) throw new net.ApiError('内容不存在或已下架', code);
  const detail = typeof json.message === 'string' ? json.message : typeof json.msg === 'string' ? json.msg : '';
  throw new net.ApiError(`${what || '接口'}失败${detail ? '：' + detail : '（' + code + '）'}`, code);
}

module.exports = { eapi, assertOk };
