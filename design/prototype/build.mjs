// Bundles index.html + css + js into one self-contained file: dist/index.html
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(fileURLToPath(import.meta.url));
let html = readFileSync(join(root, 'index.html'), 'utf8');
html = html.replace(/<link rel="stylesheet" href="(css\/[^"]+)">/g, (m, p) => '<style>\n' + readFileSync(join(root, p), 'utf8') + '\n</style>');
html = html.replace(/<script src="(js\/[^"]+)"><\/script>/g, (m, p) => '<script>\n' + readFileSync(join(root, p), 'utf8').replace(/<\/script>/g, '<\\/script>') + '\n</script>');
mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(join(root, 'dist', 'index.html'), html);
console.log('wrote dist/index.html', (html.length / 1024).toFixed(0), 'KB');

// Second output: dist/artifact.html — the same page without the document skeleton,
// for hosts that wrap the file in their own <html>/<head>/<body> (claude.ai artifacts).
const inner = html
  .replace(/^[\s\S]*?<head>/, '').replace(/<meta[^>]*>\s*/g, '')
  .replace(/<\/head>\s*<body>/, '').replace(/<\/body>\s*<\/html>\s*$/, '');
writeFileSync(join(root, 'dist', 'artifact.html'), inner);
console.log('wrote dist/artifact.html', (inner.length / 1024).toFixed(0), 'KB');
