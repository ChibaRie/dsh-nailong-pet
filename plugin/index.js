/**
 * 奶龙桌宠 —— DSH 插件的宿主半。
 *
 * 干三件事：
 *   1. 随着 DSH 启动，把 `runtime/app` 这个 Electron 桌宠拉起来（插件卸载时把它收掉）；
 *   2. 注册 `/nailong` 人类命令：开关奶龙、换动作、叫回右下角；
 *   3. 注册一条本机 HTTP 路由，给 Web 半（client.js 的按钮）和外部脚本用。
 *
 * 两个必须照做的细节（都是 DSH 生态里踩出来的）：
 *   - 用 node:child_process 自己 spawn，不用 `ctx.subprocess.spawn`：那个服务销毁时会
 *     terminate 并 await 所有受管子进程，会把 DSH 的退出拖住；自己 spawn 才能精确决定
 *     什么时候收、收的是哪一只（见 stop）。
 *   - spawn 之前必须把 `ELECTRON_RUN_AS_NODE` 从 env 里**删掉**（不是置空）。
 *     置空会让 Electron 以 134 崩掉；'0'/'false'/'1' 都会让它进纯 Node 模式。
 *     DSH Desktop 自己的进程里就带着这个变量。
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'nailong-pet';
export const inject = ['webServer', 'commands', 'llm', 'agentDefaultModel'];

/** 路由前缀要够独特：同一张表里重复 (kind, path) 会在启动时 throw，拖垮整棵配置树 */
const ROUTE = '/nailong-pet-7f3a';
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)));
const APP_DIR = join(PACKAGE_ROOT, 'runtime', 'app');

/** 中文别名 → manifest 里的动作 key */
const ACTIONS = {
  打招呼: 'wave', 招手: 'wave', 挥手: 'wave',
  大笑: 'laugh', 笑: 'laugh', 开心: 'laugh',
  害羞: 'shy', 捂脸: 'shy',
  敲键盘: 'work', 打字: 'work', 工作: 'work',
  睡觉: 'sleep', 睡: 'sleep', 困了: 'sleep',
  走: 'walk', 走一走: 'walk',
  跑: 'run', 跑一跑: 'run',
  散步: 'stroll', 溜达: 'stroll', 悠闲散步: 'stroll',
  坐: 'sit', 坐一会: 'sit', 坐着: 'sit',
  发呆: 'idle3', 东张西望: 'idle2', 打哈欠: 'idle4', 待机: 'idle',
  随机: 'random', 随便: 'random',
};

/** 尺寸锁死在小（60%）：app 里的 LOCKED_SCALE 就是它，这里不再提供任何改大小的入口。 */
const LOCKED_SCALE = 0.6;

function electronPath() {
  if (process.env.NAILONG_ELECTRON_PATH) return process.env.NAILONG_ELECTRON_PATH;
  const home = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '', '.dsh');
  const candidates = [
    join(home, 'electron', 'electron.exe'),
    join(PACKAGE_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'),
  ];
  return candidates.find((p) => existsSync(p)) || null;
}

/** 奶龙是个 GUI 程序：没有显示服务就 spawn 只会瞬间崩溃，然后反复重启刷 core dump */
function hasGraphicalDisplay() {
  if (process.platform !== 'linux') return true;
  return !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY || process.env.DSH_PET_DESKTOP_FORCE);
}

function controlPort() {
  const base = process.env.APPDATA
    || process.env.XDG_CONFIG_HOME
    || join(process.env.HOME || '', '.config');
  try {
    const j = JSON.parse(readFileSync(join(base, 'nailong-desktop-pet', 'control.json'), 'utf8'));
    return Number(j && j.port) || 0;
  } catch (_) {
    return 0;
  }
}

/** 控制通道超时：文件里可能是死端口，命令/退出不能在这里无限等 */
const CONTROL_TIMEOUT_MS = 2000;

async function control(pathAndQuery) {
  const port = controlPort();
  if (!port) return { ok: false, error: '奶龙没在跑' };
  try {
    const r = await fetch(`http://127.0.0.1:${port}${pathAndQuery}`, {
      signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
    });
    return await r.json();
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

/** 常驻实例（不是本进程 spawn 的）也能通过控制通道判断在不在 */
async function probe() {
  if (!controlPort()) return false;
  const r = await control('/state');
  return !!(r && r.ok);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 新拉起的奶龙要 1~2s 才写好 control.json；动作命令不能立刻去 control */
async function waitForPet(ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await probe()) return true;
    await sleep(150);
  }
  return false;
}


// ---------------------------------------------------------------- 对话（LLM）
// 奶龙的对话能力：网页端把用户输入交给宿主，这里用 DSH 的 LLM 统一抽象层
// （ctx.llm + agentDefaultModel）生成一句回复，并把最近几轮记到本地 memory，
// 让下一轮能接着聊。dsh-llm 是宿主注入的模块，动态 import + 失败兜底，
// 保证即使拿不到 LLM 也不影响桌宠本体启动。
let llmHelpersPromise = null;
function importLlm() {
  if (!llmHelpersPromise) {
    llmHelpersPromise = import('@deepseek-ai/dsh-llm').catch((err) => {
      llmHelpersPromise = null;
      throw err;
    });
  }
  return llmHelpersPromise;
}

function dshHome() {
  return process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '', '.dsh');
}
function chatMemoryPath() {
  return join(dshHome(), 'nailong-pet', 'chat-memory.json');
}
function hostChatFile() {
  return join(dshHome(), 'nailong-pet', 'host-chat.json');
}
function readChatMemory() {
  try {
    const j = JSON.parse(readFileSync(chatMemoryPath(), 'utf8'));
    return Array.isArray(j && j.messages) ? j.messages : [];
  } catch (_) {
    return [];
  }
}
function writeChatMemory(messages) {
  try {
    mkdirSync(dirname(chatMemoryPath()), { recursive: true });
    writeFileSync(chatMemoryPath(), JSON.stringify({ messages }, null, 2));
  } catch (_) { /* 记不下来不影响聊天 */ }
}

const CHAT_MEMORY_LIMIT = 20;
const DEFAULT_PERSONA =
  '你是一只住在 Windows 桌面上的小奶龙，名叫“奶龙”。性格活泼、爱吃、爱玩，说话简短可爱（尽量 30 字以内），偶尔撒娇、用颜文字。用户用中文和你聊天，你就用中文回复，像真人闲聊一样自然。';

/** 生成一次对话回复；失败返回结构化原因，不伪造文案。 */
async function generateChat(ctx, persona, history, userText) {
  let helpers;
  try {
    helpers = await importLlm();
  } catch (err) {
    return { ok: false, error: '对话服务不可用（dsh-llm 未加载）：' + String((err && err.message) || err) };
  }
  const llm = ctx.llm;
  if (!llm || typeof llm.stream !== 'function') {
    return { ok: false, error: 'LLM 服务不可用' };
  }
  let sel = null;
  try {
    sel = ctx.agentDefaultModel && ctx.agentDefaultModel.currentSelection();
  } catch (_) { sel = null; }
  if (!sel || !sel.provider || !sel.model) {
    return { ok: false, error: '当前对话没有配置模型' };
  }
  const { BlockAssembler, createUserMessage, createAssistantMessage } = helpers;
  const historyMessages = history.map((m) =>
    m.role === 'user'
      ? createUserMessage({ content: [{ type: 'text', text: String(m.content || '') }], source: { kind: 'user' } })
      : createAssistantMessage({
          content: [{ type: 'text', text: String(m.content || '') }],
          source: { provider: sel.provider, model: sel.model },
        }),
  );
  const options = {
    provider: sel.provider,
    model: sel.model,
    sessionId: 'dsh-nailong-pet',
    messages: [
      ...historyMessages,
      createUserMessage({ content: [{ type: 'text', text: userText }], source: { kind: 'user' } }),
    ],
    system: persona,
    temperature: 1,
    signal: AbortSignal.timeout(60_000),
  };
  const assembler = new BlockAssembler();
  try {
    for await (const chunk of llm.stream(options)) assembler.push(chunk);
  } catch (err) {
    return { ok: false, error: '对话生成失败：' + String((err && err.message) || err) };
  }
  const text = assembler
    .blocks()
    .filter((b) => b.type === 'text')
    .map((b) => (b && typeof b.text === 'string' ? b.text : ''))
    .join('')
    .trim();
  if (!text) return { ok: false, error: '奶龙这次没想好说什么' };
  return { ok: true, text };
}

export function apply(ctx, config = {}) {
  const autoStart = config.autoStart !== false;
  /** 当前由本插件拉起来的 Electron 子进程 */
  let child = null;
  let childExe = null;

  const log = (level, msg) => {
    const fn = ctx.logger && ctx.logger[level];
    if (typeof fn === 'function') fn.call(ctx.logger, '[nailong-pet] ' + msg);
  };

  // 对话能力自检：把关键依赖的状态写进日志，便于排查「聊天没反应」。
  void (async () => {
    try {
      const m = await import('@deepseek-ai/dsh-llm');
      log('info', 'chat-diag dsh-llm=ok keys=' + Object.keys(m).slice(0, 8).join(','));
    } catch (err) {
      log('warn', 'chat-diag dsh-llm=FAIL ' + String((err && err.message) || err));
    }
    try {
      const sel = ctx.agentDefaultModel && ctx.agentDefaultModel.currentSelection();
      log('info', 'chat-diag agentDefaultModel=' + JSON.stringify(sel || null));
    } catch (err) {
      log('warn', 'chat-diag agentDefaultModel=ERR ' + String((err && err.message) || err));
    }
    log('info', 'chat-diag llm.stream=' + (ctx.llm && typeof ctx.llm.stream));
  })();

  // ---- 本机聊天服务：桌面端（Electron）用 ----
  // DSH webServer 会拦「插件自拉进程」的裸 HTTP 请求，桌面端不能直接打宿主路由，
  // 所以在 127.0.0.1 另开一个小服务，把端口写进文件供 Electron 读取。
  let hostChatServer = null;
  function startHostChatServer() {
    if (hostChatServer) return;
    const server = createServer(async (req, res) => {
      const reply = (obj, code) => {
        const body = JSON.stringify(obj);
        res.writeHead(code || 200, {
          'content-type': 'application/json; charset=utf-8',
          'content-length': Buffer.byteLength(body),
        });
        res.end(body);
      };
      try {
        const url = new URL(req.url, 'http://127.0.0.1');
        if (url.pathname !== '/chat') return reply({ ok: false, error: 'not found' }, 404);
        const text = (url.searchParams.get('text') || '').trim();
        if (!text) return reply({ ok: false, error: '缺少 text' }, 400);
        const history = readChatMemory();
        const persona = (typeof config.chatPersona === 'string' && config.chatPersona.trim() !== '')
          ? config.chatPersona
          : DEFAULT_PERSONA;
        const gen = await generateChat(ctx, persona, history, text);
        if (!gen.ok) {
          log('warn', '桌面对话失败：' + gen.error);
          return reply({ ok: false, error: gen.error }, 502);
        }
        const now = Date.now();
        history.push({ role: 'user', content: text, ts: now });
        history.push({ role: 'assistant', content: gen.text, ts: now });
        writeChatMemory(history.slice(-CHAT_MEMORY_LIMIT));
        control('/action?key=laugh').catch(() => {});
        return reply({ ok: true, text: gen.text });
      } catch (err) {
        try { reply({ ok: false, error: String((err && err.message) || err) }, 500); } catch (_) {}
      }
    });
    server.on('error', () => { hostChatServer = null; });
    server.listen(0, '127.0.0.1', () => {
      try {
        const port = server.address().port;
        mkdirSync(dirname(hostChatFile()), { recursive: true });
        writeFileSync(hostChatFile(), JSON.stringify({ v: 1, port, pid: process.pid }));
        log('info', '桌面聊天服务已就绪 127.0.0.1:' + port);
      } catch (_) { /* 写不进文件也不影响网页端 */ }
    });
    hostChatServer = server;
  }
  /** 只删自己写的那份端口文件，避免误删另一个 DSH 实例的服务 */
  function removeHostChatFile() {
    try {
      const j = JSON.parse(readFileSync(hostChatFile(), 'utf8'));
      if (j && j.pid === process.pid) unlinkSync(hostChatFile());
    } catch (_) { /* 文件不存在或不是我们的 */ }
  }
  startHostChatServer();

  /**
   * 收掉奶龙 —— 面板按钮、/nailong、卸载插件都走这里。
   *
   * 先杀本会话 spawn 的那个子进程。但 `child` 经常是空的：奶龙可能是上一次 DSH
   * 留下的、或者你自己双击过那个独立启动的 .bat，进程句柄根本不在我们手里 ——
   * 这时光靠 `child.kill()` 什么也收不掉（用户看到的现象就是「插件都取消了，
   * 奶龙还在桌面上」）。
   *
   * 兜底办法是顺着控制通道请它自己退出。control.json 写在奶龙自己的配置目录
   * （%APPDATA%/nailong-desktop-pet）里，能连上就说明那确实是我们这只奶龙，
   * 不会误伤别人的程序。
   */
  async function stop(reason) {
    if (child) {
      const c = child;
      child = null;
      try { c.kill(); } catch (_) { /* 已经退了 */ }
      log('info', `奶龙已收工（${reason}）`);
      return true;
    }
    const r = await control('/quit');
    if (r && r.ok) {
      log('info', `奶龙已收工（${reason}·常驻进程）`);
      return true;
    }
    return false;
  }

  async function start() {
    // 常驻实例（上次 DSH 留下的 / .bat 启动的）：绝不能再 spawn —— 第二实例会撞
    // 单例锁退出，同时让常驻那只执行 second-instance（显示 + 回右下角），
    // 用户看到的就是「点一下动作，奶龙被传送回角落」。
    if (await probe()) return { ok: true, already: true, ready: true };
    if (child) return { ok: true, already: true, ready: await waitForPet(3000) };
    if (!hasGraphicalDisplay()) return { ok: false, error: '当前环境没有图形显示，奶龙起不来' };
    const exe = electronPath();
    if (!exe) return { ok: false, error: '找不到 electron.exe，可用 NAILONG_ELECTRON_PATH 指定' };
    if (!existsSync(APP_DIR)) return { ok: false, error: `找不到奶龙程序目录：${APP_DIR}` };

    const env = { ...process.env, NAILONG_SCALE: String(LOCKED_SCALE), NAILONG_HOST_CHAT_FILE: hostChatFile() };
    delete env.ELECTRON_RUN_AS_NODE; // 见文件顶部注释：必须 delete，置空会以 134 崩

    const c = spawn(exe, [APP_DIR], { env, cwd: PACKAGE_ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child = c;
    childExe = exe;
    // 子进程的 stdout/stderr 不接走的话，管道写满会把 Electron 卡死
    if (c.stdout) c.stdout.on('data', () => {});
    if (c.stderr) c.stderr.on('data', () => {});
    c.on('error', (err) => {
      log('warn', `奶龙启动失败：${(err && err.message) || err}`);
      if (child === c) child = null;
    });
    c.on('exit', (code) => {
      if (child === c) child = null;
      log('info', `奶龙进程退出（code=${code}）`);
    });
    log('info', `奶龙已出笼：${exe} ${APP_DIR}`);
    const ready = await waitForPet(4000);
    return { ok: true, started: true, ready };
  }

  // ---- 1. 路由：给 Web 半的按钮和外部脚本用 ----
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE,
      handler: async (req, res) => {
        const reply = (obj, code) => {
          const body = JSON.stringify(obj);
          res.writeHead(code || 200, {
            'content-type': 'application/json; charset=utf-8',
            'content-length': Buffer.byteLength(body), // 必须和 body 同一个字符串算，否则响应不结束
          });
          res.end(body);
        };
        try {
          const url = new URL(req.url, 'http://127.0.0.1');
          const sub = url.pathname.slice(ROUTE.length).replace(/^\//, '');
          if (sub === '' || sub === 'state') {
            return reply({ ok: true, running: !!child, electron: childExe, app: APP_DIR });
          }
          if (sub === 'toggle') {
            return reply(stop('面板按钮') ? { ok: true, running: false } : start());
          }
          if (sub === 'start') return reply(start());
          if (sub === 'stop') return reply({ ok: stop('面板按钮'), running: !!child });
          if (sub === 'action') {
            const key = url.searchParams.get('key') || 'random';
            if (!child) start();
            return reply(await control('/action?key=' + encodeURIComponent(key)));
          }
          if (sub === 'chat') {
            const text = (url.searchParams.get('text') || '').trim();
            if (!text) return reply({ ok: false, error: '缺少 text' }, 400);
            const history = readChatMemory();
            const persona = (typeof config.chatPersona === 'string' && config.chatPersona.trim() !== '')
              ? config.chatPersona
              : DEFAULT_PERSONA;
            const r = await generateChat(ctx, persona, history, text);
            if (!r.ok) {
              log('warn', '对话失败：' + r.error);
              return reply({ ok: false, error: r.error }, 502);
            }
            const now = Date.now();
            history.push({ role: 'user', content: text, ts: now });
            history.push({ role: 'assistant', content: r.text, ts: now });
            writeChatMemory(history.slice(-CHAT_MEMORY_LIMIT));
            // 让桌面奶龙笑一下（推送失败不影响回复本身）
            control('/action?key=laugh').catch(() => {});
            return reply({ ok: true, text: r.text });
          }
          return reply({ ok: false, error: 'not found' }, 404);
        } catch (err) {
          try { reply({ ok: false, error: String((err && err.message) || err) }, 500); } catch (_) {}
        }
      },
    }),
    'nailong-pet: route',
  );

  // ---- 2. /nailong 命令 ----
  ctx.effect(
    () => ctx.commands.register({
      name: 'nailong',
      description: '奶龙桌宠：不带参数=开关；也可用 打招呼/大笑/睡觉/跑一跑… 或 右下角',
      input: { hint: '[动作|右下角]' },
      handler: async ({ rawInput }) => {
        const arg = String(rawInput || '').trim();
        if (!arg) {
          if (stop('命令')) return { kind: 'success', text: '奶龙回家睡觉了' };
          const r = start();
          return r.ok ? { kind: 'success', text: '奶龙出来了 🐣' } : { kind: 'error', text: r.error };
        }
        if (arg === '关' || arg === '关掉' || arg === '回家') {
          return { kind: 'success', text: stop('命令') ? '奶龙回家睡觉了' : '奶龙本来就没出来' };
        }
        if (!child) start();

        if (arg === '右下角') {
          const r = await control('/home');
          return r.ok ? { kind: 'success', text: '奶龙回到右下角' } : { kind: 'error', text: r.error };
        }
        const key = ACTIONS[arg];
        if (!key) {
          return { kind: 'error', text: `不认识的指令「${arg}」。可用：${Object.keys(ACTIONS).join(' / ')}` };
        }
        const r = await control('/action?key=' + encodeURIComponent(key));
        return r.ok
          ? { kind: 'success', text: `奶龙：${arg} 👌` }
          : { kind: 'error', text: r.error || '动作没送出去' };
      },
    }),
    'nailong-pet: /nailong command',
  );

  // ---- 3. 跟着 DSH 起停 ----
  ctx.effect(() => {
    if (autoStart) {
      void start().catch((err) => log('warn', '自动启动失败：' + String((err && err.message) || err)));
    }
    return () => {
      void stop('插件卸载');
      try { if (hostChatServer) hostChatServer.close(); } catch (_) {}
      hostChatServer = null;
      removeHostChatFile();
    };
  }, 'nailong-pet: electron lifecycle');
}
