'use strict';
// SitHub: self-hosted API and moderation layer for SitHub-TEST.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);
const JSZip = require('../vendor/sit/node_modules/jszip');
const localAuth = require('../dev-server/local-auth');
const DATA = path.resolve(process.env.SITHUB_DATA_DIR || path.join(__dirname, 'data'));
const REPOS = path.join(DATA, 'repos');
const COOKIE = 'sithub_session';
const SESSION_DAYS = 14;
const authAttempts = new Map();
function authRateLimited(req) {
  const key = req.ip || req.socket?.remoteAddress || 'unknown', nowMs = Date.now();
  const row = authAttempts.get(key) || { count: 0, resetAt: nowMs + 15 * 60 * 1000 };
  if (row.resetAt <= nowMs) { row.count = 0; row.resetAt = nowMs + 15 * 60 * 1000; }
  row.count += 1; authAttempts.set(key, row);
  return row.count > 12;
}
const MAX_BODY = 30 * 1024 * 1024;
const SCRATCH_PROJECT_HOST = (process.env.PROJECT_HOST || 'https://projects.scratch.mit.edu').replace(/\/+$/, '');
const now = () => new Date().toISOString();
const id = (n = 16) => crypto.randomBytes(n).toString('hex');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const safeName = value => String(value || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 39);
const usernameOk = value => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/.test(String(value || ''));
const cookieSecure = () => process.env.NODE_ENV === 'production';
const cookieFlags = `Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${cookieSecure() ? '; Secure' : ''}`;

async function readJson(file, fallback) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}
async function writeJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${id(4)}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await fsp.rename(tmp, file);
}
async function init() {
  await fsp.mkdir(REPOS, { recursive: true });
  for (const [name, seed] of Object.entries({
    users: {}, sessions: {}, repos: {}, issues: {}, pulls: {}, comments: {},
    moderation: { version: 1, blacklist: [], updatedAt: now(), updatedBy: null },
    audit: []
  })) {
    const file = path.join(DATA, `${name}.json`);
    if (!fs.existsSync(file)) await writeJson(file, seed);
  }
}
const read = name => readJson(path.join(DATA, `${name}.json`), {});
const write = (name, value) => writeJson(path.join(DATA, `${name}.json`), value);
function send(res, status, data, headers = {}) {
  res.status(status).set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers }).json(data);
}
function fail(res, status, message, code) { return send(res, status, { error: message, ...(code ? { code } : {}) }); }
function publicUser(user) {
  if (!user) return null;
  return { id: user.id, username: user.username, displayName: user.displayName, bio: user.bio || '', avatarUrl: user.avatarUrl || null, role: user.role || 'user', disabled: !!user.disabled, createdAt: user.createdAt };
}
function cookieValue(header, name) {
  const row = String(header || '').split(';').map(x => x.trim()).find(x => x.startsWith(`${name}=`));
  return row ? decodeURIComponent(row.slice(name.length + 1)) : '';
}
async function getContext(req) {
  const token = cookieValue(req.headers.cookie, COOKIE);
  const users = await read('users');
  if (token) {
    const sessions = await read('sessions');
    const key = sha(token), session = sessions[key];
    if (session && Date.parse(session.expiresAt) >= Date.now()) {
      const user = users[session.userId];
      if (user && !user.disabled) return { user, session, sessionKey: key };
    } else if (session) {
      delete sessions[key]; await write('sessions', sessions);
    }
  }

  // ScratchWWW local authentication is the shared identity source.
  // A local_session is mapped to a SitHub account by its canonical username.
  const localToken = cookieValue(req.headers.cookie, 'local_session');
  if (!localToken) return { user: null, session: null };
  const localDb = localAuth.load();
  const localUsername = localDb.sessions?.[localToken];
  const localUser = localUsername && localDb.users?.[String(localUsername).toLowerCase()];
  if (!localUser) return { user: null, session: null };
  const identity = `scratch-local:${String(localUser.username).toLowerCase()}`;
  let user = Object.values(users).find(u => (u.externalIdentities || []).includes(identity));
  if (!user) {
    // Never merge accounts based only on a matching display name. If a legacy
    // SitHub account already owns this name, keep the identities separate.
    const occupied = Object.values(users).some(u => u.username.toLowerCase() === String(localUser.username).toLowerCase());
    let linkedUsername = localUser.username;
    if (occupied) {
      const suffix = `-scratch-${String(localUser.id).slice(-4)}`;
      linkedUsername = `${String(localUser.username).slice(0, Math.max(3, 39 - suffix.length))}${suffix}`;
    }
    user = {
      id: id(12), username: linkedUsername,
      displayName: localUser.username, password: null, bio: '',
      externalIdentities: [identity], role: 'user', disabled: false,
      createdAt: localUser.dateJoined || now()
    };
    users[user.id] = user;
    await write('users', users);
  }
  if (user.disabled) return { user: null, session: null };
  const sessions = await read('sessions');
  const key = sha(`local:${localToken}`);
  let session = sessions[key];
  if (!session || session.userId !== user.id || Date.parse(session.expiresAt) < Date.now()) {
    session = {
      userId: user.id, csrf: id(24), createdAt: now(),
      expiresAt: new Date(Date.now() + SESSION_DAYS * 86400000).toISOString(),
      authSource: 'scratch-local'
    };
    sessions[key] = session;
    await write('sessions', sessions);
  }
  return { user, session, sessionKey: key };
}
function requireLogin(ctx, res) { if (ctx.user) return false; fail(res, 401, 'ログインが必要です', 'LOGIN_REQUIRED'); return true; }
function requireAdmin(ctx, res) { if (ctx.user?.role === 'admin') return false; fail(res, 403, '運営管理者のみ利用できます', 'ADMIN_REQUIRED'); return true; }
function requireCsrf(req, ctx, res) {
  if (!ctx.session) return fail(res, 401, 'ログインが必要です', 'LOGIN_REQUIRED');
  const token = req.get('x-csrf-token');
  if (!token || token !== ctx.session.csrf) return fail(res, 403, 'CSRFトークンが一致しません', 'CSRF_INVALID');
  return false;
}
function repoPath(repo) { return path.join(REPOS, repo.id); }
function canRead(repo, user) { return repo.visibility === 'public' || !!user && (repo.ownerId === user.id || (repo.collaborators || []).includes(user.id)); }
function canWrite(repo, user) { return !!user && (repo.ownerId === user.id || (repo.collaborators || []).includes(user.id)); }
function repoView(repo, users) {
  const owner = Object.values(users).find(u => u.id === repo.ownerId);
  return { id: repo.id, name: repo.name, description: repo.description || '', visibility: repo.visibility, owner: publicUser(owner), defaultBranch: repo.defaultBranch || 'main', forkedFrom: repo.forkedFrom || null, sourceProjectUrl: repo.sourceProjectUrl || null, createdAt: repo.createdAt, updatedAt: repo.updatedAt, stars: repo.stars || 0, topics: repo.topics || [], hasSb3: !!repo.hasSb3 };
}
async function getRepo(owner, name) {
  const repos = await read('repos');
  const entry = Object.values(repos).find(r => r.owner.toLowerCase() === String(owner).toLowerCase() && r.name.toLowerCase() === String(name).toLowerCase());
  return entry || null;
}
async function appendAudit(actor, action, target, detail = {}) {
  const rows = await read('audit');
  rows.unshift({ id: id(8), actor: actor?.username || 'system', action, target, detail, at: now() });
  await write('audit', rows.slice(0, 1000));
}
async function checkText(text, scope) {
  const cfg = await read('moderation');
  const value = String(text || '');
  for (const item of (cfg.blacklist || [])) {
    if (item.enabled === false || (item.scopes?.length && !item.scopes.includes(scope) && !item.scopes.includes('all'))) continue;
    const needle = String(item.value || '');
    if (!needle) continue;
    let hit = false;
    if (item.mode === 'regex') {
      try { hit = new RegExp(needle, item.flags?.includes('i') ? 'i' : '').test(value); }
      catch { /* Invalid expressions are ignored safely; admin UI validates before save. */ }
    } else hit = value.toLocaleLowerCase().includes(needle.toLocaleLowerCase());
    if (hit) return { blocked: true, rule: item.label || item.value };
  }
  return { blocked: false };
}
function startSharedLocalSession(username, password, res) {
  const db = localAuth.load();
  const key = String(username).toLowerCase();
  let localUser = db.users?.[key];
  if (localUser) {
    if (localUser.hash) {
      const candidate = crypto.scryptSync(String(password), localUser.salt, 32).toString('hex');
      if (candidate !== localUser.hash) return false;
    } else {
      const salt = crypto.randomBytes(16).toString('hex');
      localUser.salt = salt;
      localUser.hash = crypto.scryptSync(String(password), salt, 32).toString('hex');
    }
  } else {
    db.nextId = Number(db.nextId || 1000);
    const salt = crypto.randomBytes(16).toString('hex');
    localUser = {
      id: db.nextId++, username, email: '', salt,
      hash: crypto.scryptSync(String(password), salt, 32).toString('hex'),
      dateJoined: now()
    };
    db.users[key] = localUser;
  }
  localAuth.startSession(res, db, localUser);
  return true;
}
function clearSharedLocalSession(req, res) {
  const token = cookieValue(req.headers.cookie, 'local_session');
  if (token) {
    const db = localAuth.load();
    if (db.sessions) { delete db.sessions[token]; localAuth.save(db); }
  }
  res.append('Set-Cookie', 'local_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}

async function createSession(user, res) {
  const token = id(32), csrf = id(24), sessions = await read('sessions');
  sessions[sha(token)] = { userId: user.id, csrf, createdAt: now(), expiresAt: new Date(Date.now() + SESSION_DAYS * 86400000).toISOString() };
  await write('sessions', sessions);
  res.append('Set-Cookie', `${COOKIE}=${encodeURIComponent(token)}; ${cookieFlags}`);
  return csrf;
}
async function parseSb3(base64) {
  const buffer = Buffer.from(String(base64), 'base64');
  if (!buffer.length || buffer.length > MAX_BODY) throw new Error('.sb3ファイルのサイズが不正です');
  const zip = await JSZip.loadAsync(buffer);
  const projectFile = zip.file('project.json');
  if (!projectFile) throw new Error('project.jsonがありません');
  const projectJson = JSON.parse(await projectFile.async('string'));
  const assets = {};
  for (const [name, file] of Object.entries(zip.files)) if (name !== 'project.json' && !file.dir) assets[name] = await file.async('nodebuffer');
  return { projectJson, assets };
}
async function commitSb3(repo, base64, message, author) {
  const { projectJson, assets } = await parseSb3(base64);
  const { Repo } = await import('../vendor/sit/repo.mjs');
  const disk = repoPath(repo), sit = new Repo(disk);
  if (!sit.isInitialized()) await sit.init(repo.trackedFile || 'project.sb3');
  const hash = await sit.commit(projectJson, assets, message, author);
  repo.hasSb3 = true; repo.lastCommit = hash; repo.updatedAt = now();
  const repos = await read('repos'); repos[repo.id] = repo; await write('repos', repos);
  return hash;
}

function attach(app) {
  app.use('/api/sit', require('express').json({ limit: '40mb', strict: true }));
  app.use('/api/sit', async (req, res, next) => {
    try {
      const ctx = await getContext(req); req.sithub = ctx;
      const p = req.path, m = req.method;
      if (p === '/health' && m === 'GET') return send(res, 200, { ok: true, service: 'SitHub API', sitEngine: true });
      if (p === '/auth/register' && m === 'POST') {
        if (authRateLimited(req)) return fail(res, 429, '認証試行が多すぎます。15分後に再試行してください');
        const { username, password, displayName } = req.body || {};
        if (!usernameOk(username)) return fail(res, 400, 'ユーザー名は英数字とハイフンで入力してください');
        const nameCheck = await checkText(`${username}\n${displayName || ''}`, 'profile');
        if (nameCheck.blocked) return fail(res, 422, `禁止文字列が含まれています: ${nameCheck.rule}`, 'MODERATION_BLOCKED');
        if (typeof password !== 'string' || password.length < 10 || password.length > 200) return fail(res, 400, 'パスワードは10文字以上200文字以内にしてください');
        const users = await read('users');
        if (Object.values(users).some(u => u.username.toLowerCase() === username.toLowerCase())) return fail(res, 409, 'そのユーザー名は既に使用されています');
        const localExisting = localAuth.load().users?.[username.toLowerCase()];
        if (localExisting) {
          const localHash = localExisting.hash ? crypto.scryptSync(password, localExisting.salt, 32).toString('hex') : '';
          if (!localHash || localHash !== localExisting.hash) return fail(res, 409, 'ScratchWWWに同じユーザー名があります。ScratchWWW側と同じパスワードで登録してください');
        }
        const salt = crypto.randomBytes(16).toString('hex'), hash = (await scrypt(password, salt, 64)).toString('hex');
        const user = { id: id(12), username, displayName: String(displayName || username).slice(0, 80), password: { salt, hash }, bio: '', role: process.env.SITHUB_ADMIN_USERNAME && username.toLowerCase() === process.env.SITHUB_ADMIN_USERNAME.toLowerCase() ? 'admin' : 'user', disabled: false, createdAt: now() };
        users[user.id] = user; await write('users', users);
        startSharedLocalSession(user.username, password, res);
        user.externalIdentities = [...new Set([...(user.externalIdentities || []), `scratch-local:${user.username.toLowerCase()}`])];
        users[user.id] = user; await write('users', users);
        const csrf = await createSession(user, res); await appendAudit(user, 'account.register', user.id);
        return send(res, 201, { user: publicUser(user), csrf });
      }
      if (p === '/auth/login' && m === 'POST') {
        if (authRateLimited(req)) return fail(res, 429, '認証試行が多すぎます。15分後に再試行してください');
        const { username, password } = req.body || {}, users = await read('users');
        const user = Object.values(users).find(u => u.username.toLowerCase() === String(username || '').toLowerCase());
        if (!user || user.disabled || !user.password) return fail(res, 401, 'ユーザー名またはパスワードが違います');
        const candidate = await scrypt(String(password || ''), user.password.salt, 64);
        if (!crypto.timingSafeEqual(candidate, Buffer.from(user.password.hash, 'hex'))) return fail(res, 401, 'ユーザー名またはパスワードが違います');
        if (!startSharedLocalSession(user.username, password, res)) return fail(res, 409, 'ScratchWWW側の同名アカウントとパスワードが一致しません。アカウント連携を確認してください');
        user.externalIdentities = [...new Set([...(user.externalIdentities || []), `scratch-local:${user.username.toLowerCase()}`])];
        const usersUpdate = await read('users'); usersUpdate[user.id] = user; await write('users', usersUpdate);
        const csrf = await createSession(user, res); await appendAudit(user, 'account.login', user.id);
        return send(res, 200, { user: publicUser(user), csrf });
      }
      if (p === '/auth/logout' && m === 'POST') {
        if (ctx.session) { const sessions = await read('sessions'); delete sessions[ctx.sessionKey]; await write('sessions', sessions); }
        res.set('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${cookieSecure() ? '; Secure' : ''}`);
        clearSharedLocalSession(req, res);
        return send(res, 200, { ok: true });
      }
      if (p === '/me' && m === 'GET') return send(res, 200, { user: publicUser(ctx.user), csrf: ctx.session?.csrf || null });
      if (p.startsWith('/users/') && m === 'GET') {
        const username = decodeURIComponent(p.slice('/users/'.length)).replace(/\/$/, '');
        const users = await read('users'), repos = await read('repos');
        const user = Object.values(users).find(u => u.username.toLowerCase() === username.toLowerCase());
        if (!user) return fail(res, 404, 'ユーザーが見つかりません', 'USER_NOT_FOUND');
        const owned = Object.values(repos).filter(r => r.ownerId === user.id && r.visibility === 'public')
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(r => repoView(r, users));
        return send(res, 200, { user: publicUser(user), repos: owned });
      }
      if (p === '/search' && m === 'GET') {
        const q = String(req.query.q || '').trim().slice(0, 120);
        const type = req.query.type === 'studios' ? 'studios' : 'projects';
        const limit = Math.max(1, Math.min(40, Number(req.query.limit) || 16));
        const offset = Math.max(0, Math.min(500, Number(req.query.offset) || 0));
        const mode = ['trending', 'popular'].includes(req.query.mode) ? req.query.mode : 'popular';
        const language = String(req.query.language || 'ja').slice(0, 12);
        const users = await read('users'), repos = await read('repos');
        const localRepos = Object.values(repos).filter(r => r.visibility === 'public' &&
          (!q || `${r.owner}/${r.name} ${r.description || ''}`.toLowerCase().includes(q.toLowerCase())))
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 50).map(r => repoView(r, users));
        let items = [], projects = [];
        try {
          const url = new URL(`https://api.scratch.mit.edu/search/${type}`);
          if (q) url.searchParams.set('q', q);
          url.searchParams.set('limit', String(limit)); url.searchParams.set('offset', String(offset));
          url.searchParams.set('mode', mode); url.searchParams.set('language', language);
          const remote = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'ScratchWWW-SitHub/1.0' }, signal: AbortSignal.timeout(12000) });
          if (remote.ok) {
            const body = await remote.json();
            items = Array.isArray(body) ? body : [];
            if (type === 'projects') projects = items.map(x => ({
              id: String(x.id), title: String(x.title || ''), description: String(x.description || ''),
              author: x.author?.username || '', image: x.image || null, loves: Number(x.stats?.loves || 0),
              url: `/projects/${encodeURIComponent(x.id)}/`
            }));
          }
        } catch (error) { console.warn('[ScratchWWW search] Scratch API unavailable:', error.message); }
        return send(res, 200, { items, projects, repos: localRepos, offset, limit, hasMore: items.length === limit });
      }
      if (p === '/me' && m === 'PATCH') {
        if (requireLogin(ctx, res) || requireCsrf(req, ctx, res)) return;
        const users = await read('users'), user = users[ctx.user.id];
        if (typeof req.body.displayName === 'string') user.displayName = req.body.displayName.trim().slice(0, 80);
        if (typeof req.body.bio === 'string') user.bio = req.body.bio.slice(0, 500);
        const profileCheck = await checkText(`${user.displayName}\n${user.bio}`, 'profile');
        if (profileCheck.blocked) return fail(res, 422, `禁止文字列が含まれています: ${profileCheck.rule}`, 'MODERATION_BLOCKED');
        users[user.id] = user; await write('users', users); return send(res, 200, { user: publicUser(user) });
      }
      if (p === '/me/password' && m === 'POST') {
        if (requireLogin(ctx, res) || requireCsrf(req, ctx, res)) return;
        const oldPassword = String(req.body.oldPassword || ''), newPassword = String(req.body.newPassword || '');
        if (newPassword.length < 10 || newPassword.length > 200) return fail(res, 400, '新しいパスワードは10文字以上200文字以内にしてください');
        const users = await read('users'), user = users[ctx.user.id];
        if (!user.password) return fail(res, 400, 'このアカウントではパスワードを変更できません');
        const oldHash = await scrypt(oldPassword, user.password.salt, 64);
        if (!crypto.timingSafeEqual(oldHash, Buffer.from(user.password.hash, 'hex'))) return fail(res, 401, '現在のパスワードが違います');
        const salt = crypto.randomBytes(16).toString('hex'); user.password = { salt, hash: (await scrypt(newPassword, salt, 64)).toString('hex') };
        users[user.id] = user; await write('users', users); await appendAudit(user, 'account.password.change', user.id);
        return send(res, 200, { ok: true });
      }
      const projectFork = p.match(/^\/projects\/(\d+)\/fork$/);
      if (projectFork && m === 'POST') {
        if (requireLogin(ctx, res) || requireCsrf(req, ctx, res)) return;
        const projectId = projectFork[1];
        const all = await read('repos');
        const existing = Object.values(all).find(r => r.sourceProjectId === projectId && r.ownerId === ctx.user.id);
        if (existing) return send(res, 200, { repo: repoView(existing, await read('users')), alreadyForked: true });
        const remote = await fetch(`${SCRATCH_PROJECT_HOST}/${projectId}`, { headers: { 'Accept': 'application/octet-stream', 'User-Agent': 'ScratchWWW-Sit/1.0' }, signal: AbortSignal.timeout(20000) });
        if (!remote.ok) return fail(res, remote.status === 404 ? 404 : 502, `Scratchからプロジェクトを取得できませんでした (HTTP ${remote.status})`);
        const bytes = Buffer.from(await remote.arrayBuffer());
        if (!bytes.length || bytes.length > MAX_BODY) return fail(res, 413, '.sb3ファイルが大きすぎます');
        const baseName = safeName(req.body.name || `scratch-${projectId}`) || `scratch-${projectId}`;
        let name = baseName, suffix = 2;
        while (Object.values(all).some(r => r.ownerId === ctx.user.id && r.name.toLowerCase() === name.toLowerCase())) name = `${baseName}-${suffix++}`;
        const repo = { id: id(12), ownerId: ctx.user.id, owner: ctx.user.username, name, description: `Fork of Scratch project ${projectId}`, visibility: 'public', defaultBranch: 'main', trackedFile: 'project.sb3', collaborators: [], forkedFrom: { service: 'Scratch', projectId }, sourceProjectId: projectId, sourceProjectUrl: `https://scratch.mit.edu/projects/${projectId}/`, stars: 0, topics: ['scratch','fork'], createdAt: now(), updatedAt: now(), hasSb3: false };
        await fsp.mkdir(repoPath(repo), { recursive: true });
        await writeJson(path.join(repoPath(repo), 'files.json'), { 'README.md': `# ${name}\n\nFork of [Scratch project ${projectId}](${repo.sourceProjectUrl}).\n` });
        all[repo.id] = repo; await write('repos', all);
        try { const hash = await commitSb3(repo, bytes.toString('base64'), `Fork Scratch project ${projectId}`, ctx.user.username); await appendAudit(ctx.user, 'project.fork', repo.id, { projectId, hash }); }
        catch (error) { const current = await read('repos'); delete current[repo.id]; await write('repos', current); await fsp.rm(repoPath(repo), { recursive: true, force: true }); throw error; }
        return send(res, 201, { repo: repoView(repo, await read('users')) });
      }
      const projectCommits = p.match(/^\/projects\/(\d+)\/commits$/);
      if (projectCommits && m === 'GET') {
        const projectId = projectCommits[1], repos = await read('repos'), users = await read('users');
        const candidates = Object.values(repos).filter(r => r.sourceProjectId === projectId && canRead(r, ctx.user))
          .sort((a, b) => (a.ownerId === ctx.user?.id ? -1 : 0) - (b.ownerId === ctx.user?.id ? -1 : 0) || b.updatedAt.localeCompare(a.updatedAt));
        if (!candidates.length) return fail(res, 404, 'このプロジェクトにはまだFork履歴がありません');
        const repo = candidates[0];
        const textCommits = await readJson(path.join(repoPath(repo), 'commits.json'), []);
        const { Repo } = await import('../vendor/sit/repo.mjs');
        const sitLog = repo.hasSb3 ? await new Repo(repoPath(repo)).getLog(100) : [];
        const commits = [...sitLog.map(c => ({ hash: c.hash, shortHash: c.hash.slice(0, 7), message: c.message, author: c.author, at: c.timestamp, changed: c.assetNames || [], engine: 'Sit' })), ...textCommits]
          .sort((a, b) => Date.parse(b.at || b.timestamp) - Date.parse(a.at || a.timestamp)).slice(0, 150);
        return send(res, 200, { repo: repoView(repo, users), commits });
      }
      if (p === '/explore' && m === 'GET') {
        const users = await read('users'), repos = await read('repos'), q = String(req.query.q || '').toLowerCase();
        const rows = Object.values(repos).filter(r => r.visibility === 'public' && `${r.owner}/${r.name} ${r.description}`.toLowerCase().includes(q)).sort((a,b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 100);
        return send(res, 200, { repos: rows.map(r => repoView(r, users)) });
      }
      if (p === '/repos' && m === 'GET') {
        if (requireLogin(ctx, res)) return;
        const users = await read('users'), repos = await read('repos');
        return send(res, 200, { repos: Object.values(repos).filter(r => r.ownerId === ctx.user.id || (r.collaborators || []).includes(ctx.user.id)).map(r => repoView(r, users)) });
      }
      if (p === '/repos' && m === 'POST') {
        if (requireLogin(ctx, res) || requireCsrf(req, ctx, res)) return;
        const name = safeName(req.body.name);
        if (!name) return fail(res, 400, 'リポジトリ名が必要です');
        const repoTextCheck = await checkText(`${name}\n${req.body.description || ''}`, 'repository');
        if (repoTextCheck.blocked) return fail(res, 422, `禁止文字列が含まれています: ${repoTextCheck.rule}`, 'MODERATION_BLOCKED');
        const repos = await read('repos');
        if (Object.values(repos).some(r => r.ownerId === ctx.user.id && r.name.toLowerCase() === name.toLowerCase())) return fail(res, 409, '同じ名前のリポジトリがあります');
        const repo = { id: id(12), ownerId: ctx.user.id, owner: ctx.user.username, name, description: String(req.body.description || '').slice(0, 350), visibility: req.body.visibility === 'public' ? 'public' : 'private', defaultBranch: 'main', trackedFile: 'project.sb3', collaborators: [], forkedFrom: null, stars: 0, topics: [], createdAt: now(), updatedAt: now(), hasSb3: false };
        await fsp.mkdir(repoPath(repo), { recursive: true });
        await writeJson(path.join(repoPath(repo), 'files.json'), {});
        repos[repo.id] = repo; await write('repos', repos);
        if (req.body.sb3Base64) await commitSb3(repo, req.body.sb3Base64, String(req.body.commitMessage || 'Initial commit'), ctx.user.username);
        await appendAudit(ctx.user, 'repo.create', repo.id);
        return send(res, 201, { repo: repoView(repo, await read('users')) });
      }
      if (p === '/import-scratch' && m === 'POST') {
        if (requireLogin(ctx, res) || requireCsrf(req, ctx, res)) return;
        const projectId = String(req.body.projectId || '');
        if (!/^\d{1,16}$/.test(projectId)) return fail(res, 400, 'ScratchプロジェクトIDが不正です');
        const name = safeName(req.body.name || `scratch-${projectId}`);
        if (!name) return fail(res, 400, 'リポジトリ名が必要です');
        const all = await read('repos');
        if (Object.values(all).some(r => r.ownerId === ctx.user.id && r.name.toLowerCase() === name.toLowerCase())) return fail(res, 409, '同じ名前のリポジトリがあります');
        const remote = await fetch(`${SCRATCH_PROJECT_HOST}/${projectId}`, { headers: { 'Accept': 'application/octet-stream', 'User-Agent': 'SitHub/1.0' }, signal: AbortSignal.timeout(20000) });
        if (!remote.ok) return fail(res, remote.status === 404 ? 404 : 502, `Scratchからプロジェクトを取得できませんでした (HTTP ${remote.status})`);
        const bytes = Buffer.from(await remote.arrayBuffer());
        if (!bytes.length || bytes.length > MAX_BODY) return fail(res, 413, '.sb3ファイルが大きすぎます');
        const repo = { id: id(12), ownerId: ctx.user.id, owner: ctx.user.username, name, description: String(req.body.description || `Imported from Scratch project ${projectId}`).slice(0,350), visibility: req.body.visibility === 'public' ? 'public' : 'private', defaultBranch: 'main', trackedFile: 'project.sb3', collaborators: [], forkedFrom: null, sourceProjectId: projectId, sourceProjectUrl: `https://scratch.mit.edu/projects/${projectId}/`, stars: 0, topics: ['scratch'], createdAt: now(), updatedAt: now(), hasSb3: false };
        await fsp.mkdir(repoPath(repo), { recursive: true });
        await writeJson(path.join(repoPath(repo), 'files.json'), { 'README.md': `# ${name}\n\nImported from [Scratch project ${projectId}](${repo.sourceProjectUrl}).\n` });
        all[repo.id] = repo; await write('repos', all);
        try { const hash = await commitSb3(repo, bytes.toString('base64'), 'Import from Scratch', ctx.user.username); await appendAudit(ctx.user, 'repo.import-scratch', repo.id, { projectId, hash }); }
        catch (error) { const current = await read('repos'); delete current[repo.id]; await write('repos', current); await fsp.rm(repoPath(repo), { recursive: true, force: true }); throw error; }
        return send(res, 201, { repo: repoView(repo, await read('users')) });
      }
      const match = p.match(/^\/repos\/([^/]+)\/([^/]+)(.*)$/);
      if (match) {
        const [, owner, name, tail] = match, repo = await getRepo(decodeURIComponent(owner), decodeURIComponent(name));
        if (!repo) return fail(res, 404, 'リポジトリが見つかりません');
        if (!canRead(repo, ctx.user)) return fail(res, ctx.user ? 403 : 401, 'このリポジトリを閲覧できません');
        if (tail === '' && m === 'GET') {
          const users = await read('users'), files = await readJson(path.join(repoPath(repo), 'files.json'), {}), commits = await readJson(path.join(repoPath(repo), 'commits.json'), []);
          return send(res, 200, { repo: repoView(repo, users), files: Object.keys(files).map(file => ({ path: file, size: Buffer.byteLength(files[file]) })), commits: commits.slice(0, 20) });
        }
        if (tail === '' && m === 'PATCH') {
          if (repo.ownerId !== ctx.user?.id) return fail(res, 403, 'リポジトリ所有者のみ設定を変更できます');
          if (requireCsrf(req, ctx, res)) return;
          const repos = await read('repos');
          if (typeof req.body.description === 'string') repo.description = req.body.description.slice(0, 350);
          const repoTextCheck = await checkText(`${repo.name}\n${repo.description}`, 'repository');
          if (repoTextCheck.blocked) return fail(res, 422, `禁止文字列が含まれています: ${repoTextCheck.rule}`, 'MODERATION_BLOCKED');
          if (['public','private'].includes(req.body.visibility)) repo.visibility = req.body.visibility;
          if (typeof req.body.name === 'string') {
            const nextName = safeName(req.body.name) || repo.name;
            if (Object.values(repos).some(other => other.id !== repo.id && other.ownerId === repo.ownerId && other.name.toLowerCase() === nextName.toLowerCase())) return fail(res, 409, '同じ名前のリポジトリがあります');
            repo.name = nextName;
          }
          repo.updatedAt = now(); repos[repo.id] = repo; await write('repos', repos);
          return send(res, 200, { repo: repoView(repo, await read('users')) });
        }
        if (tail === '/fork' && m === 'POST') {
          if (requireLogin(ctx, res) || requireCsrf(req, ctx, res)) return;
          if (repo.ownerId === ctx.user.id) return fail(res, 400, '自分のリポジトリはForkできません');
          const repos = await read('repos'), fork = { ...repo, id: id(12), ownerId: ctx.user.id, owner: ctx.user.username, name: safeName(req.body.name || repo.name) || repo.name, visibility: repo.visibility === 'public' ? 'public' : 'private', collaborators: repo.visibility === 'private' ? [repo.ownerId] : [], forkedFrom: { repoId: repo.id, owner: repo.owner, name: repo.name }, createdAt: now(), updatedAt: now(), stars: 0 };
          const dest = repoPath(fork); await fsp.cp(repoPath(repo), dest, { recursive: true });
          repos[fork.id] = fork; await write('repos', repos); await appendAudit(ctx.user, 'repo.fork', fork.id, { source: repo.id });
          return send(res, 201, { repo: repoView(fork, await read('users')) });
        }
        if (tail === '/collaborators' && m === 'GET') {
          const users = await read('users');
          return send(res, 200, { collaborators: (repo.collaborators || []).map(uid => publicUser(users[uid])).filter(Boolean) });
        }
        if (tail === '/collaborators' && m === 'POST') {
          if (repo.ownerId !== ctx.user?.id) return fail(res, 403, 'リポジトリ所有者のみ変更できます');
          if (requireCsrf(req, ctx, res)) return;
          const users = await read('users'), target = Object.values(users).find(u => u.username.toLowerCase() === String(req.body.username || '').toLowerCase());
          if (!target || target.disabled) return fail(res, 404, 'ユーザーが見つかりません');
          repo.collaborators = [...new Set([...(repo.collaborators || []), target.id])];
          const allRepos = await read('repos'); allRepos[repo.id] = repo; await write('repos', allRepos);
          return send(res, 200, { collaborators: repo.collaborators.map(uid => publicUser(users[uid])).filter(Boolean) });
        }
        if (tail.startsWith('/collaborators/') && m === 'DELETE') {
          if (repo.ownerId !== ctx.user?.id) return fail(res, 403, 'リポジトリ所有者のみ変更できます');
          if (requireCsrf(req, ctx, res)) return;
          const targetName = decodeURIComponent(tail.slice('/collaborators/'.length)), users = await read('users');
          const target = Object.values(users).find(u => u.username.toLowerCase() === targetName.toLowerCase());
          repo.collaborators = (repo.collaborators || []).filter(uid => uid !== target?.id);
          const allRepos = await read('repos'); allRepos[repo.id] = repo; await write('repos', allRepos);
          return send(res, 200, { ok: true });
        }
        if (tail === '/branches' && m === 'GET') {
          if (!repo.hasSb3) return send(res, 200, { branches: ['main'], current: 'main' });
          const { Repo } = await import('../vendor/sit/repo.mjs'); const sit = new Repo(repoPath(repo));
          return send(res, 200, { branches: await sit.listBranches(), current: (await sit.getHead()).branch || null });
        }
        if (tail === '/branches' && m === 'POST') {
          if (!canWrite(repo, ctx.user)) return fail(res, 403, '書き込み権限がありません');
          if (requireCsrf(req, ctx, res)) return;
          const branch = String(req.body.name || '');
          if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,49}$/.test(branch)) return fail(res, 400, 'ブランチ名は英数字・ドット・ハイフン・アンダースコアで指定してください');
          if (!repo.hasSb3) return fail(res, 400, 'ブランチ操作はSitの.sb3リポジトリで利用できます');
          const { Repo } = await import('../vendor/sit/repo.mjs'); const sit = new Repo(repoPath(repo));
          const existing = await sit.listBranches(); if (existing.includes(branch)) return fail(res, 409, '同名のブランチがあります');
          await sit.createBranch(branch); return send(res, 201, { branches: await sit.listBranches(), current: (await sit.getHead()).branch });
        }
        const branchDelete = tail.match(/^\/branches\/([^/]+)$/);
        if (branchDelete && m === 'DELETE') {
          if (!canWrite(repo, ctx.user)) return fail(res, 403, '書き込み権限がありません');
          if (requireCsrf(req, ctx, res)) return;
          if (!repo.hasSb3) return fail(res, 400, 'ブランチ操作はSitの.sb3リポジトリで利用できます');
          const branch = decodeURIComponent(branchDelete[1]); const { Repo } = await import('../vendor/sit/repo.mjs'); const sit = new Repo(repoPath(repo));
          const head = await sit.getHead(); if (head.branch === branch) return fail(res, 400, '現在のブランチは削除できません');
          await sit.deleteBranch(branch); return send(res, 200, { ok: true, branches: await sit.listBranches() });
        }
        if (tail === '/checkout' && m === 'POST') {
          if (!canWrite(repo, ctx.user)) return fail(res, 403, '書き込み権限がありません');
          if (requireCsrf(req, ctx, res)) return;
          if (!repo.hasSb3) return fail(res, 400, 'ブランチ切り替えはSitの.sb3リポジトリで利用できます');
          const ref = String(req.body.ref || ''); const { Repo } = await import('../vendor/sit/repo.mjs'); const sit = new Repo(repoPath(repo));
          const branches = await sit.listBranches(); if (!branches.includes(ref)) return fail(res, 404, 'ブランチが見つかりません');
          await sit.switchBranch(ref); return send(res, 200, { ok: true, current: ref });
        }
        if (tail === '/sb3' && m === 'POST') {
          if (!canWrite(repo, ctx.user)) return fail(res, 403, '書き込み権限がありません');
          if (requireCsrf(req, ctx, res)) return;
          if (typeof req.body.sb3Base64 !== 'string') return fail(res, 400, '.sb3データが必要です');
          const blocked = await checkText(String(req.body.commitMessage || ''), 'repository');
          if (blocked.blocked) return fail(res, 422, `禁止文字列が含まれています: ${blocked.rule}`, 'MODERATION_BLOCKED');
          const hash = await commitSb3(repo, req.body.sb3Base64, String(req.body.commitMessage || 'Update Scratch project').slice(0, 200), ctx.user.username);
          await appendAudit(ctx.user, 'repo.sb3.commit', repo.id, { hash });
          return send(res, 201, { commit: { hash, shortHash: hash.slice(0, 7) } });
        }
        if (tail === '/sb3' && m === 'GET') {
          if (!repo.hasSb3) return fail(res, 404, '.sb3プロジェクトがありません');
          const { Repo } = await import('../vendor/sit/repo.mjs');
          const sit = new Repo(repoPath(repo)), hash = await sit.getCurrentCommitHash();
          if (!hash) return fail(res, 404, 'コミットがありません');
          const commit = await sit.loadCommit(hash), assets = await sit.getAssetsForCommit(commit), zip = new JSZip();
          zip.file('project.json', JSON.stringify(commit.projectJson));
          for (const [assetName, bytes] of Object.entries(assets)) zip.file(assetName, bytes);
          const output = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
          res.set({ 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename=\"${repo.name}.sb3\"`, 'Cache-Control': 'no-store' });
          return res.status(200).send(output);
        }
        if (tail === '/files' && m === 'GET') {
          const files = await readJson(path.join(repoPath(repo), 'files.json'), {});
          return send(res, 200, { files: Object.entries(files).map(([file, content]) => ({ path: file, content })) });
        }
        if (tail === '/files' && m === 'PUT') {
          if (!canWrite(repo, ctx.user)) return fail(res, 403, '書き込み権限がありません');
          if (requireCsrf(req, ctx, res)) return;
          const entries = req.body.files;
          if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return fail(res, 400, 'filesオブジェクトが必要です');
          const files = await readJson(path.join(repoPath(repo), 'files.json'), {});
          for (const [file, content] of Object.entries(entries)) {
            const norm = path.posix.normalize(file).replace(/^\.\//, '');
            if (!norm || norm.startsWith('../') || norm.startsWith('/') || norm.includes('\\') || norm.length > 240) return fail(res, 400, `不正なファイルパス: ${file}`);
            if (content === null) delete files[norm]; else if (typeof content === 'string' && Buffer.byteLength(content) <= 2_000_000) files[norm] = content; else return fail(res, 400, `ファイル内容が不正です: ${file}`);
          }
          const blocked = await checkText(Object.values(entries).filter(v => typeof v === 'string').join('\n'), 'repository');
          if (blocked.blocked) return fail(res, 422, `禁止文字列が含まれています: ${blocked.rule}`, 'MODERATION_BLOCKED');
          await writeJson(path.join(repoPath(repo), 'files.json'), files);
          const commits = await readJson(path.join(repoPath(repo), 'commits.json'), []);
          const message = String(req.body.message || 'Update files').slice(0, 200);
          const hash = sha(JSON.stringify({ parent: commits[0]?.hash || null, files, message, author: ctx.user.username, at: now() }));
          commits.unshift({ hash, shortHash: hash.slice(0, 7), message, author: ctx.user.username, at: now(), changed: Object.keys(entries) });
          await writeJson(path.join(repoPath(repo), 'commits.json'), commits);
          repo.updatedAt = now(); const repos = await read('repos'); repos[repo.id] = repo; await write('repos', repos);
          return send(res, 200, { ok: true, commit: commits[0] });
        }
        if (tail === '/commits' && m === 'GET') {
          const textCommits = await readJson(path.join(repoPath(repo), 'commits.json'), []);
          if (repo.hasSb3) {
            const { Repo } = await import('../vendor/sit/repo.mjs');
            const sitLog = await new Repo(repoPath(repo)).getLog(100);
            const sitCommits = sitLog.map(c => ({ hash: c.hash, shortHash: c.hash.slice(0, 7), message: c.message, author: c.author, at: c.timestamp, changed: c.assetNames || [], engine: 'Sit' }));
            return send(res, 200, { commits: [...sitCommits, ...textCommits].sort((a, b) => Date.parse(b.at || b.timestamp) - Date.parse(a.at || a.timestamp)).slice(0, 150) });
          }
          return send(res, 200, { commits: textCommits });
        }
        if (tail === '/issues' && m === 'GET') { const all = await read('issues'); return send(res, 200, { issues: (all[repo.id] || []).filter(i => req.query.state === 'all' || i.state === 'open') }); }
        if (tail === '/issues' && m === 'POST') {
          if (requireLogin(ctx, res) || requireCsrf(req, ctx, res)) return;
          const title = String(req.body.title || '').trim(), body = String(req.body.body || '');
          if (!title) return fail(res, 400, 'タイトルが必要です');
          if (title.length > 180 || body.length > 100000) return fail(res, 400, 'Issueのタイトルまたは本文が長すぎます');
          const blocked = await checkText(`${title}\n${body}`, 'issue'); if (blocked.blocked) return fail(res, 422, `禁止文字列が含まれています: ${blocked.rule}`, 'MODERATION_BLOCKED');
          const all = await read('issues'), rows = all[repo.id] || [];
          const issue = { id: id(8), number: rows.length ? Math.max(...rows.map(x => x.number)) + 1 : 1, title, body, state: 'open', author: publicUser(ctx.user), comments: [], createdAt: now() };
          rows.unshift(issue); all[repo.id] = rows; await write('issues', all); return send(res, 201, { issue });
        }
        const issueMatch = tail.match(/^\/issues\/(\d+)(?:\/(comments))?$/);
        if (issueMatch) {
          const all = await read('issues'), rows = all[repo.id] || [], issue = rows.find(x => x.number === Number(issueMatch[1]));
          if (!issue) return fail(res, 404, 'Issueが見つかりません');
          if (!issueMatch[2] && m === 'GET') return send(res, 200, { issue });
          if (issueMatch[2] && m === 'POST') {
            if (requireLogin(ctx, res) || requireCsrf(req, ctx, res)) return;
            const body = String(req.body.body || '').trim(); if (!body) return fail(res, 400, 'コメント本文が必要です');
            if (body.length > 20000) return fail(res, 400, 'コメントは20000文字以内にしてください');
            const blocked = await checkText(body, 'comment'); if (blocked.blocked) return fail(res, 422, `禁止文字列が含まれています: ${blocked.rule}`, 'MODERATION_BLOCKED');
            issue.comments.push({ id: id(8), body, author: publicUser(ctx.user), createdAt: now() }); await write('issues', all); return send(res, 201, { issue });
          }
          if (!issueMatch[2] && m === 'PATCH') {
            if (!canWrite(repo, ctx.user)) return fail(res, 403, '操作権限がありません');
            if (requireCsrf(req, ctx, res)) return;
            issue.state = req.body.state === 'closed' ? 'closed' : 'open'; await write('issues', all); return send(res, 200, { issue });
          }
        }
        if (tail === '/pulls' && m === 'GET') { const all = await read('pulls'); return send(res, 200, { pulls: (all[repo.id] || []) }); }
        const mergePull = tail.match(/^\/pulls\/(\d+)\/merge$/);
        if (mergePull && m === 'POST') {
          if (!canWrite(repo, ctx.user)) return fail(res, 403, 'マージ権限がありません');
          if (requireCsrf(req, ctx, res)) return;
          const allPulls = await read('pulls'), pullRows = allPulls[repo.id] || [], pull = pullRows.find(x => x.number === Number(mergePull[1]));
          if (!pull) return fail(res, 404, 'Pull requestが見つかりません');
          if (pull.state !== 'open') return fail(res, 409, 'このPull requestは既に処理されています');
          const allRepos = await read('repos'), source = allRepos[pull.sourceRepoId];
          if (!source || !canRead(source, ctx.user)) return fail(res, 404, 'ソースリポジトリが見つかりません');
          if (repo.hasSb3 && source.hasSb3) {
            const { Repo } = await import('../vendor/sit/repo.mjs');
            const sourceSit = new Repo(repoPath(source)), targetSit = new Repo(repoPath(repo));
            const sourceHash = await sourceSit.getCurrentCommitHash(); if (!sourceHash) return fail(res, 400, 'ソースにコミットがありません');
            const sourceCommit = await sourceSit.loadCommit(sourceHash), assets = await sourceSit.getAssetsForCommit(sourceCommit);
            const hash = await targetSit.commit(sourceCommit.projectJson, assets, `Merge pull request #${pull.number}: ${pull.title}`, ctx.user.username);
            repo.lastCommit = hash; repo.updatedAt = now(); allRepos[repo.id] = repo; await write('repos', allRepos);
            pull.mergeCommit = hash;
          } else {
            const sourceFiles = await readJson(path.join(repoPath(source), 'files.json'), {});
            const targetFiles = await readJson(path.join(repoPath(repo), 'files.json'), {});
            const mergedFiles = { ...targetFiles, ...sourceFiles };
            await writeJson(path.join(repoPath(repo), 'files.json'), mergedFiles);
            const commits = await readJson(path.join(repoPath(repo), 'commits.json'), []), hash = sha(JSON.stringify({ parent: commits[0]?.hash || null, files: mergedFiles, message: `Merge pull request #${pull.number}: ${pull.title}`, author: ctx.user.username, at: now() }));
            commits.unshift({ hash, shortHash: hash.slice(0,7), message: `Merge pull request #${pull.number}: ${pull.title}`, author: ctx.user.username, at: now(), changed: Object.keys(sourceFiles) });
            await writeJson(path.join(repoPath(repo), 'commits.json'), commits);
            repo.updatedAt = now(); allRepos[repo.id] = repo; await write('repos', allRepos);
          }
          pull.state = 'merged'; pull.mergedAt = now(); pull.mergedBy = ctx.user.username; await write('pulls', allPulls);
          await appendAudit(ctx.user, 'pull.merge', `${repo.id}#${pull.number}`);
          return send(res, 200, { pull });
        }
        if (tail === '/pulls' && m === 'POST') {
          if (requireLogin(ctx, res) || requireCsrf(req, ctx, res)) return;
          const title = String(req.body.title || '').trim(), body = String(req.body.body || ''), sourceRepoId = String(req.body.sourceRepoId || '');
          if (!title || !sourceRepoId) return fail(res, 400, 'タイトルとソースリポジトリが必要です');
          if (sourceRepoId === repo.id) return fail(res, 400, '同じリポジトリをソースに指定できません');
          if (title.length > 180 || body.length > 100000) return fail(res, 400, 'Pull requestのタイトルまたは本文が長すぎます');
          const allRepos = await read('repos'), source = allRepos[sourceRepoId];
          if (!source || !canRead(source, ctx.user)) return fail(res, 404, 'ソースリポジトリが見つからないか、アクセスできません');
          const blocked = await checkText(`${title}\n${body}`, 'pull'); if (blocked.blocked) return fail(res, 422, `禁止文字列が含まれています: ${blocked.rule}`, 'MODERATION_BLOCKED');
          const all = await read('pulls'), rows = all[repo.id] || [];
          const pr = { id: id(8), number: rows.length ? Math.max(...rows.map(x => x.number)) + 1 : 1, title, body, state: 'open', sourceRepoId, source: `${source.owner}/${source.name}`, author: publicUser(ctx.user), createdAt: now() };
          rows.unshift(pr); all[repo.id] = rows; await write('pulls', all); return send(res, 201, { pull: pr });
        }
        return fail(res, 404, 'APIエンドポイントが見つかりません');
      }
      if (p === '/admin/moderation' && m === 'GET') {
        if (requireAdmin(ctx, res)) return; return send(res, 200, await read('moderation'));
      }
      if (p === '/admin/moderation' && m === 'PUT') {
        if (requireAdmin(ctx, res) || requireCsrf(req, ctx, res)) return;
        const list = req.body.blacklist;
        if (!Array.isArray(list) || list.length > 2000) return fail(res, 400, 'blacklistは2000件以内の配列にしてください');
        for (const item of list) {
          if (!item || typeof item.value !== 'string' || !item.value.trim() || item.value.length > 500) return fail(res, 400, '禁止文字列は1〜500文字で指定してください');
          if (!['literal','regex'].includes(item.mode || 'literal')) return fail(res, 400, 'modeはliteralまたはregexです');
          if (item.mode === 'regex') { try { new RegExp(item.value, item.flags?.includes('i') ? 'i' : ''); } catch { return fail(res, 400, `正規表現が不正です: ${item.value}`); } }
        }
        const config = { version: 1, blacklist: list.map(x => ({ id: x.id || id(8), label: String(x.label || x.value).slice(0, 100), value: x.value, mode: x.mode || 'literal', flags: x.flags === 'i' ? 'i' : '', scopes: Array.isArray(x.scopes) ? x.scopes.filter(s => ['all','comment','issue','pull','repository','profile'].includes(s)) : ['all'], enabled: x.enabled !== false })), updatedAt: now(), updatedBy: ctx.user.username };
        await write('moderation', config); await appendAudit(ctx.user, 'moderation.update', 'blacklist', { count: config.blacklist.length }); return send(res, 200, config);
      }
      if (p === '/admin/users' && m === 'GET') {
        if (requireAdmin(ctx, res)) return; const users = await read('users'); return send(res, 200, { users: Object.values(users).map(publicUser) });
      }
      const adminUser = p.match(/^\/admin\/users\/([^/]+)$/);
      if (adminUser && m === 'PATCH') {
        if (requireAdmin(ctx, res) || requireCsrf(req, ctx, res)) return;
        const users = await read('users'), user = users[adminUser[1]]; if (!user) return fail(res, 404, 'ユーザーが見つかりません');
        if (user.id === ctx.user.id && req.body.disabled === true) return fail(res, 400, '自分自身を停止できません');
        if (typeof req.body.disabled === 'boolean') user.disabled = req.body.disabled;
        if (['user','admin'].includes(req.body.role)) user.role = req.body.role;
        await write('users', users); await appendAudit(ctx.user, 'user.update', user.id); return send(res, 200, { user: publicUser(user) });
      }
      if (p === '/admin/audit' && m === 'GET') { if (requireAdmin(ctx, res)) return; return send(res, 200, { events: (await read('audit')).slice(0, 300) }); }
      return next();
    } catch (error) {
      console.error('[SitHub API]', error);
      if (!res.headersSent) return send(res, 500, { error: process.env.NODE_ENV === 'production' ? 'サーバー内部エラー' : error.message });
    }
  });
  // SitHub has no standalone web root. Git features are embedded in ScratchWWW
  // project pages; only the internal API remains mounted at /api/sit.
  const commitLogHtml = (projectId, commitHash) => `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Commit history - Scratch</title><link rel="stylesheet" href="/css/main.css"><style>body{background:#f9f9f9;color:#575e75;font-family:Helvetica,Arial,sans-serif}.sit-log{max-width:1000px;margin:32px auto;padding:24px;background:#fff;border:1px solid #e5e5e5;border-radius:12px}.sit-log h1{font-size:28px}.sit-log a{color:#855cd6;text-decoration:none}.sit-log-row{padding:16px 0;border-bottom:1px solid #eee;display:flex;gap:18px;align-items:flex-start}.sit-log-row code{color:#855cd6}.sit-log-meta{margin-left:auto;color:#999;font-size:13px}.sit-log button{background:#855cd6;color:white;border:0;border-radius:6px;padding:10px 18px;cursor:pointer}.sit-log-error{color:#c33}</style></head><body><main class="sit-log"><p><a href="/projects/${projectId}/">← プロジェクトに戻る</a></p><h1>${commitHash ? 'コミット詳細' : 'コミット履歴'}</h1><div id="sit-log-content">読み込み中...</div></main><script>(async()=>{const root=document.getElementById('sit-log-content');const esc=s=>String(s??'').replace(/[&<>\"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[c]));try{const r=await fetch('/api/sit/projects/${projectId}/commits',{credentials:'same-origin'});const d=await r.json();if(!r.ok)throw Error(d.error||'履歴を取得できません');const commits=d.commits||[];${commitHash ? `const c=commits.find(x=>x.hash==='${commitHash}');if(!c)throw Error('コミットが見つかりません');root.innerHTML='<h2>'+esc(c.message)+'</h2><p><code>'+esc(c.hash)+'</code></p><p>'+esc(c.author)+' · '+esc(c.at)+'</p><p>変更: '+esc((c.changed||[]).join(', ')||'Scratch project')+'</p>';` : `root.innerHTML='<p>'+esc(d.repo.owner.username)+' / '+esc(d.repo.name)+'</p>'+(commits.length?commits.map(c=>'<article class=\"sit-log-row\"><div><strong>'+esc(c.message)+'</strong><br><code>'+esc(c.shortHash||c.hash)+'</code> · '+esc(c.author)+'</div><span class=\"sit-log-meta\">'+esc(c.at)+'</span><a href=\"/projects/${projectId}/commit/'+encodeURIComponent(c.hash)+'\">詳細</a></article>').join(''):'<p>コミットはありません。</p>');`}}catch(e){root.innerHTML='<p class=\"sit-log-error\">'+esc(e.message)+'</p>'}})();</script></body></html>`;
  app.get('/projects/:id/commit_log', (req, res) => { if (!/^\d{1,16}$/.test(req.params.id)) return res.sendStatus(404); res.type('html').send(commitLogHtml(req.params.id)); });
  app.get('/projects/:id/commit/:hash', (req, res) => { if (!/^\d{1,16}$/.test(req.params.id) || !/^[a-f0-9]{16,128}$/i.test(req.params.hash)) return res.sendStatus(404); res.type('html').send(commitLogHtml(req.params.id, req.params.hash)); });
}

module.exports = { attach, init };
