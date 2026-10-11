'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const source = path.join(root, 'client');
// The browser assets are already deployable. Serve client/ directly, so the
// output exists in a fresh Git checkout without any generated public/ folder.
for (const file of ['index.html', 'style.css', 'graph.js', 'icons.js', 'favicon.svg', 'vendor/cytoscape.min.js']) {
  if (!fs.statSync(path.join(source, file)).isFile()) throw new Error(`Missing frontend asset: ${file}`);
}
console.log('Frontend assets verified in client/; API entry is api/index.js.');
