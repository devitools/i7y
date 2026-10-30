import { readFileSync, writeFileSync } from 'node:fs';
const source = new URL('../packages/theme/palette.json', import.meta.url);
const target = new URL('../packages/theme/palette.css', import.meta.url);
const palette = JSON.parse(readFileSync(source, 'utf8'));
const block = name => Object.entries(palette[name]).map(([key,value]) => '--i7y-'+key+':'+value+';').join('');
const css = ':root{'+block('light')+'}.body--dark{'+block('dark')+'}\n';
if (process.argv.includes('--check')) { if (readFileSync(target, 'utf8') !== css) throw new Error('Palette CSS is out of date'); } else writeFileSync(target, css);
