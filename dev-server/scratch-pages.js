'use strict';

// Local implementations of the Scratch 2.0-era account/profile pages and
// project storage. These pages use the same local_session identity as WWW.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const JSZip = require('../vendor/sit/node_modules/jszip');
const localAuth = require('./local-api');
const renderScratchNavbar = require('./scratch-navbar');

const DATA_DIR = path.join(__dirname, 'local-data');
const ASSET_HOST = (process.env.ASSET_HOST || 'https://assets.scratch.mit.edu').replace(/\/+$/, '');
const PROJECTS_FILE = path.join(DATA_DIR, 'projects.json');
const readProjects = () => {
    try { return JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
};
const writeProjects = projects => {
    fs.mkdirSync(DATA_DIR, {recursive: true});
    const temp = `${PROJECTS_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(projects), {mode: 0o600});
    fs.renameSync(temp, PROJECTS_FILE);
};
const readCookie = (req, name) => {
    const row = String(req.headers.cookie || '').split(/;\s*/).find(value => value.startsWith(`${name}=`));
    return row ? decodeURIComponent(row.slice(name.length + 1)) : '';
};
const currentUser = req => {
    const db = localAuth.load();
    const username = db.sessions && db.sessions[readCookie(req, 'local_session')];
    return username && db.users[username.toLowerCase()] ? db.users[username.toLowerCase()] : null;
};
const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[char]));
const publicProject = project => ({
    id: Number(project.id), title: project.title, description: project.description || '',
    instructions: '', author: {id: Number(project.ownerId) || 0, username: project.username},
    username: project.username, created: project.createdAt, modified: project.updatedAt,
    history: {created: project.createdAt, modified: project.updatedAt, shared: project.shared ? project.updatedAt : null},
    stats: {views: 0, loves: 0, favorites: 0, comments: 0, remixes: 0},
    remix: {parent: null, root: null}, project_token: '',
    visibility: project.visibility, shared: project.shared === true,
    is_published: project.shared === true, comments_allowed: true,
    image: project.thumbnailUrl || '/images/create_a_project.svg'
});
const pageShell = (title, active, content, user) => `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} - Scratch</title>
<link rel="stylesheet" href="/css/lib/normalize.min.css">
<link rel="stylesheet" href="/common.css">
<style>
/* Page content only. Navigation is shared with ScratchWWW's real component styles. */
*{box-sizing:border-box}
html,body{min-height:100%;margin:0}
body{background:#f9f9f9;color:#575e75;font-family:Helvetica,Arial,sans-serif;padding-top:50px}
.wrap{max-width:1200px;margin:28px auto;padding:0 18px}
.panel{background:#fff;border:1px solid #e5e5e5;border-radius:8px;box-shadow:0 1px 2px #0000000d;padding:24px;margin-bottom:20px}
h1{font-size:26px;margin:0 0 20px;color:#575e75}h2{font-size:20px;margin:0 0 16px}.muted{color:#999}
.btn{display:inline-block;background:#855cd6;color:#fff;border:0;border-radius:6px;padding:10px 18px;font-weight:700;text-decoration:none;cursor:pointer}.btn.secondary{background:#fff;color:#855cd6;border:1px solid #855cd6}.btn.danger{background:#d94b4b}
.field{margin:0 0 18px}.field label{display:block;font-weight:700;font-size:14px;margin-bottom:7px}.field input,.field textarea,.field select{width:100%;border:1px solid #d9dce2;border-radius:5px;padding:11px 12px;font:inherit;color:#575e75}.field textarea{min-height:110px;resize:vertical}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:16px}.project{border:1px solid #e5e5e5;border-radius:8px;overflow:hidden;background:#fff}.project img{display:block;width:100%;aspect-ratio:4/3;object-fit:cover;background:#eee}.project .meta{padding:12px}.project a{color:#855cd6;text-decoration:none;font-weight:700}.project p{font-size:13px;color:#999;margin:7px 0 0}
.profile-head{display:flex;align-items:center;gap:20px}.avatar{width:96px;height:96px;border-radius:50%;object-fit:cover;background:#eee}.notice{padding:12px 15px;border-radius:6px;background:#fff4e5;color:#875b20;margin-bottom:16px}.empty{padding:34px;text-align:center;color:#999}
.row{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.row .grow{flex:1}.tabs{display:flex;gap:22px;border-bottom:1px solid #ddd;margin:0 0 20px}.tabs a{padding:10px 0;color:#855cd6;text-decoration:none;font-weight:700}.tabs a.active{border-bottom:3px solid #855cd6}.status{font-size:12px;border-radius:12px;background:#e9e5f5;color:#6845a5;padding:4px 9px}
@media(max-width:760px){.wrap{margin:16px auto}.panel{padding:16px}.profile-head{align-items:flex-start}.profile-head .avatar{width:68px;height:68px}}
</style></head><body>
${renderScratchNavbar(user)}
<main class="wrap">${content}</main></body></html>`;

const attach = app => {
    app.use('/projects-data', express.json({limit: '30mb', strict: true}));

    // Scratch project storage protocol used by scratch-gui.
    app.post('/projects-data/', (req, res) => {
        const user = currentUser(req);
        if (!user) return res.status(401).json({error: 'ログインしてください'});
        if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) return res.status(400).json({error: 'プロジェクトデータが不正です'});
        const projects = readProjects();
        const id = String(Date.now()) + String(crypto.randomInt(100, 999));
        const title = String(req.query.title || '無題のプロジェクト').slice(0, 100);
        const stamp = new Date().toISOString();
        projects[id] = {id, ownerId: user.id, username: user.username, title, description: '', visibility: 'private', shared: false, projectJson: req.body, createdAt: stamp, updatedAt: stamp};
        writeProjects(projects);
        return res.status(200).json({'content-name': id});
    });
    app.put('/projects-data/:id', (req, res) => {
        const user = currentUser(req);
        if (!user) return res.status(401).json({error: 'ログインしてください'});
        const projects = readProjects(), project = projects[req.params.id];
        if (!project) return res.status(404).json({error: 'プロジェクトが見つかりません'});
        if (project.username.toLowerCase() !== user.username.toLowerCase()) return res.sendStatus(403);
        if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) return res.status(400).json({error: 'プロジェクトデータが不正です'});
        project.projectJson = req.body;
        if (req.query.title) project.title = String(req.query.title).slice(0, 100);
        project.updatedAt = new Date().toISOString();
        writeProjects(projects);
        return res.status(200).json({'content-name': project.id});
    });
    app.get('/projects-data/:id', async (req, res) => {
        const project = readProjects()[req.params.id];
        if (!project || (project.visibility !== 'public' && !project.shared && currentUser(req)?.username.toLowerCase() !== project.username.toLowerCase())) return res.sendStatus(404);
        const zip = new JSZip();
        zip.file('project.json', JSON.stringify(project.projectJson));
        const assetNames = new Set();
        for (const target of project.projectJson.targets || []) {
            for (const asset of [...(target.costumes || []), ...(target.sounds || [])]) {
                if (typeof asset.md5ext === 'string' && /^[a-f0-9]{32}\.(?:svg|png|jpe?g|wav|mp3)$/i.test(asset.md5ext)) assetNames.add(asset.md5ext);
            }
        }
        await Promise.all([...assetNames].map(async name => {
            const response = await fetch(`${ASSET_HOST}/${encodeURIComponent(name)}`, {signal: AbortSignal.timeout(12000)});
            if (!response.ok) throw new Error(`プロジェクト素材 ${name} を取得できません (HTTP ${response.status})`);
            zip.file(name, Buffer.from(await response.arrayBuffer()));
        }));
        const bytes = await zip.generateAsync({type: 'nodebuffer', compression: 'DEFLATE'});
        res.set({'Content-Type': 'application/octet-stream', 'Content-Length': bytes.length, 'Cache-Control': 'no-store'});
        return res.send(bytes);
    });

    // API endpoints expected by the Scratch WWW profile and project views.
    app.get('/scratch-api/users/:username', (req, res) => {
        const db = localAuth.load(), user = db.users[String(req.params.username).toLowerCase()];
        if (!user) return res.status(404).json({code: 'NotFound', message: 'User not found'});
        const projects = Object.values(readProjects()).filter(project => project.username.toLowerCase() === user.username.toLowerCase() && project.shared);
        return res.json({id: user.id, username: user.username, profile: {
            id: user.id, images: { '90x90': user.avatarUrl || '/images/logo_sm.png', '60x60': user.avatarUrl || '/images/logo_sm.png' },
            status: user.status || '', bio: user.bio || '', country: user.country || ''
        }, history: {joined: user.dateJoined || null}, projectCount: projects.length});
    });
    app.get('/scratch-api/projects/:id', (req, res) => {
        const project = readProjects()[req.params.id];
        if (!project || (!project.shared && currentUser(req)?.username.toLowerCase() !== project.username.toLowerCase())) return res.status(404).json({code: 'NotFound', message: 'Project not found'});
        return res.json(publicProject(project));
    });
    app.get('/site-api/users/:username', (req, res) => {
        const db = localAuth.load(), user = db.users[String(req.params.username).toLowerCase()];
        if (!user) return res.status(404).json({error: 'ユーザーが見つかりません'});
        const projects = Object.values(readProjects()).filter(project => project.username.toLowerCase() === user.username.toLowerCase() && project.shared).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        return res.json({user: {username: user.username, bio: user.bio || '', status: user.status || '', country: user.country || '', avatarUrl: user.avatarUrl || null, joined: user.dateJoined}, projects: projects.map(publicProject)});
    });
    app.get('/site-api/mystuff', (req, res) => {
        const user = currentUser(req);
        if (!user) return res.status(401).json({error: 'ログインしてください'});
        const projects = Object.values(readProjects()).filter(project => project.username.toLowerCase() === user.username.toLowerCase()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        return res.json({projects: projects.map(publicProject)});
    });
    app.patch('/site-api/projects/:id', express.json({limit: '64kb'}), (req, res) => {
        const user = currentUser(req);
        if (!user) return res.status(401).json({error: 'ログインしてください'});
        const projects = readProjects(), project = projects[req.params.id];
        if (!project) return res.status(404).json({error: 'プロジェクトが見つかりません'});
        if (project.username.toLowerCase() !== user.username.toLowerCase()) return res.sendStatus(403);
        if (typeof req.body.title === 'string') project.title = req.body.title.trim().slice(0, 100) || '無題のプロジェクト';
        if (typeof req.body.description === 'string') project.description = req.body.description.slice(0, 2000);
        if (typeof req.body.shared === 'boolean') project.shared = req.body.shared;
        project.updatedAt = new Date().toISOString();
        writeProjects(projects);
        return res.json({project: publicProject(project)});
    });

    app.patch('/site-api/account', express.json({limit: '64kb'}), (req, res) => {
        const user = currentUser(req);
        if (!user) return res.status(401).json({error: 'ログインしてください'});
        const db = localAuth.load(), stored = db.users[user.username.toLowerCase()];
        for (const field of ['bio', 'status', 'country', 'avatarUrl']) {
            if (typeof req.body[field] === 'string') stored[field] = req.body[field].slice(0, field === 'bio' ? 2000 : 300);
        }
        if (typeof req.body.email === 'string') {
            if (req.body.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(req.body.email)) return res.status(400).json({error: 'メールアドレスの形式が正しくありません'});
            stored.email = req.body.email;
        }
        if (req.body.newPassword) {
            if (!stored.hash || typeof req.body.currentPassword !== 'string') return res.status(400).json({error: '現在のパスワードを入力してください'});
            const current = crypto.scryptSync(req.body.currentPassword, stored.salt, 32).toString('hex');
            if (current !== stored.hash) return res.status(400).json({error: '現在のパスワードが違います'});
            if (String(req.body.newPassword).length < 6 || String(req.body.newPassword).length > 200) return res.status(400).json({error: '新しいパスワードは6〜200文字で指定してください'});
            stored.salt = crypto.randomBytes(16).toString('hex');
            stored.hash = crypto.scryptSync(req.body.newPassword, stored.salt, 32).toString('hex');
        }
        localAuth.save(db);
        // Keep the Sit identity profile in step with the shared ScratchWWW account.
        const sitData = path.resolve(process.env.SITHUB_DATA_DIR || path.join(__dirname, '../sithub/data'));
        const sitUsersFile = path.join(sitData, 'users.json');
        try {
            const sitUsers = JSON.parse(fs.readFileSync(sitUsersFile, 'utf8'));
            const identity = `scratch-local:${stored.username.toLowerCase()}`;
            const linked = Object.values(sitUsers).find(row => (row.externalIdentities || []).includes(identity));
            if (linked) {
                linked.bio = stored.bio || '';
                linked.displayName = stored.username;
                if (stored.avatarUrl) linked.avatarUrl = stored.avatarUrl;
                fs.writeFileSync(sitUsersFile, JSON.stringify(sitUsers, null, 2), {mode: 0o600});
            }
        } catch (error) {
            if (error.code !== 'ENOENT') console.warn('[Scratch profile] Sit profile sync failed:', error.message);
        }
        return res.json({ok: true});
    });

    app.get('/users/:username/', (req, res) => {
        const user = localAuth.load().users[String(req.params.username).toLowerCase()];
        if (!user) return res.status(404).send(pageShell('ユーザーが見つかりません', '', '<section class="panel"><h1>ユーザーが見つかりません</h1><a class="btn" href="/">ホームへ戻る</a></section>', currentUser(req)));
        const content = `<section class="panel"><div class="profile-head"><img class="avatar" src="${esc(user.avatarUrl || '/images/logo_sm.png')}" alt=""><div><h1>${esc(user.username)}</h1><p>${esc(user.status || '')}</p><p class="muted">${esc(user.country || '')}</p></div><span class="grow"></span>${currentUser(req)?.username.toLowerCase() === user.username.toLowerCase() ? '<a class="btn secondary" href="/accounts/settings/">プロフィールを編集</a>' : ''}</div><hr style="border:0;border-top:1px solid #eee;margin:22px 0"><h2>自己紹介</h2><p>${esc(user.bio || 'まだ自己紹介はありません。').replace(/\n/g, '<br>')}</p></section><section class="panel"><h2>共有されたプロジェクト</h2><div id="profile-projects" class="grid"><div class="empty">読み込み中...</div></div></section><script>fetch('/site-api/users/${encodeURIComponent(user.username)}').then(r=>r.json()).then(d=>{const root=document.getElementById('profile-projects');root.innerHTML=d.projects.length?d.projects.map(p=>'<article class="project"><a href="/projects/'+encodeURIComponent(p.id)+'/"><img src="'+(p.image||'/images/create_a_project.svg')+'" alt=""></a><div class="meta"><a href="/projects/'+encodeURIComponent(p.id)+'/">'+${JSON.stringify('')}+' </a><p>'+new Date(p.modified).toLocaleDateString()+'</p></div></article>').join(''):'<div class="empty">共有されたプロジェクトはありません。</div>';root.querySelectorAll('.project .meta a').forEach((a,i)=>a.textContent=d.projects[i].title) }).catch(()=>{document.getElementById('profile-projects').innerHTML='<div class="empty">プロジェクトを読み込めませんでした。</div>'});</script>`;
        return res.send(pageShell(`${user.username} のプロフィール`, 'profile', content, currentUser(req)));
    });

    app.get('/mystuff/', (req, res) => {
        const user = currentUser(req);
        if (!user) return res.redirect('/auth/');
        const content = `<section class="panel"><div class="row"><h1 class="grow">私の作品</h1><a class="btn" href="/projects/editor/">新しいプロジェクト</a></div><div class="tabs"><a class="active" href="/mystuff/">すべて</a><a href="/mystuff/?filter=shared">共有済み</a><a href="/mystuff/?filter=unshared">未共有</a></div><div id="my-projects" class="grid"><div class="empty">読み込み中...</div></div></section><script>fetch('/site-api/mystuff').then(r=>{if(!r.ok)throw Error('作品一覧を取得できません');return r.json()}).then(d=>{const filter=new URLSearchParams(location.search).get('filter');const rows=d.projects.filter(p=>!filter||(filter==='shared'?p.shared:!p.shared));const root=document.getElementById('my-projects');root.innerHTML=rows.length?rows.map(p=>'<article class="project"><a href="/projects/'+encodeURIComponent(p.id)+'/editor/"><img src="'+(p.image||'/images/create_a_project.svg')+'" alt=""></a><div class="meta"><a href="/projects/'+encodeURIComponent(p.id)+'/editor/">'+String(p.title).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))+'</a><p>'+(p.shared?'共有済み':'未共有')+' · '+new Date(p.modified).toLocaleDateString()+'</p><button class="btn secondary share-toggle" data-id="'+p.id+'" data-shared="'+p.shared+'">'+(p.shared?'共有をやめる':'共有する')+'</button></div></article>').join(''):'<div class="empty">プロジェクトはまだありません。「新しいプロジェクト」から作成できます。</div>'}).catch(e=>{document.getElementById('my-projects').innerHTML='<div class="empty">'+e.message+'</div>'});document.getElementById('my-projects').addEventListener('click',async e=>{const b=e.target.closest('.share-toggle');if(!b)return;b.disabled=true;try{const r=await fetch('/site-api/projects/'+encodeURIComponent(b.dataset.id),{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({shared:b.dataset.shared!=='true'})});const d=await r.json();if(!r.ok)throw Error(d.error||'更新できません');location.reload()}catch(err){b.disabled=false;alert(err.message)}});</script>`;
        return res.send(pageShell('私の作品', 'mystuff', content, user));
    });

    app.get('/accounts/settings/', (req, res) => {
        const user = currentUser(req);
        if (!user) return res.redirect('/auth/');
        const content = `<section class="panel"><h1>アカウント設定</h1><div class="tabs"><a class="active" href="/accounts/settings/">プロフィール</a><a href="#account">アカウント</a></div><form id="profile-form"><div class="field"><label for="status">ひとこと</label><input id="status" name="status" maxlength="300" value="${esc(user.status || '')}"></div><div class="field"><label for="bio">自己紹介</label><textarea id="bio" name="bio" maxlength="2000">${esc(user.bio || '')}</textarea></div><div class="field"><label for="country">国・地域</label><input id="country" name="country" maxlength="100" value="${esc(user.country || '')}"></div><div class="field"><label for="avatarUrl">プロフィール画像URL</label><input id="avatarUrl" name="avatarUrl" type="url" value="${esc(user.avatarUrl || '')}"></div><div class="field"><label for="email">メールアドレス</label><input id="email" name="email" type="email" value="${esc(user.email || '')}"></div><details style="margin:18px 0"><summary>パスワードを変更</summary><div class="field" style="margin-top:14px"><label for="currentPassword">現在のパスワード</label><input id="currentPassword" name="currentPassword" type="password" autocomplete="current-password"></div><div class="field"><label for="newPassword">新しいパスワード</label><input id="newPassword" name="newPassword" type="password" minlength="6" maxlength="200" autocomplete="new-password"></div></details><button class="btn" type="submit">変更を保存</button><span id="save-status" class="muted" role="status"></span></form><hr style="border:0;border-top:1px solid #eee;margin:28px 0"><div id="account"><h2>アカウント</h2><p>ユーザー名: <strong>${esc(user.username)}</strong></p><p class="muted">アカウント作成日: ${esc(user.dateJoined || '')}</p><form method="post" action="/accounts/logout/"><button class="btn secondary" type="submit">ログアウト</button></form></div></section><script>document.getElementById('profile-form').addEventListener('submit',async e=>{e.preventDefault();const f=new FormData(e.currentTarget);const body=Object.fromEntries(f.entries());const status=document.getElementById('save-status');status.textContent='保存中...';try{const r=await fetch('/site-api/account',{method:'PATCH',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify(body)});const d=await r.json();if(!r.ok)throw Error(d.error||'保存できませんでした');status.textContent='保存しました';}catch(err){status.textContent=err.message}});</script>`;
        return res.send(pageShell('アカウント設定', 'settings', content, user));
    });
};

module.exports = {attach};
