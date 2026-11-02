'use strict';

const { TTL, cacheGet, cacheSet, clearAll } = require('./state.js');
const net = require('./net.js');
const { sid, str } = require('./map.js');

const METHODS = [
  { id: 'qr', type: 'qr', label: '扫码登录', description: '用网易云音乐 App 扫码' },
  {
    id: 'web',
    type: 'web',
    label: '网页登录',
    description: '在 Fushi 内打开网易云登录页，自动获取 Cookie',
  },
  {
    id: 'cookie',
    type: 'form',
    label: '粘贴 Cookie',
    description: '从浏览器复制 music.163.com 的 Cookie（含 MUSIC_U）',
  },
];

let inflight = null;

function anonymous() {
  return { account: { loggedIn: false }, vipType: 0, vipKnown: true };
}

function normalizeVipType(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n === 10 || n === 11) return n;
  // 网页账号的 profile.vipType 可能返回 100/110 这类带标志位的值，account.vipType
  // 仍是规范的 10/11；优先账号字段，同时把 110 归一成 11。
  if (n === 100 || n === 110) return n / 10;
  if (n >= 100) return Math.floor(n / 10);
  return n;
}

function shapeSession(json) {
  if (!json || !json.account || typeof json.account !== 'object' || json.account.id === undefined) {
    return anonymous();
  }
  const profile = json.profile && typeof json.profile === 'object' ? json.profile : {};
  const account = { loggedIn: true };
  const name = str(profile.nickname) || str(json.account.userName);
  if (name) account.name = name;
  const avatar = str(profile.avatarUrl) || str(json.account.avatarUrl);
  if (avatar) account.avatarUrl = avatar;
  const accountVipRaw = Number(json.account.vipType);
  const profileVipRaw = Number(profile.vipType);
  const vipType = normalizeVipType(json.account.vipType) || normalizeVipType(profile.vipType);
  const vipKnown = Number.isFinite(accountVipRaw) || Number.isFinite(profileVipRaw);
  if (vipType === 11) account.badge = '黑胶 VIP';
  else if (vipType === 10) account.badge = '音乐包';
  return { account, vipType, vipKnown, uid: sid(json.account.id) };
}

async function fetchSession(force) {
  if (!force) {
    const cached = cacheGet('account');
    if (cached) return cached;
    if (inflight) return inflight;
  }
  const run = (async () => {
    const res = await net.plainOrWeapi('/api/nuser/account/get', {});
    const json = res.json || {};
    if (json.code === 301 || json.code === 401) {
      const out = anonymous();
      cacheSet('account', out, TTL.account);
      return out;
    }
    net.assertOk(json, '账号');
    const out = shapeSession(json);
    cacheSet('account', out, TTL.account);
    return out;
  })();
  inflight = run;
  try {
    return await run;
  } finally {
    if (inflight === run) inflight = null;
  }
}

async function getSession() {
  try {
    return await fetchSession(false);
  } catch (e) {
    return anonymous();
  }
}

async function isVip() {
  const session = await getSession();
  return session.vipType === 10 || session.vipType === 11;
}

async function account() {
  return (await fetchSession(false)).account;
}

function qrContent(key) {
  return 'https://music.163.com/login?codekey=' + encodeURIComponent(key);
}

function qrChallenge(key, scanned, message) {
  return {
    state: 'pending',
    session: key,
    qr: { content: qrContent(key), scanned: !!scanned },
    pollMs: 2000,
    message,
  };
}

function webChallenge() {
  return {
    state: 'pending',
    message: '请在打开的网页中登录网易云',
    web: {
      url: 'https://music.163.com/#/login',
      cookieUrl: 'https://music.163.com/',
      doneCookie: 'MUSIC_U',
    },
  };
}

function formChallenge(message) {
  return {
    state: 'pending',
    message: message || '请粘贴 music.163.com 的 Cookie',
    form: {
      fields: [
        {
          id: 'cookie',
          label: 'Cookie',
          secret: true,
          multiline: true,
          placeholder: 'MUSIC_U=...; __csrf=...',
        },
      ],
      actions: [{ id: 'cookie', label: '登录', primary: true }],
    },
  };
}

async function begin(args) {
  if (args.method === 'cookie') return formChallenge();
  if (args.method === 'web') return webChallenge();
  if (args.method !== 'qr') throw new net.ApiError('不支持的登录方式');
  const res = await net.plainOrWeapi('/api/login/qrcode/unikey', { type: 3 });
  net.assertOk(res.json, '二维码');
  const key = str(res.json.unikey) || str(res.json.key);
  if (!key) throw new net.ApiError('网易云没有返回二维码，请稍后重试');
  return qrChallenge(key, false, '请用网易云音乐 App 扫码');
}

async function verifyLogin() {
  clearAll();
  inflight = null;
  let session;
  try {
    session = await fetchSession(true);
  } catch (e) {
    return { state: 'failed', message: '登录后验证失败：' + e.message };
  }
  if (session.account.loggedIn) return { state: 'done', account: session.account };
  await net.clearLogin();
  return { state: 'failed', message: '登录未生效，请重试' };
}

async function pollQr(session) {
  const key = str(session);
  if (!key) return { state: 'failed', message: '二维码已失效，请重新获取' };
  const res = await net.plainOrWeapi('/api/login/qrcode/client/login', { key, type: 3 });
  const json = res.json || {};
  const code = Number(json.code);
  const detail = str(json.message) || str(json.msg) || str(json.error);
  if (code === 801) {
    return qrChallenge(key, false, '等待扫码');
  }
  if (code === 802) {
    return qrChallenge(key, true, '已扫码，请在手机上确认');
  }
  if (code === 800) return { state: 'failed', message: '二维码已过期，请重新获取' };
  if (code === 8821) {
    return {
      state: 'failed',
      message:
        '网易云拒绝了扫码登录（8821）' +
        (detail ? '：' + detail : '') +
        '。请刷新二维码后立即在手机上确认，或改用「粘贴 Cookie」',
    };
  }
  if (code === 803) {
    let cookieText = typeof json.cookie === 'string' ? json.cookie : '';
    if (!cookieText) {
      const pairs = [];
      for (const raw of Array.isArray(res.setCookies) ? res.setCookies : []) {
        const pair = String(raw).split(';')[0];
        if (/^\s*(MUSIC_U|MUSIC_A)=/.test(pair)) pairs.push(pair);
      }
      cookieText = pairs.join('; ');
    }
    if (!cookieText) {
      if (net.hasLoginCookie()) return verifyLogin();
      return { state: 'failed', message: '登录成功但没拿到 Cookie，请改用粘贴 Cookie' };
    }
    const stored = await net.setLoginCookie(cookieText);
    if (!stored) return { state: 'failed', message: '登录 Cookie 不完整，请重试' };
    return verifyLogin();
  }
  return {
    state: 'failed',
    message:
      '登录状态未知（' +
      (Number.isFinite(code) ? code : '无响应') +
      '）' +
      (detail ? '：' + detail : ''),
  };
}

async function poll(args) {
  if (args.method !== 'qr') return { state: 'failed', message: '网页登录不需要轮询' };
  return pollQr(args.session);
}

function normalizeCookie(raw) {
  let text = String(raw || '').trim();
  if (!text) return '';
  text = text.replace(/^cookie\s*:\s*/i, '');
  return text.replace(/\r?\n/g, ';').replace(/\s+/g, ' ').trim();
}

async function submit(args) {
  const method = args.method;
  if (method !== 'cookie' && method !== 'web') {
    return { state: 'failed', message: '请扫码登录' };
  }
  if (args.action !== method) return { state: 'failed', message: '未知的登录操作' };
  const raw = args.inputs && args.inputs.cookie;
  const text = normalizeCookie(raw);
  if (!text) {
    return {
      state: 'failed',
      message: method === 'web' ? '网页登录没有拿到 Cookie，请重试或改用粘贴 Cookie' : '请粘贴包含 MUSIC_U 或 MUSIC_A 的 Cookie',
    };
  }
  const stored = await net.setLoginCookie(text);
  if (!stored) {
    return {
      state: 'failed',
      message: method === 'web' ? '网页登录没有拿到有效的 MUSIC_U，请重试' : 'Cookie 中缺少 MUSIC_U 或 MUSIC_A',
    };
  }
  return verifyLogin();
}

async function logout() {
  await net.clearLogin();
  clearAll();
  inflight = null;
  return null;
}

async function login(args) {
  const a = args || {};
  if (a.op === 'methods') return { methods: METHODS };
  if (a.op === 'begin') return begin(a);
  if (a.op === 'poll') return poll(a);
  if (a.op === 'submit') return submit(a);
  if (a.op === 'logout') return logout();
  throw new net.ApiError('未知的登录操作');
}

module.exports = { account, getSession, isVip, login };
