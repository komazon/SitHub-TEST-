// ローカル開発用の簡易バックエンド。
// - scratchr2 側 (/session/, /accounts/*, /csrf_token/) をローカルで再現(アカウントは dev-server/local-data/accounts.json に保存)
// - API_HOST=/scratch-api 配下は、認証系だけローカル応答し、残りは https://api.scratch.mit.edu へ転送(CORS回避)
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const proxy = require('express-http-proxy');

const DATA_DIR = path.join(__dirname, 'local-data');
const FILE = path.join(DATA_DIR, 'accounts.json');
const COOKIE = 'local_session';
const REMOTE_API = process.env.REMOTE_API_HOST || 'https://api.scratch.mit.edu';

const load = () => {
    try {
        return JSON.parse(fs.readFileSync(FILE, 'utf8'));
    } catch (e) {
        return {users: {}, sessions: {}, nextId: 1000};
    }
};
const save = db => {
    fs.mkdirSync(DATA_DIR, {recursive: true});
    fs.writeFileSync(FILE, JSON.stringify(db, null, 2));
};
const hash = (password, salt) => crypto.scryptSync(String(password), salt, 32).toString('hex');
const readCookie = (req, name) => {
    const m = (req.headers.cookie || '').split(/;\s*/).find(c => c.startsWith(`${name}=`));
    return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
};
const currentUser = req => {
    const token = readCookie(req, COOKIE);
    if (!token) return null;
    const db = load();
    const username = db.sessions[token];
    return username && db.users[username.toLowerCase()] ? db.users[username.toLowerCase()] : null;
};
const startSession = (res, db, user) => {
    const token = crypto.randomBytes(24).toString('hex');
    db.sessions[token] = user.username;
    save(db);
    res.append('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}`);
};
const permissions = {
    admin: false, scratcher: true, new_scratcher: false, invited_scratcher: false,
    social: true, educator: false, educator_invitee: false, student: false, mute_status: {}
};
const flags = {
    must_complete_registration: false, must_reset_password: false,
    project_comments_enabled: true, gallery_comments_enabled: true,
    userId: 0, everything_is_totally_normal: true
};
const sessionBody = user => {
    if (!user) return {permissions, flags};
    return {
        user: {
            id: user.id, banned: false, username: user.username, token: `local-token-${user.id}`,
            thumbnailUrl: '//uploads.scratch.mit.edu/get_image/user/default_60x60.png',
            dateJoined: user.dateJoined, email: user.email || '', birthYear: null, birthMonth: null,
            gender: null, classroomId: null
        },
        permissions,
        flags: Object.assign({}, flags, {userId: user.id})
    };
};
const validName = name => /^[\w-]{3,20}$/.test(name || '');

const checkUsername = (req, res) => {
    const name = req.params.username;
    const exists = !!load().users[String(name).toLowerCase()];
    let msg = 'valid username';
    if (!validName(name)) msg = 'invalid username';
    else if (exists) msg = 'username exists';
    res.json([{msg, username: name}]);
};
const checkPassword = (req, res) => {
    const pw = req.body && req.body.password;
    res.json({msg: pw && String(pw).toLowerCase() !== 'password' ? 'valid password' : 'invalid password'});
};
const checkEmail = (req, res) => {
    const ok = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(req.query.email || '');
    res.json([{msg: ok ? 'valid email' : 'Enter a valid email address.'}]);
};

const attach = app => {
    const json = express.json({limit: '2mb'});
    const form = express.urlencoded({extended: false, limit: '2mb'});
    const root = express.Router();
    root.use(json, form);

    root.get('/session/', (req, res) => {
        res.set('Cache-Control', 'no-store');
        res.json(sessionBody(currentUser(req)));
    });
    root.get('/csrf_token/', (req, res) => {
        res.append('Set-Cookie', 'scratchcsrftoken=local-csrf-token; Path=/; SameSite=Lax');
        res.send('');
    });
    root.get('/accounts/check_email/', checkEmail);
    root.get('/accounts/consent_status/', (req, res) => {
        res.json({under_consent_age: false, requires_external_verification: false});
    });
    root.post('/accounts/register_new_user/', (req, res) => {
        const b = req.body || {};
        const db = load();
        const errors = {};
        if (!validName(b.username)) errors.username = ['Enter a valid username (3-20 characters: letters, numbers, - and _).'];
        else if (db.users[b.username.toLowerCase()]) errors.username = ['A user with that username already exists.'];
        if (!b.password || String(b.password).length < 6) errors.password = ['Password must be at least 6 characters.'];
        if (Object.keys(errors).length) {
            return res.json([{success: false, msg: 'Please correct the errors.', errors}]);
        }
        const salt = crypto.randomBytes(16).toString('hex');
        const user = {
            id: db.nextId++, username: b.username, email: b.email || '', salt,
            hash: hash(b.password, salt), dateJoined: new Date().toISOString()
        };
        db.users[b.username.toLowerCase()] = user;
        startSession(res, db, user);
        res.json([{success: true, username: user.username, logged_in: true, msg: '', redirect: '/'}]);
    });
    root.post('/accounts/login/', (req, res) => {
        const b = req.body || {};
        const db = load();
        const user = db.users[String(b.username || '').toLowerCase()];
        if (!user || !user.hash || hash(b.password, user.salt) !== user.hash) {
            return res.json([{success: false, msg: 'Incorrect username or password.', num_tries: 1}]);
        }
        startSession(res, db, user);
        res.json([{success: true, username: user.username, num_tries: 1, redirect: '/', messages: []}]);
    });
    root.post('/accounts/logout/', (req, res) => {
        const token = readCookie(req, COOKIE);
        if (token) {
            const db = load();
            delete db.sessions[token];
            save(db);
        }
        res.append('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; Max-Age=0`);
        res.redirect('/');
    });
    app.use(root);

    // API_HOST=/scratch-api : 認証系はローカル、その他は本家APIへ転送
    const api = express.Router();
    api.use(json);
    api.get('/accounts/checkusername/:username/', checkUsername);
    api.post('/accounts/checkpassword', checkPassword);
    api.get('/users/:username/messages/count', (req, res) => res.json({count: 0}));
    api.use(proxy(REMOTE_API, {
        timeout: 15000,
        proxyReqOptDecorator: opts => {
            delete opts.headers.cookie;
            delete opts.headers.origin;
            delete opts.headers.referer;
            return opts;
        },
        proxyErrorHandler: (err, res) => {
            res.status(502).json({code: 'ProxyError', message: String(err && err.message || err)});
        }
    }));
    app.use('/scratch-api', api);
};

const findOrCreateExternalUser = (db, identity, wantedName, email) => {
    // identity 例: "scratchauth:Name" / "github:12345"
    const linked = Object.values(db.users).find(u => u.identities && u.identities.includes(identity));
    if (linked) return linked;
    let base = String(wantedName || 'user').replace(/[^\w-]/g, '-').slice(0, 20);
    if (base.length < 3) base = `${base}user`.slice(0, 20);
    let name = base;
    let n = 1;
    while (db.users[name.toLowerCase()]) {
        const suffix = `-${n++}`;
        name = base.slice(0, 20 - suffix.length) + suffix;
    }
    const user = {
        id: db.nextId++, username: name, email: email || '', salt: '', hash: '',
        dateJoined: new Date().toISOString(), identities: [identity]
    };
    db.users[name.toLowerCase()] = user;
    return user;
};

module.exports = {attach, load, save, startSession, findOrCreateExternalUser};
