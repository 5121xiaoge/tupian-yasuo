// Installs Git hooks only inside a Git checkout.
// Source-only delivery packages have no .git directory, and husky 7 exits with
// an error there, which used to break a plain `npm ci`.
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
if (process.env.HUSKY === '0' || !fs.existsSync(path.join(root, '.git'))) {
  process.exit(0);
}
try {
  require('husky').install();
} catch (err) {
  console.warn(`Git hooks not installed: ${err.message}`);
}
