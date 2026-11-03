// Node.js для тех, у кого его нет: официальная сборка в своей папке, без прав администратора и без правок системного Node.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addToPath, nodeBinDir, nodeHome, prependPath, which } from '../env.js';
import { run } from '../proc.js';
import type { NodeInfo, NodeInstallResult } from '../types.js';

const VERSION = '22.23.4';
const DIST_URL = `https://nodejs.org/dist/v${VERSION}`;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

/** Суммы зашиты, а не скачиваются рядом с архивом: подмена на стороне сервера или в сети не пройдёт незамеченной. */
const SHA256: Record<string, string> = {
  'darwin-arm64': 'c9e1dbc748b33ed2d14f42445191ecaf14c56259c7a9a26d0042c49ec2b66428',
  'darwin-x64': 'efcc2b0db6f94bf53eddb038fe2b370277a042bd29e4f19b8f8e23598795b819',
  'linux-arm64': 'f7a1e486dbc8b286847815b477d4fb5e9fb963ed4489c3e1588853d685f589f9',
  'linux-x64': 'b8492284c76a54baf58d61668dd0e41ee0fc98adabf9503d30f05d08f55b4406',
  'win-arm64': 'a8b8cd79cbbb3062435f449591d98dd63730bbbf30ce2d7cc3a6376c236cb111',
  'win-x64': 'cbc74b5e0982c9dbb41525fd8fb5dcd32fbee237863f7829072f4639a1ce5f20',
};

export interface NodeDist {
  url: string;
  sha256: string;
}

export function nodeDist(platform: string = process.platform, arch: string = process.arch): NodeDist | null {
  const key = `${platform === 'win32' ? 'win' : platform}-${arch}`;
  const sha256 = SHA256[key];
  if (!sha256) return null;
  return { url: `${DIST_URL}/node-v${VERSION}-${key}.${platform === 'win32' ? 'zip' : 'tar.gz'}`, sha256 };
}

/** Node без npm ничего не поставит, поэтому найденным считаем только пару. */
export async function detectNode(env: NodeJS.ProcessEnv): Promise<NodeInfo> {
  const node = which('node', env);
  if (!node || !which('npm', env)) return { path: null, version: null };
  const r = await run(node, ['--version'], { cwd: os.homedir(), env: prependPath(env, path.dirname(node)), timeoutMs: 15_000 });
  return r.code === 0 ? { path: node, version: r.stdout.trim().replace(/^v/, '') } : { path: null, version: null };
}

export async function installNode(env: NodeJS.ProcessEnv, dist: NodeDist | null = nodeDist()): Promise<NodeInstallResult> {
  if (!dist) return { ok: false, error: `Для ${process.platform}-${process.arch} нет готовой сборки. Установите Node.js с nodejs.org.` };
  const home = nodeHome();
  fs.mkdirSync(path.dirname(home), { recursive: true });
  // Распаковка рядом с итоговой папкой: перенос внутри одного диска атомарен, и оборванная установка не оставит половину Node.
  const tmp = fs.mkdtempSync(`${home}-`);
  try {
    const res = await fetch(dist.url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!res.ok) return { ok: false, error: `Не удалось скачать Node.js: HTTP ${res.status}.` };
    const data = Buffer.from(await res.arrayBuffer());
    if (createHash('sha256').update(data).digest('hex') !== dist.sha256) {
      return { ok: false, error: 'Контрольная сумма Node.js не совпала, архив не установлен.' };
    }
    const archive = path.join(tmp, path.basename(new URL(dist.url).pathname));
    fs.writeFileSync(archive, data);
    const out = path.join(tmp, 'node');
    fs.mkdirSync(out);
    // Системный tar Windows умеет zip, а tar из Git, который может стоять первым в PATH, — нет.
    const tar = process.platform === 'win32' ? path.join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
    const r = await run(tar, ['-xf', archive, '-C', out, '--strip-components=1'], { cwd: tmp, env, timeoutMs: 5 * 60_000 });
    if (r.spawnError || r.code !== 0)
      return { ok: false, error: `Не удалось распаковать Node.js: ${(r.spawnError || r.stderr).trim().slice(-300)}` };
    fs.rmSync(home, { recursive: true, force: true });
    fs.renameSync(out, home);
    addToPath(env, nodeBinDir());
    const info = await detectNode(env);
    return info.path ? { ok: true, info } : { ok: false, error: 'Node.js распакован, но не запускается.' };
  } catch (e) {
    return { ok: false, error: `Не удалось установить Node.js: ${(e as Error).message}` };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
