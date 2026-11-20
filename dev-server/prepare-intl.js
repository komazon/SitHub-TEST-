// 起動前に intl/ (翻訳ファイル) と bin/lib/localized-urls.json を用意する。
// webpack.config.js の CopyWebpackPlugin が {from: 'intl'} を参照するため、無いと
// "unable to locate '.../intl' glob" で失敗する。
const fs = require('fs');
const path = require('path');
const https = require('https');
const {spawnSync} = require('child_process');

const root = path.resolve(__dirname, '..');
const intlDir = path.join(root, 'intl');
const urlsFile = path.join(root, 'bin', 'lib', 'localized-urls.json');

const fetchUrls = () => new Promise(resolve => {
    const req = https.get('https://resources.scratch.mit.edu/localized-urls.json', {timeout: 8000}, res => {
        if (res.statusCode !== 200) {
            res.resume();
            return resolve(null);
        }
        let data = '';
        res.setEncoding('utf8');
        res.on('data', c => (data += c));
        res.on('end', () => {
            try {
                resolve(JSON.parse(data));
            } catch (e) {
                resolve(null);
            }
        });
    });
    req.on('timeout', () => {
        req.destroy();
        resolve(null);
    });
    req.on('error', () => resolve(null));
});

module.exports = async () => {
    const hasIntl = fs.existsSync(intlDir) && fs.readdirSync(intlDir).some(f => f.endsWith('.intl.js'));
    if (hasIntl) return;

    if (!fs.existsSync(urlsFile)) {
        let urls = await fetchUrls();
        if (!urls) {
            process.stdout.write('[prepare-intl] localized-urls を取得できないため英語のみの空データを使用します\n');
            urls = {en: {}};
        }
        fs.writeFileSync(urlsFile, JSON.stringify(urls, null, '  '));
    }

    fs.mkdirSync(intlDir, {recursive: true});
    process.stdout.write('[prepare-intl] intl/ を生成しています...\n');
    const result = spawnSync(
        process.execPath,
        [path.join(root, 'bin', 'build-locales'), 'node_modules/scratch-l10n/www', 'intl'],
        {cwd: root, stdio: 'inherit'}
    );
    if (result.status !== 0) {
        throw new Error('intl の生成に失敗しました (bin/build-locales, exit ' + result.status + ')。npm install 済みか確認してください');
    }
};
