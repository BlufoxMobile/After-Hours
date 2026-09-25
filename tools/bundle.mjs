// Bundle an ES-module entry (and everything it imports, incl. three) into ONE self-contained HTML file.
// usage: node tools/bundle.mjs <entry.js> <out.html> [--shell shell.html] [--minify]
import * as esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';
const args = process.argv.slice(2);
const entry = args[0], out = args[1];
const shellIdx = args.indexOf('--shell');
const minify = args.includes('--minify');
if (!entry || !out) { console.error('usage: node tools/bundle.mjs <entry.js> <out.html> [--shell file] [--minify]'); process.exit(1); }
const res = await esbuild.build({
  entryPoints: [entry], bundle: true, format: 'iife', write: false, minify,
  target: ['es2020', 'safari15'], legalComments: 'none', logLevel: 'warning',
  nodePaths: [path.resolve('node_modules')], loader: { '.webp': 'dataurl', '.png': 'dataurl', '.jpg': 'dataurl', '.css': 'text' },
});
let js = res.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
let shell = shellIdx >= 0 ? fs.readFileSync(args[shellIdx + 1], 'utf8') :
`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
<style>html,body{margin:0;height:100%;background:#05060c;overflow:hidden}canvas{display:block;width:100%;height:100%}</style></head>
<body><div id="app" style="position:fixed;inset:0"></div><!--SCRIPT--></body></html>`;
if (!shell.includes('<!--SCRIPT-->')) throw new Error('shell needs <!--SCRIPT--> marker');
const html = shell.replace('<!--SCRIPT-->', () => `<script>${js}</script>`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html);
console.log(`wrote ${out} ${(html.length / 1024).toFixed(0)} KB`);
