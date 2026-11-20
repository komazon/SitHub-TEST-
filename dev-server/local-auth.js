// ScratchAuth (https://auth.itinerary.eu.org/) と OAuth 2.0 (認可コード + PKCE) によるログイン。
// 成功すると local-api と同じセッションCookieを発行する。
//   /auth/                          ログイン方法の選択ページ
//   /auth/scratchauth/start|callback
//   /auth/oauth/:provider/start|callback
// OAuth の設定: 環境変数 または dev-server/local-data/oauth.json
//   環境変数: OAUTH_GITHUB_CLIENT_ID / OAUTH_GITHUB_CLIENT_SECRET, OAUTH_GOOGLE_CLIENT_ID / OAUTH_GOOGLE_CLIENT_SECRET
//   独自プロバイダ(oauth.json の providers.<名前>): authUrl, tokenUrl, userinfoUrl, scope, clientId, clientSecret, idField, usernameField, label
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {load, save, startSession, findOrCreateExternalUser} = require('./local-api');

const SA_BASE = process.env.SCRATCHAUTH_BASE || 'https://auth.itinerary.eu.org';
const APP_NAME = process.env.SCRATCHAUTH_APP_NAME || 'Scratch www (local)';
const CONFIG_FILE = path.join(__dirname, 'local-data', 'oauth.json');

const BUILTIN = {
    github: {
        label: 'GitHub',
        authUrl: 'https://github.com/login/oauth/authorize',
        tokenUrl: 'https://github.com/login/oauth/access_token',
        userinfoUrl: 'https://api.github.com/user',
        scope: 'read:user',
        idField: 'id',
        usernameField: 'login'
    },
    google: {
        label: 'Google',
        authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
        tokenUrl: 'https://oauth2.googleapis.com/token',
        userinfoUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
        scope: 'openid email profile',
        idField: 'sub',
        usernameField: 'name'
    }
};

const providers = () => {
    let file = {};
    try {
        file = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')).providers || {};
    } catch (e) { /* 設定ファイルなし */ }
    const out = {};
    const names = new Set([...Object.keys(BUILTIN), ...Object.keys(file)]);
    names.forEach(name => {
        const env = name.toUpperCase().replace(/[^A-Z0-9]/g, '_');
        const cfg = Object.assign({}, BUILTIN[name], file[name]);
        cfg.clientId = (file[name] && file[name].clientId) || process.env[`OAUTH_${env}_CLIENT_ID`];
        cfg.clientSecret = (file[name] && file[name].clientSecret) || process.env[`OAUTH_${env}_CLIENT_SECRET`];
        if (cfg.clientId && cfg.authUrl && cfg.tokenUrl && cfg.userinfoUrl) {
            cfg.label = cfg.label || name;
            out[name] = cfg;
        }
    });
    return out;
};

const esc = s => String(s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;'}[c]));
const origin = req => `${req.protocol}://${req.get('host')}`;
const b64url = buf => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const page = (title, body) => `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${esc(title)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:sans-serif;background:#f9f9f9;display:flex;justify-content:center;padding:48px 16px}
.card{background:#fff;border-radius:12px;box-shadow:0 2px 8px #0002;padding:32px;max-width:420px;width:100%}
h1{font-size:22px;color:#575e75;margin-top:0}a.btn{display:block;text-align:center;margin:12px 0;padding:12px;border-radius:8px;
background:#855cd6;color:#fff;text-decoration:none;font-weight:bold}a.btn.sub{background:#4d97ff}small{color:#777}</style></head>
<body><div class="card"><h1>${esc(title)}</h1>${body}</div></body></html>`;

// state / PKCE の保持 (10分)
const pending = new Map();
const remember = (key, value) => {
    pending.set(key, Object.assign({exp: Date.now() + 600000}, value));
    pending.forEach((v, k) => v.exp < Date.now() && pending.delete(k));
};
const take = key => {
    const v = pending.get(key);
    pending.delete(key);
    return v && v.exp >= Date.now() ? v : null;
};

const attach = app => {
    app.get('/auth/', (req, res) => {
        const list = providers();
        const oauth = Object.keys(list).map(n =>
            `<a class="btn sub" href="/auth/oauth/${encodeURIComponent(n)}/start">${esc(list[n].label)} でログイン (OAuth 2.0)</a>`
        ).join('');
        res.send(page('ログイン', `
            <a class="btn" href="/auth/scratchauth/start">ScratchAuth でログイン</a>
            ${oauth || '<small>OAuth プロバイダ未設定: 環境変数 OAUTH_GITHUB_CLIENT_ID / OAUTH_GITHUB_CLIENT_SECRET などか dev-server/local-data/oauth.json を設定してください。</small>'}
            <p><small>ユーザー名とパスワードでのログインは <a href="/">トップページ</a> の「サインイン」から。</small></p>`));
    });

    // ---- ScratchAuth ----
    app.get('/auth/scratchauth/start', (req, res) => {
        const redirect = `${origin(req)}/auth/scratchauth/callback`;
        const url = `${SA_BASE}/auth/?redirect=${encodeURIComponent(Buffer.from(redirect).toString('base64'))}` +
            `&name=${encodeURIComponent(APP_NAME)}`;
        res.redirect(url);
    });
    app.get('/auth/scratchauth/callback', async (req, res) => {
        const code = String(req.query.privateCode || '');
        if (!code) return res.status(400).send(page('ScratchAuth 失敗', '<p>privateCode がありません。</p><a class="btn" href="/auth/">戻る</a>'));
        try {
            const r = await fetch(`${SA_BASE}/api/auth/verifyToken?privateCode=${encodeURIComponent(code)}`, {
                signal: AbortSignal.timeout(10000)
            });
            const body = await r.json();
            const expected = `${origin(req)}/auth/scratchauth/callback`;
            if (!body.valid || !body.username) throw new Error('認証が無効です');
            // 別アプリ向けに発行されたコードの流用を防ぐ
            if (body.redirect && body.redirect !== expected) throw new Error('リダイレクト先が一致しません');
            const db = load();
            const user = findOrCreateExternalUser(db, `scratchauth:${String(body.username).toLowerCase()}`, body.username);
            startSession(res, db, user);
            res.redirect('/');
        } catch (e) {
            res.status(401).send(page('ScratchAuth 失敗', `<p>${esc(e.message || e)}</p><a class="btn" href="/auth/">戻る</a>`));
        }
    });

    // ---- OAuth 2.0 (Authorization Code + PKCE) ----
    app.get('/auth/oauth/:provider/start', (req, res) => {
        const cfg = providers()[req.params.provider];
        if (!cfg) return res.status(404).send(page('OAuth', '<p>このプロバイダは設定されていません。</p><a class="btn" href="/auth/">戻る</a>'));
        const state = b64url(crypto.randomBytes(24));
        const verifier = b64url(crypto.randomBytes(32));
        const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
        remember(state, {provider: req.params.provider, verifier});
        const params = new URLSearchParams({
            response_type: 'code',
            client_id: cfg.clientId,
            redirect_uri: `${origin(req)}/auth/oauth/${req.params.provider}/callback`,
            scope: cfg.scope || '',
            state,
            code_challenge: challenge,
            code_challenge_method: 'S256'
        });
        res.redirect(`${cfg.authUrl}${cfg.authUrl.includes('?') ? '&' : '?'}${params}`);
    });
    app.get('/auth/oauth/:provider/callback', async (req, res) => {
        const fail = msg => res.status(401).send(page('OAuth 失敗', `<p>${esc(msg)}</p><a class="btn" href="/auth/">戻る</a>`));
        try {
            const cfg = providers()[req.params.provider];
            const saved = take(String(req.query.state || ''));
            if (!cfg || !saved || saved.provider !== req.params.provider) return fail('state が無効か期限切れです');
            if (req.query.error) return fail(`プロバイダからエラー: ${req.query.error}`);
            const tokenRes = await fetch(cfg.tokenUrl, {
                method: 'POST',
                headers: {'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json'},
                body: new URLSearchParams({
                    grant_type: 'authorization_code',
                    code: String(req.query.code || ''),
                    redirect_uri: `${origin(req)}/auth/oauth/${req.params.provider}/callback`,
                    client_id: cfg.clientId,
                    client_secret: cfg.clientSecret || '',
                    code_verifier: saved.verifier
                }),
                signal: AbortSignal.timeout(10000)
            });
            const token = await tokenRes.json();
            if (!token.access_token) return fail('アクセストークンを取得できませんでした');
            const infoRes = await fetch(cfg.userinfoUrl, {
                headers: {Authorization: `Bearer ${token.access_token}`, Accept: 'application/json', 'User-Agent': 'scratch-www-local'},
                signal: AbortSignal.timeout(10000)
            });
            const info = await infoRes.json();
            const sub = info[cfg.idField || 'id'] || info.sub || info.id;
            if (!sub) return fail('ユーザー情報にIDが含まれていません');
            const wanted = info[cfg.usernameField || 'login'] || (info.email || '').split('@')[0] || `${req.params.provider}-user`;
            const db = load();
            const user = findOrCreateExternalUser(db, `${req.params.provider}:${sub}`, wanted, info.email);
            startSession(res, db, user);
            res.redirect('/');
        } catch (e) {
            fail(e.message || String(e));
        }
    });
};

module.exports = {attach};
