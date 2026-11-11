// 用法:
//   node render.mjs still  <scene> <t1,t2,...> <outDir>       # 输出若干静帧 PNG（调试用）
//   node render.mjs clip   <scene> <out.mp4> [fps] [cap]       # 渲染一个场景为无声 MP4（cap=1 烧录字幕）
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = pathToFileURL(path.join(here, '..', 'anim.html')).href;
const CHROME = process.env.CHROME_BIN ||
  `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;

const [mode, sceneArg, a3, a4, a5] = process.argv.slice(2);
const si = Number(sceneArg);
const cap = (mode === 'clip' ? a5 : a4) === '1' || (mode === 'still' && process.argv[6] === '1');

const browser = await chromium.launch({ executablePath: CHROME, args: ['--force-device-scale-factor=1', '--font-render-hinting=none'] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
page.on('pageerror', e => console.error('PAGE ERROR', e.message));
page.on('console', m => { if (m.type() === 'error') console.error('CONSOLE', m.text()); });
await page.goto(html + `?render=1${cap ? '&cap=1' : ''}`);
const info = await page.evaluate(i => buildScene(i), si);

if (mode === 'still') {
  const out = a4; fs.mkdirSync(out, { recursive: true });
  for (const t of a3.split(',').map(Number)) {
    await page.evaluate(t => setT(t), t);
    await page.screenshot({ path: path.join(out, `s${si + 1}_${String(t).replace('.', '_')}.png`) });
  }
  console.log('scene', si, 'duration', info.D);
} else {
  const out = a3, fps = Number(a4 || 30), frames = Math.round(info.D * fps);
  const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', '-',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '17', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out], { stdio: ['pipe', 'inherit', 'inherit'] });
  for (let f = 0; f < frames; f++) {
    await page.evaluate(t => setT(t), f / fps);
    const buf = await page.screenshot({ type: 'jpeg', quality: 94 });
    if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once('drain', r));
    if (f % 300 === 0) console.log(`scene ${si} frame ${f}/${frames}`);
  }
  ff.stdin.end(); await new Promise(r => ff.on('close', r));
  console.log('done', out, info.D.toFixed(1) + 's');
}
await browser.close();
