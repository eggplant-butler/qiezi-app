const fs = require('fs');
const serverCode = fs.readFileSync('/workspace/qiezi-app/server.js', 'utf8');

const startMarker = "res.send(`";
const endMarker = "`);";

const startIndex = serverCode.indexOf(startMarker);
const endIndex = serverCode.lastIndexOf(endMarker);

if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
    let html = serverCode.substring(startIndex + startMarker.length, endIndex);
    // 还原模板字符串中的转义
    html = html.replace(/\\`/g, '`').replace(/\\\$/g, '$').replace(/\\\\/g, '\\');
    fs.writeFileSync('/workspace/qiezi-app/frontend/index.html', html, 'utf8');
    console.log('frontend/index.html updated, length:', html.length);
} else {
    console.error('Markers not found');
    process.exit(1);
}
