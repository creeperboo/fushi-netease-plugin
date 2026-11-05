'use strict';

const { UA, KEYS } = require('./state.js');

const BASE = 'https://music.163.com';
const PRESET_KEY = '0CoJUm6Qyw8W8jud';
const IV = '0102030405060708';
const EXPONENT = '010001';
const MODULUS =
  '00e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725152b3ab17a876aea8a5aa76d2e417629ec4ce341f56135fccf695280104e0312ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424d813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7';
const LOGIN_COOKIES = ['MUSIC_U', 'MUSIC_A'];
const LOGIN_NAMES = ['MUSIC_U', 'MUSIC_A', '__csrf'];

let jar = Object.create(null);
let loginCookie = '';
let loadPromise = null;
let jarChain = Promise.resolve();
let loginChain = Promise.resolve();
let jarWarned = false;
let loginWarned = false;

class ApiError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
  }
}

const COOKIE_ATTRS = [
  'expires', 'max-age', 'path', 'domain', 'secure', 'httponly', 'samesite',
  'version', 'priority', 'partitioned',
];

function parseCookieHeader(text) {
  const out = Object.create(null);
  String(text || '')
    .split(';')
    .forEach((part) => {
      const at = part.indexOf('=');
      if (at <= 0) return;
      const name = part.slice(0, at).trim();
      const value = part.slice(at + 1).trim();
      if (name && COOKIE_ATTRS.indexOf(name.toLowerCase()) < 0) out[name] = value;
    });
  return out;
}

function serializeCookies(map) {
  return Object.keys(map)
    .filter((name) => name && map[name] !== undefined && map[name] !== null)
    .map((name) => `${name}=${map[name]}`)
    .join('; ');
}

function cookieHeader() {
  const merged = Object.assign(Object.create(null), jar, parseCookieHeader(loginCookie));
  return serializeCookies(merged);
}

function csrfToken() {
  const login = parseCookieHeader(loginCookie);
  return login.__csrf || jar.__csrf || '';
}

async function ensureLoaded() {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    let rawJar = null;
    let rawLogin = null;
    try {
      rawJar = await fushi.storage.get(KEYS.jar);
    } catch (e) {
      console.warn('读取 Cookie 缓存失败：' + e.message);
    }
    try {
      rawLogin = await fushi.credentials.get(KEYS.login);
    } catch (e) {
      console.warn('读取登录凭据失败：' + e.message);
    }
    if (rawJar) {
      try {
        const parsed = JSON.parse(rawJar);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          for (const name of Object.keys(parsed)) {
            if (typeof parsed[name] === 'string') jar[name] = parsed[name];
          }
        }
      } catch (e) {
        console.warn('Cookie 缓存格式损坏，已忽略');
      }
    }
    if (typeof rawLogin === 'string') loginCookie = rawLogin;
  })();
  return loadPromise;
}

function persistJar() {
  const snapshot = JSON.stringify(jar);
  jarChain = jarChain
    .then(() => fushi.storage.set(KEYS.jar, snapshot))
    .catch((e) => {
      if (!jarWarned) {
        jarWarned = true;
        console.warn('保存 Cookie 缓存失败：' + e.message);
      }
    });
  return jarChain;
}

function persistLogin() {
  const snapshot = loginCookie;
  loginChain = loginChain
    .then(() => (snapshot ? fushi.credentials.set(KEYS.login, snapshot) : fushi.credentials.remove(KEYS.login)))
    .catch((e) => {
      if (!loginWarned) {
        loginWarned = true;
        console.warn('保存登录凭据失败：' + e.message);
      }
    });
  return loginChain;
}

function absorbCookies(setCookies) {
  let jarChanged = false;
  let loginChanged = false;
  for (const raw of Array.isArray(setCookies) ? setCookies : []) {
    const first = String(raw).split(';')[0];
    const at = first.indexOf('=');
    if (at <= 0) continue;
    const name = first.slice(0, at).trim();
    const value = first.slice(at + 1).trim();
    if (!name) continue;
    if (/max-age\s*=\s*0/i.test(raw) || /expires\s*=\s*thu,\s*01\s+jan\s+1970/i.test(raw)) {
      if (jar[name] !== undefined) {
        delete jar[name];
        jarChanged = true;
      }
      continue;
    }
    const loginish = LOGIN_COOKIES.indexOf(name) >= 0 || (loginCookie && name === '__csrf');
    if (loginish) {
      const map = parseCookieHeader(loginCookie);
      if (map[name] !== value) {
        map[name] = value;
        loginCookie = serializeCookies(map);
        loginChanged = true;
      }
      if (jar[name] !== undefined) {
        delete jar[name];
        jarChanged = true;
      }
    } else if (jar[name] !== value) {
      jar[name] = value;
      jarChanged = true;
    }
  }
  return { jarChanged, loginChanged };
}

async function absorbAndSave(setCookies) {
  const result = absorbCookies(setCookies);
  if (result.jarChanged) await persistJar();
  if (result.loginChanged) await persistLogin();
}

function formEncode(data) {
  const parts = [];
  for (const key of Object.keys(data || {})) {
    const value = data[key];
    if (value === undefined || value === null) continue;
    const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(text)}`);
  }
  return parts.join('&');
}

function aesB64(text, key) {
  const out = fushi.crypto.aes({
    mode: 'cbc',
    key,
    iv: IV,
    padding: 'pkcs7',
    data: fushi.encoding.utf8Encode(text),
  });
  return fushi.encoding.base64Encode(out);
}

function weapiForm(payload) {
  const data = Object.assign({}, payload);
  if (data.csrf_token === undefined) data.csrf_token = csrfToken();
  const first = aesB64(JSON.stringify(data), PRESET_KEY);
  // Classic weapi uses a 16-character alphanumeric secret (AES-128).
  const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const noise = fushi.crypto.randomBytes(16);
  let secret = '';
  for (let i = 0; i < 16; i++) secret += charset.charAt(noise[i] % charset.length);
  const params = aesB64(first, secret);
  const raw = fushi.crypto.rsaRaw({
    modulus: MODULUS,
    exponent: EXPONENT,
    data: fushi.encoding.utf8Encode(secret.split('').reverse().join('')),
  });
  const encSecKey = fushi.encoding.hexEncode(raw).toLowerCase();
  return formEncode({ params, encSecKey });
}

function requestHeaders(body) {
  const headers = {
    'User-Agent': UA,
    Referer: BASE + '/',
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  };
  if (body !== undefined) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  const cookie = cookieHeader();
  if (cookie) headers.Cookie = cookie;
  return headers;
}

function normalizeTimeout(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 15000;
  return Math.max(1000, Math.min(60000, Math.round(n)));
}

async function request(opts) {
  const options = opts || {};
  const path = String(options.path || '');
  if (!path) throw new ApiError('接口路径为空');
  await ensureLoaded();
  const mode = options.crypto === 'weapi' ? 'weapi' : 'plain';
  const method = String(options.method || 'POST').toUpperCase();
  const useCookie = options.auth !== false;
  let url = BASE + path;
  let body;

  if (mode === 'weapi') {
    url = BASE + path.replace(/^\/api\//, '/weapi/');
    body = weapiForm(options.data || {});
  } else if (method === 'GET' || method === 'HEAD') {
    const query = formEncode(options.data || {});
    if (query) url += (url.indexOf('?') >= 0 ? '&' : '?') + query;
  } else {
    body = formEncode(options.data || {});
  }

  const headers = requestHeaders(body);
  if (!useCookie) delete headers.Cookie;

  let res;
  try {
    res = await fushi.http.request({
      url,
      method,
      headers,
      body,
      timeoutMs: normalizeTimeout(options.timeoutMs),
      responseType: 'text',
    });
  } catch (e) {
    throw new ApiError('网络请求失败：' + e.message);
  }

  await absorbAndSave(res.setCookies);

  if (res.status < 200 || res.status >= 300) {
    throw new ApiError(`网易云接口暂不可用（HTTP ${res.status}）`);
  }

  const text = String(res.text || '');
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (e) {
    throw new ApiError('网易云接口返回了无法解析的内容');
  }
  return { status: res.status, json, text, setCookies: res.setCookies || [], url: res.url };
}

function plain(path, data, opts) {
  return request(Object.assign({ path, data, crypto: 'plain' }, opts || {}));
}

function weapi(path, data, opts) {
  return request(Object.assign({ path, data, crypto: 'weapi' }, opts || {}));
}

function badCryptoCode(res) {
  if (!res || !res.json || typeof res.json !== 'object') return true;
  const code = typeof res.json.code === 'number' ? res.json.code : undefined;
  return code === 400 || code === -460;
}

async function plainOrWeapi(path, data) {
  try {
    const res = await plain(path, data);
    if (badCryptoCode(res)) throw new ApiError('plain 校验失败', res.json && res.json.code);
    return res;
  } catch (e) {
    console.warn('plain 请求失败，改用 weapi 重试：' + e.message);
    return weapi(path, data);
  }
}

function isLoggedOut(json) {
  if (!json || typeof json !== 'object') return true;
  return json.code === 301 || json.code === 401 || json.account === null;
}

function assertOk(json, what) {
  if (!json || typeof json !== 'object') throw new ApiError('网易云接口返回异常');
  const code = typeof json.code === 'number' ? json.code : undefined;
  if (code === undefined || code === 200) return json;
  if (code === 301 || code === 401) throw new ApiError('登录已过期，请重新登录', code);
  if (code === 400 || code === -460) throw new ApiError('网易云接口校验失败，请稍后重试', code);
  throw new ApiError(`网易云${what || '接口'}失败（${code}）`, code);
}

function mediaHeaders() {
  return { 'User-Agent': UA, Referer: BASE + '/' };
}

async function setLoginCookie(text) {
  const map = parseCookieHeader(text);
  if (!map.MUSIC_U && !map.MUSIC_A) return false;
  loginCookie = serializeCookies(map);
  for (const name of LOGIN_NAMES) {
    if (jar[name] !== undefined) delete jar[name];
  }
  await Promise.all([persistLogin(), persistJar()]);
  return true;
}

function hasLoginCookie() {
  return !!loginCookie;
}

async function clearLogin() {
  loginCookie = '';
  for (const name of LOGIN_NAMES) {
    if (jar[name] !== undefined) delete jar[name];
  }
  await Promise.all([persistLogin(), persistJar()]);
}

module.exports = {
  ApiError,
  BASE,
  plain,
  weapi,
  plainOrWeapi,
  assertOk,
  isLoggedOut,
  csrfToken,
  ensureLoaded,
  cookieHeader,
  mediaHeaders,
  setLoginCookie,
  hasLoginCookie,
  clearLogin,
  request,
};
