// node scripts/render-icons.mjs docs/images/icon.svg public/icon: the SVG as 16/32/48/128 PNGs.
import { readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
const [, , svgPath, outDir] = process.argv;
const svg = readFileSync(svgPath, 'utf8');
const browser = await chromium.launch();
const page = await browser.newPage();
for (const size of [16, 32, 48, 128]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`,
  );
  await page.screenshot({ path: `${outDir}/${size}.png`, omitBackground: true });
}
await browser.close();
