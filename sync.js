#!/usr/bin/env node
/**
 * 同步 AIsouler/MyClash 的 Config/mihomoConfig.yaml（全量版）到本地，
 * 并套用 patches.js 中的个人补丁（订阅地址、自用节点等）。
 *
 * 本文件同时是可复用的模块（server.js 通过 require 调用）与 CLI 脚本：
 *   CLI：node sync.js
 *   模块：const sync = require('./sync.js'); sync.runSync()
 *
 * 流程：下载（raw 优先，jsdelivr 兜底，失败重试）→ 校验 → 打补丁（按开关）→ 写产物 + 快照。
 * 任一启用的补丁锚点找不到 → 中止且不写文件（防止上游改版后生成残缺配置）。
 * 产物与上次一致 → 跳过写入（幂等，适合计划任务重复调用）。
 */

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const UPSTREAM_URLS = [
  "https://raw.githubusercontent.com/AIsouler/MyClash/main/Config/mihomoConfig.yaml",
  "https://cdn.jsdelivr.net/gh/AIsouler/MyClash@main/Config/mihomoConfig.yaml",
];
const RETRY = 2; // 每个源最多尝试次数（含首次）
// 数据目录：容器里用环境变量指向挂载卷（/data），Windows 本地默认代码目录，行为不变
const DATA_DIR = process.env.DATA_DIR || __dirname;
const OUTPUT_FILE = path.join(DATA_DIR, "mihomoConfig.synced.yaml");
const SNAPSHOT_DIR = path.join(DATA_DIR, "snapshot");
const UPSTREAM_SNAPSHOT = path.join(SNAPSHOT_DIR, "upstream.yaml");
const META_FILE = path.join(SNAPSHOT_DIR, "meta.json");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
// 上游文件头注释，用于校验下载到的是否为全量版配置
const MARKER = "#  mihomo配置（全量版）";

const allPatches = require("./patches.js");

// 最近一次同步日志（供 Web 控制台 /api/log 读取）
let lastLog = { time: null, lines: [] };

/** 重新加载 patches.js（修改补丁后即时生效，无需重启服务）；返回最新补丁列表 */
function reloadPatches() {
  try {
    delete require.cache[require.resolve("./patches.js")];
    return require("./patches.js");
  } catch (err) {
    log(`重新加载补丁失败（${err.message}），继续使用上次加载的补丁。`);
    return allPatches;
  }
}

function getAllPatches() {
  return allPatches;
}

function sha1(text) {
  return crypto.createHash("sha1").update(text, "utf8").digest("hex");
}

/** 读取补丁开关设置；文件不存在或损坏时返回空对象（视为全部启用） */
function loadSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

/** 保存补丁开关设置 */
function saveSettings(settings) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2) + "\n", "utf8");
  return settings;
}

/** 按 settings.json 过滤出启用的补丁（每次同步重新读取 patches.js，修改后即时生效） */
function getEnabledPatches() {
  const settings = loadSettings();
  const enabledMap = settings.enabled || {};
  const patches = reloadPatches();
  // 未填写（或清空）的变量用 patches.js 声明的 default 回落，保证 CLI / 首次运行也有可用值
  for (const p of patches) {
    for (const v of p.vars || []) {
      if ((settings[v.key] === undefined || settings[v.key] === "") && v.default !== undefined) {
        settings[v.key] = v.default;
      }
    }
  }
  return {
    settings,
    patches: patches.filter((p) => enabledMap[p.id] !== false && p.enabled !== false),
  };
}

/** 按顺序尝试各下载源，失败自动换源/重试 */
async function download() {
  for (const url of UPSTREAM_URLS) {
    for (let attempt = 1; attempt <= RETRY; attempt++) {
      try {
        log(`下载 ${url}（第 ${attempt}/${RETRY} 次尝试）`);
        const res = await fetch(url, { redirect: "follow" });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status} ${res.statusText}`);
        }
        const text = await res.text();
        if (!text || !text.trim()) {
          throw new Error("下载内容为空");
        }
        log("下载成功。");
        return text;
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        if (attempt < RETRY) {
          log(`失败：${msg}，稍后重试...`);
          await new Promise((r) => setTimeout(r, 1500));
        } else {
          log(`源 ${url} 失败：${msg}`);
        }
      }
    }
  }
  return null;
}

/**
 * 查询上游文件最近一次提交时间（GitHub API，供页面展示「上游更新时间」）。
 * 从 UPSTREAM_URLS[0] 解析 owner/repo/path，跟随仓库结构变动；失败返回 null（不阻塞同步）。
 */
async function fetchUpstreamTime() {
  const m = UPSTREAM_URLS[0].match(/^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/[^/]+\/(.+)$/);
  if (!m) return null;
  const api = `https://api.github.com/repos/${m[1]}/${m[2]}/commits?path=${encodeURIComponent(m[3])}&per_page=1`;
  try {
    const res = await fetch(api, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "subforge" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const list = await res.json();
    const date = list && list[0] && list[0].commit && list[0].commit.committer && list[0].commit.committer.date;
    if (!date) throw new Error("响应中无提交时间");
    return date;
  } catch (err) {
    log(`查询上游更新时间失败（已忽略）：${err.message}`);
    return null;
  }
}

/** 校验是否为全量版配置文件 */
function validate(text) {
  if (!text.includes(MARKER)) {
    throw new Error(`下载内容不是预期配置文件（缺少标记「${MARKER}」），已中止`);
  }
}

/** 解析补丁 replace 中的 {{变量名}} 占位符（值取自 settings.json）；缺失或为空则抛错 */
function resolveTemplate(template, settings) {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    const val = settings[key];
    if (val === undefined || val === null || val === "") {
      throw new Error(`补丁需要配置「${key}」，请先在页面（或 settings.json）中填写`);
    }
    return String(val);
  });
}

/** 依次应用补丁；任一锚点缺失或重复则抛错；{{变量}} 由 settings 解析 */
function applyPatches(text, enabledPatches, settings) {
  let result = text;
  for (const p of enabledPatches) {
    if (!p.find || typeof p.replace !== "string") {
      throw new Error(`补丁「${p.desc || "(未命名)"}」缺少 find/replace 字段`);
    }
    const resolved = p.replace.includes("{{") ? resolveTemplate(p.replace, settings) : p.replace;
    const count = result.split(p.find).length - 1;
    if (count === 0) {
      throw new Error(`补丁「${p.desc}」的锚点在上游文件中未找到，可能上游已改版，已中止`);
    }
    if (count > 1) {
      throw new Error(`补丁「${p.desc}」的锚点在文件中出现 ${count} 次，不唯一，请改用更精确的锚点，已中止`);
    }
    result = result.replace(p.find, resolved);
    log(`✓ 补丁应用成功：${p.desc}`);
  }
  return result;
}

/** 写入最近一次日志到内存（供 server 轮询） */
function log(...args) {
  const msg = args.map((a) => (typeof a === "string" ? a : String(a))).join(" ");
  console.log("[sync]", msg);
  if (lastLog.lines.length >= 500) lastLog.lines.shift();
  lastLog.lines.push(msg);
}

function getLastLog() {
  return lastLog;
}

/** 清空最近一次日志（供页面「清空」按钮调用，避免刷新后旧日志又出现） */
function clearLastLog() {
  lastLog = { time: null, lines: [] };
}

/**
 * 执行一次完整同步（下载 → 校验 → 打补丁 → 写产物 + 快照）。
 * @returns {{ok: boolean, sha?: string, outputLen?: number, changed?: boolean, error?: string}}
 */
async function runSync() {
  lastLog = { time: new Date().toISOString(), lines: [] };
  try {
    const upstream = await download();
    if (upstream === null) {
      throw new Error("所有下载源均失败，请检查网络后重试。");
    }

    validate(upstream);

    const { settings, patches: enabledPatches } = getEnabledPatches();
    if (enabledPatches.length === 0) {
      log("当前没有启用任何补丁，将生成纯净镜像。");
    }
    const patched = applyPatches(upstream, enabledPatches, settings);

    const previous = fs.existsSync(OUTPUT_FILE) ? fs.readFileSync(OUTPUT_FILE, "utf8") : null;
    const changed = previous !== patched;
    if (!changed) {
      log("内容与上次输出一致，跳过写入。");
    } else {
      fs.writeFileSync(OUTPUT_FILE, patched, { encoding: "utf8" });
      log(`已写入 ${path.basename(OUTPUT_FILE)}（${patched.length} 字符）。`);
    }

    // 保存上游快照，供 Web 控制台 diff 上游变化
    fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
    fs.writeFileSync(UPSTREAM_SNAPSHOT, upstream, "utf8");
    const meta = {
      time: new Date().toISOString(),
      sha: sha1(upstream),
      upstreamTime: await fetchUpstreamTime(), // GitHub 上该文件最近提交时间（可能为 null）
      outputLen: patched.length,
      changed,
    };
    fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2) + "\n", "utf8");

    log("同步完成。");
    return { ok: true, ...meta };
  } catch (err) {
    log(`错误：${err.message}`);
    return { ok: false, error: err.message };
  }
}

/** 读取上次同步时保存的上游快照（不存在返回 null） */
function readUpstreamSnapshot() {
  try {
    return fs.readFileSync(UPSTREAM_SNAPSHOT, "utf8");
  } catch {
    return null;
  }
}

/** 读取上次同步元信息（不存在返回 null） */
function readMeta() {
  try {
    return JSON.parse(fs.readFileSync(META_FILE, "utf8"));
  } catch {
    return null;
  }
}

// CLI 入口
if (require.main === module) {
  runSync().then((result) => {
    if (!result.ok) process.exit(1);
  });
}

module.exports = {
  UPSTREAM_URLS,
  DATA_DIR,
  OUTPUT_FILE,
  SNAPSHOT_DIR,
  UPSTREAM_SNAPSHOT,
  META_FILE,
  SETTINGS_FILE,
  MARKER,
  allPatches,
  getAllPatches,
  reloadPatches,
  sha1,
  loadSettings,
  saveSettings,
  getEnabledPatches,
  download,
  fetchUpstreamTime,
  validate,
  applyPatches,
  resolveTemplate,
  runSync,
  getLastLog,
  clearLastLog,
  readUpstreamSnapshot,
  readMeta,
};
