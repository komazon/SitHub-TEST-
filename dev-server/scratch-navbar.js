'use strict';

// Server-rendered counterpart of src/components/navigation/www/navigation.jsx.
// Keep the same DOM classes and asset paths so account pages use the exact
// ScratchWWW navigation stylesheet instead of maintaining a second design.
const escapeHtml = value => String(value == null ? '' : value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[character]));

const renderScratchNavbar = user => {
    const account = user ? `
        <li class="link right messages">
            <a href="/messages/" title="メッセージ">メッセージ</a>
        </li>
        <li class="link right mystuff">
            <a href="/mystuff/" title="私の作品">私の作品</a>
        </li>
        <li class="link right account-nav">
            <a class="ignore-react-onclickoutside user-info" href="#" data-account-toggle aria-haspopup="true" aria-expanded="false">
                <span class="avatar-wrapper"><img class="avatar" src="${escapeHtml(user.avatarUrl || '//uploads.scratch.mit.edu/get_image/user/2584924_24x24.png?v=1438702210.96')}" alt="" width="24" height="24"></span>
                <span class="profile-name">${escapeHtml(user.username)}</span>
            </a>
            <ul class="dropdown" data-account-menu>
                <li><a href="/users/${encodeURIComponent(user.username)}/">プロフィール</a></li>
                <li><a href="/mystuff/">私の作品</a></li>
                <li><a href="/accounts/settings/">アカウント設定</a></li>
                <li class="divider"><a href="/accounts/logout/">サインアウト</a></li>
            </ul>
        </li>` : `
        <li class="link right join"><a class="registrationLink" href="/join/">Scratchに参加</a></li>
        <li class="link right login-item"><a href="/auth/">サインイン</a></li>`;

    return `
<nav id="navigation" class="scratch-local-navbar" aria-label="Scratch navigation">
    <div class="inner ${user ? 'logged-in' : ''}">
        <ul>
            <li class="logo"><a aria-label="Scratch" href="/"></a></li>
            <li class="link create"><a href="/projects/editor/">作る</a></li>
            <li class="link explore"><a href="/explore/projects/all">見る</a></li>
            <li class="link ideas"><a href="/ideas">アイデア</a></li>
            <li class="search">
                <form class="form" action="/search/projects" method="get">
                    <button class="button btn-search" type="submit" aria-label="検索"></button>
                    <input class="input search-wrapper" type="text" name="q" placeholder="検索" aria-label="検索">
                </form>
            </li>
            ${account}
        </ul>
    </div>
</nav>
<style>
/* Match the desktop ScratchWWW account control even on compact page layouts. */
#navigation.scratch-local-navbar .account-nav .user-info:after {
    display: inline-block !important;
    flex: 0 0 20px;
    margin-left: 8px;
    background-image: url("/images/dropdown.png");
    background-repeat: no-repeat;
    background-position: center center;
    background-size: 50%;
    width: 20px;
    height: 20px;
    content: " ";
}
#navigation.scratch-local-navbar .account-nav .avatar {
    display: block;
    width: 24px;
    height: 24px;
    border-radius: 3px;
    object-fit: cover;
}
#navigation.scratch-local-navbar .account-nav .avatar-wrapper {
    display: inline-flex;
    flex: 0 0 24px;
    width: 24px;
    height: 24px;
    margin-right: 10px;
}
</style>
<script>
(() => {
    const toggle = document.querySelector('[data-account-toggle]');
    const menu = document.querySelector('[data-account-menu]');
    if (!toggle || !menu) return;
    const close = () => {
        menu.classList.remove('open');
        toggle.classList.remove('open');
        toggle.setAttribute('aria-expanded', 'false');
    };
    toggle.addEventListener('click', event => {
        event.preventDefault();
        const opening = !menu.classList.contains('open');
        menu.classList.toggle('open', opening);
        toggle.classList.toggle('open', opening);
        toggle.setAttribute('aria-expanded', String(opening));
    });
    document.addEventListener('click', event => {
        if (!event.target.closest('.account-nav')) close();
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape') close();
    });
})();
</script>`;
};

module.exports = renderScratchNavbar;
