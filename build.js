const fs = require('fs');
const html = fs.readFileSync('index.html', 'utf8');
let worker = fs.readFileSync('worker.js', 'utf8');

// 用 JSON.stringify 安全转义 HTML，然后注入
const jsonHtml = JSON.stringify(html);
// 替换 `PLACEHOLDER_HTML` 为 JSON 字符串形式
worker = worker.replace('`PLACEHOLDER_HTML`', jsonHtml);

fs.writeFileSync('dist-worker.js', worker);
console.log('Build OK, output size:', worker.length, 'bytes');

if (worker.includes('PLACEHOLDER_HTML')) {
  console.error('ERROR: placeholder not replaced!');
  process.exit(1);
}
