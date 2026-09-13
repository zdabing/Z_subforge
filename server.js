#!/usr/bin/env node
/**
 * subforge 订阅配置生成 Web 控制台（零依赖，仅用 Node 内置模块）
 *
 * 启动：node server.js（或双击 start.cmd，会自动打开浏览器）
 * 浏览器访问：http://localhost:8790
 *
 * 能力全部由本地 Node 服务承载（浏览器沙箱无法直接执行 Node / 写文件 / 注册计划任务），
 * 页面 index.html 只做界面。
 *
 * API 一览：
 *   GET  /                      页面
 *   GET  /api/status            运行状态、上游 SHA、上次同步、产物大小、任务状态
 *   POST /api/sync              触发同步（防并发）
 *   GET  /api/log               最近一次同步日志
 *   GET  /api/diff              上游最新 vs 上次产物 的逐行 diff
 *   GET  /api/output            产物内容（text/plain）
 *   GET  /api/settings          补丁开关设置
 *   POST /api/settings          保存补丁开关设置
 *   GET  /api/task              定时任务状态（存在与否）
 *   POST /api/task              注册 / 卸载定时任务
 *   （脚本版）
 *   GET  /api/script/status     脚本版状态、全部开关、产物信息
 *   POST /api/script/sync       下载上游脚本
 *   POST /api/script/options    保存开关设置
 *   POST /api/script/generate   生成脚本版配置
 *   GET  /api/script/output     脚本版产物内容
 *   GET  /api/script/log        最近一次脚本操作日志
 */

"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const sync = require("./sync.js");
const scriptGen = require("./scriptGenerator.js");

const PORT = Number(process.env.PORT || 8790);
// 监听地址：容器里通过 HOST=0.0.0.0 暴露给外部，Windows 本地默认只监听回环
const HOST = process.env.HOST || "127.0.0.1";
const INDEX_FILE = path.join(__dirname, "index.html");
const TASK_NAME = "SubForgeSync";
const TASK_TIME = "09:00";
const TASK_DAY = "SUN"; // 每周日

let syncing = false;

// ---------- 工具 ----------

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error("请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

function execCmd(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 15000 }, (error) => {
      // 只看退出码：schtasks 输出是 GBK 编码，解析内容反而会乱码
      resolve(
        error
          ? { code: typeof error.code === "number" ? error.code : -1, errno: error.code || null }
          : { code: 0, errno: null },
      );
    });
  });
}

// ---------- 上游 ----------

// 上游内容仅在「立即同步」时下载（sync.runSync），页面状态/差异均读本地快照，
// 不在请求里触发网络下载，避免轮询导致反复拉取上游。

// ---------- diff（简单逐行 LCS，行数较大时降级为朴素比较） ----------

function diffLines(a, b) {
  const A = a.split("\n");
  const B = b.split("\n");
  const n = A.length;
  const m = B.length;
  if (n * m > 4_000_000) {
    // 行数过大：朴素逐行比较，不做对齐
    const ops = [];
    for (let i = 0; i < n; i++) ops.push({ type: "del", text: A[i] });
    for (let j = 0; j < m; j++) ops.push({ type: "add", text: B[j] });
    return ops;
  }
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      ops.push({ type: "same", text: A[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: "del", text: A[i] });
      i++;
    } else {
      ops.push({ type: "add", text: B[j] });
      j++;
    }
  }
  while (i < n) ops.push({ type: "del", text: A[i++] });
  while (j < m) ops.push({ type: "add", text: B[j++] });
  return ops;
}

// ---------- 路由 ----------

async function route(req, res, url) {
  if (req.method === "GET" && url.pathname === "/") {
    fs.readFile(INDEX_FILE, "utf8", (err, html) => {
      if (err) {
        sendJson(res, 500, { error: "无法读取 index.html" });
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/favicon.ico") {
    res.writeHead(204);
    res.end();
    return;
  }

  // ---- status ----
  if (req.method === "GET" && url.pathname === "/api/status") {
    const meta = sync.readMeta();
    let outputSize = null;
    let outputExists = false;
    try {
      const st = fs.statSync(sync.OUTPUT_FILE);
      outputExists = st.isFile();
      outputSize = outputExists ? st.size : null;
    } catch {}

    // 上游 SHA：取自上次同步保存的本地快照（不在请求里触发下载）
    const snapshotText = sync.readUpstreamSnapshot();
    const upstreamSha = snapshotText !== null ? sync.sha1(snapshotText) : null;
    const task = await getTaskStatus();

    sendJson(res, 200, {
      running: syncing,
      upstreamSha,
      upstreamOk: upstreamSha !== null,
      upstreamTime: meta ? meta.upstreamTime : null,
      lastSyncTime: meta ? meta.time : null,
      lastSyncSha: meta ? meta.sha : null,
      lastChanged: meta ? meta.changed : null,
      outputExists,
      outputSize,
      taskRegistered: task,
      enabledCount: sync.getEnabledPatches().length,
      totalPatches: sync.allPatches.length,
    });
    return;
  }

  // ---- sync ----
  if (req.method === "POST" && url.pathname === "/api/sync") {
    if (syncing) {
      sendJson(res, 409, { error: "同步正在进行中，请稍候" });
      return;
    }
    syncing = true;
    try {
      const result = await sync.runSync();
      // 脚本版一并同步：先下载上游脚本，再重新生成脚本版配置（失败不阻塞 YAML 版结果）
      let script = null;
      if (scriptBusy) {
        script = { ok: false, error: "脚本操作正在进行中，请稍候" };
      } else {
        scriptBusy = true;
        try {
          const s = await scriptGen.syncScript();
          script = s.ok ? await scriptGen.generate() : s;
        } finally {
          scriptBusy = false;
        }
      }
      sendJson(res, 200, { ...result, script });
    } finally {
      syncing = false;
    }
    return;
  }

  // ---- log ----
  if (req.method === "GET" && url.pathname === "/api/log") {
    sendJson(res, 200, sync.getLastLog());
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/log") {
    sync.clearLastLog();
    sendJson(res, 200, { ok: true });
    return;
  }

  // ---- diff ----
  if (req.method === "GET" && url.pathname === "/api/diff") {
    // 基于上次同步保存的上游快照做差异，不自动下载上游（同步时才会更新快照）
    const upstream = sync.readUpstreamSnapshot();
    let output = null;
    try {
      output = fs.readFileSync(sync.OUTPUT_FILE, "utf8");
    } catch {}

    if (upstream === null) {
      sendJson(res, 200, { error: "尚无上游快照，请先执行一次同步", ops: [] });
      return;
    }
    if (output === null) {
      sendJson(res, 200, { error: "尚无产物，请先执行一次同步", ops: [] });
      return;
    }
    const ops = diffLines(upstream, output);
    sendJson(res, 200, { ops, upstreamSha: sync.sha1(upstream) });
    return;
  }

  // ---- output ----
  if (req.method === "GET" && url.pathname === "/api/output") {
    fs.readFile(sync.OUTPUT_FILE, "utf8", (err, text) => {
      if (err) {
        sendJson(res, 404, { error: "尚无产物，请先执行一次同步" });
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": `attachment; filename="${sync.OUTPUT_FILE}"`,
      });
      res.end(text);
    });
    return;
  }

  // ---- 客户端订阅端点：mihomo 客户端把 http://127.0.0.1:8790/sub 填为订阅地址，
  // 每次点「更新」即触发一次全量刷新（拉最新上游脚本 → 强制拉最新订阅 → 重新生成），
  // 并把最新 YAML 直接返回给客户端。正在生成或生成失败时回退返回上次产物，保证客户端不中断。
  // 同时把订阅元信息（Subscription-Userinfo / Profile-Update-Interval）透传给客户端，
  // 使其能显示「流量/到期/更新间隔」（与直接拉机场订阅一致）。
  if (req.method === "GET" && url.pathname === "/sub") {
    const outPath = scriptGen.OUTPUT_FILE;
    // 订阅元信息注释头（标准 Clash 订阅格式，mihomo 客户端据此显示订阅名/流量/到期；
    // 注意格式为 #profile-title 无空格，带空格客户端正则不匹配）
    const metaHeader = () => {
      const info = scriptGen.getSubInfo();
      const lines = [];
      if (info && info.title) {
        const b64 = Buffer.from(String(info.title), "utf8").toString("base64");
        lines.push(`#profile-title: ${b64}`);
      }
      if (info && info.userinfo) lines.push(`#subscription-userinfo: ${info.userinfo}`);
      if (info && info.updateInterval) lines.push(`#profile-update-interval: ${info.updateInterval}`);
      return lines.length ? lines.join("\n") + "\n" : "";
    };
    const serveLast = () => {
      fs.readFile(outPath, "utf8", (err, text) => {
        if (err) {
          res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("服务端尚未生成过配置，请先在页面点一次「生成 YAML」");
          return;
        }
        const info = scriptGen.getSubInfo();
        if (info && info.userinfo) res.setHeader("Subscription-Userinfo", info.userinfo);
        if (info && info.updateInterval) res.setHeader("Profile-Update-Interval", info.updateInterval);
        res.writeHead(200, { "Content-Type": "text/yaml; charset=utf-8" });
        res.end(metaHeader() + text);
      });
    };
    if (scriptBusy) return serveLast(); // 正在生成中：直接给上次产物，避免重复触发
    scriptBusy = true;
    (async () => {
      try {
        const s = await scriptGen.syncScript(); // 拉最新上游脚本
        if (!s.ok) throw new Error(s.error || "上游脚本下载失败");
        scriptGen.clearSubCache(); // 绕过 60s 订阅缓存，强制拉最新订阅
        const r = await scriptGen.generate();
        if (!r.ok) throw new Error(r.error || "生成失败");
        const text = fs.readFileSync(outPath, "utf8");
        const info = scriptGen.getSubInfo();
        if (info && info.userinfo) res.setHeader("Subscription-Userinfo", info.userinfo);
        if (info && info.updateInterval) res.setHeader("Profile-Update-Interval", info.updateInterval);
        res.writeHead(200, { "Content-Type": "text/yaml; charset=utf-8" });
        res.end(metaHeader() + text);
      } catch (err) {
        console.log("[sub]", "刷新失败，回退上次产物：", err.message);
        serveLast();
      } finally {
        scriptBusy = false;
      }
    })();
    return;
  }

  // ---- settings ----
  if (req.method === "GET" && url.pathname === "/api/settings") {
    sendJson(res, 200, {
      settings: sync.loadSettings(),
      patches: sync.getAllPatches().map((p) => ({
        id: p.id,
        desc: p.desc,
        enabled: p.enabled !== false,
        vars: p.vars || [],
      })),
    });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/settings") {
    try {
      const body = await readBody(req);
      const settings = sync.loadSettings();
      if (body.enabled && typeof body.enabled === "object") {
        settings.enabled = { ...(settings.enabled || {}), ...body.enabled };
      }
      // 用户填写的变量（如订阅链接）直接存 settings 顶层
      if (body.values && typeof body.values === "object") {
        for (const [k, v] of Object.entries(body.values)) {
          settings[k] = v;
        }
      }
      sync.saveSettings(settings);
      sendJson(res, 200, { ok: true, settings });
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
    return;
  }

  // ---- task ----
  if (req.method === "GET" && url.pathname === "/api/task") {
    const task = await getTaskStatus();
    sendJson(res, 200, { registered: task });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/task") {
    try {
      const body = await readBody(req);
      if (body.action === "install") {
        const task = await getTaskStatus();
        if (task) {
          sendJson(res, 200, { ok: true, registered: true, message: "定时任务已注册" });
          return;
        }
        const syncCmd = path.join(__dirname, "sync.cmd");
        const r = await execCmd("schtasks", [
          "/Create",
          "/F",
          "/TN",
          TASK_NAME,
          "/SC",
          "WEEKLY",
          "/D",
          TASK_DAY,
          "/ST",
          TASK_TIME,
          "/TR",
          `"${syncCmd}"`,
        ]);
        if (r.code === 0) {
          sendJson(res, 200, { ok: true, registered: true, message: `已注册：每周日 ${TASK_TIME} 自动同步` });
        } else {
          sendJson(res, 500, { error: `schtasks 注册失败（code ${r.code}），可能需要管理员权限` });
        }
        return;
      }
      if (body.action === "uninstall") {
        const r = await execCmd("schtasks", ["/Delete", "/F", "/TN", TASK_NAME]);
        if (r.code === 0) {
          sendJson(res, 200, { ok: true, registered: false, message: "定时任务已卸载" });
        } else {
          sendJson(res, 500, { error: `schtasks 卸载失败（code ${r.code}）` });
        }
        return;
      }
      sendJson(res, 400, { error: "action 必须是 install 或 uninstall" });
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
    return;
  }

  sendJson(res, 404, { error: "Not Found" });
}

// ---------- 脚本版（动态生成）API ----------

let scriptBusy = false;

async function routeScript(req, res, url) {
  // 状态
  if (req.method === "GET" && url.pathname === "/api/script/status") {
    const st = scriptGen.getStatus();
    sendJson(res, 200, { ...st, busy: scriptBusy });
    return;
  }

  // 下载上游脚本
  if (req.method === "POST" && url.pathname === "/api/script/sync") {
    if (scriptBusy) {
      sendJson(res, 409, { error: "脚本操作正在进行中，请稍候" });
      return;
    }
    scriptBusy = true;
    try {
      const r = await scriptGen.syncScript();
      sendJson(res, r.ok ? 200 : 500, r);
    } finally {
      scriptBusy = false;
    }
    return;
  }

  // 保存开关设置
  if (req.method === "POST" && url.pathname === "/api/script/options") {
    try {
      const body = await readBody(req);
      const cur = scriptGen.loadOptions();
      for (const [k, v] of Object.entries(body)) {
        cur[k] = v;
      }
      scriptGen.saveOptions(cur);
      sendJson(res, 200, { ok: true, options: cur });
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
    return;
  }

  // 订阅节点 + 分流组节点勾选状态 + 归属地标注
  if (req.method === "GET" && url.pathname === "/api/script/nodes") {
    const r = await scriptGen.getNodeList();
    sendJson(res, 200, r); // 订阅失败也返回 200，页面用 error 字段提示重试
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/script/nodes") {
    try {
      const body = await readBody(req);
      const cur = scriptGen.loadNodeSelection();
      for (const [k, v] of Object.entries(body)) {
        if (Array.isArray(v)) {
          cur[k] = v.filter((n) => typeof n === "string");
        } else if (v === null) {
          delete cur[k];
        }
      }
      scriptGen.saveNodeSelection(cur);
      sendJson(res, 200, { ok: true, selection: cur });
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
    return;
  }
  // 保存节点归属地标注（完整映射 { 原名: "美国" }，null/空值剔除）
  if (req.method === "POST" && url.pathname === "/api/script/regions") {
    try {
      const body = await readBody(req);
      const cleaned = scriptGen.saveNodeRegion(body);
      sendJson(res, 200, { ok: true, regions: cleaned });
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
    return;
  }
  // 保存订阅 URL 列表（多订阅；第一个同步 subscribeUrl）
  if (req.method === "POST" && url.pathname === "/api/script/subscriptions") {
    try {
      const body = await readBody(req);
      const urls = Array.isArray(body.urls) ? body.urls : [];
      const saved = scriptGen.saveSubscriptions(urls);
      sendJson(res, 200, { ok: true, urls: saved });
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
    return;
  }

  // 保存 Gist 推送配置（token 存 settings.json，不上传 Git）
  if (req.method === "POST" && url.pathname === "/api/script/gist") {
    try {
      const body = await readBody(req);
      const cfg = scriptGen.saveGistConfig({
        token: body.token,
        gistId: body.gistId,
        filename: body.filename,
        enabled: body.enabled === true,
      });
      sendJson(res, 200, { ok: true, config: { hasToken: cfg.token.length > 0, hasId: cfg.gistId.length > 0, filename: cfg.filename, enabled: cfg.enabled } });
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
    return;
  }

  // 测试推送：把当前产物内容推送到 Gist（验证 token/gistId 可用，再开自动开关）
  if (req.method === "POST" && url.pathname === "/api/script/gist/test") {
    let text = null;
    try {
      text = fs.readFileSync(scriptGen.OUTPUT_FILE, "utf8");
    } catch {}
    if (text === null) {
      sendJson(res, 400, { error: "尚无产物，请先生成 YAML" });
      return;
    }
    const r = await scriptGen.pushToGist(text);
    sendJson(res, r.ok ? 200 : 400, r);
    return;
  }

  // 生成脚本版配置
  if (req.method === "POST" && url.pathname === "/api/script/generate") {
    if (scriptBusy) {
      sendJson(res, 409, { error: "脚本操作正在进行中，请稍候" });
      return;
    }
    scriptBusy = true;
    try {
      const r = await scriptGen.generate();
      sendJson(res, r.ok ? 200 : 500, r);
    } finally {
      scriptBusy = false;
    }
    return;
  }

  // 产物内容
  if (req.method === "GET" && url.pathname === "/api/script/output") {
    fs.readFile(scriptGen.OUTPUT_FILE, "utf8", (err, text) => {
      if (err) {
        sendJson(res, 404, { error: "尚无脚本版产物，请先生成" });
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8",
        // 响应头只能放下载文件名，不能放可能含中文的本地绝对路径；
        // 否则 Node 会抛 ERR_INVALID_CHAR 并导致服务进程退出。
        "Content-Disposition": `attachment; filename="${path.basename(scriptGen.OUTPUT_FILE)}"`,
      });
      res.end(text);
    });
    return;
  }

  // 最近一次脚本操作日志
  if (req.method === "GET" && url.pathname === "/api/script/log") {
    sendJson(res, 200, scriptGen.getLastLog());
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/script/log") {
    scriptGen.clearLastLog();
    sendJson(res, 200, { ok: true });
    return;
  }

  sendJson(res, 404, { error: "Not Found" });
}

/** 检测定时任务是否存在（只看 schtasks 退出码，规避 GBK 输出解析）；schtasks 不可用时返回 null */
async function getTaskStatus() {
  const r = await execCmd("schtasks", ["/Query", "/TN", TASK_NAME]);
  if (r.errno === "ENOENT") return null; // schtasks 不可用，无法检测
  return r.code === 0;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (url.pathname.startsWith("/api/script")) {
    routeScript(req, res, url).catch((err) => {
      sendJson(res, 500, { error: err.message || "服务器内部错误" });
    });
    return;
  }
  route(req, res, url).catch((err) => {
    sendJson(res, 500, { error: err.message || "服务器内部错误" });
  });
});

server.listen(PORT, HOST, () => {
  console.log(`subforge 配置生成服务已启动： http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`);
  console.log(`按 Ctrl+C 停止服务（窗口关闭即停）。`);
});
