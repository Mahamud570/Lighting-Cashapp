const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function walk(dir) {
    let results = [];
    const list = fs.readdirSync(dir);
    list.forEach(file => {
        const fullPath = path.join(dir, file);
        const stat = fs.statSync(fullPath);
        if (stat && stat.isDirectory()) {
            if (file !== 'node_modules' && file !== '.git') {
                results = results.concat(walk(fullPath));
            }
        } else if (file.endsWith('.js')) {
            results.push(fullPath);
        }
    });
    return results;
}

const root = path.resolve(__dirname, '..');
const files = walk(root);
let passCount = 0;

for (const f of files) {
    try {
        execSync(`node --check "${f}"`, { stdio: 'pipe' });
        passCount++;
    } catch (err) {
        console.error('SYNTAX ERROR in:', f, err.message);
        process.exit(1);
    }
}

console.log(`ALL ${passCount} JavaScript files pass node --check syntax verification perfectly.`);
