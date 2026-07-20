const CURRENT_VERSION = '3.3-enhanced';

// 内置优选域名
const DEFAULT_OPTIMIZED_DOMAINS = [
  { domain: 'youxuan.cf.090227.xyz', name: 'CF优选-090227', isBuiltin: true },
  { domain: 'cf.877774.xyz', name: '秋名山优选', isBuiltin: true },
  { domain: 'cf.cf.cnae.top', name: 'NB优选', isBuiltin: true },
  { domain: 'saas.sin.fan', name: 'MIYU优选', isBuiltin: true },
  { domain: 'bestcf.030101.xyz', name: 'Mingyu优选', isBuiltin: true },
  { domain: 'cf.cloudflare.182682.xyz', name: 'WeTest优选', isBuiltin: true },
  { domain: 'cf.tencentapp.cn', name: '无名氏维护域名', isBuiltin: true },
  { domain: 'www.visa.cn', name: 'Visa官方', isBuiltin: true },
  { domain: 'mfa.gov.ua', name: '乌克兰外交部', isBuiltin: true },
  { domain: 'www.shopify.com', name: 'Shopify官方', isBuiltin: true },
  { domain: 'store.ubi.com', name: '育碧商店', isBuiltin: true },
  { domain: 'staticdelivery.nexusmods.com', name: 'NexusMods', isBuiltin: true },
];

const RESERVED_ALIASES = new Set([
  'admin', 'stats', 'health', 'api', 'favicon.ico', 'cdn-cgi',
  '__client_rtt__', 'web', 'emby', 'sessions', 'playbackinfo',
]);

const MANUAL_REDIRECT_DOMAINS = [
  'emby.bangumi.ca', 'aliyundrive.com', 'aliyundrive.net', 'aliyuncs.com', 'alicdn.com', 'aliyun.com',
  'cdn.aliyundrive.com', 'xunlei.com', 'xlusercdn.com', 'xycdn.com', 'sandai.net', 'thundercdn.com',
  '115.com', '115cdn.com', '115cdn.net', 'anxia.com', '189.cn', 'mini189.cn', 'ctyunxs.cn',
  'cloud.189.cn', 'tianyiyun.com', 'telecomjs.com', 'quark.cn', 'quarkdrive.cn', 'uc.cn', 'ucdrive.cn',
  'xiaoya.pro', 'myqcloud.com', 'cloudfront.net', 'akamaized.net', 'fastly.net', 'hwcdn.net', 'bytecdn.cn', 'bdcdn.net',
];

const DOMAIN_PROXY_RULES = { 'bilibili.uk': 'example.com' };
const JP_COLOS = ['NRT', 'KIX', 'FUK', 'OKA'];

const CONFIG = {
  enableStats: true,
};

const CORS_JSON = { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' };

let dbReady = false;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS_JSON });
}

function html(body, status = 200) {
  return new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

function getCookie(req, name) {
  const s = req.headers.get('Cookie');
  if (!s) return null;
  const m = s.match(new RegExp('(^| )' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[2]) : null;
}

function getAdminToken(env) {
  const raw = env.ADMIN_TOKEN ?? env.ADMIN_PASSWORD ?? env.admin_token ?? env.AdminToken;
  if (raw == null) return null;
  const t = String(raw).trim();
  return t.length ? t : null;
}

function isAdmin(request, env) {
  const expected = getAdminToken(env);
  if (!expected) return false;
  const provided = getCookie(request, 'admin_token');
  return provided === expected;
}

function adminLoginResponse(request, env, tokenFromUser) {
  const expected = getAdminToken(env);
  if (!expected) {
    return json({
      ok: false,
      error: 'Worker 未读到 ADMIN_TOKEN。请在 Cloudflare 控制台 → Worker → 设置 → 变量和机密 中添加 ADMIN_TOKEN。',
    }, 503);
  }
  if (tokenFromUser !== expected) {
    return json({ ok: false, error: '密钥错误' }, 401);
  }
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  const cookie = `admin_token=${encodeURIComponent(expected)}; Path=/; Max-Age=7200; SameSite=Lax${secure}`;
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': cookie,
      'Cache-Control': 'no-store',
    },
  });
}

function getClientCacheKey(request) {
  const ip = request.headers.get('cf-connecting-ip') || '0.0.0.0';
  const cf = request.cf || {};
  let ipKey = ip;
  if (ip.includes('.')) ipKey = ip.split('.').slice(0, 3).join('.');
  else if (ip.includes(':')) ipKey = ip.split(':').slice(0, 4).join(':');
  return `${cf.country || 'XX'}|${cf.city || ''}|${cf.asn || ''}|${ipKey}`;
}

function latencyStatus(ms) {
  if (ms < 0) return 'timeout';
  if (ms < 100) return 'fast';
  if (ms < 300) return 'good';
  return 'slow';
}

async function initDatabase(env) {
  if (!env.DB || dbReady) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS routes (
      prefix TEXT PRIMARY KEY, target TEXT NOT NULL,
      remark TEXT DEFAULT '', last_play TEXT DEFAULT '',
      cache_img TEXT DEFAULT 'on', compat_mode TEXT DEFAULT 'off',
      sort_order INTEGER DEFAULT 0
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS visitor_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, prefix TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, ip TEXT, country TEXT, ua TEXT
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS request_stats (
      prefix TEXT, date TEXT, count INTEGER DEFAULT 0, PRIMARY KEY(prefix, date)
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS auto_emby_daily_stats (
      date TEXT PRIMARY KEY, playing_count INTEGER DEFAULT 0, playback_info_count INTEGER DEFAULT 0
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS optimized_domains (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      domain TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      is_builtin INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS dns_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dns_name TEXT NOT NULL,
      current_domain TEXT,
      zone_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`),
  ]);
  
  try {
    const { results } = await env.DB.prepare('SELECT COUNT(*) as count FROM optimized_domains').all();
    if (results[0].count === 0) {
      const stmt = env.DB.prepare('INSERT INTO optimized_domains (domain, name, is_builtin) VALUES (?, ?, 1)');
      for (const d of DEFAULT_OPTIMIZED_DOMAINS) {
        try {
          await stmt.bind(d.domain, d.name).run();
        } catch (e) {}
      }
    }
  } catch (e) {}
  
  dbReady = true;
}

async function getOptimizedDomains(env) {
  const { results } = await env.DB.prepare('SELECT * FROM optimized_domains ORDER BY is_builtin DESC, name ASC').all();
  return results.map(r => ({
    id: r.id,
    domain: r.domain,
    name: r.name,
    isBuiltin: Boolean(r.is_builtin),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

async function addOptimizedDomain(env, domain, name) {
  const result = await env.DB.prepare('INSERT INTO optimized_domains (domain, name, is_builtin) VALUES (?, ?, 0)')
    .bind(domain, name)
    .run();
  return result.success;
}

async function updateOptimizedDomain(env, id, domain, name) {
  const result = await env.DB.prepare('UPDATE optimized_domains SET domain = ?, name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .bind(domain, name, id)
    .run();
  return result.success;
}

async function deleteOptimizedDomain(env, id) {
  const result = await env.DB.prepare('DELETE FROM optimized_domains WHERE id = ?')
    .bind(id)
    .run();
  return result.success;
}

async function getDNSConfig(env) {
  const { results } = await env.DB.prepare('SELECT * FROM dns_config ORDER BY id DESC LIMIT 1').all();
  if (results.length > 0) {
    return {
      id: results[0].id,
      dnsName: results[0].dns_name,
      currentDomain: results[0].current_domain,
      zoneId: results[0].zone_id,
      createdAt: results[0].created_at,
      updatedAt: results[0].updated_at,
    };
  }
  return null;
}

async function saveDNSConfig(env, dnsName, currentDomain, zoneId) {
  const existing = await getDNSConfig(env);
  let result;
  if (existing) {
    result = await env.DB.prepare('UPDATE dns_config SET dns_name = ?, current_domain = ?, zone_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .bind(dnsName, currentDomain || '', zoneId || '', existing.id)
      .run();
  } else {
    result = await env.DB.prepare('INSERT INTO dns_config (dns_name, current_domain, zone_id) VALUES (?, ?, ?)')
      .bind(dnsName, currentDomain || '', zoneId || '')
      .run();
  }
  return result.success;
}

async function cloudflareAPICall(env, method, endpoint, body = null) {
  const apiToken = env.CF_API_TOKEN;
  const zoneId = env.CF_ZONE_ID;
  const accountId = env.CF_ACCOUNT_ID;
  const dnsRecordName = env.DNS_RECORD_NAME;
  
  if (!apiToken) {
    return { success: false, error: 'CF_API_TOKEN not configured' };
  }
  
  const url = `https://api.cloudflare.com/client/v4${endpoint}`;
  const headers = {
    'Authorization': 'Bearer ' + apiToken,
    'Content-Type': 'application/json',
  };
  
  const options = {
    method,
    headers,
  };
  
  if (body) {
    options.body = JSON.stringify(body);
  }
  
  try {
    const response = await fetch(url, options);
    const data = await response.json();
    return data;
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function getZones(env) {
  const accountId = env.CF_ACCOUNT_ID;
  const endpoint = accountId ? '/zones?account.id=' + accountId : '/zones';
  return await cloudflareAPICall(env, 'GET', endpoint);
}

async function getDNSRecords(env, zoneId) {
  return await cloudflareAPICall(env, 'GET', `/zones/${zoneId}/dns_records`);
}

async function createOrUpdateDNSRecord(env, zoneId, dnsName, targetDomain) {
  if (!zoneId) zoneId = env.CF_ZONE_ID;
  const baseDomain = env.BASE_DOMAIN || 'example.com';
  const defaultDNSName = env.DNS_RECORD_NAME || dnsName;
  const fullDNSName = `${dnsName}.${baseDomain}`;
  
  const recordsResult = await getDNSRecords(env, zoneId);
  if (!recordsResult.success) {
    return recordsResult;
  }
  
  const existingRecord = recordsResult.result.find(r => r.name === fullDNSName && r.type === 'CNAME');
  
  const recordData = {
    type: 'CNAME',
    name: dnsName,
    content: targetDomain,
    ttl: 1,
    proxied: false,
  };
  
  let result;
  if (existingRecord) {
    result = await cloudflareAPICall(env, 'PUT', `/zones/${zoneId}/dns_records/${existingRecord.id}`, recordData);
  } else {
    result = await cloudflareAPICall(env, 'POST', `/zones/${zoneId}/dns_records`, recordData);
  }
  
  if (result.success) {
    await saveDNSConfig(env, dnsName, targetDomain, zoneId);
  }
  
  return result;
}

async function getEdgeInfo(request) {
  const cf = request.cf || {};
  let traceIp = '';
  let traceColo = cf.colo || '未知';
  try {
    const tr = await fetch('https://1.1.1.1/cdn-cgi/trace', { headers: { 'User-Agent': 'CF-Worker-Trace' } });
    const text = await tr.text();
    const coloM = text.match(/colo=([A-Z0-9]+)/);
    const ipM = text.match(/ip=([^\n]+)/);
    if (coloM) traceColo = coloM[1];
    if (ipM) traceIp = ipM[1].trim();
  } catch (_) {}
  return {
    clientIp: request.headers.get('cf-connecting-ip') || '未知',
    entryColo: cf.colo || '未知',
    entryCountry: cf.country || '未知',
    entryCity: cf.city || '',
    edgeIp: traceIp || '—',
    egressColo: traceColo,
    cacheKey: getClientCacheKey(request),
  };
}

async function speedtestUrl(urlStr, timeoutMs = 5000) {
  const start = Date.now();
  try {
    const u = new URL(urlStr.startsWith('http') ? urlStr : 'https://' + urlStr);
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(u.origin + '/', { method: 'HEAD', signal: ctrl.signal, redirect: 'manual' });
    clearTimeout(tid);
    if (res.status === 502 || res.status === 503 || res.status === 504) return -1;
    return Date.now() - start;
  } catch {
    return -1;
  }
}

async function speedtestOptimizedFromEdge(env) {
  const domains = await getOptimizedDomains(env);
  const results = [];
  for (const item of domains) {
    const host = item.domain;
    const ms = await speedtestUrl(`https://${host}/cdn-cgi/trace`, 4000);
    results.push({
      id: item.id,
      domain: item.domain,
      name: item.name,
      host,
      latency: ms,
      status: latencyStatus(ms),
      isBuiltin: item.isBuiltin,
    });
  }
  results.sort((a, b) => {
    if (a.latency < 0 && b.latency < 0) return 0;
    if (a.latency < 0) return 1;
    if (b.latency < 0) return -1;
    return a.latency - b.latency;
  });
  const best = results.find((r) => r.latency >= 0);
  return { results, best: best ? best : null };
}

async function recordStats(env, type) {
  if (!env.DB || !CONFIG.enableStats) return;
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
  const q = type === 'playing'
    ? `INSERT INTO auto_emby_daily_stats (date, playing_count, playback_info_count) VALUES (?, 1, 0)
       ON CONFLICT(date) DO UPDATE SET playing_count = playing_count + 1`
    : `INSERT INTO auto_emby_daily_stats (date, playing_count, playback_info_count) VALUES (?, 0, 1)
       ON CONFLICT(date) DO UPDATE SET playback_info_count = playback_info_count + 1`;
  await env.DB.prepare(q).bind(today).run();
}

async function handleStatsRequest(env) {
  if (!env.DB) return json({ error: 'D1 数据库未绑定', data: null });
  const statsResult = await env.DB.prepare(
    `SELECT date, playing_count, playback_info_count FROM auto_emby_daily_stats
     WHERE date >= date('now', '-30 days') ORDER BY date DESC`
  ).all();
  const totalResult = await env.DB.prepare(
    `SELECT SUM(playing_count) as total_playing, SUM(playback_info_count) as total_playback_info
     FROM auto_emby_daily_stats WHERE date >= date('now', '-30 days')`
  ).first();
  return json({
    error: null,
    data: {
      total: { playing: totalResult?.total_playing || 0, playbackInfo: totalResult?.total_playback_info || 0 },
      dailyStats: statsResult?.results || [],
      lastUpdated: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
    },
  });
}

function normalizePrefix(p) {
  return String(p || '').trim().toLowerCase().replace(/^\/+|\/+$/g, '');
}

function validatePrefix(prefix) {
  const a = normalizePrefix(prefix);
  if (!a || !/^[a-z0-9][a-z0-9_-]{0,62}$/i.test(a)) return '路径仅允许字母数字、下划线和连字符';
  if (RESERVED_ALIASES.has(a.toLowerCase())) return '该路径为系统保留，不可使用';
  return null;
}

async function handleAdminApi(request, env, url) {
  if (!isAdmin(request, env)) return new Response('Unauthorized', { status: 401 });

  if (url.pathname === '/admin/api/routes') {
    if (request.method === 'GET') {
      const { results } = await env.DB.prepare('SELECT * FROM routes ORDER BY sort_order, prefix').all();
      return json(results || []);
    }
    if (request.method === 'POST') {
      const data = await request.json();
      const err = validatePrefix(data.prefix);
      if (err) return json({ error: err }, 400);
      const prefix = normalizePrefix(data.prefix);
      let currentSortOrder = 0;
      if (data.oldPrefix && data.oldPrefix !== data.prefix) {
        const oldRow = await env.DB.prepare('SELECT sort_order FROM routes WHERE prefix = ?').bind(normalizePrefix(data.oldPrefix)).first();
        if (oldRow) currentSortOrder = oldRow.sort_order;
        await env.DB.prepare('DELETE FROM routes WHERE prefix = ?').bind(normalizePrefix(data.oldPrefix)).run();
      } else {
        const oldRow = await env.DB.prepare('SELECT sort_order FROM routes WHERE prefix = ?').bind(prefix).first();
        if (oldRow) currentSortOrder = oldRow.sort_order;
      }
      await env.DB.prepare(
        'INSERT OR REPLACE INTO routes (prefix, target, remark, cache_img, compat_mode, sort_order) VALUES (?, ?, ?, ?, ?, ?)'
      ).bind(
        prefix, data.target, data.remark || '', data.cache_img || 'on', data.compat_mode || 'off', currentSortOrder
      ).run();
      return json({ success: true });
    }
    if (request.method === 'DELETE') {
      const prefix = url.searchParams.get('prefix');
      if (!prefix) return json({ error: '缺少 prefix 参数' }, 400);
      await env.DB.prepare('DELETE FROM routes WHERE prefix = ?').bind(normalizePrefix(prefix)).run();
      return json({ success: true });
    }
  }

  if (url.pathname === '/admin/api/speedtest/domains' && request.method === 'POST') {
    const data = await speedtestOptimizedFromEdge(env);
    return json(data);
  }

  if (url.pathname === '/admin/api/optimized-domains') {
    if (request.method === 'GET') {
      const domains = await getOptimizedDomains(env);
      return json({ success: true, domains });
    }
    if (request.method === 'POST') {
      const data = await request.json();
      const success = await addOptimizedDomain(env, data.domain, data.name);
      return json({ success });
    }
  }

  if (url.pathname.startsWith('/admin/api/optimized-domains/')) {
    const id = url.pathname.split('/').pop();
    if (request.method === 'PUT') {
      const data = await request.json();
      const success = await updateOptimizedDomain(env, id, data.domain, data.name);
      return json({ success });
    }
    if (request.method === 'DELETE') {
      const success = await deleteOptimizedDomain(env, id);
      return json({ success });
    }
  }

  if (url.pathname === '/admin/api/dns-config') {
    if (request.method === 'GET') {
      const config = await getDNSConfig(env);
      let zones = [];
      let zonesError = null;
      try {
        const zonesResult = await getZones(env);
        if (zonesResult.success && zonesResult.result) {
          zones = zonesResult.result;
        } else {
          zonesError = zonesResult.error || zonesResult.errors?.[0]?.message || '获取区域列表失败';
        }
      } catch (e) {
        zonesError = e.message;
      }
      return json({ success: true, config, zones, zonesError });
    }
    if (request.method === 'POST') {
      const data = await request.json();
      const success = await saveDNSConfig(env, data.dnsName, data.currentDomain || '', data.zoneId || '');
      return json({ success });
    }
  }

  if (url.pathname === '/admin/api/dns/replace' && request.method === 'POST') {
    const data = await request.json();
    const { zoneId, dnsName, targetDomain } = data;
    
    if (!dnsName || !targetDomain) {
      return json({ success: false, error: '缺少必要参数' });
    }
    
    const result = await createOrUpdateDNSRecord(env, zoneId, dnsName, targetDomain);
    if (result.success && result.result) {
      return json({ success: true, result: result.result });
    }
    return json({ success: false, error: result.error || result.errors?.[0]?.message || 'DNS 替换失败', errors: result.errors });
  }

  return json({ error: 'Not found' }, 404);
}

async function resolveProxyTarget(request, env, url) {
  const decodedPath = decodeURIComponent(url.pathname);
  const pathParts = decodedPath.split('/').filter(Boolean);
  const prefix = normalizePrefix(pathParts[0]);
  if (!prefix) return { error: new Response('Not Found', { status: 404 }) };

  const route = await env.DB.prepare('SELECT * FROM routes WHERE prefix = ?').bind(prefix).first();
  if (!route) return { error: new Response('404: 节点不存在', { status: 404 }) };

  const enableCache = route.cache_img !== 'off';
  const compatMode = route.compat_mode === 'on';
  const remainingSegments = pathParts.slice(1).join('/');
  const targetUrls = route.target.split(',').map(s => s.trim()).filter(Boolean);

  let upstreamUrls = [];
  for (const target of targetUrls) {
    try {
      const t = new URL(target);
      const port = t.port || (t.protocol === 'https:' ? '443' : '80');
      const scheme = t.protocol.replace(':', '');
      let path = t.hostname + ':' + port;
      if (remainingSegments) path += '/' + remainingSegments;
      if (url.search) path += url.search;
      const parsed = new URL(scheme + '://' + path);
      upstreamUrls.push(parsed.toString());
    } catch {
      const suffix = remainingSegments ? '/' + remainingSegments : '';
      upstreamUrls.push(target.replace(/\/+$/, '') + suffix + url.search);
    }
  }

  return { upstreamUrls, enableCache, compatMode, matchedPrefix: route.prefix };
}

function normalizeAlias(a) {
  return String(a || '').trim().toLowerCase().replace(/^\/+|\/+$/g, '');
}

async function proxyDirectUrl(request, env, ctx, upstreamUrls, opts = {}) {
// 放在函数最开头，任何逻辑之前
if (request.method === 'OPTIONS') {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': '*',
    },
  });
}

  const { enableCache = true, compatMode = false, matchedPrefix = null } = opts;

  if (!upstreamUrls.length) return new Response('404: Target empty', { status: 404 });

  let firstUpstreamUrl;
  try {
    firstUpstreamUrl = new URL(upstreamUrls[0]);
  } catch {
    return new Response('Invalid upstream URL', { status: 500 });
  }

  const isPlaybackInfo = /\/PlaybackInfo/i.test(firstUpstreamUrl.pathname);
  const isPlaying = firstUpstreamUrl.pathname.endsWith('/Sessions/Playing');

  if (isPlaying && CONFIG.enableStats) ctx.waitUntil(recordStats(env, 'playing'));
  if (isPlaybackInfo) ctx.waitUntil(recordStats(env, 'playback_info'));

  if (matchedPrefix && env.DB && ctx?.waitUntil && isPlaybackInfo) {
    const todayStr = new Date(Date.now() + 8 * 3600000).toISOString().split('T')[0];
    const nowTime = new Date(Date.now() + 8 * 3600000).toISOString().replace('T', ' ').split('.')[0];
    const clientIp = request.headers.get('cf-connecting-ip') || 'Unknown';
    const clientCountry = request.headers.get('cf-ipcountry') || 'Unknown';
    const clientUa = request.headers.get('User-Agent') || 'Unknown';
    try {
      ctx.waitUntil(env.DB.batch([
        env.DB.prepare(`INSERT INTO request_stats (prefix, date, count) VALUES (?, ?, 1) ON CONFLICT(prefix, date) DO UPDATE SET count = count + 1`).bind(matchedPrefix, todayStr),
        env.DB.prepare(`UPDATE routes SET last_play = ? WHERE prefix = ?`).bind(nowTime, matchedPrefix),
        env.DB.prepare(`INSERT INTO visitor_logs (prefix, ip, country, ua) VALUES (?, ?, ?, ?)`).bind(matchedPrefix, clientIp, clientCountry, clientUa),
      ]));
    } catch (_) {}
  }

  const upgradeHeader = request.headers.get('Upgrade');
  if (upgradeHeader?.toLowerCase() === 'websocket') {
    return fetch(upstreamUrls[0], request);
  }

  let requestBody = null;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    requestBody = await request.arrayBuffer();
  }

  let finalResponse = null;
  let lastError = null;
  let lastUpstreamUrl = null;

  for (let i = 0; i < upstreamUrls.length; i++) {
    let upstreamUrl;
    try {
      upstreamUrl = new URL(upstreamUrls[i]);
    } catch {
      lastError = new Error('Invalid target URL');
      continue;
    }

    const colo = request.cf?.colo;
    if (colo && JP_COLOS.includes(colo)) {
      for (const suffix in DOMAIN_PROXY_RULES) {
        if (upstreamUrl.host.endsWith(suffix)) {
          upstreamUrl.hostname = DOMAIN_PROXY_RULES[suffix];
          break;
        }
      }
    }

    // --- 修改开始：这是你原本逻辑的替换部分 ---
    const headers = new Headers(request.headers);
    // 1. 删除危险的 Hop-by-hop Headers
    ['Connection', 'Keep-Alive', 'Transfer-Encoding', 'Upgrade', 'Proxy-Connection', 'TE', 'Trailer'].forEach(h => headers.delete(h));

    // 2. 规范化 Host/Origin/Referer
    headers.set('Host', upstreamUrl.host);
    if (request.headers.has('Origin')) headers.set('Origin', upstreamUrl.origin);
    if (request.headers.has('Referer')) headers.set('Referer', upstreamUrl.origin + '/');
    else headers.set('Referer', upstreamUrl.origin + '/'); // 强制补一个

    // 3. 增强 X-Forwarded 系列
    const clientIp = request.headers.get('cf-connecting-ip');
    if (clientIp) {
      headers.set('x-forwarded-for', clientIp);
      headers.set('x-real-ip', clientIp);
      headers.set('X-Forwarded-Proto', upstreamUrl.protocol.replace(':', ''));
      headers.set('X-Forwarded-Host', upstreamUrl.host);
    }

    // 4. 构建 fetchInit
    const fetchInit = {
      method: request.method,
      headers: headers,
      body: requestBody || undefined,
      redirect: compatMode ? 'follow' : 'manual',
      cf: {
        cacheEverything: false, // 核心：禁用缓存
      },
    };

    try {
      // 5. 构造标准的 Request 发起请求
      const response = await fetch(new Request(upstreamUrl.toString(), fetchInit));
      if (!compatMode && [502, 503, 504].includes(response.status)) {
        lastError = new Error(`HTTP ${response.status}`);
        continue;
      }
      finalResponse = response;
      lastUpstreamUrl = upstreamUrl;
      break;
    } catch (err) {
      lastError = err;
      continue;
    }
    // --- 修改结束 ---
  }

  if (!finalResponse) {
    return new Response('所有线路不可用: ' + (lastError?.message || 'Unknown'), { status: 502 });
  }

  if (!compatMode) {
    const location = finalResponse.headers.get('Location');
    if (location && finalResponse.status >= 300 && finalResponse.status < 400) {
      const redirectUrl = new URL(location, lastUpstreamUrl);

      if (MANUAL_REDIRECT_DOMAINS.some(domain => redirectUrl.hostname.endsWith(domain))) {
        const newHeaders = new Headers(finalResponse.headers);
        newHeaders.set('Location', redirectUrl.toString());
        return new Response(finalResponse.body, { status: finalResponse.status, headers: newHeaders });
      }

      const newReqHeaders = new Headers(request.headers);
      newReqHeaders.set('Host', redirectUrl.host);
      newReqHeaders.delete('Referer');
      const cIp = request.headers.get('cf-connecting-ip');
      if (cIp) {
        newReqHeaders.set('x-forwarded-for', cIp);
        newReqHeaders.set('x-real-ip', cIp);
      }

      return fetch(redirectUrl.toString(), {
        method: request.method,
        headers: newReqHeaders,
        body: requestBody || undefined,
        redirect: 'follow',
      });
    }
  }

  const responseHeaders = new Headers(finalResponse.headers);
  responseHeaders.set('Access-Control-Allow-Origin', '*');
  responseHeaders.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  responseHeaders.set('Access-Control-Allow-Headers', '*');
  responseHeaders.delete('Content-Security-Policy');
  responseHeaders.delete('X-Frame-Options');

  if (isPlaying || isPlaybackInfo) {
    responseHeaders.set('X-Served-By', request.cf?.colo || 'Unknown');
  }

  return new Response(finalResponse.body, {
    status: finalResponse.status,
    statusText: finalResponse.statusText,
    headers: responseHeaders,
  });
}

const PAGE_STYLE = `
  * { box-sizing: border-box; }
  body { font-family: -apple-system, system-ui, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; line-height: 1.6; color: #e5e7eb; margin: 0; padding: 0; background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%); min-height: 100vh; }
  .container { max-width: 1200px; margin: auto; padding: 24px; display: flex; flex-direction: column; gap: 24px; }
  .card { background: rgba(30, 41, 59, 0.7); backdrop-filter: blur(10px); padding: 28px; border-radius: 20px; border: 1px solid rgba(148, 163, 184, 0.15); box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3); }
  h1 { margin-top: 0; color: #60a5fa; font-size: 2em; font-weight: 700; letter-spacing: -0.02em; }
  h2 { color: #94a3b8; border-bottom: 2px solid rgba(148, 163, 184, 0.15); padding-bottom: 12px; font-size: 1.2em; font-weight: 600; letter-spacing: -0.01em; }
  code { background: rgba(96, 165, 250, 0.15); padding: 4px 10px; border-radius: 8px; color: #93c5fd; word-break: break-all; font-size: 0.9em; border: 1px solid rgba(96, 165, 250, 0.2); }
  .muted { color: #94a3b8; font-size: 14px; }
  .stat-row { display: flex; gap: 16px; flex-wrap: wrap; margin: 20px 0; }
  .stat-card { flex: 1; min-width: 160px; background: linear-gradient(135deg, rgba(96, 165, 250, 0.1) 0%, rgba(59, 130, 246, 0.05) 100%); border: 1px solid rgba(96, 165, 250, 0.2); border-radius: 16px; padding: 20px; text-align: center; transition: transform 0.2s ease, box-shadow 0.2s ease; }
  .stat-card:hover { transform: translateY(-2px); box-shadow: 0 10px 30px rgba(96, 165, 250, 0.2); }
  .stat-val { font-size: 2em; font-weight: 700; color: #60a5fa; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th, td { padding: 12px 14px; text-align: left; border-bottom: 1px solid rgba(148, 163, 184, 0.15); }
  th { color: #60a5fa; background: rgba(96, 165, 250, 0.08); font-weight: 600; }
  tr.best td { background: rgba(34, 197, 94, 0.08); }
  .tag { display: inline-block; padding: 4px 10px; border-radius: 20px; font-size: 12px; font-weight: 600; }
  .tag-fast { background: rgba(34, 197, 94, 0.2); color: #4ade80; border: 1px solid rgba(34, 197, 94, 0.3); }
  .tag-good { background: rgba(96, 165, 250, 0.2); color: #93c5fd; border: 1px solid rgba(96, 165, 250, 0.3); }
  .tag-slow { background: rgba(251, 191, 36, 0.2); color: #fbbf24; border: 1px solid rgba(251, 191, 36, 0.3); }
  .tag-timeout { background: rgba(248, 113, 113, 0.2); color: #f87171; border: 1px solid rgba(248, 113, 113, 0.3); }
  .tag-builtin { background: rgba(168, 85, 247, 0.2); color: #a855f7; border: 1px solid rgba(168, 85, 247, 0.3); }
  .edge-box { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 16px; }
  .edge-item { background: rgba(15, 23, 42, 0.5); padding: 16px; border-radius: 12px; font-size: 13px; border: 1px solid rgba(148, 163, 184, 0.1); }
  .edge-item strong { color: #60a5fa; display: block; margin-bottom: 6px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; }
  .btn { display: inline-flex; align-items: center; gap: 8px; padding: 12px 20px; background: linear-gradient(135deg, #60a5fa 0%, #3b82f6 100%); color: #fff; border-radius: 12px; text-decoration: none; font-weight: 600; border: none; cursor: pointer; font-size: 14px; transition: all 0.2s ease; box-shadow: 0 4px 15px rgba(96, 165, 250, 0.3); }
  .btn:hover { background: linear-gradient(135deg, #93c5fd 0%, #60a5fa 100%); transform: translateY(-2px); box-shadow: 0 6px 20px rgba(96, 165, 250, 0.4); }
  .btn:active { transform: translateY(0); }
  .btn:disabled { opacity: 0.6; cursor: not-allowed; transform: none; }
  .btn-success { background: linear-gradient(135deg, #22c55e 0%, #16a34a 100%); }
  .btn-success:hover { background: linear-gradient(135deg, #4ade80 0%, #22c55e 100%); }
  .btn-sm { padding: 8px 14px; font-size: 13px; border-radius: 10px; font-weight: 500; }
  .btn-del { background: rgba(248, 113, 113, 0.15); border: 1px solid rgba(248, 113, 113, 0.3); color: #fca5a5; box-shadow: none; }
  .btn-del:hover { background: rgba(248, 113, 113, 0.25); }
  .btn-outline { background: rgba(148, 163, 184, 0.15); border: 1px solid rgba(148, 163, 184, 0.3); color: #cbd5e1; box-shadow: none; }
  .btn-outline:hover { background: rgba(148, 163, 184, 0.25); }
  .warn { border: 2px solid rgba(248, 113, 113, 0.3); padding: 20px; border-radius: 16px; color: #fca5a5; background: rgba(248, 113, 113, 0.08); }
  input[type=password], input[type=text], input[type=url], select { width: 100%; padding: 14px 16px; border: 2px solid rgba(148, 163, 184, 0.2); border-radius: 12px; background: rgba(15, 23, 42, 0.6); color: #e5e7eb; margin-bottom: 16px; font-size: 14px; transition: all 0.2s ease; }
  input[type=password]:focus, input[type=text]:focus, input[type=url]:focus, select:focus { outline: none; border-color: #60a5fa; box-shadow: 0 0 0 4px rgba(96, 165, 250, 0.1); }
  label { display: block; font-weight: 600; margin-bottom: 8px; font-size: 13px; color: #cbd5e1; text-transform: uppercase; letter-spacing: 0.05em; }
  .form-row { margin-bottom: 20px; }
  .toolbar { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 24px; align-items: center; }
  .route-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 20px; }
  .route-item { background: linear-gradient(135deg, rgba(30, 41, 59, 0.9) 0%, rgba(15, 23, 42, 0.9) 100%); border: 1px solid rgba(148, 163, 184, 0.15); border-radius: 20px; padding: 24px; transition: all 0.3s ease; position: relative; overflow: hidden; }
  .route-item::before { content: ''; position: absolute; top: 0; left: 0; right: 0; height: 4px; background: linear-gradient(90deg, #60a5fa 0%, #a78bfa 50%, #60a5fa 100%); opacity: 0; transition: opacity 0.3s ease; }
  .route-item:hover { transform: translateY(-4px); box-shadow: 0 20px 50px rgba(0, 0, 0, 0.4); border-color: rgba(96, 165, 250, 0.3); }
  .route-item:hover::before { opacity: 1; }
  .route-header { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
  .route-title { flex: 1; }
  .route-name { font-size: 1.3em; font-weight: 700; color: #f1f5f9; margin: 0 0 4px; letter-spacing: -0.01em; }
  .route-path { color: #60a5fa; font-weight: 600; font-size: 0.95em; }
  .route-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 16px; padding-top: 16px; border-top: 1px solid rgba(148, 163, 184, 0.1); }
  .target-list { margin-top: 12px; }
  .target-row { background: rgba(15, 23, 42, 0.6); border: 1px solid rgba(148, 163, 184, 0.1); border-radius: 12px; padding: 12px 16px; margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center; gap: 12px; transition: all 0.2s ease; }
  .target-row:hover { background: rgba(15, 23, 42, 0.8); border-color: rgba(148, 163, 184, 0.2); }
  .target-url { color: #94a3b8; font-size: 13px; word-break: break-all; flex: 1; }
  .route-meta { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
  .meta-tag { font-size: 11px; padding: 3px 8px; background: rgba(148, 163, 184, 0.15); border-radius: 20px; color: #cbd5e1; }
  .modal { display: none; position: fixed; inset: 0; background: rgba(15, 23, 42, 0.85); backdrop-filter: blur(8px); z-index: 1000; padding: 20px; overflow: auto; animation: fadeIn 0.2s ease; }
  @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
  .modal.show { display: flex; align-items: center; justify-content: center; }
  .modal-inner { background: linear-gradient(135deg, rgba(30, 41, 59, 0.95) 0%, rgba(15, 23, 42, 0.95) 100%); padding: 32px; border-radius: 24px; max-width: 560px; width: 100%; border: 1px solid rgba(148, 163, 184, 0.2); box-shadow: 0 25px 60px rgba(0, 0, 0, 0.5); animation: slideUp 0.3s ease; }
  @keyframes slideUp { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
  .modal-header { margin-bottom: 24px; }
  .modal-title { font-size: 1.5em; font-weight: 700; color: #f1f5f9; margin: 0; }
  .search-box { position: relative; flex: 1; min-width: 240px; }
  .search-box input { margin-bottom: 0; padding-left: 44px; }
  .search-icon { position: absolute; left: 16px; top: 50%; transform: translateY(-50%); color: #64748b; pointer-events: none; }
  .empty-state { text-align: center; padding: 48px 24px; color: #64748b; }
  .empty-state-icon { font-size: 4em; margin-bottom: 16px; display: block; }
  .empty-state-text { font-size: 1.1em; margin: 0; }
  .form-group { margin-bottom: 20px; }
  .form-group label { display: block; color: #cbd5e1; margin-bottom: 8px; font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; }
  .form-group input, .form-group select { width: 100%; padding: 14px 16px; border: 2px solid rgba(148, 163, 184, 0.2); border-radius: 12px; background: rgba(15, 23, 42, 0.6); color: #e5e7eb; font-size: 14px; transition: all 0.2s ease; margin-bottom: 0; }
  .form-group input:focus, .form-group select:focus { outline: none; border-color: #60a5fa; box-shadow: 0 0 0 4px rgba(96, 165, 250, 0.1); }
  .form-hint { color: #64748b; font-size: 12px; margin: 8px 0 0; }
  .form-hint span { color: #60a5fa; font-weight: 600; }
  .modal-desc { color: #94a3b8; font-size: 14px; margin: 8px 0 0; }
  .modal-actions { display: flex; gap: 12px; justify-content: flex-end; margin-top: 28px; padding-top: 20px; border-top: 1px solid rgba(148, 163, 184, 0.1); }
  .checkbox-label { display: flex !important; align-items: center; gap: 10px !important; text-transform: none !important; letter-spacing: normal !important; cursor: pointer; }
  .checkbox-label input[type="checkbox"] { width: 18px !important; height: 18px; accent-color: #60a5fa; cursor: pointer; flex-shrink: 0; }
  #toast { position: fixed; top: -60px; left: 50%; transform: translateX(-50%); background: rgba(15, 23, 42, 0.9); backdrop-filter: blur(10px); color: #f1f5f9; padding: 12px 24px; border-radius: 30px; font-size: 14px; font-weight: 500; transition: top 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275); z-index: 9999; border: 1px solid rgba(96, 165, 250, 0.3); box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3); }
  #toast.show { top: 20px; }
  .domain-list { margin-top: 16px; }
  .domain-item { display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; background: rgba(15, 23, 42, 0.6); border-radius: 12px; margin-bottom: 8px; border: 1px solid rgba(148, 163, 184, 0.1); }
  .domain-info { flex: 1; }
  .domain-name { font-weight: 600; color: #f1f5f9; }
  .domain-url { color: #94a3b8; font-size: 13px; }
  .domain-actions { display: flex; gap: 8px; }
  .dns-current-config { display: flex; align-items: center; justify-content: space-between; padding: 16px; background: rgba(15, 23, 42, 0.6); border: 2px solid rgba(148, 163, 184, 0.2); border-radius: 12px; margin-bottom: 16px; }
  .dns-record-display { display: flex; align-items: center; gap: 12px; flex: 1; }
  .dns-record-name { font-weight: 700; color: #60a5fa; font-size: 1.1em; }
  .dns-record-arrow { color: #94a3b8; font-size: 1.2em; }
  .dns-record-target { color: #f1f5f9; font-weight: 600; font-size: 1.1em; }
  .btn-edit { background: rgba(96, 165, 250, 0.15); border: 1px solid rgba(96, 165, 250, 0.3); color: #93c5fd; box-shadow: none; }
  .btn-edit:hover { background: rgba(96, 165, 250, 0.25); }
`;

function buildFrontendHtml() {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Emby 反代 | 自动测速优选</title><style>${PAGE_STYLE}</style></head><body>
<div class="container">
  <div class="card">
    <h1>Emby 反向代理</h1>
    <p class="muted">版本 ${CURRENT_VERSION} · 支持别名快捷入口与优选域名自动测速</p>
    <p><a href="/admin" class="btn btn-outline">管理后台</a></p>
  </div>
  <div class="card">
    <h2>当前边缘节点</h2>
    <div id="edge-loading" class="muted">加载中...</div>
    <div id="edge-info" class="edge-box" style="display:none"></div>
  </div>
  <div class="card">
    <h2>优选域名测速</h2>
    <p class="muted">测试本地网络到优选域名的真实延迟，自动排序显示最快节点</p>
    <div class="toolbar">
      <button class="btn" id="btn-retest">重新测速</button>
      <span id="speed-status" class="muted"></span>
    </div>
    <div id="domain-table-wrap"><p class="muted" id="domain-loading">正在测速...</p></div>
  </div>
  <div class="card">
    <h2>使用格式</h2>
    <p><code>https://你的域名/别名</code> 或 <code>https://你的域名/https://emby.example.com:8096</code></p>
    <div class="warn">添加服务后请务必手动测试。恶意刷接口将封禁 IP。</div>
  </div>
  <div class="card">
    <h2>使用统计</h2>
    <div id="stats-loading" class="muted">加载中...</div>
    <div id="stats-body" style="display:none">
      <div class="stat-row">
        <div class="stat-card"><div>播放次数</div><div class="stat-val" id="st-play">0</div></div>
        <div class="stat-card"><div>获取链接</div><div class="stat-val" id="st-pb">0</div></div>
      </div>
      <div id="daily-table"></div>
    </div>
  </div>
</div>
<script>
const TAG = { fast:'极快', good:'良好', slow:'较慢', timeout:'超时' };
const CLS = { fast:'tag-fast', good:'tag-good', slow:'tag-slow', timeout:'tag-timeout' };

async function loadEdge() {
  try {
    const r = await fetch('/api/edge-info');
    const d = await r.json();
    document.getElementById('edge-loading').style.display = 'none';
    const box = document.getElementById('edge-info');
    box.style.display = 'grid';
    box.innerHTML = [
      ['客户端 IP', d.clientIp],
      ['接入 POP', d.entryColo],
      ['国家/地区', d.entryCountry + (d.entryCity ? ' / '+d.entryCity : '')],
      ['边缘出口 IP', d.edgeIp],
      ['落地 COLO', d.egressColo],
    ].map(([k,v]) => '<div class="edge-item"><strong>'+k+'</strong>'+ (v||'—') +'</div>').join('');
  } catch(e) { document.getElementById('edge-loading').textContent = '加载失败'; }
}

function renderDomainTable(results, best) {
  const wrap = document.getElementById('domain-table-wrap');
  if (!results.length) { wrap.innerHTML = '<p class="muted">无数据</p>'; return; }
  let html = '<table><thead><tr><th>#</th><th>名称</th><th>域名</th><th>延迟</th><th>状态</th></tr></thead><tbody>';
  results.forEach((r, i) => {
    const host = r.host || r.domain;
    const isBest = best && best.domain === r.domain;
    html += '<tr class="'+(isBest?'best':'')+'"><td>'+(i+1)+'</td><td>'+ (r.name||'—') +'</td><td><code>'+host+'</code></td><td>'+(r.latency>=0?r.latency+' ms':'—')+'</td><td><span class="tag '+CLS[r.status||'timeout']+'">'+(TAG[r.status]||'—')+'</span></td></tr>';
  });
  wrap.innerHTML = html + '</tbody></table>';
}

function pingMs(url, timeout) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const timer = setTimeout(() => resolve(-1), timeout || 7000);
    const done = (ms) => { clearTimeout(timer); resolve(ms >= 0 && ms < (timeout || 7000) ? ms : -1); };
    fetch(url, { mode: 'no-cors', cache: 'no-store', credentials: 'omit' })
      .then(() => done(Math.round(performance.now() - t0)))
      .catch(() => {
        const img = new Image();
        const t1 = performance.now();
        const t2 = setTimeout(() => done(-1), 5000);
        const end = () => { clearTimeout(t2); done(Math.round(performance.now() - t1)); };
        img.onload = end;
        img.onerror = end;
        img.src = url + (url.indexOf('?') >= 0 ? '&' : '?') + '_=' + Date.now();
      });
  });
}

async function probeDomain(item) {
  const host = item.domain;
  const paths = ['/cdn-cgi/trace', '/favicon.ico', '/'];
  for (const p of paths) {
    const ms = await pingMs('https://' + host + p, 7000);
    if (ms >= 0) {
      const status = ms < 100 ? 'fast' : ms < 300 ? 'good' : 'slow';
      return { id: item.id, domain: item.domain, name: item.name, host, latency: ms, status, isBuiltin: item.isBuiltin };
    }
  }
  try {
    const r = await fetch('/api/ping-host?host=' + encodeURIComponent(host));
    const d = await r.json();
    if (d.ms >= 0) {
      const status = d.ms < 100 ? 'fast' : d.ms < 300 ? 'good' : 'slow';
      return { id: item.id, domain: item.domain, name: item.name, host, latency: d.ms, status, isBuiltin: item.isBuiltin };
    }
  } catch (_) {}
  return { id: item.id, domain: item.domain, name: item.name, host, latency: -1, status: 'timeout', isBuiltin: item.isBuiltin };
}

function finalizeResults(rows) {
  rows.forEach(r => { if (r.latency >= 0) r.status = r.latency < 100 ? 'fast' : r.latency < 300 ? 'good' : 'slow'; else r.status = 'timeout'; });
  rows.sort((a,b) => { if (a.latency<0) return 1; if (b.latency<0) return -1; return a.latency-b.latency; });
  return rows;
}

async function getOptimizedDomains() {
  try {
    const r = await fetch('/api/domains/list');
    const d = await r.json();
    if (d.success) return d.domains;
  } catch (_) {}
  return [];
}

async function runDomainSpeed(force) {
  const st = document.getElementById('speed-status');
  const wrap = document.getElementById('domain-table-wrap');
  st.textContent = '正在测速...';
  wrap.innerHTML = '<p class="muted">正在测试您本地网络到各优选域名的延迟...</p>';
  
  try {
    const er = await fetch('/api/domains/speed?edge=1');
    const ed = await er.json();
    if (ed.results?.length) {
      renderDomainTable(ed.results, ed.best);
      st.textContent = '边缘测速完成，正在用您的网络复测...';
    }
  } catch (_) {}
  
  const domains = await getOptimizedDomains();
  const clientResults = await Promise.all(domains.map(probeDomain));
  finalizeResults(clientResults);
  const clientOk = clientResults.filter(r => r.latency >= 0).length;
  const best = clientResults.find(r => r.latency >= 0);
  renderDomainTable(clientResults, best);
  
  if (clientOk > 0) {
    st.textContent = '测速完成！' + clientOk + ' 个域名可用，推荐使用: ' + (best ? best.domain : '无');
  } else {
    st.textContent = '测速失败，请检查网络或稍后重试';
  }
}

async function loadStats() {
  try {
    const r = await fetch('/stats');
    const d = await r.json();
    if (d.error) { document.getElementById('stats-loading').textContent = d.error; return; }
    document.getElementById('stats-loading').style.display = 'none';
    document.getElementById('stats-body').style.display = 'block';
    document.getElementById('st-play').textContent = d.data.total.playing;
    document.getElementById('st-pb').textContent = d.data.total.playbackInfo;
    const daily = (d.data.dailyStats||[]).slice(0,10);
    let t = '<table><tr><th>日期</th><th>播放</th><th>链接</th></tr>';
    daily.forEach(s => { t += '<tr><td>'+s.date+'</td><td>'+s.playing_count+'</td><td>'+s.playback_info_count+'</td></tr>'; });
    document.getElementById('daily-table').innerHTML = t + '</table>';
  } catch(e) { document.getElementById('stats-loading').textContent = '统计加载失败'; }
}

document.getElementById('btn-retest').onclick = () => runDomainSpeed(true);
loadEdge(); 
runDomainSpeed(false); 
loadStats();
</script></body></html>`;
}

function buildLoginHtml() {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>管理登录</title><style>${PAGE_STYLE}
body{display:flex;align-items:center;justify-content:center;min-height:100vh;}
.login-box{background:#252830;padding:40px;border-radius:16px;max-width:360px;width:100%;border-top:4px solid #0070f3;}
</style></head><body><div class="login-box">
<h1 style="text-align:center">管理后台</h1>
<p class="muted" style="text-align:center">请输入 Worker 环境变量 ADMIN_TOKEN</p>
<input type="password" id="tokenInput" placeholder="请输入管理密钥" onkeydown="if(event.key==='Enter')login()">
<p id="loginErr" style="color:#e06c75;font-size:14px;min-height:1.2em"></p>
<button class="btn" style="width:100%" id="loginBtn" onclick="login()">登录</button>
<script>
async function login(){
  const t=document.getElementById('tokenInput').value.trim();
  const err=document.getElementById('loginErr');
  const btn=document.getElementById('loginBtn');
  err.textContent='';
  if(!t){ err.textContent='请输入密钥'; return; }
  btn.disabled=true; btn.textContent='验证中...';
  try{
    const r=await fetch('/admin/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:t})});
    const d=await r.json();
    if(d.ok){ location.href='/admin'; return; }
    err.textContent=d.error||'登录失败';
  } catch(e){ err.textContent='请求失败: '+e.message; }
  btn.disabled=false; btn.textContent='登录';
}
</script></div></body></html>`;
}

function buildAdminHtml() {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>管理后台</title><style>${PAGE_STYLE}</style></head><body>
<div id="toast"></div>
<div class="container">
  <div class="card">
    <div class="toolbar" style="justify-content:space-between">
      <h1 style="margin:0">🎛️ 管理后台</h1>
      <div style="display:flex;gap:10px">
        <a href="/" class="btn btn-outline btn-sm">🏠 首页</a>
        <button class="btn btn-del btn-sm" onclick="logout()">🚪 退出</button>
      </div>
    </div>
  </div>

  <div class="card">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:24px;flex-wrap:wrap;gap:16px">
      <h2 style="border:none;margin:0;padding:0">📦 路由管理</h2>
      <div class="toolbar" style="margin:0">
        <button class="btn" onclick="openRouteModal()">➕ 添加路由</button>
        <div class="search-box">
          <span class="search-icon">🔍</span>
          <input type="text" id="routeSearch" placeholder="搜索备注或路径..." oninput="filterRoutes()">
        </div>
      </div>
    </div>
    <div id="routeList" class="route-grid"><p class="muted">加载中...</p></div>
  </div>

  <div class="card">
    <h2>⚡ 优选域名管理</h2>
    <div class="toolbar" style="margin-bottom:16px">
      <button class="btn" onclick="openDomainModal()">➕ 添加优选域名</button>
      <button class="btn" onclick="testDomains()">🚀 开始测速</button>
      <button class="btn btn-success" id="btn-replace-dns" onclick="openDNSModal()" style="display:none">🔄 一键替换DNS</button>
    </div>
    <div id="domainList" class="domain-list"><p class="muted">加载中...</p></div>
  </div>

  <div class="card">
    <h2>🔧 DNS 配置</h2>
    <div id="dnsConfig">
      <p class="muted">加载中...</p>
    </div>
  </div>
</div>

<div id="modalRoute" class="modal">
  <div class="modal-inner">
    <div class="modal-header">
      <h2 class="modal-title" id="routeModalTitle">➕ 添加路由</h2>
      <p class="modal-desc">创建路由后可通过 /路径 快捷访问目标服务</p>
    </div>
    <input type="hidden" id="oldPrefix">
    <div class="form-group">
      <label>备注名</label>
      <input id="routeRemark" placeholder="例如：我的 Emby 服务器">
    </div>
    <div class="form-group">
      <label>路径 (prefix)</label>
      <input id="routePrefix" placeholder="myemby">
      <p class="form-hint">访问路径: https://你的域名/<span id="prefixPreview">myemby</span></p>
    </div>
    <div class="form-group">
      <label>目标地址 (target)</label>
      <input id="routeTarget" type="url" placeholder="https://emby.example.com:8096">
      <p class="form-hint">多个地址用逗号分隔（按顺序切换）</p>
    </div>
    <div class="form-group">
      <label class="checkbox-label">
        <input type="checkbox" id="routeCache" checked> 启用图片/静态资源缓存
      </label>
      <label class="checkbox-label" style="margin-top:12px">
        <input type="checkbox" id="routeCompat"> 兼容模式
      </label>
      <p class="form-hint">兼容模式适用于部分无法正常播放的 Emby 服务器，开启后不重写媒体流地址，由客户端直连源站播放</p>
    </div>
    <div class="modal-actions">
      <button class="btn btn-outline" onclick="closeModal('modalRoute')">取消</button>
      <button class="btn" onclick="saveRoute()">💾 保存</button>
    </div>
  </div>
</div>

<div id="modalDomain" class="modal">
  <div class="modal-inner">
    <div class="modal-header">
      <h2 class="modal-title" id="domainModalTitle">➕ 添加优选域名</h2>
      <p class="modal-desc">添加您自己的优选域名</p>
    </div>
    <input type="hidden" id="domainId">
    <div class="form-group">
      <label>名称</label>
      <input id="domainName" placeholder="例如：我的优选域名">
    </div>
    <div class="form-group">
      <label>域名</label>
      <input id="domainUrl" type="url" placeholder="https://example.com">
    </div>
    <div class="modal-actions">
      <button class="btn btn-outline" onclick="closeModal('modalDomain')">取消</button>
      <button class="btn" onclick="saveDomain()">💾 保存</button>
    </div>
  </div>
</div>

<div id="modalDNS" class="modal">
  <div class="modal-inner">
    <div class="modal-header">
      <h2 class="modal-title">🔄 一键替换 DNS</h2>
      <p class="modal-desc">将最优域名配置到您的 DNS 记录</p>
    </div>
    <div class="form-group">
      <label>当前配置DNS记录</label>
      <div id="dnsCurrentConfig" class="dns-current-config">
        <div class="dns-record-display">
          <span id="dnsCurrentName" class="dns-record-name">加载中...</span>
          <span class="dns-record-arrow">→</span>
          <span id="dnsCurrentTarget" class="dns-record-target">加载中...</span>
        </div>
        <button class="btn btn-edit btn-sm" onclick="editDNSConfig()">✏️ 编辑</button>
      </div>
      <input type="hidden" id="dnsZone" value="">
    </div>
    <div class="form-group">
      <label>DNS 名称</label>
      <input id="dnsName" placeholder="例如：emby">
      <p class="form-hint">将创建 <span id="dnsPreview">emby.yourdomain.com</span></p>
    </div>
    <div class="form-group">
      <label>目标域名</label>
      <input id="dnsTarget" placeholder="最优域名">
    </div>
    <div class="modal-actions">
      <button class="btn btn-outline" onclick="closeModal('modalDNS')">取消</button>
      <button class="btn btn-success" onclick="replaceDNS()">🚀 替换</button>
    </div>
  </div>
</div>

<script>
let allRoutes = [];
let allDomains = [];
let bestDomain = null;
let dnsConfig = null;

function showToast(msg) {
  var t = document.getElementById('toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(function() { t.classList.remove('show'); }, 2500);
}

function closeModal(id) { document.getElementById(id).classList.remove('show'); }
function openModal(id) { document.getElementById(id).classList.add('show'); }

function logout() { document.cookie = 'admin_token=;path=/;max-age=0'; location.reload(); }

async function loadRoutes() {
  try {
    const r = await fetch('/admin/api/routes');
    if (r.status === 401) { location.reload(); return; }
    allRoutes = await r.json();
    renderRoutes(allRoutes);
  } catch (e) {
    document.getElementById('routeList').innerHTML = '<p class="muted">加载失败: ' + e.message + '</p>';
  }
}

function renderRoutes(list) {
  const el = document.getElementById('routeList');
  if (!list.length) {
    el.innerHTML = '<div class="empty-state" style="grid-column:1/-1"><span class="empty-state-icon">📦</span><p class="empty-state-text">暂无路由，点击上方按钮添加</p></div>';
    return;
  }
  el.innerHTML = list.map(r => {
    const targets = r.target.split(',').map(s => s.trim()).filter(Boolean);
    const remarkName = r.remark || '未命名';
    const cacheStatus = r.cache_img !== 'off';
    const compatStatus = r.compat_mode === 'on';

    let targetsHtml = '';
    targets.forEach((t, idx) => {
      const tag = idx === 0 ? '<span style="color:#4ade80;font-weight:bold">[主]</span>' : '<span style="color:#fbbf24;font-weight:bold">[备' + idx + ']</span>';
      targetsHtml += '<div class="target-row">' + tag + ' <span class="target-url"><code>' + t + '</code></span></div>';
    });

    return '<div class="route-item" data-search="' + (remarkName + ' ' + r.prefix).toLowerCase() + '">' +
      '<div class="route-header">' +
        '<div class="route-title">' +
          '<h3 class="route-name">' + remarkName + '</h3>' +
          '<span class="route-path">/' + r.prefix + '</span>' +
        '</div>' +
      '</div>' +
      '<div class="target-list">' + targetsHtml + '</div>' +
      '<div class="route-meta">' +
        (cacheStatus ? '<span class="meta-tag">🖼️ 缓存开启</span>' : '<span class="meta-tag">缓存关闭</span>') +
        (compatStatus ? '<span class="meta-tag" style="background:rgba(251,191,36,0.2);color:#fbbf24">🔧 兼容模式</span>' : '') +
        (r.last_play ? '<span class="meta-tag">📺 ' + r.last_play + '</span>' : '') +
      '</div>' +
      '<div class="route-actions">' +
        '<button class="btn btn-sm btn-outline" onclick="editRoute(\\'' + r.prefix + '\\')">✏️ 编辑</button>' +
        '<button class="btn btn-sm btn-del" onclick="delRoute(\\'' + r.prefix + '\\')">🗑️ 删除</button>' +
      '</div>' +
    '</div>';
  }).join('');
}

function filterRoutes() {
  const q = document.getElementById('routeSearch').value.toLowerCase();
  document.querySelectorAll('.route-item').forEach(c => {
    c.style.display = (!q || c.dataset.search.includes(q)) ? 'block' : 'none';
  });
}

function openRouteModal() {
  document.getElementById('oldPrefix').value = '';
  document.getElementById('routeRemark').value = '';
  document.getElementById('routePrefix').value = '';
  document.getElementById('routeTarget').value = '';
  document.getElementById('routeCache').checked = true;
  document.getElementById('routeCompat').checked = false;
  document.getElementById('prefixPreview').textContent = 'myemby';
  document.getElementById('routeModalTitle').textContent = '➕ 添加路由';
  openModal('modalRoute');
}

function editRoute(prefix) {
  const r = allRoutes.find(x => x.prefix === prefix);
  if (!r) return;
  document.getElementById('oldPrefix').value = r.prefix;
  document.getElementById('routeRemark').value = r.remark || '';
  document.getElementById('routePrefix').value = r.prefix;
  document.getElementById('routeTarget').value = r.target;
  document.getElementById('routeCache').checked = r.cache_img !== 'off';
  document.getElementById('routeCompat').checked = r.compat_mode === 'on';
  document.getElementById('prefixPreview').textContent = r.prefix;
  document.getElementById('routeModalTitle').textContent = '✏️ 编辑路由';
  openModal('modalRoute');
}

async function saveRoute() {
  const oldPrefix = document.getElementById('oldPrefix').value;
  const remark = document.getElementById('routeRemark').value.trim();
  let prefix = document.getElementById('routePrefix').value.trim(); while(prefix.startsWith('/')) prefix = prefix.slice(1); while(prefix.endsWith('/')) prefix = prefix.slice(0,-1);
  const cache_img = document.getElementById('routeCache').checked ? 'on' : 'off';
  const compat_mode = document.getElementById('routeCompat').checked ? 'on' : 'off';
  const target = document.getElementById('routeTarget').value.trim();

  if (!prefix) { showToast('请输入路径'); return; }
  if (!target) { showToast('请至少填写一个目标地址'); return; }

  document.getElementById('prefixPreview').textContent = prefix || 'myemby';

  const r = await fetch('/admin/api/routes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ oldPrefix, prefix, target, remark, cache_img, compat_mode })
  });
  const d = await r.json();
  if (!r.ok) { showToast(d.error || '保存失败'); return; }
  closeModal('modalRoute');
  showToast('保存成功');
  loadRoutes();
}

async function delRoute(prefix) {
  if (!confirm('确定删除路由 /' + prefix + ' ？')) return;
  await fetch('/admin/api/routes?prefix=' + encodeURIComponent(prefix), { method: 'DELETE' });
  showToast('已删除');
  loadRoutes();
}

async function loadDomains() {
  try {
    const r = await fetch('/admin/api/optimized-domains');
    if (r.status === 401) { location.reload(); return; }
    const d = await r.json();
    if (d.success) {
      allDomains = d.domains;
      renderDomains(allDomains);
    } else {
      document.getElementById('domainList').innerHTML = '<p class="muted">加载失败</p>';
    }
  } catch (e) {
    document.getElementById('domainList').innerHTML = '<p class="muted">加载失败: ' + e.message + '</p>';
  }
}

function renderDomains(list, speedResults) {
  const el = document.getElementById('domainList');
  if (!list.length) {
    el.innerHTML = '<div class="empty-state"><span class="empty-state-icon">🌐</span><p class="empty-state-text">暂无优选域名</p></div>';
    return;
  }
  const speedMap = {};
  if (speedResults) speedResults.forEach(r => { speedMap[r.domain] = r; });
  let html = '<table><thead><tr><th>名称</th><th>域名</th><th>延迟</th><th>状态</th><th>操作</th></tr></thead><tbody>';
  list.forEach(d => {
    const sr = speedMap[d.domain];
    const latency = sr && sr.latency >= 0 ? sr.latency + 'ms' : '—';
    const statusClass = sr ? (sr.latency >= 0 ? (sr.latency < 100 ? 'tag-fast' : sr.latency < 300 ? 'tag-good' : 'tag-slow') : 'tag-timeout') : '';
    const statusText = sr ? (sr.latency >= 0 ? (sr.latency < 100 ? '极快' : sr.latency < 300 ? '良好' : '较慢') : '超时') : '';
    const isBest = speedResults && speedResults.length && sr && sr.domain === speedResults.sort((a,b) => (a.latency<0?1:b.latency<0?-1:a.latency-b.latency))[0]?.domain;
    html += '<tr' + (isBest ? ' class="best"' : '') + '>' +
      '<td>' + d.name + (d.isBuiltin ? ' <span class="tag tag-builtin">内置</span>' : '') + '</td>' +
      '<td><code>' + d.domain + '</code></td>' +
      '<td>' + latency + '</td>' +
      '<td>' + (statusText ? '<span class="tag ' + statusClass + '">' + statusText + '</span>' : '—') + '</td>' +
      '<td>' + (!d.isBuiltin ? '<button class="btn btn-sm btn-outline" onclick="editDomain(' + d.id + ')">✏️</button> <button class="btn btn-sm btn-del" onclick="delDomain(' + d.id + ')">🗑️</button>' : '') + '</td>' +
    '</tr>';
  });
  html += '</tbody></table>';
  el.innerHTML = html;
}

function openDomainModal() {
  document.getElementById('domainId').value = '';
  document.getElementById('domainName').value = '';
  document.getElementById('domainUrl').value = '';
  document.getElementById('domainModalTitle').textContent = '➕ 添加优选域名';
  openModal('modalDomain');
}

function editDomain(id) {
  const d = allDomains.find(x => x.id === id);
  if (!d) return;
  document.getElementById('domainId').value = d.id;
  document.getElementById('domainName').value = d.name;
  document.getElementById('domainUrl').value = 'https://' + d.domain;
  document.getElementById('domainModalTitle').textContent = '✏️ 编辑优选域名';
  openModal('modalDomain');
}

async function saveDomain() {
  const id = document.getElementById('domainId').value;
  const name = document.getElementById('domainName').value.trim();
  const url = document.getElementById('domainUrl').value.trim();
  
  if (!name) { showToast('请输入名称'); return; }
  if (!url) { showToast('请输入域名'); return; }
  
  let domain = url.replace('https://', '').replace('http://', '').split('/')[0];
  
  let method = 'POST';
  let endpoint = '/admin/api/optimized-domains';
  if (id) {
    method = 'PUT';
    endpoint = '/admin/api/optimized-domains/' + id;
  }
  
  const r = await fetch(endpoint, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ domain, name })
  });
  const d = await r.json();
  if (!d.success) { showToast('保存失败'); return; }
  closeModal('modalDomain');
  showToast('保存成功');
  loadDomains();
}

async function delDomain(id) {
  if (!confirm('确定删除此优选域名？')) return;
  const r = await fetch('/admin/api/optimized-domains/' + id, { method: 'DELETE' });
  const d = await r.json();
  if (d.success) {
    showToast('已删除');
    loadDomains();
  } else {
    showToast('删除失败');
  }
}

async function testDomains() {
  document.getElementById('domainList').innerHTML = '<p class="muted">测速中...</p>';
  const r = await fetch('/admin/api/speedtest/domains', { method: 'POST' });
  const d = await r.json();
  
  if (d.best) {
    bestDomain = d.best;
    document.getElementById('btn-replace-dns').style.display = 'inline-flex';
  }
  
  renderDomains(allDomains, d.results || []);
}

async function loadDNSConfig() {
  try {
    const r = await fetch('/admin/api/dns-config');
    if (r.status === 401) { location.reload(); return; }
    const d = await r.json();
    if (d.success) {
      dnsConfig = d.config;
      var baseDomain = '';
      try {
        var bdResp = await fetch('/api/config/base-domain');
        var bdData = await bdResp.json();
        baseDomain = bdData.baseDomain || '';
      } catch(e) {}
      renderDNSConfig(d.config, d.zones, d.zonesError, baseDomain);
    } else {
      document.getElementById('dnsConfig').innerHTML = '<p class="muted">加载失败</p>';
    }
  } catch (e) {
    document.getElementById('dnsConfig').innerHTML = '<p class="muted">加载失败: ' + e.message + '</p>';
  }
}

function renderDNSConfig(config, zones, zonesError, baseDomain) {
  const el = document.getElementById('dnsConfig');
  let html = '';
  
  if (zonesError) {
    html += '<div class="warn" style="margin-bottom:16px">获取区域列表失败: ' + zonesError + '</div>';
  }
  
  if (zones && zones.length) {
    html += '<div class="form-group"><label>当前配置DNS记录</label>';
    html += '<div style="display:flex;gap:8px;flex-wrap:wrap">';
    zones.forEach(z => {
      html += '<span style="padding:6px 12px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:6px;font-size:14px">' + z.name + '</span>';
    });
    html += '</div></div>';
  } else if (!zonesError) {
    html += '<p class="muted">未找到可用区域，请确认 CF_API_TOKEN 有 Zone:Read 权限</p>';
  }
  
  var domainForCname = baseDomain || (zones && zones.length ? zones[0].name : '');
  
  if (config && config.dnsName) {
    var cnameRecord = config.dnsName + '.' + domainForCname;
    html += '<div style="margin-top:16px;padding:12px;background:var(--bg-secondary);border-radius:8px">';
    html += '<div style="margin-bottom:8px"><strong>当前 CNAME 记录</strong></div>';
    html += '<div style="font-size:15px;color:var(--accent)">📌 ' + cnameRecord + '</div>';
    html += '<div style="font-size:13px;color:var(--muted);margin-top:4px">指向 → ' + (config.currentDomain || '未设置') + '</div>';
    if (config.updatedAt) {
      html += '<div style="font-size:12px;color:var(--muted);margin-top:4px">更新时间: ' + config.updatedAt + '</div>';
    }
    html += '</div>';
  } else {
    html += '<div style="margin-top:16px;padding:12px;background:var(--bg-secondary);border-radius:8px">';
    html += '<div style="color:var(--muted)">尚未配置 DNS 记录，请测速后点击一键替换DNS</div>';
    html += '</div>';
  }
  
  el.innerHTML = html;
}

async function openDNSModal() {
  if (!bestDomain) {
    showToast('请先测速找到最优域名');
    return;
  }
  
  const r = await fetch('/admin/api/dns-config');
  const d = await r.json();
  
  const baseDomainResp = await fetch('/api/config/base-domain');
  const baseDomainData = await baseDomainResp.json();
  const baseDomain = baseDomainData.baseDomain || 'yourdomain.com';
  
  const dnsCurrentName = document.getElementById('dnsCurrentName');
  const dnsCurrentTarget = document.getElementById('dnsCurrentTarget');
  const dnsZone = document.getElementById('dnsZone');
  
  if (d.success && d.config && d.config.dnsName) {
    dnsCurrentName.textContent = d.config.dnsName + '.' + baseDomain;
    dnsCurrentTarget.textContent = d.config.currentDomain || '未设置';
    dnsZone.value = d.config.zoneId || '';
  } else {
    dnsCurrentName.textContent = '未配置';
    dnsCurrentTarget.textContent = '未设置';
  }
  
  const dnsNameConfig = await fetch('/api/config/dns-record-name');
  const dnsNameData = await dnsNameConfig.json();
  document.getElementById('dnsName').value = d.config?.dnsName || dnsNameData.dnsRecordName || 'emby';
  document.getElementById('dnsTarget').value = bestDomain.domain;
  document.getElementById('dnsPreview').textContent = (d.config?.dnsName || dnsNameData.dnsRecordName || 'emby') + '.' + baseDomain;
  
  openModal('modalDNS');
}

function editDNSConfig() {
  const dnsCurrentName = document.getElementById('dnsCurrentName');
  const dnsCurrentTarget = document.getElementById('dnsCurrentTarget');
  
  const currentName = dnsCurrentName.textContent;
  const currentTarget = dnsCurrentTarget.textContent;
  
  if (currentName === '未配置') {
    showToast('当前没有配置DNS记录');
    return;
  }
  
  const nameParts = currentName.split('.');
  if (nameParts.length >= 2) {
    document.getElementById('dnsName').value = nameParts[0];
  }
  
  if (currentTarget !== '未设置') {
    document.getElementById('dnsTarget').value = currentTarget;
  }
  
  showToast('已加载当前配置，可以修改后替换');
}

async function replaceDNS() {
  const zoneId = document.getElementById('dnsZone').value;
  const dnsName = document.getElementById('dnsName').value.trim();
  const targetDomain = document.getElementById('dnsTarget').value.trim();
  
  if (!dnsName) { showToast('请输入DNS名称'); return; }
  if (!targetDomain) { showToast('请输入目标域名'); return; }
  
  const btn = event.target;
  btn.disabled = true;
  btn.textContent = '替换中...';
  
  try {
    const r = await fetch('/admin/api/dns/replace', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ zoneId, dnsName, targetDomain })
    });
    const d = await r.json();
    
    if (d.success) {
      var recordInfo = d.result || {};
      var recordName = recordInfo.name || (dnsName + '.' + (recordInfo.zone_name || ''));
      var recordContent = recordInfo.content || targetDomain;
      var recordType = recordInfo.type || 'CNAME';
      var isProxied = recordInfo.proxied !== undefined ? recordInfo.proxied : true;
      
      showToast('✅ DNS 替换成功！' + recordName + ' → ' + recordContent);
      closeModal('modalDNS');
      
      loadDNSConfig();
    } else {
      var errorMsg = d.error || d.errors?.[0]?.message || 'DNS 替换失败';
      showToast('❌ ' + errorMsg);
    }
  } catch (e) {
    showToast('❌ 请求失败: ' + e.message);
  }
  
  btn.disabled = false;
  btn.textContent = '🚀 替换';
}

document.getElementById('routePrefix').addEventListener('input', function() {
  document.getElementById('prefixPreview').textContent = this.value.trim() || 'myemby';
});

document.getElementById('dnsName').addEventListener('input', function() {
  document.getElementById('dnsPreview').textContent = (this.value.trim() || 'emby') + '.yourdomain.com';
});

loadRoutes();
loadDomains();
loadDNSConfig();
</script></body></html>`;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': '*',
        },
      });
    }

    if (env.DB) await initDatabase(env);

    if (url.pathname === '/') return html(buildFrontendHtml());
    if (url.pathname === '/favicon.ico') return new Response('', { headers: { 'Content-Type': 'image/x-icon' } });
    if (url.pathname.startsWith('/cdn-cgi/')) return new Response('Not Found', { status: 404 });

    if (url.pathname === '/health') {
      return json({ status: 'ok', version: CURRENT_VERSION, colo: request.cf?.colo, timestamp: new Date().toISOString() });
    }

    if (url.pathname === '/stats') return handleStatsRequest(env);

    if (url.pathname === '/api/edge-info') return json(await getEdgeInfo(request));

    if (url.pathname === '/api/ping-host') {
      const host = (url.searchParams.get('host') || '').replace(/^https?:\/\//, '').split('/')[0];
      if (!host) return json({ ms: -1, error: 'missing host' });
      const ms = await speedtestUrl('https://' + host + '/cdn-cgi/trace', 5000);
      return json({ ms, host });
    }

    if (url.pathname === '/api/domains/list') {
      if (!env.DB) {
        return json({ success: true, domains: DEFAULT_OPTIMIZED_DOMAINS.map((d, i) => ({ id: i, ...d })) });
      }
      const domains = await getOptimizedDomains(env);
      return json({ success: true, domains });
    }

    if (url.pathname === '/api/domains/speed') {
      if (url.searchParams.get('edge') === '1') {
        const data = await speedtestOptimizedFromEdge(env);
        return json({ cached: false, edge: true, best: data.best, results: data.results });
      }
      return json({ cached: false, results: [] });
    }

    if (url.pathname === '/api/config/dns-record-name') {
      return json({ dnsRecordName: env.DNS_RECORD_NAME || 'emby' });
    }

    if (url.pathname === '/api/config/base-domain') {
      return json({ baseDomain: env.BASE_DOMAIN || 'yourdomain.com' });
    }

    if (url.pathname === '/admin/api/login' && request.method === 'POST') {
      try {
        const body = await request.json();
        return adminLoginResponse(request, env, String(body.token || '').trim());
      } catch (e) {
        return json({ ok: false, error: e.message }, 400);
      }
    }

    if (url.pathname === '/admin' || url.pathname === '/admin/') {
      if (!isAdmin(request, env)) return html(buildLoginHtml());
      return html(buildAdminHtml());
    }

    if (url.pathname.startsWith('/admin/api/')) {
      if (!isAdmin(request, env)) return new Response('Unauthorized', { status: 401 });
      if (!env.DB) return json({ error: 'DB 未绑定' }, 500);
      return handleAdminApi(request, env, url);
    }

    const pathFirst = url.pathname.split('/').filter(Boolean)[0]?.toLowerCase();
    const looksLikeDirectUrl = url.pathname.startsWith('/http://') || url.pathname.startsWith('/https://') ||
      (pathFirst && (pathFirst.includes('.') || pathFirst.includes(':')));

    if (looksLikeDirectUrl) {
      let path = url.pathname.substring(1);
      if (path.startsWith('/')) return new Response('Invalid proxy format', { status: 400 });
      path = path.replace(/^(https?)\/(?!\/)/, '$1://');
      if (!path.startsWith('http')) path = 'https://' + path;
      try {
        const upstreamUrl = new URL(path);
        upstreamUrl.search = url.search;
        return proxyDirectUrl(request, env, ctx, [upstreamUrl.toString()], { enableCache: true });
      } catch {
        return new Response('Invalid URL format', { status: 400 });
      }
    }

    if (!env.DB) {
      return new Response('D1 数据库未绑定，路由反代不可用。仍可使用 /https://... 格式。', { status: 500 });
    }

    const resolved = await resolveProxyTarget(request, env, url);
    if (resolved.error) return resolved.error;

    return proxyDirectUrl(request, env, ctx, resolved.upstreamUrls, {
      enableCache: resolved.enableCache,
      compatMode: resolved.compatMode,
      matchedPrefix: resolved.matchedPrefix,
    });
  },
};