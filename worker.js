/**
 * =================================================================================
 *              Cloudflare Worker Emby 反向代理 (管理版)
 * =================================================================================
 *
 * 版本: 3.0
 * 功能: 别名管理、多线路故障转移、智能选线、管理后台
 *
 */

const OPTIMIZED_DOMAINS = [
    { subdomain: 'proxy1', domain: 'cf.090227.xyz', name: 'CF优选-090227' },
    { subdomain: 'proxy2', domain: 'cf.877774.xyz', name: 'CF优选-877774' },
    { subdomain: 'proxy3', domain: 'cloudflare-dl.byoip.top', name: '鱼皮优选' },
    { subdomain: 'proxy4', domain: 'saas.sin.fan', name: 'MIYU优选' },
    { subdomain: 'proxy5', domain: 'bestcf.030101.xyz', name: 'Mingyu优选' },
    { subdomain: 'proxy6', domain: 'cf.cloudflare.182682.xyz', name: 'WeTest优选' },
    { subdomain: 'proxy7', domain: 'cf.tencentapp.cn', name: '腾讯泛域名' },
    { subdomain: 'proxy8', domain: 'www.visa.cn', name: 'Visa官方' },
    { subdomain: 'proxy9', domain: 'mfa.gov.ua', name: '乌克兰外交部' },
    { subdomain: 'proxy10', domain: 'www.shopify.com', name: 'Shopify官方' },
    { subdomain: 'proxy11', domain: 'store.ubi.com', name: '育碧商店' },
];

const MANUAL_REDIRECT_DOMAINS = [
    'emby.bangumi.ca',
    'aliyundrive.com', 'aliyundrive.net', 'aliyuncs.com', 'alicdn.com', 'aliyun.com', 'cdn.aliyundrive.com',
    'xunlei.com', 'xlusercdn.com', 'xycdn.com', 'sandai.net', 'thundercdn.com',
    '115.com', '115cdn.com', '115cdn.net', 'anxia.com',
    '189.cn', 'mini189.cn', 'ctyunxs.cn', 'cloud.189.cn', 'tianyiyun.com', 'telecomjs.com',
    'quark.cn', 'quarkdrive.cn', 'uc.cn', 'ucdrive.cn',
    'xiaoya.pro',
    'myqcloud.com', 'cloudfront.net', 'akamaized.net', 'fastly.net', 'hwcdn.net', 'bytecdn.cn', 'bdcdn.net'
];

const DOMAIN_PROXY_RULES = {
    'biliblili.uk': 'example.com',
};

const JP_COLOS = ['NRT', 'KIX', 'FUK', 'OKA'];

const blocker = {
    keys: [".m3u8", ".ts", ".acc", ".m4s", "photocall.tv", "googlevideo.com"],
    check: function (url) {
        url = url.toLowerCase();
        return blocker.keys.some(x => url.includes(x));
    }
};

const PREFLIGHT_INIT = {
    status: 204,
    headers: new Headers({
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "*"
    })
};

const CONFIG = {
    pikpakProxyUrl: 'https://pp.255432.xyz',
    enableStats: true,
    cacheEnabled: true,
    speedtestCacheTTL: 3600,
    rateLimit: { maxRequests: 1000, windowMs: 60000 }
};

const PIKPAK_DOMAINS = [
    'pikpak.com', 'pikpak.net', 'pikpak-cn.com', 'pikpakcdn.com', 'pikpakapi.com', 'pikpakdrive.com'
];

const _aliasCache = new Map();
const ALIAS_CACHE_TTL = 300000;
let _dbInitialized = false;

async function getAliasConfig(env, aliasName) {
    const cached = _aliasCache.get(aliasName);
    if (cached && (Date.now() - cached.ts) < ALIAS_CACHE_TTL) {
        return cached.data;
    }
    if (!env.DB) return null;
    try {
        const alias = await env.DB.prepare('SELECT * FROM aliases WHERE alias = ?').bind(aliasName).first();
        if (!alias) {
            _aliasCache.delete(aliasName);
            return null;
        }
        const lines = await env.DB.prepare(
            'SELECT * FROM alias_lines WHERE alias_id = ? ORDER BY sort_order, id'
        ).bind(alias.id).all();
        const data = { alias, lines: lines.results || [] };
        _aliasCache.set(aliasName, { data, ts: Date.now() });
        if (_aliasCache.size > 200) {
            const now = Date.now();
            for (const [k, v] of _aliasCache) {
                if (now - v.ts >= ALIAS_CACHE_TTL) _aliasCache.delete(k);
            }
        }
        return data;
    } catch (e) {
        console.error('Alias cache fetch error:', e.message);
        return cached ? cached.data : null;
    }
}

function invalidateAliasCache(aliasName) {
    if (aliasName) {
        _aliasCache.delete(aliasName);
    } else {
        _aliasCache.clear();
    }
}

async function readRequestBody(request) {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return null;
    try {
        const ct = (request.headers.get('content-type') || '').toLowerCase();
        if (ct.includes('application/json')) {
            return await request.text();
        } else if (ct.includes('application/text') || ct.includes('text/html')) {
            return await request.text();
        } else if (ct.includes('form')) {
            return await request.formData();
        } else {
            return await request.blob();
        }
    } catch (e) {
        return null;
    }
}

const LOGIN_UI = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>管理后台登录</title>
    <style>
        :root {
            --primary: #0a84ff;
            --primary-hover: #0071e3;
            --bg: #1a1c22;
            --card: #252830;
            --text: #e1e4e8;
            --text-sec: #8b8fa3;
            --border: #3e4451;
            --radius: 12px;
            --shadow: 0 8px 32px rgba(0,0,0,0.35);
        }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
            background: var(--bg);
            color: var(--text);
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            padding: 20px;
            -webkit-font-smoothing: antialiased;
        }
        .login-container {
            width: 100%;
            max-width: 380px;
            animation: fadeUp 0.5s ease-out;
        }
        @keyframes fadeUp {
            from { opacity: 0; transform: translateY(20px); }
            to { opacity: 1; transform: translateY(0); }
        }
        .login-header {
            text-align: center;
            margin-bottom: 32px;
        }
        .login-icon {
            width: 64px;
            height: 64px;
            background: linear-gradient(135deg, var(--primary), #5856d6);
            border-radius: 16px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            margin-bottom: 16px;
            font-size: 28px;
        }
        .login-header h1 {
            font-size: 22px;
            font-weight: 700;
            color: var(--text);
            letter-spacing: -0.3px;
        }
        .login-header p {
            font-size: 13px;
            color: var(--text-sec);
            margin-top: 6px;
        }
        .login-card {
            background: var(--card);
            border-radius: 20px;
            padding: 32px 28px;
            box-shadow: var(--shadow);
            border: 1px solid rgba(255,255,255,0.06);
        }
        .form-group {
            margin-bottom: 20px;
        }
        .form-group label {
            display: block;
            font-size: 13px;
            font-weight: 600;
            color: var(--text-sec);
            margin-bottom: 8px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        .input-wrap {
            position: relative;
        }
        .input-wrap input {
            width: 100%;
            padding: 14px 44px 14px 16px;
            background: var(--bg);
            border: 1px solid var(--border);
            border-radius: var(--radius);
            color: var(--text);
            font-size: 15px;
            outline: none;
            transition: border-color 0.2s, box-shadow 0.2s;
        }
        .input-wrap input:focus {
            border-color: var(--primary);
            box-shadow: 0 0 0 3px rgba(10,132,255,0.2);
        }
        .input-wrap input::placeholder {
            color: #555a6e;
        }
        .input-wrap .toggle-vis {
            position: absolute;
            right: 12px;
            top: 50%;
            transform: translateY(-50%);
            background: none;
            border: none;
            color: var(--text-sec);
            cursor: pointer;
            padding: 4px;
            font-size: 16px;
            line-height: 1;
        }
        .input-wrap .toggle-vis:hover {
            color: var(--primary);
        }
        .btn-login {
            width: 100%;
            padding: 14px;
            background: linear-gradient(135deg, var(--primary), #5856d6);
            color: #fff;
            border: none;
            border-radius: var(--radius);
            font-size: 15px;
            font-weight: 700;
            cursor: pointer;
            transition: opacity 0.2s, transform 0.1s;
            letter-spacing: 0.3px;
        }
        .btn-login:hover {
            opacity: 0.92;
        }
        .btn-login:active {
            transform: scale(0.98);
        }
        .btn-login:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        #toast {
            position: fixed;
            top: 24px;
            left: 50%;
            transform: translateX(-50%) translateY(-80px);
            background: var(--card);
            color: var(--text);
            padding: 12px 24px;
            border-radius: 10px;
            font-size: 14px;
            font-weight: 500;
            box-shadow: 0 8px 24px rgba(0,0,0,0.4);
            border: 1px solid var(--border);
            z-index: 9999;
            opacity: 0;
            transition: transform 0.35s cubic-bezier(0.4,0,0.2,1), opacity 0.35s ease;
            pointer-events: none;
        }
        #toast.show {
            transform: translateX(-50%) translateY(0);
            opacity: 1;
        }
        .login-footer {
            text-align: center;
            margin-top: 20px;
            font-size: 12px;
            color: #444a5e;
        }
    </style>
</head>
<body>
    <div id="toast"></div>
    <div class="login-container">
        <div class="login-header">
            <div class="login-icon">\u{1F512}</div>
            <h1>管理后台登录</h1>
            <p>Cloudflare Worker Emby Proxy</p>
        </div>
        <div class="login-card">
            <div class="form-group">
                <label>管理密钥</label>
                <div class="input-wrap">
                    <input type="password" id="tokenInput" placeholder="请输入管理密钥 (ADMIN_TOKEN)" onkeydown="if(event.key==='Enter') doLogin()">
                    <button class="toggle-vis" onclick="toggleVis()" type="button" id="visBtn">\u{1F441}</button>
                </div>
            </div>
            <button class="btn-login" id="loginBtn" onclick="doLogin()">登 录</button>
        </div>
        <div class="login-footer">Powered by Cloudflare Workers</div>
    </div>
    <script>
        (function() {
            var cookies = document.cookie.split(';');
            for (var i = 0; i < cookies.length; i++) {
                var c = cookies[i].trim();
                if (c.indexOf('admin_token=') === 0) {
                    var val = c.substring('admin_token='.length);
                    if (val && val !== '' && val !== 'undefined') {
                        fetch('/admin/api/verify').then(function(r) { return r.json(); }).then(function(d) {
                            if (d.ok) window.location.href = '/admin';
                        });
                        return;
                    }
                }
            }
        })();

        function showToast(msg, duration) {
            var t = document.getElementById('toast');
            t.textContent = msg;
            t.classList.add('show');
            setTimeout(function() { t.classList.remove('show'); }, duration || 2500);
        }

        function toggleVis() {
            var inp = document.getElementById('tokenInput');
            var btn = document.getElementById('visBtn');
            if (inp.type === 'password') {
                inp.type = 'text';
                btn.textContent = '\u{1F441}\u{200D}\u{1F5E8}';
            } else {
                inp.type = 'password';
                btn.textContent = '\u{1F441}';
            }
        }

        function doLogin() {
            var input = document.getElementById('tokenInput');
            var btn = document.getElementById('loginBtn');
            var token = input.value.trim();
            if (!token) {
                showToast('请输入管理密钥');
                input.focus();
                return;
            }
            btn.disabled = true;
            btn.textContent = '验证中...';
            document.cookie = 'admin_token=' + encodeURIComponent(token) + '; path=/; max-age=2592000; SameSite=Lax';
            fetch('/admin/api/verify').then(function(r) { return r.json(); }).then(function(d) {
                if (d.ok) {
                    showToast('登录成功，正在跳转...', 1200);
                    setTimeout(function() { window.location.href = '/admin'; }, 800);
                } else {
                    document.cookie = 'admin_token=; path=/; max-age=0';
                    showToast(d.error || '密钥错误，请重试');
                    btn.disabled = false;
                    btn.textContent = '登 录';
                    input.value = '';
                    input.focus();
                }
            }).catch(function() {
                showToast('网络错误，请重试');
                btn.disabled = false;
                btn.textContent = '登 录';
            });
        }
    </script>
</body>
</html>`;

const ADMIN_UI = '<!DOCTYPE html>\n\
<html lang="zh-CN">\n\
<head>\n\
<meta charset="utf-8">\n\
<meta name="viewport" content="width=device-width, initial-scale=1">\n\
<title>\u7BA1\u7406\u540E\u53F0</title>\n\
<style>\n\
:root {\n\
  --primary: #0a84ff;\n\
  --primary-hover: #0070e3;\n\
  --bg: #000;\n\
  --card: #1c1c1e;\n\
  --card-hover: #2c2c2e;\n\
  --text: #f5f5f7;\n\
  --text-sec: #98989d;\n\
  --border: #38383a;\n\
  --danger: #ff453a;\n\
  --success: #30d158;\n\
  --warning: #ff9f0a;\n\
  --danger-bg: rgba(255,69,58,0.12);\n\
  --success-bg: rgba(48,209,88,0.12);\n\
  --warning-bg: rgba(255,159,10,0.12);\n\
  --modal-bg: rgba(0,0,0,0.65);\n\
  --radius: 16px;\n\
  --radius-sm: 10px;\n\
  --shadow: 0 4px 24px rgba(0,0,0,0.25);\n\
  --shadow-lg: 0 16px 48px rgba(0,0,0,0.5);\n\
  --transition: 0.25s cubic-bezier(0.4,0,0.2,1);\n\
}\n\
body.light {\n\
  --primary: #0071e3;\n\
  --primary-hover: #005cbf;\n\
  --bg: #f5f5f7;\n\
  --card: #fff;\n\
  --card-hover: #f0f0f2;\n\
  --text: #1d1d1f;\n\
  --text-sec: #86868b;\n\
  --border: #d2d2d7;\n\
  --danger: #ff3b30;\n\
  --success: #34c759;\n\
  --warning: #ff9500;\n\
  --danger-bg: rgba(255,59,48,0.1);\n\
  --success-bg: rgba(52,199,89,0.1);\n\
  --warning-bg: rgba(255,149,0,0.1);\n\
  --modal-bg: rgba(0,0,0,0.35);\n\
  --shadow: 0 4px 24px rgba(0,0,0,0.08);\n\
  --shadow-lg: 0 16px 48px rgba(0,0,0,0.15);\n\
}\n\
* { box-sizing: border-box; margin: 0; padding: 0; }\n\
body {\n\
  font-family: -apple-system, "SF Pro Display", system-ui, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;\n\
  line-height: 1.5;\n\
  color: var(--text);\n\
  background: var(--bg);\n\
  min-height: 100vh;\n\
  -webkit-font-smoothing: antialiased;\n\
  transition: background var(--transition), color var(--transition);\n\
}\n\
.container {\n\
  max-width: 1000px;\n\
  margin: 0 auto;\n\
  padding: 24px 20px 60px;\n\
  display: flex;\n\
  flex-direction: column;\n\
  gap: 24px;\n\
}\n\
.card {\n\
  background: var(--card);\n\
  border-radius: var(--radius);\n\
  padding: 24px;\n\
  box-shadow: var(--shadow);\n\
  border: 1px solid var(--border);\n\
  transition: background var(--transition), border-color var(--transition), box-shadow var(--transition);\n\
}\n\
.card:hover {\n\
  border-color: color-mix(in srgb, var(--primary) 30%, var(--border));\n\
}\n\
.header {\n\
  display: flex;\n\
  align-items: center;\n\
  justify-content: space-between;\n\
  gap: 16px;\n\
  flex-wrap: wrap;\n\
}\n\
.header h1 {\n\
  font-size: 1.5em;\n\
  font-weight: 700;\n\
  margin: 0;\n\
  letter-spacing: -0.02em;\n\
}\n\
.header-actions {\n\
  display: flex;\n\
  align-items: center;\n\
  gap: 8px;\n\
}\n\
.section-title {\n\
  font-size: 1.15em;\n\
  font-weight: 600;\n\
  margin-bottom: 16px;\n\
  display: flex;\n\
  align-items: center;\n\
  gap: 8px;\n\
}\n\
.btn {\n\
  display: inline-flex;\n\
  align-items: center;\n\
  gap: 6px;\n\
  padding: 10px 18px;\n\
  background: var(--primary);\n\
  color: #fff;\n\
  border-radius: var(--radius-sm);\n\
  text-decoration: none;\n\
  font-weight: 600;\n\
  border: none;\n\
  cursor: pointer;\n\
  font-size: 14px;\n\
  transition: all var(--transition);\n\
  white-space: nowrap;\n\
  font-family: inherit;\n\
}\n\
.btn:hover { background: var(--primary-hover); transform: translateY(-1px); }\n\
.btn:active { transform: translateY(0); }\n\
.btn-sm { padding: 6px 12px; font-size: 12px; border-radius: 8px; }\n\
.btn-ghost {\n\
  background: transparent;\n\
  color: var(--text-sec);\n\
  border: 1px solid var(--border);\n\
}\n\
.btn-ghost:hover {\n\
  background: var(--card-hover);\n\
  color: var(--text);\n\
  border-color: var(--text-sec);\n\
}\n\
.btn-danger {\n\
  background: transparent;\n\
  color: var(--danger);\n\
  border: 1px solid color-mix(in srgb, var(--danger) 40%, transparent);\n\
}\n\
.btn-danger:hover {\n\
  background: var(--danger-bg);\n\
}\n\
.btn-icon {\n\
  width: 36px;\n\
  height: 36px;\n\
  padding: 0;\n\
  display: inline-flex;\n\
  align-items: center;\n\
  justify-content: center;\n\
  border-radius: 50%;\n\
  background: transparent;\n\
  color: var(--text-sec);\n\
  border: 1px solid var(--border);\n\
  cursor: pointer;\n\
  font-size: 16px;\n\
  transition: all var(--transition);\n\
}\n\
.btn-icon:hover {\n\
  background: var(--card-hover);\n\
  color: var(--text);\n\
}\n\
.toolbar {\n\
  display: flex;\n\
  gap: 10px;\n\
  flex-wrap: wrap;\n\
  align-items: center;\n\
  margin-bottom: 16px;\n\
}\n\
.search-input {\n\
  flex: 1;\n\
  min-width: 180px;\n\
  max-width: 280px;\n\
  padding: 10px 14px;\n\
  padding-left: 36px;\n\
  border: 1px solid var(--border);\n\
  border-radius: var(--radius-sm);\n\
  background: var(--bg);\n\
  color: var(--text);\n\
  font-size: 14px;\n\
  transition: all var(--transition);\n\
  font-family: inherit;\n\
  outline: none;\n\
  background-image: url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'16\' height=\'16\' fill=\'%2398989d\' viewBox=\'0 0 16 16\'%3E%3Cpath d=\'M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398h-.001l3.85 3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85zm-5.442.156a5 5 0 1 1 0-10 5 5 0 0 1 0 10z\'/%3E%3C/svg%3E");\n\
  background-repeat: no-repeat;\n\
  background-position: 12px center;\n\
}\n\
.search-input:focus {\n\
  border-color: var(--primary);\n\
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--primary) 20%, transparent);\n\
}\n\
.search-input::placeholder { color: var(--text-sec); }\n\
input[type=text], input[type=url], input[type=password], select {\n\
  width: 100%;\n\
  padding: 12px 14px;\n\
  border: 1px solid var(--border);\n\
  border-radius: var(--radius-sm);\n\
  background: var(--bg);\n\
  color: var(--text);\n\
  font-size: 14px;\n\
  transition: all var(--transition);\n\
  font-family: inherit;\n\
  outline: none;\n\
}\n\
input:focus, select:focus {\n\
  border-color: var(--primary);\n\
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--primary) 20%, transparent);\n\
}\n\
select { cursor: pointer; appearance: none; background-image: url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'12\' height=\'12\' fill=\'%2398989d\' viewBox=\'0 0 16 16\'%3E%3Cpath d=\'M1.646 4.646a.5.5 0 0 1 .708 0L8 10.293l5.646-5.647a.5.5 0 0 1 .708.708l-6 6a.5.5 0 0 1-.708 0l-6-6a.5.5 0 0 1 0-.708z\'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 12px center; padding-right: 32px; }\n\
label {\n\
  display: block;\n\
  font-weight: 600;\n\
  margin-bottom: 6px;\n\
  font-size: 13px;\n\
  color: var(--text-sec);\n\
  text-transform: uppercase;\n\
  letter-spacing: 0.3px;\n\
}\n\
.form-row { margin-bottom: 16px; }\n\
.form-row:last-child { margin-bottom: 0; }\n\
.checkbox-label {\n\
  display: inline-flex;\n\
  align-items: center;\n\
  gap: 8px;\n\
  font-weight: 500;\n\
  font-size: 14px;\n\
  color: var(--text);\n\
  cursor: pointer;\n\
  text-transform: none;\n\
  letter-spacing: 0;\n\
}\n\
.checkbox-label input[type=checkbox] {\n\
  width: 18px;\n\
  height: 18px;\n\
  accent-color: var(--primary);\n\
  cursor: pointer;\n\
}\n\
.alias-grid {\n\
  display: grid;\n\
  grid-template-columns: 1fr;\n\
  gap: 16px;\n\
}\n\
.alias-card {\n\
  background: var(--card);\n\
  border: 1px solid var(--border);\n\
  border-radius: var(--radius);\n\
  overflow: hidden;\n\
  transition: all var(--transition);\n\
}\n\
.alias-card:hover {\n\
  border-color: color-mix(in srgb, var(--primary) 40%, var(--border));\n\
  box-shadow: 0 4px 20px rgba(0,0,0,0.15);\n\
}\n\
.alias-card-header {\n\
  display: flex;\n\
  align-items: center;\n\
  gap: 12px;\n\
  padding: 16px 20px;\n\
  border-bottom: 1px solid var(--border);\n\
  background: color-mix(in srgb, var(--primary) 4%, var(--card));\n\
}\n\
.alias-icon {\n\
  font-size: 1.6em;\n\
  line-height: 1;\n\
  width: 40px;\n\
  height: 40px;\n\
  display: flex;\n\
  align-items: center;\n\
  justify-content: center;\n\
  background: color-mix(in srgb, var(--primary) 10%, transparent);\n\
  border-radius: 10px;\n\
  flex-shrink: 0;\n\
}\n\
.alias-info {\n\
  flex: 1;\n\
  min-width: 0;\n\
}\n\
.alias-name {\n\
  font-weight: 600;\n\
  font-size: 15px;\n\
  line-height: 1.3;\n\
}\n\
.alias-path {\n\
  font-size: 12px;\n\
  color: var(--text-sec);\n\
  font-family: "SF Mono", "Fira Code", "Cascadia Code", monospace;\n\
}\n\
.alias-actions {\n\
  display: flex;\n\
  gap: 6px;\n\
  flex-shrink: 0;\n\
}\n\
.alias-card-body {\n\
  padding: 0;\n\
  overflow-x: auto;\n\
}\n\
.alias-card-body table {\n\
  width: 100%;\n\
  border-collapse: collapse;\n\
  font-size: 13px;\n\
}\n\
.alias-card-body th,\n\
.alias-card-body td {\n\
  padding: 10px 16px;\n\
  text-align: left;\n\
  border-bottom: 1px solid var(--border);\n\
}\n\
.alias-card-body th {\n\
  color: var(--text-sec);\n\
  font-weight: 600;\n\
  font-size: 11px;\n\
  text-transform: uppercase;\n\
  letter-spacing: 0.5px;\n\
  background: color-mix(in srgb, var(--bg) 50%, var(--card));\n\
}\n\
.alias-card-body tr:last-child td { border-bottom: none; }\n\
.alias-card-body tr:hover td { background: color-mix(in srgb, var(--primary) 3%, var(--card)); }\n\
.alias-card-body code {\n\
  background: color-mix(in srgb, var(--primary) 10%, transparent);\n\
  padding: 2px 6px;\n\
  border-radius: 4px;\n\
  font-size: 12px;\n\
  color: var(--primary);\n\
  font-family: "SF Mono", "Fira Code", "Cascadia Code", monospace;\n\
  word-break: break-all;\n\
}\n\
.alias-card-footer {\n\
  display: flex;\n\
  gap: 8px;\n\
  padding: 12px 20px;\n\
  border-top: 1px solid var(--border);\n\
  background: color-mix(in srgb, var(--bg) 30%, var(--card));\n\
}\n\
.empty-state {\n\
  text-align: center;\n\
  padding: 48px 20px;\n\
  color: var(--text-sec);\n\
}\n\
.empty-state-icon { font-size: 3em; margin-bottom: 12px; opacity: 0.5; }\n\
.empty-state-text { font-size: 15px; }\n\
.tag {\n\
  display: inline-flex;\n\
  align-items: center;\n\
  padding: 3px 8px;\n\
  border-radius: 6px;\n\
  font-size: 11px;\n\
  font-weight: 600;\n\
  letter-spacing: 0.2px;\n\
}\n\
.tag-off { background: color-mix(in srgb, var(--primary) 15%, transparent); color: var(--primary); }\n\
.tag-dual { background: var(--warning-bg); color: var(--warning); }\n\
.status-dot {\n\
  display: inline-block;\n\
  width: 8px;\n\
  height: 8px;\n\
  border-radius: 50%;\n\
  margin-right: 6px;\n\
}\n\
.status-dot.fast { background: var(--success); box-shadow: 0 0 6px var(--success); }\n\
.status-dot.good { background: var(--primary); box-shadow: 0 0 6px var(--primary); }\n\
.status-dot.slow { background: var(--warning); box-shadow: 0 0 6px var(--warning); }\n\
.status-dot.timeout { background: var(--danger); box-shadow: 0 0 6px var(--danger); }\n\
.modal {\n\
  display: none;\n\
  position: fixed;\n\
  inset: 0;\n\
  background: var(--modal-bg);\n\
  z-index: 999;\n\
  padding: 20px;\n\
  overflow: auto;\n\
  backdrop-filter: blur(12px);\n\
  -webkit-backdrop-filter: blur(12px);\n\
}\n\
.modal.show {\n\
  display: flex;\n\
  align-items: flex-start;\n\
  justify-content: center;\n\
}\n\
.modal-inner {\n\
  background: var(--card);\n\
  padding: 28px;\n\
  border-radius: var(--radius);\n\
  max-width: 500px;\n\
  width: 100%;\n\
  margin-top: 60px;\n\
  border: 1px solid var(--border);\n\
  box-shadow: var(--shadow-lg);\n\
  animation: modalIn 0.25s ease-out;\n\
}\n\
@keyframes modalIn {\n\
  from { opacity: 0; transform: translateY(-20px) scale(0.97); }\n\
  to { opacity: 1; transform: translateY(0) scale(1); }\n\
}\n\
.modal-inner h2 {\n\
  margin: 0 0 20px;\n\
  font-size: 1.2em;\n\
  font-weight: 700;\n\
}\n\
.modal-toolbar {\n\
  display: flex;\n\
  gap: 10px;\n\
  margin-top: 24px;\n\
}\n\
.modal-toolbar .btn { flex: 1; justify-content: center; }\n\
#toast {\n\
  position: fixed;\n\
  top: 24px;\n\
  left: 50%;\n\
  transform: translateX(-50%) translateY(-100px);\n\
  background: var(--card);\n\
  color: var(--text);\n\
  padding: 12px 24px;\n\
  border-radius: var(--radius-sm);\n\
  font-size: 14px;\n\
  font-weight: 500;\n\
  box-shadow: var(--shadow-lg);\n\
  border: 1px solid var(--border);\n\
  z-index: 9999;\n\
  opacity: 0;\n\
  transition: transform 0.35s cubic-bezier(0.34,1.56,0.64,1), opacity 0.25s ease;\n\
  pointer-events: none;\n\
  white-space: nowrap;\n\
}\n\
#toast.show {\n\
  transform: translateX(-50%) translateY(0);\n\
  opacity: 1;\n\
}\n\
.result-table {\n\
  width: 100%;\n\
  border-collapse: collapse;\n\
  font-size: 13px;\n\
  margin-top: 12px;\n\
}\n\
.result-table th,\n\
.result-table td {\n\
  padding: 10px 14px;\n\
  text-align: left;\n\
  border-bottom: 1px solid var(--border);\n\
}\n\
.result-table th {\n\
  color: var(--text-sec);\n\
  font-weight: 600;\n\
  font-size: 11px;\n\
  text-transform: uppercase;\n\
  letter-spacing: 0.5px;\n\
}\n\
.result-table tr.best td {\n\
  background: var(--success-bg);\n\
  border-left: 3px solid var(--success);\n\
}\n\
.result-table tr:hover td {\n\
  background: color-mix(in srgb, var(--primary) 5%, var(--card));\n\
}\n\
.domain-card {\n\
  background: var(--card);\n\
  border: 1px solid var(--border);\n\
  border-radius: var(--radius);\n\
  overflow: hidden;\n\
}\n\
.domain-card-header {\n\
  display: flex;\n\
  align-items: center;\n\
  justify-content: space-between;\n\
  gap: 12px;\n\
  padding: 16px 20px;\n\
  border-bottom: 1px solid var(--border);\n\
  background: color-mix(in srgb, var(--primary) 4%, var(--card));\n\
}\n\
.domain-result-body {\n\
  padding: 16px 20px;\n\
}\n\
.domain-best {\n\
  margin-top: 12px;\n\
  padding: 10px 16px;\n\
  background: var(--success-bg);\n\
  border: 1px solid color-mix(in srgb, var(--success) 30%, transparent);\n\
  border-radius: var(--radius-sm);\n\
  font-size: 13px;\n\
  font-weight: 500;\n\
}\n\
.domain-best code {\n\
  color: var(--success);\n\
  background: color-mix(in srgb, var(--success) 12%, transparent);\n\
  padding: 2px 6px;\n\
  border-radius: 4px;\n\
  font-family: "SF Mono", "Fira Code", "Cascadia Code", monospace;\n\
}\n\
.domain-no-result {\n\
  padding: 32px;\n\
  text-align: center;\n\
  color: var(--text-sec);\n\
  font-size: 14px;\n\
}\n\
.loading-text {\n\
  color: var(--text-sec);\n\
  font-size: 14px;\n\
  display: flex;\n\
  align-items: center;\n\
  gap: 8px;\n\
}\n\
.loading-text::before {\n\
  content: "";\n\
  display: inline-block;\n\
  width: 14px;\n\
  height: 14px;\n\
  border: 2px solid var(--border);\n\
  border-top-color: var(--primary);\n\
  border-radius: 50%;\n\
  animation: spin 0.6s linear infinite;\n\
}\n\
@keyframes spin { to { transform: rotate(360deg); } }\n\
@media (max-width: 640px) {\n\
  .container { padding: 16px 12px 40px; gap: 16px; }\n\
  .card { padding: 18px; }\n\
  .header { gap: 12px; }\n\
  .header h1 { font-size: 1.2em; }\n\
  .alias-card-header { padding: 12px 14px; }\n\
  .alias-card-body th, .alias-card-body td { padding: 8px 10px; }\n\
  .alias-card-footer { padding: 10px 14px; }\n\
  .modal-inner { padding: 20px; margin-top: 30px; }\n\
  .search-input { max-width: 100%; }\n\
}\n\
\n\
.icon-picker-container { position: relative; }\n\
.icon-picker-preview { display: flex; align-items: center; gap: 10px; }\n\
.icon-picker-current { width: 40px; height: 40px; display: flex; align-items: center; justify-content: center; background: var(--bg-tertiary); border-radius: 10px; font-size: 24px; overflow: hidden; border: 2px solid var(--border-color); flex-shrink: 0; }\n\
.icon-picker-current img { width: 100%; height: 100%; object-fit: contain; }\n\
.icon-picker-trigger { padding: 8px 14px; background: var(--bg-tertiary); border: 1px solid var(--border-color); border-radius: 8px; cursor: pointer; font-size: 13px; color: var(--text-secondary); transition: all 0.2s; }\n\
.icon-picker-trigger:hover { border-color: var(--accent-blue); color: var(--accent-blue); }\n\
#iconPickerPanel { display: none; position: absolute; left: 0; right: 0; top: 100%; margin-top: 4px; background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 12px; padding: 12px; z-index: 100; box-shadow: 0 8px 32px rgba(0,0,0,0.3); max-height: 320px; overflow: hidden; }\n\
#iconPickerPanel.show { display: block; }\n\
.icon-search { width: 100%; padding: 8px 12px; background: var(--bg-tertiary); border: 1px solid var(--border-color); border-radius: 8px; color: var(--text-primary); font-size: 13px; margin-bottom: 10px; outline: none; }\n\
.icon-search:focus { border-color: var(--accent-blue); }\n\
.icon-grid { display: grid; grid-template-columns: repeat(6, 1fr); gap: 6px; max-height: 240px; overflow-y: auto; padding: 2px; }\n\
.icon-grid::-webkit-scrollbar { width: 4px; }\n\
.icon-grid::-webkit-scrollbar-thumb { background: var(--border-color); border-radius: 4px; }\n\
.icon-item { width: 100%; aspect-ratio: 1; display: flex; align-items: center; justify-content: center; border-radius: 8px; cursor: pointer; border: 2px solid transparent; transition: all 0.15s; background: var(--bg-tertiary); }\n\
.icon-item:hover { border-color: var(--accent-blue); transform: scale(1.08); }\n\
.icon-item.selected { border-color: var(--accent-blue); box-shadow: 0 0 0 2px rgba(59,130,246,0.3); }\n\
.icon-item img { width: 80%; height: 80%; object-fit: contain; border-radius: 4px; }\n\
.icon-item.emoji-item { font-size: 28px; }\n\
.icon-section-label { grid-column: 1 / -1; font-size: 12px; font-weight: 600; color: var(--text-sec); padding: 6px 2px 2px; text-transform: uppercase; letter-spacing: 0.5px; }\n\
.loading-text { grid-column: 1 / -1; text-align: center; color: var(--text-sec); padding: 30px; font-size: 13px; }\n\
</style>\n\
</head>\n\
<body>\n\
<div id="toast"></div>\n\
<div class="container">\n\
  <div class="card">\n\
    <div class="header">\n\
      <h1>\u2699\uFE0F \u7BA1\u7406\u540E\u53F0</h1>\n\
      <div class="header-actions">\n\
        <button class="btn-icon" onclick="toggleDark()" title="\u5207\u6362\u6DF1\u8272/\u6D45\u8272\u6A21\u5F0F">\u{1F319}</button>\n\
        <a href="/" class="btn btn-ghost btn-sm">\u8FD4\u56DE\u9996\u9875</a>\n\
        <button class="btn btn-danger btn-sm" onclick="logout()">\u9000\u51FA</button>\n\
      </div>\n\
    </div>\n\
  </div>\n\
\n\
  <div>\n\
    <div class="section-title">\u{1F3F7}\uFE0F \u522B\u540D\u7BA1\u7406</div>\n\
    <div class="card">\n\
      <div class="toolbar">\n\
        <button class="btn" onclick="openAddAlias()">\u2795 \u6DFB\u52A0\u522B\u540D</button>\n\
        <input type="text" class="search-input" id="aliasSearch" placeholder="\u641C\u7D22\u522B\u540D..." oninput="filterAliases()">\n\
      </div>\n\
      <div id="aliasList"><div class="loading-text">\u52A0\u8F7D\u4E2D...</div></div>\n\
    </div>\n\
  </div>\n\
\n\
  <div>\n\
    <div class="section-title">\u26A1 \u4F18\u9009\u57DF\u540D\u6D4B\u901F</div>\n\
    <div class="domain-card">\n\
      <div class="domain-card-header">\n\
        <div>\n\
          <div style="font-weight:600;font-size:15px">\u8FB9\u7F18 \u2192 \u4F18\u9009\u5165\u53E3\u6D4B\u901F</div>\n\
          <div style="font-size:12px;color:var(--text-sec);margin-top:2px">\u4ECE Worker \u8FB9\u7F18\u8282\u70B9\u6D4B\u8BD5\u5230\u5404\u4F18\u9009\u57DF\u540D\u7684\u5EF6\u8FDF</div>\n\
        </div>\n\
        <button class="btn" onclick="testDomains()">\u{1F680} \u5F00\u59CB\u6D4B\u901F</button>\n\
      </div>\n\
      <div class="domain-result-body" id="domainResult"><div class="domain-no-result">\u70B9\u51FB\u4E0A\u65B9\u6309\u94AE\u5F00\u59CB\u6D4B\u901F</div></div>\n\
    </div>\n\
  </div>\n\
</div>\n\
\n\
<div id="modalAlias" class="modal" onclick="if(event.target===this)closeModal(\'modalAlias\')">\n\
  <div class="modal-inner">\n\
    <h2 id="aliasModalTitle">\u6DFB\u52A0\u522B\u540D</h2>\n\
    <input type="hidden" id="aliasId">\n\
    <div class="form-row"><label>\u540D\u79F0</label><input type="text" id="aliasName" placeholder="\u6211\u7684 Emby"></div>\n\
    <div class="form-row"><label>\u522B\u540D\u8DEF\u5F84</label><input type="text" id="aliasPath" placeholder="my-emby"></div>\n\
    <div class="form-row"><label>\u56FE\u6807</label>\n\
      <div class="icon-picker-container">\n\
        <input type="hidden" id="aliasIcon" value="\u{1F3AC}">\n\
        <div class="icon-picker-preview">\n\
          <div class="icon-picker-current" id="iconPickerCurrent">\u{1F3AC}</div>\n\
          <div class="icon-picker-trigger" onclick="toggleIconPicker()">\u{1F3A8} \u9009\u62E9\u56FE\u6807</div>\n\
          <div class="icon-picker-trigger" onclick="promptCustomIcon()" style="margin-left:4px">\u{1F517} \u81EA\u5B9A\u4E49URL</div>\n\
        </div>\n\
        <div id="iconPickerPanel">\n\
          <input type="text" class="icon-search" id="iconSearchInput" placeholder="\u641C\u7D22\u56FE\u6807..." oninput="filterIcons()">\n\
          <div class="icon-grid" id="iconGrid"></div>\n\
        </div>\n\
      </div>\n\
    </div>\n\
    <div class="modal-toolbar">\n\
      <button class="btn btn-ghost" onclick="closeModal(\'modalAlias\')">\u53D6\u6D88</button>\n\
      <button class="btn" onclick="saveAlias()">\u4FDD\u5B58</button>\n\
    </div>\n\
  </div>\n\
</div>\n\
\n\
<div id="modalLine" class="modal" onclick="if(event.target===this)closeModal(\'modalLine\')">\n\
  <div class="modal-inner">\n\
    <h2 id="lineModalTitle">\u6DFB\u52A0\u7EBF\u8DEF</h2>\n\
    <input type="hidden" id="lineId">\n\
    <input type="hidden" id="lineAliasId">\n\
    <div class="form-row"><label>\u7EBF\u8DEF\u540D\u79F0</label><input type="text" id="lineName" placeholder="\u4E3B\u7EBF\u8DEF"></div>\n\
    <div class="form-row"><label>\u76EE\u6807\u5730\u5740</label><input type="url" id="lineTargetUrl" placeholder="https://emby.example.com:8096"></div>\n\
    <div class="form-row" style="display:flex;gap:20px;align-items:center">\n\
      <label class="checkbox-label"><input type="checkbox" id="lineCompat"> \u517C\u5BB9\u6A21\u5F0F</label>\n\
      <label class="checkbox-label"><input type="checkbox" id="lineCache"> \u7F13\u5B58\u56FE\u7247</label>\n\
    </div>\n\
    <div class="modal-toolbar">\n\
      <button class="btn btn-ghost" onclick="closeModal(\'modalLine\')">\u53D6\u6D88</button>\n\
      <button class="btn" onclick="saveLine()">\u4FDD\u5B58</button>\n\
    </div>\n\
  </div>\n\
</div>\n\
\n\
<div id="modalSpeedTest" class="modal" onclick="if(event.target===this)closeModal(\'modalSpeedTest\')">\n\
  <div class="modal-inner" style="max-width:600px">\n\
    <h2>\u26A1 \u6D4B\u901F\u7ED3\u679C</h2>\n\
    <div id="speedTestBody"><div class="loading-text">\u6D4B\u901F\u4E2D...</div></div>\n\
    <div class="modal-toolbar">\n\
      <button class="btn" onclick="closeModal(\'modalSpeedTest\')" style="flex:1;justify-content:center">\u5173\u95ED</button>\n\
    </div>\n\
  </div>\n\
</div>\n\
\n\
<script>\n\
var allAliases = [];\n\
var linesCache = {};\n\
var currentLineAliasId = null;\n\
\n\
function showToast(msg) {\n\
  var t = document.getElementById(\'toast\');\n\
  t.textContent = msg;\n\
  t.classList.add(\'show\');\n\
  clearTimeout(t._timer);\n\
  t._timer = setTimeout(function() { t.classList.remove(\'show\'); }, 3000);\n\
}\n\
\n\
function closeModal(id) { document.getElementById(id).classList.remove(\'show\'); }\n\
function openModal(id) { document.getElementById(id).classList.add(\'show\'); }\n\
\n\
function toggleDark() {\n\
  document.body.classList.toggle(\'light\');\n\
  var isLight = document.body.classList.contains(\'light\');\n\
  try { localStorage.setItem(\'theme\', isLight ? \'light\' : \'dark\'); } catch(e) {}\n\
}\n\
\n\
(function() {\n\
  try {\n\
    if (localStorage.getItem(\'theme\') === \'light\') document.body.classList.add(\'light\');\n\
  } catch(e) {}\n\
})();\n\
\n\
function logout() {\n\
  document.cookie = \'admin_token=; path=/; max-age=0\';\n\
  location.href = \'/\';\n\
}\n\
\n\
function getModeLabel(mode) {\n\
  return mode === \'dual\' ? \'\u517C\u5BB9\' : \'\u9ED8\u8BA4\';\n\
}\n\
\n\
async function loadAliases() {\n\
  try {\n\
    var r = await fetch(\'/admin/api/aliases\');\n\
    if (r.status === 401) { location.href = \'/\'; return; }\n\
    allAliases = await r.json();\n\
    renderAliases(allAliases);\n\
  } catch(e) {\n\
    document.getElementById(\'aliasList\').innerHTML = \'<div class="empty-state"><div class="empty-state-icon">\u26A0\uFE0F</div><div class="empty-state-text">\u52A0\u8F7D\u5931\u8D25: \' + e.message + \'</div></div>\';\n\
  }\n\
}\n\
\n\
function renderAliases(list) {\n\
  var el = document.getElementById(\'aliasList\');\n\
  if (!list.length) {\n\
    el.innerHTML = \'<div class="empty-state"><div class="empty-state-icon">\u{1F4ED}</div><div class="empty-state-text">\u6682\u65E0\u522B\u540D\uFF0C\u70B9\u51FB\u4E0A\u65B9\u6309\u94AE\u6DFB\u52A0</div></div>\';\n\
    return;\n\
  }\n\
  var html = \'<div class="alias-grid">\';\n\
  list.forEach(function(a) {\n\
    html += \'<div class="alias-card" data-search="\' + (a.name + \' \' + a.alias).toLowerCase() + \'">\';\n\
    html += \'<div class="alias-card-header">\';\n\
    var iconVal = a.icon || \'\u{1F3AC}\';\n\
    var iconHtml = iconVal.startsWith(\'http\') ? \'<img src="\' + iconVal + \'" alt="icon" style="width:28px;height:28px;border-radius:4px;object-fit:cover">\' : iconVal;\n\
    html += \'<div class="alias-icon">\' + iconHtml + \'</div>\';\n\
    html += \'<div class="alias-info">\';\n\
    html += \'<div class="alias-name">\' + a.name + \'</div>\';\n\
    html += \'<div class="alias-path">/\' + a.alias + \'</div>\';\n\
    html += \'</div>\';\n\
    html += \'<div class="alias-actions">\';\n\
    html += \'<button class="btn btn-ghost btn-sm" onclick="openEditAlias(\' + a.id + \')">\u7F16\u8F91</button>\';\n\
    html += \'<button class="btn btn-danger btn-sm" onclick="deleteAlias(\' + a.id + \',\\\'\' + a.name.replace(/\'/g, "\\\\\'") + \'\\\')">\u5220\u9664</button>\';\n\
    html += \'</div>\';\n\
    html += \'</div>\';\n\
    html += \'<div class="alias-card-body" id="lines-\' + a.id + \'">\';\n\
    html += \'<div style="padding:16px;text-align:center;color:var(--text-sec);font-size:13px">\u52A0\u8F7D\u4E2D...</div>\';\n\
    html += \'</div>\';\n\
    html += \'<div class="alias-card-footer">\';\n\
    html += \'<button class="btn btn-sm" onclick="openAddLine(\' + a.id + \')">\u2795 \u6DFB\u52A0\u7EBF\u8DEF</button>\';\n\
    html += \'<button class="btn btn-ghost btn-sm" onclick="testLines(\' + a.id + \')">\u26A1 \u6D4B\u901F</button>\';\n\
    html += \'</div>\';\n\
    html += \'</div>\';\n\
  });\n\
  html += \'</div>\';\n\
  el.innerHTML = html;\n\
  list.forEach(function(a) { loadLines(a.id); });\n\
}\n\
\n\
function filterAliases() {\n\
  var q = document.getElementById(\'aliasSearch\').value.toLowerCase();\n\
  document.querySelectorAll(\'.alias-card\').forEach(function(c) {\n\
    c.style.display = (!q || c.dataset.search.indexOf(q) >= 0) ? \'\' : \'none\';\n\
  });\n\
}\n\
\n\
function openAddAlias() {\n\
  document.getElementById(\'aliasId\').value = \'\';\n\
  document.getElementById(\'aliasName\').value = \'\';\n\
  document.getElementById(\'aliasPath\').value = \'\';\n\
  setIconValue(\'\u{1F3AC}\');\n\
  document.getElementById(\'aliasModalTitle\').textContent = \'\u6DFB\u52A0\u522B\u540D\';\n\
  openModal(\'modalAlias\');\n\
}\n\
\n\
function openEditAlias(id) {\n\
  var a = allAliases.find(function(x) { return x.id === id; });\n\
  if (!a) return;\n\
  document.getElementById(\'aliasId\').value = a.id;\n\
  document.getElementById(\'aliasName\').value = a.name;\n\
  document.getElementById(\'aliasPath\').value = a.alias;\n\
  setIconValue(a.icon || \'\u{1F3AC}\');\n\
  document.getElementById(\'aliasModalTitle\').textContent = \'\u7F16\u8F91\u522B\u540D\';\n\
  openModal(\'modalAlias\');\n\
}\n\
\n\
var ICON_EMOJIS = [\n\
  \'\u{1F3AC}\',\'\u{1F37F}\',\'\u{1F3AE}\',\'\u{1F3A8}\',\'\u{1F3B5}\',\'\u{1F3B6}\',\'\u{1F4FC}\',\'\u{1F4FA}\',\'\u{1F4F7}\',\'\u{1F4F9}\',\n\
  \'\u{1F39E}\',\'\u{1F4BD}\',\'\u{1F4BB}\',\'\u{1F4F1}\',\'\u{1F4DF}\',\'\u{1F3A5}\',\'\u{1F4FB}\',\'\u{1F50A}\',\'\u{1F3B8}\',\'\u{1F3B9}\',\n\
  \'\u{1F3BA}\',\'\u{1F3BB}\',\'\u{1F3BC}\',\'\u{2604}\',\'\u{1F3AD}\',\'\u{1F30A}\',\'\u{1F319}\',\'\u2B50\',\'\u{1F525}\',\'\u2728\',\n\
  \'\u{1F496}\',\'\u{1F494}\',\'\u2764\uFE0F\',\'\u{1F48E}\',\'\u{1F680}\',\'\u2708\uFE0F\',\'\u{1F697}\',\'\u{1F3E0}\',\'\u{1F3F0}\',\'\u26EA\',\n\
  \'\u{1F308}\',\'\u{1F306}\',\'\u{1F307}\',\'\u{1F305}\',\'\u{1F304}\',\'\u{1F303}\',\'\u{1F302}\',\'\u{1F301}\',\'\u{1F300}\',\'\u{1F30B}\',\n\
  \'\u{1F30C}\',\'\u{1F30D}\',\'\u{1F30E}\',\'\u{1F30F}\',\'\u{1F310}\',\'\u{1F311}\',\'\u{1F312}\',\'\u{1F313}\',\'\u{1F314}\',\'\u{1F315}\',\n\
  \'\u{1F4AF}\',\'\u{1F4AB}\',\'\u{1F4A5}\',\'\u{1F4A2}\',\'\u{1F4A4}\',\'\u{1F4A8}\',\'\u{1F4A6}\',\'\u{1F4AC}\',\'\u{1F4AD}\',\'\u{1F43E}\',\n\
  \'\u{1F431}\',\'\u{1F439}\',\'\u{1F436}\',\'\u{1F42E}\',\'\u{1F43C}\',\'\u{1F43B}\',\'\u{1F428}\',\'\u{1F42F}\',\'\u{1F430}\',\'\u{1F43A}\',\n\
  \'\u{1F353}\',\'\u{1F34E}\',\'\u{1F34A}\',\'\u{1F347}\',\'\u{1F352}\',\'\u{1F349}\',\'\u{1F345}\',\'\u{1F346}\',\'\u{1F344}\',\'\u{1F340}\',\n\
  \'\u{1F370}\',\'\u{1F36D}\',\'\u{1F366}\',\'\u{1F36A}\',\'\u{1F37A}\',\'\u2615\',\'\u{1F375}\',\'\u{1F376}\',\'\u{1F37E}\',\'\u{1F377}\',\n\
  \'\u{1F378}\',\'\u{1F379}\',\'\u{1F382}\',\'\u{1F381}\',\'\u{1F388}\',\'\u{1F389}\',\'\u{1F38A}\',\'\u{1F386}\',\'\u{1F384}\',\'\u{1F383}\',\n\
  \'\u{1F3C0}\',\'\u26BD\',\'\u26BE\',\'\u{1F3C8}\',\'\u{1F3BE}\',\'\u{1F3CA}\',\'\u26F3\',\'\u{1F3D0}\',\'\u{1F3C9}\',\'\u{1F3B1}\',\n\
  \'\u{1F52E}\',\'\u{1F48B}\',\'\u{1F489}\',\'\u{1F4DA}\',\'\u{1F4D6}\',\'\u{1F4DD}\',\'\u{1F4CB}\',\'\u{1F4C4}\',\'\u{1F4CA}\',\'\u{1F4C0}\',\n\
  \'\u{1F514}\',\'\u{1F515}\',\'\u{1F513}\',\'\u{1F512}\',\'\u{1F511}\',\'\u{1F516}\',\'\u{1F517}\',\'\u{1F50D}\',\'\u{1F50E}\',\'\u{1F527}\',\n\
  \'\u{1F528}\',\'\u{1F529}\',\'\u2699\uFE0F\',\'\u{1F6E0}\',\'\u{1F4E1}\',\'\u{1F4E0}\',\'\u{1F4E2}\',\'\u{1F4E3}\',\'\u{1F50B}\',\'\u{1F50C}\',\n\
  \'\u26A1\',\'\u{1F4A1}\',\'\u{1F526}\',\'\u{1F31F}\',\'\u{1F4AB}\',\'\u{1F31A}\',\'\u{1F31D}\',\'\u{1F31E}\',\'\u{1F31B}\',\'\u{1F31C}\',\n\
  \'\u2600\uFE0F\',\'\u26C5\',\'\u{1F324}\',\'\u{1F325}\',\'\u{1F326}\',\'\u{1F327}\',\'\u{1F328}\',\'\u{1F329}\',\'\u{1F32A}\',\'\u2744\uFE0F\'\n\
];\n\
var iconPickerLoaded = false;\n\
var allIcons = [];\n\
\n\
function setIconValue(val) {\n\
  document.getElementById(\'aliasIcon\').value = val;\n\
  var cur = document.getElementById(\'iconPickerCurrent\');\n\
  if (val && val.startsWith(\'http\')) {\n\
    cur.innerHTML = \'<img src="\' + val + \'" alt="icon">\';\n\
  } else {\n\
    cur.textContent = val || \'\u{1F3AC}\';\n\
  }\n\
}\n\
\n\
async function loadIconPickerGrid() {\n\
  var grid = document.getElementById(\'iconGrid\');\n\
  if (iconPickerLoaded) { renderIconGrid(ICON_EMOJIS); return; }\n\
  grid.innerHTML = \'<div class="loading-text">\u52A0\u8F7D\u4E2D...</div>\';\n\
  try {\n\
    var r = await fetch(\'/admin/api/icons\');\n\
    if (r.ok) { var d = await r.json(); allIcons = d.icons || []; }\n\
  } catch(e) { console.error(\'load icons fail\', e); }\n\
  iconPickerLoaded = true;\n\
  renderIconGrid(ICON_EMOJIS);\n\
}\n\
\n\
function renderIconGrid(emojis, filter) {\n\
  var grid = document.getElementById(\'iconGrid\');\n\
  var curVal = document.getElementById(\'aliasIcon\').value;\n\
  var f = (filter || \'\').toLowerCase();\n\
  var html = \'\';\n\
  html += \'<div class="icon-section-label">\u{1F3A8} \u9ED8\u8BA4\u56FE\u6807</div>\';\n\
  emojis.forEach(function(e) {\n\
    var sel = e === curVal ? \' selected\' : \'\';\n\
    html += \'<div class="icon-item emoji-item\' + sel + \'" onclick="selectIcon(this.dataset.url)" data-url="\' + e + \'">\' + e + \'</div>\';\n\
  });\n\
  if (allIcons.length > 0) {\n\
    html += \'<div class="icon-section-label">\u{1F5BC} Emby \u56FE\u6807\u5E93</div>\';\n\
    allIcons.forEach(function(icon) {\n\
      if (!f || icon.name.toLowerCase().indexOf(f) >= 0) {\n\
        var sel = curVal === icon.url ? \' selected\' : \'\';\n\
        html += \'<div class="icon-item\' + sel + \'" onclick="selectIcon(this.dataset.url)" data-url="\' + icon.url + \'" title="\' + icon.name + \'"><img src="\' + icon.url + \'" loading="lazy" alt="\' + icon.name + \'"></div>\';\n\
      }\n\
    });\n\
  }\n\
  if (html.indexOf(\'icon-item\') < 0) {\n\
    html += \'<div style="grid-column:1/-1;text-align:center;color:var(--text-sec);padding:20px">\u672A\u627E\u5230\u5339\u914D\u7684\u56FE\u6807</div>\';\n\
  }\n\
  grid.innerHTML = html;\n\
}\n\
\n\
function toggleIconPicker() {\n\
  var panel = document.getElementById(\'iconPickerPanel\');\n\
  var isOpen = panel.classList.contains(\'show\');\n\
  if (isOpen) {\n\
    panel.classList.remove(\'show\');\n\
  } else {\n\
    loadIconPickerGrid();\n\
    panel.classList.add(\'show\');\n\
    document.getElementById(\'iconSearchInput\').value = \'\';\n\
    document.getElementById(\'iconSearchInput\').focus();\n\
  }\n\
}\n\
\n\
function filterIcons() {\n\
  var q = document.getElementById(\'iconSearchInput\').value.toLowerCase().trim();\n\
  if (!q) {\n\
    renderIconGrid(ICON_EMOJIS);\n\
    return;\n\
  }\n\
  var filtered = ICON_EMOJIS.filter(function(e) {\n\
    return e.indexOf(q) >= 0;\n\
  });\n\
  renderIconGrid(filtered.length ? filtered : ICON_EMOJIS, q);\n\
}\n\
\n\
function selectIcon(val) {\n\
  setIconValue(val);\n\
  document.getElementById(\'iconPickerPanel\').classList.remove(\'show\');\n\
}\n\
\n\
function promptCustomIcon() {\n\
  var url = prompt(\'\u8F93\u5165\u56FE\u7247URL\uFF08\u5C06\u663E\u793A\u4E3A\u56FE\u7247\u800C\u975Eemoji\uFF09:\', \n\
    document.getElementById(\'aliasIcon\').value.startsWith(\'http\') ? document.getElementById(\'aliasIcon\').value : \'\');\n\
  if (url !== null && url.trim()) {\n\
    setIconValue(url.trim());\n\
  }\n\
}\n\
\n\
document.addEventListener(\'click\', function(e) {\n\
  var panel = document.getElementById(\'iconPickerPanel\');\n\
  if (!panel || !panel.classList.contains(\'show\')) return;\n\
  var container = panel.closest(\'.icon-picker-container\');\n\
  if (!container.contains(e.target)) {\n\
    panel.classList.remove(\'show\');\n\
  }\n\
});\n\
\n\
async function saveAlias() {\n\
  var id = document.getElementById(\'aliasId\').value;\n\
  var body = {\n\
    name: document.getElementById(\'aliasName\').value.trim(),\n\
    alias: document.getElementById(\'aliasPath\').value.trim(),\n\
    icon: document.getElementById(\'aliasIcon\').value.trim()\n\
  };\n\
  if (!body.name || !body.alias) { showToast(\'\u8BF7\u586B\u5199\u540D\u79F0\u548C\u8DEF\u5F84\'); return; }\n\
  try {\n\
    var r = await fetch(\'/admin/api/aliases\', {\n\
      method: id ? \'PUT\' : \'POST\',\n\
      headers: { \'Content-Type\': \'application/json\' },\n\
      body: JSON.stringify(id ? Object.assign({}, body, { id: parseInt(id) }) : body)\n\
    });\n\
    if (r.status === 401) { location.href = \'/\'; return; }\n\
    var j = await r.json();\n\
    if (!r.ok) { showToast(j.error || \'\u64CD\u4F5C\u5931\u8D25\'); return; }\n\
    closeModal(\'modalAlias\');\n\
    showToast(id ? \'\u522B\u540D\u5DF2\u66F4\u65B0\' : \'\u522B\u540D\u5DF2\u521B\u5EFA\');\n\
    loadAliases();\n\
  } catch(e) { showToast(\'\u8BF7\u6C42\u5931\u8D25: \' + e.message); }\n\
}\n\
\n\
async function deleteAlias(id, name) {\n\
  if (!confirm(\'\u786E\u5B9A\u5220\u9664\u522B\u540D "\' + name + \'" \u53CA\u5176\u6240\u6709\u7EBF\u8DEF\uFF1F\u6B64\u64CD\u4F5C\u4E0D\u53EF\u6062\u590D\u3002\')) return;\n\
  try {\n\
    var r = await fetch(\'/admin/api/aliases?id=\' + id, { method: \'DELETE\' });\n\
    if (r.status === 401) { location.href = \'/\'; return; }\n\
    showToast(\'\u522B\u540D\u5DF2\u5220\u9664\');\n\
    loadAliases();\n\
  } catch(e) { showToast(\'\u5220\u9664\u5931\u8D25\'); }\n\
}\n\
\n\
async function loadLines(aliasId) {\n\
  var el = document.getElementById(\'lines-\' + aliasId);\n\
  try {\n\
    var r = await fetch(\'/admin/api/lines?alias_id=\' + aliasId);\n\
    if (r.status === 401) { location.href = \'/\'; return; }\n\
    var lines = await r.json();\n\
    lines.forEach(function(l) { linesCache[l.id] = l; });\n\
    if (!lines.length) {\n\
      el.innerHTML = \'<div style="padding:16px;text-align:center;color:var(--text-sec);font-size:13px">\u6682\u65E0\u7EBF\u8DEF\uFF0C\u70B9\u51FB\u4E0B\u65B9\u6309\u94AE\u6DFB\u52A0</div>\';\n\
      return;\n\
    }\n\
    var html = \'<table><thead><tr><th>\u7EBF\u8DEF\u540D\u79F0</th><th>\u76EE\u6807\u5730\u5740</th><th>\u6A21\u5F0F</th><th>\u64CD\u4F5C</th></tr></thead><tbody>\';\n\
    lines.forEach(function(l) {\n\
      html += \'<tr>\';\n\
      html += \'<td>\' + l.line_name + \'</td>\';\n\
      html += \'<td><code>\' + l.target_url + \'</code></td>\';\n\
      html += \'<td><span class="tag tag-\' + (l.mode || \'off\') + \'">\' + getModeLabel(l.mode) + \'</span></td>\';\n\
      html += \'<td style="white-space:nowrap">\';\n\
      html += \'<button class="btn btn-ghost btn-sm" onclick="openEditLine(\' + l.id + \',\' + aliasId + \')">\u7F16\u8F91</button> \';\n\
      html += \'<button class="btn btn-danger btn-sm" onclick="deleteLine(\' + l.id + \',\' + aliasId + \')">\u5220\u9664</button>\';\n\
      html += \'</td></tr>\';\n\
    });\n\
    html += \'</tbody></table>\';\n\
    el.innerHTML = html;\n\
  } catch(e) {\n\
    el.innerHTML = \'<div style="padding:16px;text-align:center;color:var(--text-sec);font-size:13px">\u52A0\u8F7D\u5931\u8D25</div>\';\n\
  }\n\
}\n\
\n\
function openAddLine(aliasId) {\n\
  document.getElementById(\'lineAliasId\').value = aliasId;\n\
  document.getElementById(\'lineId\').value = \'\';\n\
  document.getElementById(\'lineName\').value = \'\';\n\
  document.getElementById(\'lineTargetUrl\').value = \'\';\n\
  document.getElementById(\'lineCompat\').checked = false;\n\
  document.getElementById(\'lineCache\').checked = false;\n\
  document.getElementById(\'lineModalTitle\').textContent = \'\u6DFB\u52A0\u7EBF\u8DEF\';\n\
  openModal(\'modalLine\');\n\
}\n\
\n\
function openEditLine(lineId, aliasId) {\n\
  var l = linesCache[lineId];\n\
  if (!l) return;\n\
  document.getElementById(\'lineAliasId\').value = aliasId;\n\
  document.getElementById(\'lineId\').value = l.id;\n\
  document.getElementById(\'lineName\').value = l.line_name;\n\
  document.getElementById(\'lineTargetUrl\').value = l.target_url;\n\
  document.getElementById(\'lineCompat\').checked = (l.mode === \'dual\');\n\
  document.getElementById(\'lineCache\').checked = !!l.cache_img;\n\
  document.getElementById(\'lineModalTitle\').textContent = \'\u7F16\u8F91\u7EBF\u8DEF\';\n\
  openModal(\'modalLine\');\n\
}\n\
\n\
async function saveLine() {\n\
  var id = document.getElementById(\'lineId\').value;\n\
  var aliasId = parseInt(document.getElementById(\'lineAliasId\').value);\n\
  var body = {\n\
    alias_id: aliasId,\n\
    line_name: document.getElementById(\'lineName\').value.trim(),\n\
    target_url: document.getElementById(\'lineTargetUrl\').value.trim(),\n\
    mode: document.getElementById(\'lineCompat\').checked ? \'dual\' : \'off\',\n\
    cache_img: document.getElementById(\'lineCache\').checked ? 1 : 0\n\
  };\n\
  if (!body.line_name || !body.target_url) { showToast(\'\u8BF7\u586B\u5199\u7EBF\u8DEF\u540D\u79F0\u548C\u76EE\u6807\u5730\u5740\'); return; }\n\
  try {\n\
    var r = await fetch(\'/admin/api/lines\', {\n\
      method: id ? \'PUT\' : \'POST\',\n\
      headers: { \'Content-Type\': \'application/json\' },\n\
      body: JSON.stringify(id ? Object.assign({}, body, { id: parseInt(id) }) : body)\n\
    });\n\
    if (r.status === 401) { location.href = \'/\'; return; }\n\
    if (!r.ok) { showToast((await r.json()).error || \'\u4FDD\u5B58\u5931\u8D25\'); return; }\n\
    closeModal(\'modalLine\');\n\
    showToast(id ? \'\u7EBF\u8DEF\u5DF2\u66F4\u65B0\' : \'\u7EBF\u8DEF\u5DF2\u6DFB\u52A0\');\n\
    loadLines(aliasId);\n\
  } catch(e) { showToast(\'\u8BF7\u6C42\u5931\u8D25: \' + e.message); }\n\
}\n\
\n\
async function deleteLine(lineId, aliasId) {\n\
  if (!confirm(\'\u786E\u5B9A\u5220\u9664\u8BE5\u7EBF\u8DEF\uFF1F\')) return;\n\
  try {\n\
    var r = await fetch(\'/admin/api/lines?id=\' + lineId, { method: \'DELETE\' });\n\
    if (r.status === 401) { location.href = \'/\'; return; }\n\
    showToast(\'\u7EBF\u8DEF\u5DF2\u5220\u9664\');\n\
    loadLines(aliasId);\n\
  } catch(e) { showToast(\'\u5220\u9664\u5931\u8D25\'); }\n\
}\n\
\n\
function getSpeedTagClass(status) {\n\
  return \'tag-\' + (status || \'off\');\n\
}\n\
\n\
function getSpeedStatusLabel(status) {\n\
  var map = { fast: \'\u6781\u5FEB\', good: \'\u826F\u597D\', slow: \'\u8F83\u6162\', timeout: \'\u8D85\u65F6\' };\n\
  return map[status] || \'\u2014\';\n\
}\n\
\n\
function getSpeedDotClass(status) {\n\
  var map = { fast: \'fast\', good: \'good\', slow: \'slow\', timeout: \'timeout\' };\n\
  return map[status] || \'timeout\';\n\
}\n\
\n\
async function testLines(aliasId) {\n\
  openModal(\'modalSpeedTest\');\n\
  var body = document.getElementById(\'speedTestBody\');\n\
  body.innerHTML = \'<div class="loading-text">\u6B63\u5728\u6D4B\u901F\u7EBF\u8DEF...</div>\';\n\
  try {\n\
    var r = await fetch(\'/admin/api/speedtest/lines?alias_id=\' + aliasId, { method: \'POST\' });\n\
    if (r.status === 401) { location.href = \'/\'; return; }\n\
    var d = await r.json();\n\
    if (!d.results || !d.results.length) {\n\
      body.innerHTML = \'<div class="domain-no-result">\u65E0\u6D4B\u901F\u7ED3\u679C</div>\';\n\
      return;\n\
    }\n\
    var best = d.best || null;\n\
    var html = \'<table class="result-table"><thead><tr><th>\u7EBF\u8DEF</th><th>\u5EF6\u8FDF</th><th>\u72B6\u6001</th></tr></thead><tbody>\';\n\
    d.results.forEach(function(x) {\n\
      var isBest = best && best === x.id;\n\
      html += \'<tr\' + (isBest ? \' class="best"\' : \'\') + \'>\';\n\
      html += \'<td>\' + (x.line_name || x.name || \'\u2014\') + \'</td>\';\n\
      html += \'<td>\' + (x.latency >= 0 ? x.latency + \' ms\' : \'\u2014\') + \'</td>\';\n\
      html += \'<td><span class="status-dot \' + getSpeedDotClass(x.status) + \'"></span>\' + getSpeedStatusLabel(x.status) + \'</td>\';\n\
      html += \'</tr>\';\n\
    });\n\
    html += \'</tbody></table>\';\n\
    body.innerHTML = html;\n\
    showToast(\'\u6D4B\u901F\u5B8C\u6210\');\n\
    loadLines(aliasId);\n\
  } catch(e) {\n\
    body.innerHTML = \'<div class="domain-no-result">\u6D4B\u901F\u5931\u8D25: \' + e.message + \'</div>\';\n\
  }\n\
}\n\
\n\
async function testDomains() {\n\
  var el = document.getElementById(\'domainResult\');\n\
  el.innerHTML = \'<div class="loading-text">\u6B63\u5728\u4ECE\u8FB9\u7F18\u8282\u70B9\u6D4B\u901F...</div>\';\n\
  try {\n\
    var r = await fetch(\'/admin/api/speedtest/domains\', { method: \'POST\' });\n\
    if (r.status === 401) { location.href = \'/\'; return; }\n\
    var d = await r.json();\n\
    if (!d.results || !d.results.length) {\n\
      el.innerHTML = \'<div class="domain-no-result">\u65E0\u6D4B\u901F\u7ED3\u679C</div>\';\n\
      return;\n\
    }\n\
    var html = \'<table class="result-table"><thead><tr><th>\u540D\u79F0</th><th>\u57DF\u540D</th><th>\u5EF6\u8FDF</th><th>\u72B6\u6001</th></tr></thead><tbody>\';\n\
    d.results.forEach(function(x) {\n\
      var isBest = d.best && d.best === x.host;\n\
      html += \'<tr\' + (isBest ? \' class="best"\' : \'\') + \'>\';\n\
      html += \'<td>\' + (x.name || \'\u2014\') + \'</td>\';\n\
      html += \'<td><code>\' + x.host + \'</code></td>\';\n\
      html += \'<td>\' + (x.latency >= 0 ? x.latency + \' ms\' : \'\u2014\') + \'</td>\';\n\
      html += \'<td><span class="status-dot \' + getSpeedDotClass(x.status) + \'"></span>\' + getSpeedStatusLabel(x.status) + \'</td>\';\n\
      html += \'</tr>\';\n\
    });\n\
    html += \'</tbody></table>\';\n\
    if (d.best) {\n\
      html += \'<div class="domain-best">\u{1F449} \u63A8\u8350\u4F7F\u7528: <code>\' + d.best + \'</code></div>\';\n\
    }\n\
    el.innerHTML = html;\n\
    showToast(\'\u6D4B\u901F\u5B8C\u6210\');\n\
  } catch(e) {\n\
    el.innerHTML = \'<div class="domain-no-result">\u6D4B\u901F\u5931\u8D25: \' + e.message + \'</div>\';\n\
  }\n\
}\n\
\n\
loadAliases();\n\
<\/script>\n\
</body>\n\
</html>';




const FRONTEND_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Emby 反向代理服务</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: -apple-system, system-ui, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; line-height: 1.6; color: #e1e4e8; background: #1a1c22; min-height: 100vh; -webkit-font-smoothing: antialiased; }
        .container { max-width: 900px; margin: auto; padding: 20px; display: flex; flex-direction: column; gap: 20px; }
        .card { background: #252830; padding: 28px; border-radius: 16px; border-top: 4px solid #0070f3; box-shadow: 0 4px 12px rgba(0,0,0,0.15); }
        h1 { margin-top: 0; color: #0070f3; font-size: 1.6em; }
        h2 { color: #0070f3; border-bottom: 2px solid #3e4451; padding-bottom: 8px; font-size: 1.1em; margin-bottom: 16px; }
        code { background: rgba(0,112,243,0.1); padding: 3px 8px; border-radius: 4px; color: #61afef; word-break: break-all; font-size: 0.9em; }
        .muted { color: #abb2bf; font-size: 14px; }
        a { color: #0070f3; text-decoration: none; }
        a:hover { text-decoration: underline; }
        .btn { display: inline-block; padding: 10px 18px; background: #0070f3; color: #fff; border-radius: 8px; text-decoration: none; font-weight: 600; border: none; cursor: pointer; font-size: 14px; transition: background 0.2s; }
        .btn:hover { background: #0056b3; text-decoration: none; }
        .btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .btn-outline { background: transparent; border: 1px solid #0070f3; color: #0070f3; }
        .btn-outline:hover { background: rgba(0,112,243,0.1); }
        .hero { text-align: center; padding: 40px 28px; }
        .hero h1 { font-size: 2em; margin-bottom: 12px; }
        .hero p { color: #8b8fa3; font-size: 16px; max-width: 600px; margin: 0 auto; }
        .info-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 14px; margin: 16px 0; }
        .info-item { background: rgba(0,0,0,0.2); padding: 16px; border-radius: 10px; border-left: 3px solid #0070f3; }
        .info-label { font-size: 12px; color: #8b8fa3; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; }
        .info-value { font-family: "SF Mono", "Fira Code", "Cascadia Code", monospace; font-size: 14px; color: #61afef; word-break: break-all; }
        .stat-row { display: flex; gap: 12px; flex-wrap: wrap; margin: 16px 0; }
        .stat-card { flex: 1; min-width: 140px; background: rgba(0,112,243,0.08); border: 1px solid rgba(0,112,243,0.2); border-radius: 10px; padding: 16px; text-align: center; }
        .stat-val { font-size: 1.8em; font-weight: bold; color: #0070f3; }
        .stat-label { font-size: 13px; color: #8b8fa3; }
        table { width: 100%; border-collapse: collapse; font-size: 14px; }
        th, td { padding: 10px 12px; text-align: left; border-bottom: 1px solid #3e4451; }
        th { color: #0070f3; background: rgba(0,112,243,0.08); font-weight: 600; }
        tr.best td { background: rgba(52,199,89,0.08); }
        .tag { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 12px; font-weight: 600; }
        .tag-fast { background: rgba(52,199,89,0.2); color: #34c759; }
        .tag-good { background: rgba(0,112,243,0.2); color: #61afef; }
        .tag-slow { background: rgba(255,149,0,0.2); color: #ff9500; }
        .tag-timeout { background: rgba(224,108,117,0.2); color: #e06c75; }
        .warn { border: 2px solid rgba(224,108,117,0.3); padding: 16px; border-radius: 12px; color: #e06c75; background: rgba(224,108,117,0.05); }
        .example-box { background: #1a1c22; border: 1px solid #3e4451; border-radius: 8px; padding: 14px; margin: 10px 0; font-family: monospace; font-size: 13px; overflow-x: auto; }
        .section-desc { color: #8b8fa3; font-size: 14px; margin-bottom: 16px; }
        .toolbar { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin-bottom: 16px; }
        footer { text-align: center; padding: 30px 20px; color: #555a6e; font-size: 13px; }
        footer a { color: #0088cc; }
        #toast { position: fixed; top: 24px; left: 50%; transform: translateX(-50%) translateY(-80px); background: #252830; color: #e1e4e8; padding: 12px 24px; border-radius: 10px; font-size: 14px; box-shadow: 0 8px 24px rgba(0,0,0,0.4); border: 1px solid #3e4451; z-index: 9999; opacity: 0; transition: transform 0.3s ease, opacity 0.3s ease; pointer-events: none; }
        #toast.show { transform: translateX(-50%) translateY(0); opacity: 1; }
        @media (max-width: 600px) {
            .container { padding: 12px; }
            .card { padding: 20px; }
            .hero { padding: 28px 20px; }
            .hero h1 { font-size: 1.5em; }
            .info-grid { grid-template-columns: 1fr; }
        }
    </style>
</head>
<body>
    <div id="toast"></div>
    <div class="container">

        <div class="card hero">
            <h1>\u{1F680} Emby 反向代理服务</h1>
            <p>基于 Cloudflare Workers 的智能反向代理，支持别名管理、多线路故障转移与 CF 优选域名智能测速</p>
            <div style="margin-top:18px">
                <a href="/admin" class="btn btn-outline">\u{1F510} 管理后台</a>
            </div>
        </div>

        <div class="card">
            <h2>\u{1F4F1} 当前连接信息</h2>
            <div class="info-grid">
                <div class="info-item">
                    <div class="info-label">当前接入域名</div>
                    <div class="info-value" id="conn-host">加载中...</div>
                </div>
                <div class="info-item">
                    <div class="info-label">边缘节点</div>
                    <div class="info-value" id="conn-edge">加载中...</div>
                </div>
                <div class="info-item">
                    <div class="info-label">运营商</div>
                    <div class="info-value" id="conn-isp">加载中...</div>
                </div>
                <div class="info-item">
                    <div class="info-label">推荐优选域名</div>
                    <div class="info-value" id="conn-best">加载中...</div>
                </div>
            </div>
        </div>

        <div class="card">
            <h2>\u{1F4D6} 使用指南</h2>
            <p class="section-desc">通过本代理访问 Emby 服务，支持直接 URL 和别名两种方式：</p>

            <h3 style="color:#61afef;font-size:14px;margin:16px 0 8px">通用格式（直接 URL）</h3>
            <div class="example-box">
                <div style="color:#8b8fa3;margin-bottom:6px">// HTTP 服务</div>
                <div>https://<span style="color:#34c759">代理域名</span>/http://你的emby地址:端口</div>
                <div style="color:#8b8fa3;margin:12px 0 6px">// HTTPS 服务</div>
                <div>https://<span style="color:#34c759">代理域名</span>/https://你的emby地址:端口</div>
            </div>

            <h3 style="color:#61afef;font-size:14px;margin:16px 0 8px">实际示例</h3>
            <div class="example-box">
                <div>https://proxy.example.com/http://192.168.1.100:8096</div>
                <div style="margin-top:6px">https://proxy.example.com/https://emby.mydomain.com:8920</div>
            </div>

            <div class="warn" style="margin-top:16px">
                \u{26A0}\u{FE0F} 使用前请先手动测试代理地址是否可用，确认能正常访问后再配置到客户端。恶意刷接口将被封禁 IP。
            </div>
        </div>

        <div class="card">
            <h2>\u{1F517} 别名快捷方式</h2>
            <p class="section-desc">管理员可在后台配置别名，简化访问路径：</p>

            <div class="example-box">
                <div style="color:#8b8fa3;margin-bottom:6px">// 通过别名访问（更简短）</div>
                <div>https://proxy.example.com/<span style="color:#34c759">别名</span></div>
                <div style="margin-top:6px">https://proxy.example.com/<span style="color:#34c759">别名</span>/web/index.html</div>
            </div>

            <p class="muted" style="margin-top:12px">别名由管理员在 <a href="/admin">管理后台</a> 中配置，支持多线路故障转移与智能选线。</p>
        </div>

        <div class="card">
            <h2>\u{1F4CA} 使用统计</h2>
            <div id="stats-loading" class="muted">加载中...</div>
            <div id="stats-body" style="display:none">
                <div class="stat-row">
                    <div class="stat-card">
                        <div class="stat-val" id="st-play">0</div>
                        <div class="stat-label">播放次数</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-val" id="st-pb">0</div>
                        <div class="stat-label">获取链接</div>
                    </div>
                </div>
                <div id="daily-table"></div>
                <p class="muted" style="margin-top:12px" id="stats-time"></p>
            </div>
        </div>

        <div class="card">
            <h2>\u{26A1} 优选域名测速</h2>
            <p class="section-desc">测试各 Cloudflare 优选域名到您网络的延迟，选择最快的接入点：</p>
            <div class="toolbar">
                <button class="btn" id="btn-speedtest" onclick="runDomainSpeedtest()">开始测速</button>
                <span class="muted" id="speed-status"></span>
            </div>
            <div id="domain-table-wrap">
                <p class="muted" id="domain-hint">点击上方按钮开始测速</p>
            </div>
        </div>
    </div>

    <footer>
        <p>Emby 反向代理服务 &copy; 2024-2026 &nbsp;|&nbsp; <a href="https://t.me/emby_proxy" target="_blank">Telegram 群组</a></p>
        <p style="margin-top:4px;font-size:12px;color:#444a5e">Powered by Cloudflare Workers</p>
    </footer>

    <script>
        var OPT_DOMAINS = [];
        var TAG_MAP = { fast: '\u{1F680} 极快', good: '\u{1F44D} 良好', slow: '\u{1F40C} 较慢', timeout: '\u{274C} 超时' };
        var CLS_MAP = { fast: 'tag-fast', good: 'tag-good', slow: 'tag-slow', timeout: 'tag-timeout' };

        function showToast(msg) {
            var t = document.getElementById('toast');
            t.textContent = msg;
            t.classList.add('show');
            setTimeout(function() { t.classList.remove('show'); }, 2500);
        }

        async function loadConnectionInfo() {
            document.getElementById('conn-host').textContent = window.location.host;
            try {
                var r = await fetch('/api/connection-info');
                var d = await r.json();
                var parts = [];
                if (d.colo && d.colo !== 'Unknown') parts.push(d.colo);
                if (d.country && d.country !== 'Unknown') parts.push(d.country);
                if (d.region) parts.push(d.region);
                if (d.city) parts.push(d.city);
                document.getElementById('conn-edge').textContent = parts.join(' / ') || '\u2014';
                document.getElementById('conn-isp').textContent = d.isp || d.asn || '\u2014';
            } catch(e) {
                document.getElementById('conn-edge').textContent = '\u2014';
                document.getElementById('conn-isp').textContent = '\u2014';
            }
            try {
                var r2 = await fetch('/api/best-domain');
                var d2 = await r2.json();
                if (d2.best) {
                    var bestText = d2.best;
                    if (d2.bestName) bestText = d2.bestName + ' (' + d2.best + ')';
                    if (d2.region || d2.isp) bestText += ' [' + [d2.region, d2.isp].filter(Boolean).join(' ') + ']';
                    if (d2.cached) bestText += ' [cached]';
                    document.getElementById('conn-best').textContent = bestText;
                } else {
                    document.getElementById('conn-best').textContent = d2.message || '\u2014';
                }
            } catch(e) {
                document.getElementById('conn-best').textContent = '\u2014';
            }
        }

        async function loadStats() {
            try {
                var r = await fetch('/stats');
                var data = await r.json();
                if (data.error) {
                    document.getElementById('stats-loading').textContent = data.error;
                    return;
                }
                document.getElementById('stats-loading').style.display = 'none';
                document.getElementById('stats-body').style.display = 'block';
                document.getElementById('st-play').textContent = data.data.total.playing;
                document.getElementById('st-pb').textContent = data.data.total.playbackInfo;
                if (data.data.lastUpdated) {
                    document.getElementById('stats-time').textContent = '\u{1F504} 数据更新时间: ' + data.data.lastUpdated;
                }
                var daily = (data.data.dailyStats || []).slice(0, 10);
                if (daily.length) {
                    var t = '<table><tr><th>日期</th><th>播放次数</th><th>获取链接</th></tr>';
                    daily.forEach(function(s) {
                        t += '<tr><td>' + s.date + '</td><td>' + s.playing_count + '</td><td>' + s.playback_info_count + '</td></tr>';
                    });
                    document.getElementById('daily-table').innerHTML = t + '</table>';
                }
            } catch(e) {
                document.getElementById('stats-loading').textContent = '\u{26A0}\u{FE0F} 统计数据加载失败';
            }
        }

        function pingUrl(url, timeout) {
            return new Promise(function(resolve) {
                var t0 = performance.now();
                var timer = setTimeout(function() { resolve(-1); }, timeout || 7000);
                var done = function(ms) {
                    clearTimeout(timer);
                    resolve(ms >= 0 && ms < (timeout || 7000) ? ms : -1);
                };
                fetch(url, { mode: 'no-cors', cache: 'no-store', credentials: 'omit' })
                    .then(function() { done(Math.round(performance.now() - t0)); })
                    .catch(function() {
                        var img = new Image();
                        var t1 = performance.now();
                        var t2 = setTimeout(function() { done(-1); }, 5000);
                        var end = function() { clearTimeout(t2); done(Math.round(performance.now() - t1)); };
                        img.onload = end;
                        img.onerror = end;
                        img.src = url + (url.indexOf('?') >= 0 ? '&' : '?') + '_=' + Date.now();
                    });
            });
        }

        async function probeDomain(item) {
            var host = item.subdomain + '.' + item.domain;
            var paths = ['/cdn-cgi/trace', '/favicon.ico', '/'];
            for (var i = 0; i < paths.length; i++) {
                var ms = await pingUrl('https://' + host + paths[i], 7000);
                if (ms >= 0) {
                    var status = ms < 100 ? 'fast' : ms < 300 ? 'good' : 'slow';
                    return { subdomain: item.subdomain, domain: item.domain, name: item.name, host: host, latency: ms, status: status };
                }
            }
            return { subdomain: item.subdomain, domain: item.domain, name: item.name, host: host, latency: -1, status: 'timeout' };
        }

        async function serverSpeedTest() {
            var r = await fetch('/api/speedtest/domains', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}' });
            return await r.json();
        }

        function renderDomainTable(results, best) {
            var wrap = document.getElementById('domain-table-wrap');
            if (!results.length) { wrap.innerHTML = '<p class="muted">无测速数据</p>'; return; }
            var h = '<table><thead><tr><th>#</th><th>名称</th><th>域名</th><th>延迟</th><th>状态</th></tr></thead><tbody>';
            results.forEach(function(r, i) {
                var host = r.host || (r.subdomain + '.' + r.domain);
                var isBest = best && best === host;
                h += '<tr' + (isBest ? ' class="best"' : '') + '><td>' + (i + 1) + '</td><td>' + (r.name || '') + '</td><td><code>' + host + '</code></td>' +
                    '<td>' + (r.latency >= 0 ? r.latency + ' ms' : '\u2014') + '</td>' +
                    '<td><span class="tag ' + (CLS_MAP[r.status] || 'tag-timeout') + '">' + (TAG_MAP[r.status] || '\u2014') + '</span></td></tr>';
            });
            wrap.innerHTML = h + '</tbody></table>';
        }

        async function runDomainSpeedtest() {
            var btn = document.getElementById('btn-speedtest');
            var status = document.getElementById('speed-status');
            btn.disabled = true;
            btn.textContent = '测速中...';
            status.textContent = '正在加载域名列表...';
            document.getElementById('domain-table-wrap').innerHTML = '<p class="muted">\u{1F680} 测速中，请稍候...</p>';

            try {
                if (!OPT_DOMAINS.length) {
                    var ld = await serverSpeedTest();
                    OPT_DOMAINS = (ld.results || []).map(function(r) {
                        return { subdomain: r.subdomain, domain: r.domain, name: r.name };
                    });
                    if (!OPT_DOMAINS.length && typeof OPTIMIZED_DOMAINS !== 'undefined') {
                        OPT_DOMAINS = OPTIMIZED_DOMAINS;
                    }
                }
            } catch(e) {}

            if (!OPT_DOMAINS.length) {
                status.textContent = '无法获取域名列表';
                btn.disabled = false;
                btn.textContent = '开始测速';
                return;
            }

            status.textContent = '正在测速 (' + OPT_DOMAINS.length + ' 个域名)...';
            var results = [];
            var completed = 0;

            var promises = OPT_DOMAINS.map(function(item) {
                return probeDomain(item).then(function(r) {
                    results.push(r);
                    completed++;
                    status.textContent = '测速中... ' + completed + '/' + OPT_DOMAINS.length;
                });
            });

            await Promise.all(promises);

            var timeoutResults = results.filter(function(r) { return r.latency < 0; });
            if (timeoutResults.length > 0) {
                status.textContent = '正在从服务器获取备用数据...';
                try {
                    var sd = await serverSpeedTest();
                    var serverResults = sd.results || [];
                    timeoutResults.forEach(function(tr) {
                        var found = serverResults.find(function(x) { return x.host === tr.host && x.latency >= 0; });
                        if (found) {
                            tr.latency = found.latency;
                            tr.status = found.status;
                        }
                    });
                } catch(e) {}
            }

            results.sort(function(a, b) {
                if (a.latency < 0) return 1;
                if (b.latency < 0) return -1;
                return a.latency - b.latency;
            });

            var best = results.find(function(r) { return r.latency >= 0; });
            renderDomainTable(results, best ? best.host : null);

            var okCount = results.filter(function(r) { return r.latency >= 0; }).length;
            status.textContent = '\u{2705} 测速完成 (' + okCount + '/' + OPT_DOMAINS.length + ' 可用)';
            if (best) status.textContent += ' \u{00B7} 推荐: ' + best.host;

            btn.disabled = false;
            btn.textContent = '重新测速';
        }

        loadConnectionInfo();
        loadStats();
        setInterval(loadStats, 3600000);
    </script>
</body>
</html>`;

async function initDB(env) {
    try {
        await env.DB.exec(`
            CREATE TABLE IF NOT EXISTS auto_emby_daily_stats (
                date TEXT PRIMARY KEY,
                playing_count INTEGER DEFAULT 0,
                playback_info_count INTEGER DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS aliases (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                alias TEXT UNIQUE NOT NULL,
                name TEXT DEFAULT '',
                icon TEXT DEFAULT '\u{1F3AC}',
                sort_order INTEGER DEFAULT 0,
                created_at TEXT DEFAULT (datetime('now', '+8 hours'))
            );
            CREATE TABLE IF NOT EXISTS alias_lines (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                alias_id INTEGER NOT NULL,
                target_url TEXT NOT NULL,
                line_name TEXT DEFAULT '',
                mode TEXT DEFAULT 'off',
                cache_img INTEGER DEFAULT 0,
                sort_order INTEGER DEFAULT 0,
                FOREIGN KEY (alias_id) REFERENCES aliases(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS speedtest_cache (
                cache_key TEXT PRIMARY KEY,
                best_domain TEXT,
                results TEXT,
                updated_at TEXT DEFAULT (datetime('now', '+8 hours'))
            );
        `);
        return true;
    } catch (e) {
        console.error('DB init error:', e.message);
        return false;
    }
}

function getAdminToken(request) {
    const cookie = request.headers.get('Cookie') || '';
    const match = cookie.match(/admin_token=([^;]+)/);
    return match ? decodeURIComponent(match[1]) : null;
}

function isAdmin(request, env) {
    if (!env.ADMIN_TOKEN) return true;
    const token = getAdminToken(request);
    return token && token === env.ADMIN_TOKEN;
}

function requireAdmin(request, env) {
    if (!isAdmin(request, env)) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' }
        });
    }
    return null;
}

async function testDomainLatency(domain) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    try {
        const start = Date.now();
        await fetch('https://' + domain + '/', {
            method: 'HEAD',
            signal: controller.signal,
            redirect: 'follow',
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        clearTimeout(timeoutId);
        return Date.now() - start;
    } catch (e) {
        clearTimeout(timeoutId);
        return -1;
    }
}

function getLatencyStatus(ms) {
    if (ms < 0) return 'timeout';
    if (ms < 200) return 'fast';
    if (ms < 500) return 'good';
    return 'slow';
}

async function runOptimizedDomainTest() {
    const promises = OPTIMIZED_DOMAINS.map(async (item) => {
        const host = item.subdomain + '.' + item.domain;
        const latency = await testDomainLatency(host);
        return {
            subdomain: item.subdomain,
            domain: item.domain,
            name: item.name,
            host: host,
            latency: latency,
            status: getLatencyStatus(latency)
        };
    });
    const allResults = await Promise.all(promises);
    allResults.sort((a, b) => {
        if (a.latency < 0) return 1;
        if (b.latency < 0) return -1;
        return a.latency - b.latency;
    });
    const validResults = allResults.filter(r => r.latency >= 0);
    return {
        results: allResults,
        best: validResults.length > 0 ? validResults[0].host : null,
        bestName: validResults.length > 0 ? validResults[0].name : null,
        timestamp: new Date().toISOString()
    };
}

async function getBestDomain(env, cacheKey) {
    if (!env.DB) return null;
    try {
        const cached = await env.DB.prepare(
            'SELECT * FROM speedtest_cache WHERE cache_key = ?'
        ).bind(cacheKey).first();
        if (cached) {
            const age = (Date.now() - new Date(cached.updated_at + 'Z').getTime()) / 1000;
            if (age < CONFIG.speedtestCacheTTL) {
                return JSON.parse(cached.results);
            }
        }
    } catch (e) {
        console.error('Cache read error:', e.message);
    }
    return null;
}

async function cacheTestResult(env, cacheKey, result) {
    if (!env.DB) return;
    try {
        await env.DB.prepare(
            `INSERT INTO speedtest_cache (cache_key, best_domain, results, updated_at)
             VALUES (?, ?, ?, datetime('now', '+8 hours'))
             ON CONFLICT(cache_key) DO UPDATE SET best_domain = excluded.best_domain, results = excluded.results, updated_at = excluded.updated_at`
        ).bind(cacheKey, result.best, JSON.stringify(result)).run();
    } catch (e) {
        console.error('Cache write error:', e.message);
    }
}

async function testLineLatency(targetUrl) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);
    try {
        const start = Date.now();
        const response = await fetch(targetUrl, {
            method: 'HEAD',
            signal: controller.signal,
            redirect: 'follow'
        });
        clearTimeout(timeoutId);
        return {
            latency: Date.now() - start,
            status: response.status,
            ok: response.status < 500
        };
    } catch (e) {
        clearTimeout(timeoutId);
        return { latency: -1, status: 0, ok: false };
    }
}

function jsonResponse(data, status) {
    return new Response(JSON.stringify(data), {
        status: status || 200,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*'
        }
    });
}

async function handleAdminAliases(request, env, method) {
    if (method === 'GET') {
        const result = await env.DB.prepare('SELECT * FROM aliases ORDER BY sort_order, id').all();
        return jsonResponse(result.results || []);
    }

    if (method === 'POST') {
        const body = await request.json();
        if (!body.alias || !body.name) {
            return jsonResponse({ error: 'Missing required fields' }, 400);
        }
        const existing = await env.DB.prepare('SELECT id FROM aliases WHERE alias = ?').bind(body.alias).first();
        if (existing) {
            return jsonResponse({ error: '别名已存在' }, 400);
        }
        const result = await env.DB.prepare(
            'INSERT INTO aliases (alias, name, icon, sort_order) VALUES (?, ?, ?, ?)'
        ).bind(body.alias, body.name, body.icon || '\u{1F3AC}', body.sort_order || 0).run();
        invalidateAliasCache(body.alias);
        return jsonResponse({ success: true, id: result.meta.last_row_id });
    }

    if (method === 'PUT') {
        const body = await request.json();
        if (!body.id) return jsonResponse({ error: 'Missing id' }, 400);
        const existing = await env.DB.prepare('SELECT id FROM aliases WHERE alias = ? AND id != ?').bind(body.alias, body.id).first();
        if (existing) {
            return jsonResponse({ error: '别名已被其他条目使用' }, 400);
        }
        await env.DB.prepare(
            'UPDATE aliases SET alias = ?, name = ?, icon = ?, sort_order = ? WHERE id = ?'
        ).bind(body.alias, body.name, body.icon || '\u{1F3AC}', body.sort_order || 0, body.id).run();
        invalidateAliasCache();
        return jsonResponse({ success: true });
    }

    if (method === 'DELETE') {
        const deleteUrl = new URL(request.url);
        const id = deleteUrl.searchParams.get('id');
        if (!id) return jsonResponse({ error: 'Missing id' }, 400);
        await env.DB.prepare('DELETE FROM alias_lines WHERE alias_id = ?').bind(id).run();
        await env.DB.prepare('DELETE FROM aliases WHERE id = ?').bind(id).run();
        invalidateAliasCache();
        return jsonResponse({ success: true });
    }

    return jsonResponse({ error: 'Method not allowed' }, 405);
}

async function handleAdminLines(request, env, method, url) {
    if (method === 'GET') {
        const aliasId = url.searchParams.get('alias_id');
        if (!aliasId) return jsonResponse({ error: 'Missing alias_id' }, 400);
        const result = await env.DB.prepare(
            'SELECT * FROM alias_lines WHERE alias_id = ? ORDER BY sort_order, id'
        ).bind(aliasId).all();
        return jsonResponse(result.results || []);
    }

    if (method === 'POST') {
        const body = await request.json();
        if (!body.alias_id || !body.target_url || !body.line_name) {
            return jsonResponse({ error: 'Missing required fields' }, 400);
        }
        const result = await env.DB.prepare(
            'INSERT INTO alias_lines (alias_id, target_url, line_name, mode, cache_img, sort_order) VALUES (?, ?, ?, ?, ?, ?)'
        ).bind(body.alias_id, body.target_url, body.line_name, body.mode || 'off', body.cache_img ? 1 : 0, body.sort_order || 0).run();
        invalidateAliasCache();
        return jsonResponse({ success: true, id: result.meta.last_row_id });
    }

    if (method === 'PUT') {
        const body = await request.json();
        if (!body.id) return jsonResponse({ error: 'Missing id' }, 400);
        await env.DB.prepare(
            'UPDATE alias_lines SET target_url = ?, line_name = ?, mode = ?, cache_img = ?, sort_order = ? WHERE id = ?'
        ).bind(body.target_url, body.line_name, body.mode || 'off', body.cache_img ? 1 : 0, body.sort_order || 0, body.id).run();
        invalidateAliasCache();
        return jsonResponse({ success: true });
    }

    if (method === 'DELETE') {
        const id = url.searchParams.get('id');
        if (!id) return jsonResponse({ error: 'Missing id' }, 400);
        await env.DB.prepare('DELETE FROM alias_lines WHERE id = ?').bind(id).run();
        invalidateAliasCache();
        return jsonResponse({ success: true });
    }

    return jsonResponse({ error: 'Method not allowed' }, 405);
}

var _iconsCache = null;
var _iconsCacheTime = 0;

async function handleAdminIcons(request, env, url) {
    const now = Date.now();
    if (_iconsCache && (now - _iconsCacheTime) < 3600000) {
        return jsonResponse(_iconsCache);
    }
    try {
        const resp = await fetch('https://raw.githubusercontent.com/lige47/QuanX-icon-rule/refs/heads/main/lige-emby-icon.json');
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const data = await resp.json();
        _iconsCache = { icons: data.icons || [], name: data.name || '', description: data.description || '' };
        _iconsCacheTime = now;
        return jsonResponse(_iconsCache);
    } catch(e) {
        if (_iconsCache) return jsonResponse(_iconsCache);
        return jsonResponse({ icons: [], error: e.message }, 500);
    }
}

async function handleLineSpeedTest(request, env, url) {
    const aliasId = url.searchParams.get('alias_id');
    if (!aliasId) return jsonResponse({ error: 'Missing alias_id' }, 400);

    const lines = await env.DB.prepare(
        'SELECT * FROM alias_lines WHERE alias_id = ? ORDER BY sort_order, id'
    ).bind(aliasId).all();

    if (!lines.results || lines.results.length === 0) {
        return jsonResponse({ error: 'No lines found' }, 404);
    }

    const results = [];
    for (const line of lines.results) {
        const testResult = await testLineLatency(line.target_url);
        results.push({
            id: line.id,
            line_name: line.line_name,
            target_url: line.target_url,
            latency: testResult.latency,
            status: testResult.status,
            ok: testResult.ok
        });
    }

    results.sort((a, b) => {
        if (a.latency < 0) return 1;
        if (b.latency < 0) return -1;
        return a.latency - b.latency;
    });

    return jsonResponse({ results: results, best: results.length > 0 && results[0].latency >= 0 ? results[0].id : null });
}

async function handleDomainSpeedTest(request, env) {
    const result = await runOptimizedDomainTest();
    const cf = request.cf || {};
    const cacheKey = getCacheKey(cf);
    if (cacheKey && env.DB) {
        await cacheTestResult(env, cacheKey, result);
    }
    result.cacheKey = cacheKey;
    result.region = cf.region || '';
    result.isp = getISPName(cf);
    return jsonResponse(result);
}

async function handleAdminRequest(request, env, url) {
    const path = url.pathname;
    const method = request.method;

    const authErr = requireAdmin(request, env);
    if (authErr) return authErr;

    if (!env.DB) {
        return jsonResponse({ error: 'D1 数据库未绑定，请在 Worker 设置中绑定 DB' }, 500);
    }

    if (path === '/admin/api/aliases') {
        return handleAdminAliases(request, env, method);
    }
    if (path === '/admin/api/lines') {
        return handleAdminLines(request, env, method, url);
    }
    if (path === '/admin/api/speedtest/lines') {
        return handleLineSpeedTest(request, env, url);
    }
    if (path === '/admin/api/speedtest/domains') {
        return handleDomainSpeedTest(request, env);
    }
    if (path === '/admin/api/icons') {
        return handleAdminIcons(request, env, url);
    }

    return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
    });
}

async function handleConnectionInfo(request) {
    const cf = request.cf || {};
    return new Response(JSON.stringify({
        colo: cf.colo || 'Unknown',
        country: cf.country || 'Unknown',
        region: cf.region || '',
        city: cf.city || '',
        isp: cf.asOrganization || '',
        asn: cf.asn || '',
        timezone: cf.timezone || '',
        host: request.headers.get('host') || ''
    }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
}

function getCacheKey(cf) {
    if (!cf || cf.country !== 'CN') return null;
    const region = cf.region || 'Unknown';
    const asn = cf.asn || '0';
    return 'CN-' + region + '-' + asn;
}

function getISPName(cf) {
    return cf.asOrganization || 'Unknown';
}

async function handleBestDomain(request, env) {
    const cf = request.cf || {};
    const cacheKey = getCacheKey(cf);
    if (!cacheKey) {
        return new Response(JSON.stringify({
            cached: false,
            best: null,
            bestName: null,
            cacheKey: null,
            message: '非中国用户不适用智能选线'
        }), {
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
    }
    let cached = await getBestDomain(env, cacheKey);
    if (cached) {
        return new Response(JSON.stringify({
            cached: true,
            best: cached.best,
            bestName: cached.bestName,
            cacheKey: cacheKey,
            region: cf.region || '',
            isp: getISPName(cf),
            timestamp: cached.timestamp
        }), {
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
    }
    const result = await runOptimizedDomainTest();
    await cacheTestResult(env, cacheKey, result);
    return new Response(JSON.stringify({
        cached: false,
        best: result.best,
        bestName: result.bestName,
        cacheKey: cacheKey,
        region: cf.region || '',
        isp: getISPName(cf),
        timestamp: result.timestamp
    }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
}

async function recordStats(env, type) {
    try {
        const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
        if (!env.DB) return;
        let query = '';
        let params = [];
        if (type === 'playing') {
            query = `INSERT INTO auto_emby_daily_stats (date, playing_count, playback_info_count) VALUES (?, 1, 0) ON CONFLICT(date) DO UPDATE SET playing_count = playing_count + 1`;
            params = [today];
        } else if (type === 'playback_info') {
            query = `INSERT INTO auto_emby_daily_stats (date, playing_count, playback_info_count) VALUES (?, 0, 1) ON CONFLICT(date) DO UPDATE SET playback_info_count = playback_info_count + 1`;
            params = [today];
        }
        if (query) await env.DB.prepare(query).bind(...params).run();
    } catch (e) {
        console.error('Stats record error:', e);
    }
}

async function handleStatsRequest(env) {
    try {
        if (!env.DB) {
            return new Response(JSON.stringify({ error: 'D1 database not bound', data: null }), {
                headers: { 'Content-Type': 'application/json; charset=utf-8' }
            });
        }
        const statsResult = await env.DB.prepare(
            `SELECT date, playing_count, playback_info_count FROM auto_emby_daily_stats WHERE date >= date('now', '-30 days') ORDER BY date DESC`
        ).all();
        const totalResult = await env.DB.prepare(
            `SELECT SUM(playing_count) as total_playing, SUM(playback_info_count) as total_playback_info FROM auto_emby_daily_stats WHERE date >= date('now', '-30 days')`
        ).first();
        return new Response(JSON.stringify({
            error: null,
            data: {
                total: {
                    playing: totalResult?.total_playing || 0,
                    playbackInfo: totalResult?.total_playback_info || 0
                },
                dailyStats: statsResult?.results || [],
                lastUpdated: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
            }
        }), {
            headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
        });
    } catch (e) {
        return new Response(JSON.stringify({ error: 'Stats error: ' + e.message, data: null }), {
            status: 500,
            headers: { 'Content-Type': 'application/json; charset=utf-8' }
        });
    }
}

function isIPAllowed(ip, env) {
    if (!ip) return false;
    if (!env.ALLOWED_IPS) return true;
    const allowedIPs = env.ALLOWED_IPS.split(',').map(ip => ip.trim()).filter(ip => ip);
    if (allowedIPs.length === 0) return true;
    return allowedIPs.some(allowed => {
        if (allowed.includes('/')) {
            return isIPInCIDR(ip, allowed);
        }
        return ip === allowed;
    });
}

function isIPInCIDR(ip, cidr) {
    try {
        const [range, bits] = cidr.split('/');
        const mask = ~(2 ** (32 - parseInt(bits)) - 1);
        const ipNum = ipToNum(ip);
        const rangeNum = ipToNum(range);
        return (ipNum & mask) === (rangeNum & mask);
    } catch {
        return false;
    }
}

function ipToNum(ip) {
    return ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet), 0) >>> 0;
}

async function proxyToTarget(request, upstreamUrl, mode, env, preReadBody) {
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader && upgradeHeader.toLowerCase() === 'websocket') {
        return fetch(upstreamUrl.toString(), request);
    }

    const upstreamRequestHeaders = new Headers(request.headers);
    upstreamRequestHeaders.set('Host', upstreamUrl.host);
    upstreamRequestHeaders.delete('Referer');

    const clientIp = request.headers.get('cf-connecting-ip');
    if (clientIp) {
        upstreamRequestHeaders.set('x-forwarded-for', clientIp);
        upstreamRequestHeaders.set('x-real-ip', clientIp);
    }

    if (mode === 'dual') {
        const realIP = request.headers.get('x-real-ip') || request.headers.get('x-forwarded-for') || request.headers.get('cf-connecting-ip');
        if (!isIPAllowed(realIP, env)) {
            upstreamRequestHeaders.delete('x-real-ip');
            upstreamRequestHeaders.delete('x-forwarded-for');
        }
    }

    let requestBody = request.body;
    if (preReadBody !== undefined && preReadBody !== null) {
        requestBody = preReadBody;
    } else if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) {
        const ct = (request.headers.get('content-type') || '').toLowerCase();
        if (ct.includes('application/json')) {
            requestBody = JSON.stringify(await request.json());
        } else if (ct.includes('application/text') || ct.includes('text/html')) {
            requestBody = await request.text();
        } else if (ct.includes('form')) {
            requestBody = await request.formData();
        } else {
            requestBody = await request.blob();
        }
    }

    const upstreamRequest = new Request(upstreamUrl.toString(), {
        method: request.method,
        headers: upstreamRequestHeaders,
        body: requestBody,
        redirect: 'manual'
    });

    const upstreamResponse = await fetch(upstreamRequest);

    const location = upstreamResponse.headers.get('Location');
    if (location && upstreamResponse.status >= 300 && upstreamResponse.status < 400) {
        try {
            const redirectUrl = new URL(location, upstreamUrl);
            if (redirectUrl.hostname === upstreamUrl.hostname) {
                return fetch(redirectUrl.toString(), upstreamRequest);
            }
            if (MANUAL_REDIRECT_DOMAINS.some(domain => redirectUrl.hostname.endsWith(domain))) {
                const responseHeaders = new Headers(upstreamResponse.headers);
                responseHeaders.set('Location', redirectUrl.toString());
                return new Response(upstreamResponse.body, {
                    status: upstreamResponse.status,
                    statusText: upstreamResponse.statusText,
                    headers: responseHeaders
                });
            }
            const followHeaders = new Headers(upstreamRequestHeaders);
            followHeaders.set('Host', redirectUrl.host);
            return fetch(redirectUrl.toString(), {
                method: request.method,
                headers: followHeaders,
                body: requestBody,
                redirect: 'follow'
            });
        } catch (e) {
            return upstreamResponse;
        }
    }

    const responseHeaders = new Headers(upstreamResponse.headers);

    const contentType = upstreamResponse.headers.get('content-type');
    if (contentType && CONFIG.cacheEnabled) {
        if (contentType.includes('image/') || contentType.includes('text/css') ||
            contentType.includes('application/javascript') || contentType.includes('font/')) {
            responseHeaders.set('Cache-Control', 'public, max-age=86400');
        } else if (contentType.includes('video/') || contentType.includes('audio/')) {
            responseHeaders.set('Cache-Control', 'public, max-age=3600');
        } else {
            responseHeaders.set('Cache-Control', 'no-cache, no-store, must-revalidate');
        }
    }

    responseHeaders.set('Access-Control-Allow-Origin', '*');
    responseHeaders.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    responseHeaders.set('Access-Control-Allow-Headers', '*');
    responseHeaders.set('X-Content-Type-Options', 'nosniff');
    responseHeaders.set('X-Frame-Options', 'DENY');
    responseHeaders.set('X-XSS-Protection', '1; mode=block');
    responseHeaders.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    responseHeaders.delete('Content-Security-Policy');

    return new Response(upstreamResponse.body, {
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText,
        headers: responseHeaders
    });
}

async function handleAliasProxy(request, env, ctx, url, aliasPath) {
    if (!env.DB) {
        return new Response('Database not available', { status: 500 });
    }

    const config = await getAliasConfig(env, aliasPath);
    if (!config || !config.alias) {
        return new Response('Alias not found: ' + aliasPath, { status: 404 });
    }

    const { alias, lines } = config;

    if (!lines || lines.length === 0) {
        return new Response('No lines configured for alias: ' + aliasPath, { status: 502 });
    }

    const aliasPrefix = '/' + aliasPath;
    const remainingPath = url.pathname.substring(aliasPrefix.length) || '/';
    const targetSearch = url.search;

    let preReadBody = null;
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) {
        preReadBody = await readRequestBody(request);
    }

    let lastError = null;

    for (const line of lines) {
        try {
            const targetBase = line.target_url.replace(/\/+$/, '');
            const targetPath = remainingPath + targetSearch;
            const upstreamUrl = new URL(targetPath, targetBase);

            if (upstreamUrl.pathname.endsWith('/Sessions/Playing')) {
                ctx.waitUntil(recordStats(env, 'playing'));
            } else if (upstreamUrl.pathname.includes('/PlaybackInfo')) {
                ctx.waitUntil(recordStats(env, 'playback_info'));
            }

            const response = await proxyToTarget(request, upstreamUrl, line.mode, env, preReadBody);
            if (response.status < 500) {
                return response;
            }
            lastError = response;
        } catch (e) {
            lastError = e;
            continue;
        }
    }

    if (lastError instanceof Response) return lastError;
    return new Response('All lines failed for alias: ' + aliasPath, { status: 502 });
}

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const path = url.pathname;

        if (request.method === 'OPTIONS') {
            return new Response(null, PREFLIGHT_INIT);
        }

        if (env.DB && !_dbInitialized) {
            ctx.waitUntil(initDB(env).then(() => { _dbInitialized = true; }));
        }

        if (path === '/health') {
            return new Response(JSON.stringify({
                status: 'ok',
                timestamp: new Date().toISOString(),
                region: request.cf?.colo
            }), { headers: { 'Content-Type': 'application/json' } });
        }

        if (path === '/stats') {
            return handleStatsRequest(env);
        }

        if (path === '/api/connection-info') {
            return handleConnectionInfo(request);
        }

        if (path === '/api/best-domain') {
            return handleBestDomain(request, env);
        }

        if (path === '/api/speedtest/domains' && request.method === 'POST') {
            return handleDomainSpeedTest(request, env);
        }

        if (path === '/') {
            return new Response(FRONTEND_HTML, {
                headers: { 'Content-Type': 'text/html; charset=utf-8' }
            });
        }

        if (path === '/favicon.ico') {
            return new Response('', { headers: { 'Content-Type': 'image/x-icon' } });
        }

        if (path.startsWith('/cdn-cgi/')) {
            return new Response('Not Found', { status: 404 });
        }

        if (path === '/admin') {
            if (!isAdmin(request, env)) {
                return new Response(LOGIN_UI, {
                    headers: { 'Content-Type': 'text/html; charset=utf-8' }
                });
            }
            return new Response(ADMIN_UI, {
                headers: { 'Content-Type': 'text/html; charset=utf-8' }
            });
        }

        if (path === '/admin/api/verify') {
            const noToken = !env.ADMIN_TOKEN;
            if (noToken) {
                return new Response(JSON.stringify({ ok: true, noToken: true }), {
                    headers: { 'Content-Type': 'application/json' }
                });
            }
            if (isAdmin(request, env)) {
                return new Response(JSON.stringify({ ok: true }), {
                    headers: { 'Content-Type': 'application/json' }
                });
            }
            return new Response(JSON.stringify({ ok: false, error: '密钥错误' }), {
                status: 401,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        if (path.startsWith('/admin/api/')) {
            try {
                return await handleAdminRequest(request, env, url);
            } catch (e) {
                return new Response(JSON.stringify({ error: 'Server error: ' + e.message }), {
                    status: 500,
                    headers: { 'Content-Type': 'application/json; charset=utf-8' }
                });
            }
        }

        const pathSegments = path.split('/').filter(Boolean);
        if (pathSegments.length > 0) {
            const firstSegment = pathSegments[0];
            const looksLikeUrl = firstSegment.includes(':') || firstSegment.startsWith('http');

            if (!looksLikeUrl && env.DB) {
                try {
                    const cached = await getAliasConfig(env, firstSegment);
                    if (cached && cached.alias) {
                        return handleAliasProxy(request, env, ctx, url, firstSegment);
                    }
                } catch (e) {
                    // cache/DB error, fall through to normal proxy
                }
            }
        }

        let upstreamUrl;
        try {
            let pathStr = url.pathname.substring(1);

            if (pathStr.startsWith('/')) {
                return new Response('Invalid proxy format.', { status: 400 });
            }

            if (pathStr === 'Sessions/Playing' || pathStr.startsWith('Sessions/Playing/') || pathStr === 'PlaybackInfo' || pathStr.startsWith('PlaybackInfo/')) {
                return new Response('Invalid proxy format.', { status: 400 });
            }

            pathStr = pathStr.replace(/^(https?)\/(?!\/)/, '$1://');
            if (!pathStr.startsWith('http')) {
                pathStr = 'https://' + pathStr;
            }
            upstreamUrl = new URL(pathStr);
            upstreamUrl.search = url.search;

            const hostname = upstreamUrl.hostname;
            if (!hostname || hostname === 'Sessions' || hostname === 'PlaybackInfo') {
                return new Response('Invalid proxy format.', { status: 400 });
            }

            if (PIKPAK_DOMAINS.some(domain => hostname.endsWith(domain))) {
                const redirectUrl = new URL(upstreamUrl.pathname + upstreamUrl.search, CONFIG.pikpakProxyUrl);
                return Response.redirect(redirectUrl.toString(), 301);
            }

            if (blocker.check(upstreamUrl.toString())) {
                return Response.redirect('https://baidu.com', 301);
            }
        } catch (e) {
            return new Response('Invalid URL format.', { status: 400 });
        }

        const currentEdgeColo = request.cf?.colo;
        if (currentEdgeColo && JP_COLOS.includes(currentEdgeColo)) {
            const originalHost = upstreamUrl.host;
            for (const domainSuffix in DOMAIN_PROXY_RULES) {
                if (originalHost.endsWith(domainSuffix)) {
                    upstreamUrl.hostname = DOMAIN_PROXY_RULES[domainSuffix];
                    break;
                }
            }
        }

        if (upstreamUrl.pathname.endsWith('/Sessions/Playing')) {
            ctx.waitUntil(recordStats(env, 'playing'));
        } else if (upstreamUrl.pathname.includes('/PlaybackInfo')) {
            ctx.waitUntil(recordStats(env, 'playback_info'));
        }

        return proxyToTarget(request, upstreamUrl, 'off', env);
    }
};
