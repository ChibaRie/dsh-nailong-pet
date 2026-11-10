// 插件宿主半的进程控制回归测试。
//
// 用假的 ctx + 假的 127.0.0.1 控制服务器模拟「奶龙已经常驻」：
// 本进程没有 child 句柄，但控制通道可用。旧实现会在这里再次 spawn（单例锁让
// 第二实例退出，同时让常驻实例回右下角），并且 stop/toggle 完全失效。
//
// 隔离：APPDATA / DSH_HOME 指向临时目录，ELECTRON_PATH 指向不存在的文件，
// 任何意外的 spawn 都会立刻失败而不是真的拉起一只奶龙。
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'nailong-plugin-'));
process.env.APPDATA = join(root, 'appdata');
process.env.DSH_HOME = join(root, 'dsh');
process.env.NAILONG_ELECTRON_PATH = join(root, 'no-such-electron.exe');

const { apply } = await import('../index.js');

const controlFile = join(process.env.APPDATA, 'nailong-desktop-pet', 'control.json');
const hostChatFile = join(process.env.DSH_HOME, 'nailong-pet', 'host-chat.json');
const seen = [];

const control = createServer((req, res) => {
  seen.push(req.url);
  const body = JSON.stringify(req.url === '/state'
    ? { ok: true, bounds: { x: 0, y: 0, width: 170, height: 180 }, visible: true }
    : { ok: true });
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(body);
});
await new Promise((resolve) => control.listen(0, '127.0.0.1', resolve));
mkdirSync(join(process.env.APPDATA, 'nailong-desktop-pet'), { recursive: true });
writeFileSync(controlFile, JSON.stringify({ v: 1, port: control.address().port, pid: 424242 }));

let routeCfg = null;
let commandCfg = null;
const disposers = [];
const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  effect(fn) {
    const d = fn();
    if (typeof d === 'function') disposers.push(d);
    return d;
  },
  webServer: {
    register(cfg) { routeCfg = cfg; return () => {}; },
  },
  commands: {
    register(cfg) { commandCfg = cfg; return () => {}; },
  },
};

apply(ctx, { autoStart: false });
assert.ok(routeCfg, 'webServer.register 未被调用');
assert.ok(commandCfg, 'commands.register 未被调用');

/** 调一次插件路由，返回解析后的 JSON。 */
async function route(pathAndQuery) {
  let out = '';
  const res = {
    writeHead() {},
    end(chunk) { out += chunk; },
  };
  await routeCfg.handler({ url: routeCfg.path + pathAndQuery }, res);
  return JSON.parse(out);
}

async function waitFor(check, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

after(async () => {
  for (const d of disposers) { try { d(); } catch (_) { /* 已关闭 */ } }
  await new Promise((r) => control.close(r));
  rmSync(root, { recursive: true, force: true });
});

test('start: 已有常驻奶龙时只探测，不再 spawn', async () => {
  const r = await route('/start');
  assert.equal(r.ok, true);
  assert.equal(r.already, true);
  assert.equal(r.ready, true);
});

test('action: 直接走控制通道', async () => {
  const r = await route('/action?key=wave');
  assert.deepEqual(r, { ok: true });
  assert.ok(seen.includes('/action?key=wave'));
});

test('stop: 没有 child 句柄时通过控制通道 /quit', async () => {
  const before = seen.filter((u) => u === '/quit').length;
  const r = await route('/stop');
  assert.equal(r.ok, true);
  assert.equal(r.running, false);
  assert.equal(seen.filter((u) => u === '/quit').length, before + 1);
});

test('toggle: 常驻奶龙能被关掉', async () => {
  const r = await route('/toggle');
  assert.equal(r.ok, true);
  assert.equal(r.running, false);
});

test('/nailong 无参数: 关闭常驻奶龙并返回成功', async () => {
  const before = seen.filter((u) => u === '/quit').length;
  const r = await commandCfg.handler({ rawInput: '' });
  assert.equal(r.kind, 'success');
  assert.match(r.text, /回家|睡觉/);
  assert.equal(seen.filter((u) => u === '/quit').length, before + 1);
});

test('卸载清理: 删掉属于本进程的 host-chat.json', async () => {
  assert.ok(await waitFor(() => existsSync(hostChatFile)), 'host-chat.json 未被写出');
  for (const d of disposers) { try { d(); } catch (_) { /* 已关闭 */ } }
  disposers.length = 0;
  assert.equal(existsSync(hostChatFile), false);
});
