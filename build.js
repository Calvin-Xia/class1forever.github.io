const fs = require('fs');
const path = require('path');

const filesToCheck = [
    path.join(__dirname, 'index.html'),
    path.join(__dirname, 'js', 'map.js'),
    path.join(__dirname, 'functions', 'api', 'map', 'public.js')
];

for (const filePath of filesToCheck) {
    if (!fs.existsSync(filePath)) {
        console.error(`❌ 缺少必要文件: ${path.relative(__dirname, filePath)}`);
        process.exit(1);
    }
}

const indexHtml = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
if (indexHtml.includes('js/data.js')) {
    console.error('❌ index.html 仍在加载 js/data.js，生产环境不能再公开静态学生数据。');
    process.exit(1);
}

console.log('✅ 无需构建静态数据文件，地图数据将通过 Cloudflare Pages Functions + KV 提供');
