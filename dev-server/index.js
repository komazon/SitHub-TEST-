const express = require('express');
const proxy = require('express-http-proxy');
const webpackDevMiddleware = require('webpack-dev-middleware');
const webpack = require('webpack');

<<<<<<< HEAD
const prepareIntl = require('./prepare-intl');
const localApi = require('./local-api');
const localAuth = require('./local-auth');
const handler = require('./handler');
const log = require('./log');
const sithub = require('../sithub/server.cjs');
const scratchPages = require('./scratch-pages');
=======
const compiler = webpack(require('../webpack.config.js'));
const handler = require('./handler');
const log = require('./log');
>>>>>>> 0c341c888eafddd30bd8e462800c2f0069484693
const routes = require('../src/routes').concat(require('../src/routes-dev'))
    .filter(route => !process.env.VIEW || process.env.VIEW === route.view);

// Create server
const app = express();
app.disable('x-powered-by');

// Server setup
app.use(log());

<<<<<<< HEAD
// Scratch 2.0-era account/profile pages and local project storage.
scratchPages.attach(app);

// Sit Git API embedded in ScratchWWW project pages.
sithub.attach(app);

// ローカル認証/セッションAPI + 本家APIへの転送 (API_HOST=/scratch-api)
localApi.attach(app);
localAuth.attach(app); // ScratchAuth / OAuth 2.0 ログイン (/auth/)

=======
>>>>>>> 0c341c888eafddd30bd8e462800c2f0069484693
// Bind routes
routes.forEach(route => {
    app.get(route.pattern, handler(route));
});

const middlewareOptions = {};

<<<<<<< HEAD
const proxyHost = process.env.FALLBACK || '';

// Initialize persistent SitHub data before accepting requests.
const port = process.env.PORT || 8333;
prepareIntl().then(() => {
    // intl/ が揃ってから webpack の設定を読み込む
    // webpack.config.js が API_HOST を埋め込むため、読み込み前に設定する
    process.env.API_HOST = process.env.API_HOST || '/scratch-api';
    process.env.PROJECT_HOST = process.env.PROJECT_HOST || '/projects-data';
    const compiler = webpack(require('../webpack.config.js'));
    app.use(webpackDevMiddleware(compiler, middlewareOptions));
    if (proxyHost !== '') {
        // Fall back to scratchr2 in development
        // This proxy middleware must come last
        app.use('/', proxy(proxyHost));
    }
    return sithub.init();
}).then(() => {
    app.listen(port, () => {
        process.stdout.write(`Server listening on port ${port}\n`);
        process.stdout.write(`ScratchWWW + Sit Git: http://localhost:${port}/\n`);
        if (proxyHost) process.stdout.write(`Proxy host: ${proxyHost}\n`);
    });
}).catch(error => {
    process.stderr.write(`起動に失敗しました (SitHub/intl/webpack): ${error.stack || error}\n`);
    process.exitCode = 1;
=======
app.use(webpackDevMiddleware(compiler, middlewareOptions));

const proxyHost = process.env.FALLBACK || '';
if (proxyHost !== '') {
    // Fall back to scratchr2 in development
    // This proxy middleware must come last
    app.use('/', proxy(proxyHost));
}

// Start listening
const port = process.env.PORT || 8333;
app.listen(port, () => {
    process.stdout.write(`Server listening on port ${port}\n`);
    if (proxyHost) {
        process.stdout.write(`Proxy host: ${proxyHost}\n`);
    }
>>>>>>> 0c341c888eafddd30bd8e462800c2f0069484693
});
