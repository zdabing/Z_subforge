#!/usr/bin/env node
/**
 * 脚本版（动态生成）：本地下载并执行上游 Script/mihomoScript.js，
 * 按用户设置的开关（生成地区自动选择组 / 隐藏地区手动选择组 / 分流组添加所有节点 /
 * 过滤高倍率节点 / 过滤非地区节点 / 屏蔽国外QUIC 等）动态生成配置，
 * 输出 mihomoScript.synced.yaml。
 *
 * 上游脚本 main(config) 的输入契约：
 *   - config.proxies（必须）：订阅解析出的节点数组
 *   - config.dns / config.hosts（可选）：订阅自带，用于保留机场私有 DNS / 节点 hosts
 *   其余（规则集、策略组、DNS、基础配置）全部由脚本自建。
 *
 * 依赖 js-yaml（package.json / node_modules）解析订阅并序列化产物。
 */

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const SCRIPT_URLS = [
  "https://raw.githubusercontent.com/AIsouler/MyClash/main/Script/mihomoScript.js",
  "https://cdn.jsdelivr.net/gh/AIsouler/MyClash@main/Script/mihomoScript.js",
];
const RETRY = 2;
// 数据目录：容器里用环境变量指向挂载卷（/data），Windows 本地默认代码目录，行为不变
const DATA_DIR = process.env.DATA_DIR || __dirname;
const SCRIPT_DIR = path.join(DATA_DIR, "script");
const SCRIPT_FILE = path.join(SCRIPT_DIR, "upstream-script.js");
const SCRIPT_META = path.join(SCRIPT_DIR, "meta.json");
const OUTPUT_FILE = path.join(DATA_DIR, "mihomoScript.synced.yaml");

let yaml = null;
try {
  yaml = require("js-yaml");
} catch (err) {
  // 延迟到实际使用时再报错，保证非脚本版功能不受影响
}

const settingsSync = require("./sync.js");

// 订阅解析缓存（订阅 URL 列表不变时 60s 内复用，避免反复下载）
const SUB_CACHE_TTL = 60_000;
let subCache = { time: 0, key: null, data: null };

// 最近一次拉取订阅时捕获的元信息（HTTP 响应头），供 /sub 端点透传给 mihomo 客户端：
// mihomo 客户端据此显示「流量/到期」等订阅信息
let subInfo = { userinfo: null, updateInterval: null, title: null };

let lastLog = { time: null, lines: [] };
function log(...args) {
  const msg = args.map((a) => (typeof a === "string" ? a : String(a))).join(" ");
  console.log("[script]", msg);
  if (lastLog.lines.length >= 300) lastLog.lines.shift();
  lastLog.lines.push(msg);
}

/** 清空最近一次脚本操作日志（供页面「清空」按钮调用，避免刷新后旧日志又出现） */
function clearLastLog() {
  lastLog = { time: null, lines: [] };
}

function sha1(text) {
  return crypto.createHash("sha1").update(text, "utf8").digest("hex");
}

// ---------- 下载 ----------

async function fetchText(url) {
  const res = await fetch(url, {
    redirect: "follow",
    headers: {
      // 机场面板按 User-Agent 决定返回格式：带 clash/mihomo 才返回含 proxies 的 YAML，
      // 否则返回 base64 或 HTML/JSON 提示页，导致解析不到 proxies 节点列表
      "User-Agent": "clash-verge/v2.1.2 (mihomo)",
      Accept: "application/yaml, text/yaml, application/x-yaml, text/plain, */*",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const text = await res.text();
  if (!text || !text.trim()) throw new Error("下载内容为空");
  return text;
}

/** 拉取订阅并捕获元信息响应头（Subscription-Userinfo / Profile-Update-Interval），
 *  供 /sub 端点透传给 mihomo 客户端显示流量、到期、更新间隔 */
async function fetchSubText(url) {
  const res = await fetch(url, {
    redirect: "follow",
    headers: {
      "User-Agent": "clash-verge/v2.1.2 (mihomo)",
      Accept: "application/yaml, text/yaml, application/x-yaml, text/plain, */*",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const text = await res.text();
  if (!text || !text.trim()) throw new Error("下载内容为空");
  const userinfo = res.headers.get("subscription-userinfo");
  const updateInterval = res.headers.get("profile-update-interval");
  if (userinfo) subInfo.userinfo = userinfo;
  if (updateInterval) subInfo.updateInterval = updateInterval;
  // 机场显示名：优先取 SUB_TITLE 环境变量（容器部署可自定义，如 NAS 上设置 SUB_TITLE=MyAirport），
  // 否则按订阅域名主名称推断（如 sub.example.com → example）
  try {
    const name = process.env.SUB_TITLE || new URL(url).hostname.replace(/^sub\./, "").split(".")[0];
    if (name) subInfo.title = name;
  } catch {}
  return text;
}

/** 读取最近一次捕获的订阅元信息 */
function getSubInfo() {
  return subInfo;
}

/** 按顺序尝试各下载源，失败自动换源/重试；全部失败返回 null */
async function download(urls) {
  for (const url of urls) {
    for (let attempt = 1; attempt <= RETRY; attempt++) {
      try {
        log(`下载 ${url}（第 ${attempt}/${RETRY} 次尝试）`);
        const text = await fetchText(url);
        log("下载成功。");
        return text;
      } catch (err) {
        if (attempt < RETRY) {
          log(`失败：${err.message}，稍后重试...`);
          await new Promise((r) => setTimeout(r, 1500));
        } else {
          log(`源 ${url} 失败：${err.message}`);
        }
      }
    }
  }
  return null;
}

// ---------- 开关提取与注入 ----------

const OPTIONS_DEF_RE = /const ruleOptionsEnable = \{([\s\S]*?)\n\};/;

/** 从脚本源码提取 ruleOptionsEnable 默认值对象、每项注释说明与分组 */
function extractOptions(source) {
  const m = source.match(OPTIONS_DEF_RE);
  if (!m) {
    throw new Error("脚本中未找到 ruleOptionsEnable 定义，可能上游脚本已改版");
  }
  const literal = m[1];
  let defaults;
  try {
    // 注意：literal 末尾一行是注释（无换行），拼接时必须补换行，否则结尾的 } 会被注释吞掉
    defaults = new Function(`return {${literal}\n}`)();
  } catch (err) {
    throw new Error(`解析 ruleOptionsEnable 失败：${err.message}`);
  }
  // 逐行抓「键: 值, // 注释」与独立的分组注释行（如「// 基础策略组」）
  const labels = {};
  const groups = {};
  // 上游注释分组 → 页面展示分组 的归一化映射
  const GROUP_MAP = {
    基础策略组: "基础策略",
    以下为分流策略配置: "分流策略",
    以下为非分流策略配置: "生成配置",
  };
  let currentGroup = "其他";
  for (const line of literal.split("\n")) {
    const section = line.match(/^\s*\/\/\s*(.+)$/);
    if (section) {
      const raw = section[1].trim();
      currentGroup =
        GROUP_MAP[raw] ||
        raw.replace(/^以下为/, "").replace(/配置$/, "").replace(/组$/, "") ||
        "其他";
      continue;
    }
    const lm = line.match(/^\s*([A-Za-z\u4e00-\u9fa5]+):[^/]*?\/\/\s*(.+)$/);
    if (lm) {
      labels[lm[1].trim()] = lm[2].trim();
      groups[lm[1].trim()] = currentGroup;
    }
  }
  return { defaults, labels, groups };
}

/**
 * 本地默认值覆盖：优先于上游脚本 ruleOptionsEnable 的默认值。
 * 用户要求「屏蔽国外QUIC」默认关闭——即使上游脚本默认是 true，
 * 且 settings.json 未保存该开关时，也按 false 处理。
 */
const DEFAULT_OVERRIDES = { 屏蔽国外QUIC: false };

function defaultOf(key, upstreamDefault) {
  return Object.prototype.hasOwnProperty.call(DEFAULT_OVERRIDES, key)
    ? DEFAULT_OVERRIDES[key]
    : upstreamDefault;
}

/**
 * 注入用户开关：把源码中的 ruleOptionsEnable 定义替换为合并后的 JSON 字面量。
 * 返回值：{ source, options }；source 为替换后的脚本源码。
 */
function injectOptions(source, userOptions) {
  const { defaults } = extractOptions(source);
  const merged = {};
  for (const [key, val] of Object.entries(defaults)) {
    merged[key] = typeof userOptions[key] === "boolean" ? userOptions[key] : defaultOf(key, val);
  }
  const replaced = source.replace(
    OPTIONS_DEF_RE,
    `const ruleOptionsEnable = ${JSON.stringify(merged, null, 2)};`,
  );
  if (replaced === source) {
    throw new Error("注入开关失败：未替换到 ruleOptionsEnable 定义");
  }
  return { source: replaced, options: merged };
}

/** 执行脚本源码，返回 { main, defaults, labels } */
function executeScript(source) {
  const { defaults, labels } = extractOptions(source);
  const code = source + "\n;module.exports = { main, ruleOptionsEnable };";
  const factory = new Function(
    "module",
    "exports",
    "require",
    code,
  );
  const mod = { exports: {} };
  factory(mod, mod.exports, (id) => {
    throw new Error(`脚本不应在本地 require 外部模块：${id}`);
  });
  if (typeof mod.exports.main !== "function") {
    throw new Error("脚本执行后未找到 main 函数");
  }
  return { main: mod.exports.main, defaults, labels };
}

// ---------- 快照读写 ----------

function readScriptSource() {
  try {
    return fs.readFileSync(SCRIPT_FILE, "utf8");
  } catch {
    return null;
  }
}

function readScriptMeta() {
  try {
    return JSON.parse(fs.readFileSync(SCRIPT_META, "utf8"));
  } catch {
    return null;
  }
}

// ---------- 开关持久化（settings.json 的 scriptOptions） ----------

function loadOptions() {
  const s = settingsSync.loadSettings();
  return (s.scriptOptions && typeof s.scriptOptions === "object") ? s.scriptOptions : {};
}

function saveOptions(options) {
  const s = settingsSync.loadSettings();
  s.scriptOptions = options;
  settingsSync.saveSettings(s);
  return options;
}

// ---------- Gist 推送配置（settings.json 顶层，token 不上传 Git） ----------

/** 读取 Gist 推送配置（token / gistId / filename / enabled）；文件缺失或损坏时回落默认 */
function loadGistConfig() {
  const s = settingsSync.loadSettings();
  return {
    token: typeof s.gistToken === "string" ? s.gistToken : "",
    gistId: typeof s.gistId === "string" ? s.gistId : "",
    filename: typeof s.gistFilename === "string" && s.gistFilename ? s.gistFilename : "mihomoScript.synced.yaml",
    enabled: s.gistEnabled === true,
  };
}

/**
 * 保存 Gist 推送配置（仅持久化四个字段）。
 * token/gistId 传 undefined 时保持原值（勾选开关时避免用空输入框覆盖已存配置），
 * 传字符串则按值设置（空字符串即清除）。
 */
function saveGistConfig(cfg) {
  const s = settingsSync.loadSettings();
  const prev = {
    token: typeof s.gistToken === "string" ? s.gistToken : "",
    gistId: typeof s.gistId === "string" ? s.gistId : "",
    filename: typeof s.gistFilename === "string" && s.gistFilename ? s.gistFilename : "mihomoScript.synced.yaml",
  };
  const token = typeof cfg.token === "string" ? cfg.token.trim() : prev.token;
  const gistId = typeof cfg.gistId === "string" ? cfg.gistId.trim() : prev.gistId;
  const filename = typeof cfg.filename === "string" && cfg.filename.trim() ? cfg.filename.trim() : prev.filename;
  s.gistToken = token;
  s.gistId = gistId;
  s.gistFilename = filename;
  s.gistEnabled = cfg.enabled === true;
  settingsSync.saveSettings(s);
  return { token, gistId, filename, enabled: cfg.enabled === true };
}

/**
 * 推送 YAML 内容到已有 Gist（GitHub REST API PATCH，文件不存在则自动新建）。
 * 未启用/未配置 → 返回 { ok:false, reason:"未配置" }；失败 → { ok:false, error }；不抛出异常。
 */
async function pushToGist(yamlText) {
  const cfg = loadGistConfig();
  if (!cfg.enabled) return { ok: false, reason: "Gist 推送未启用" };
  if (!cfg.token) return { ok: false, reason: "未配置 GitHub Token" };
  if (!cfg.gistId) return { ok: false, reason: "未配置 Gist ID" };
  const api = `https://api.github.com/gists/${encodeURIComponent(cfg.gistId)}`;
  try {
    const res = await fetch(api, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "subforge",
      },
      body: JSON.stringify({
        files: { [cfg.filename]: { content: yamlText } },
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      let msg = `HTTP ${res.status}`;
      try {
        const j = JSON.parse(detail);
        if (j.message) msg += `：${j.message}`;
      } catch {}
      return { ok: false, error: msg };
    }
    const g = await res.json();
    return { ok: true, url: g.html_url, gistId: cfg.gistId };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

// ---------- 订阅 ----------

/** 获取订阅 URL 列表（多订阅 subscribeUrls；缺失/为空时回落单条 subscribeUrl） */
function getSubscribeUrls() {
  const s = settingsSync.loadSettings();
  const urls = Array.isArray(s.subscribeUrls) ? s.subscribeUrls.filter((u) => typeof u === "string" && u.trim()) : [];
  if (urls.length > 0) return urls;
  return s.subscribeUrl ? [s.subscribeUrl] : [];
}

/**
 * 下载并解析订阅，返回 { proxies, names, urls, dns?, hosts? }；URL 列表不变时带 60s 缓存。
 * 多个订阅节点合并：同名节点后覆盖先（避免 mihomo proxies 重名报错）；
 * 单条订阅下载/解析失败 → 跳过该条并记日志，其余继续；全部失败才抛错。
 */
async function fetchAndParseSubscription() {
  const urls = getSubscribeUrls();
  if (urls.length === 0) {
    throw new Error("未配置订阅链接，请先在「订阅管理」（或补丁设置）中填写");
  }
  const cacheKey = urls.join("\n");
  if (subCache.key === cacheKey && subCache.data && Date.now() - subCache.time < SUB_CACHE_TTL) {
    return subCache.data;
  }

  const mergedProxies = [];
  const seen = new Set();
  let firstDns = null;
  let firstHosts = null;
  let okCount = 0;
  const perUrl = [];
  const perUrlProxies = []; // 每个订阅各自的节点（原始名），供页面按订阅分组展示

  for (const url of urls) {
    log(`下载订阅 ${url}`);
    try {
      const subText = await fetchSubText(url);
      let parsed;
      try {
        parsed = yaml.load(subText);
      } catch (err) {
        throw new Error(`订阅内容不是合法 YAML：${err.message}`);
      }
      const proxies = parsed && Array.isArray(parsed.proxies) ? parsed.proxies : [];
      if (proxies.length === 0) {
        throw new Error("订阅内容中未找到 proxies 节点列表");
      }
      perUrlProxies.push({ url, proxies });
      // 同名节点后覆盖先
      for (const p of proxies) {
        if (!p || typeof p.name !== "string") continue;
        if (seen.has(p.name)) {
          const idx = mergedProxies.findIndex((x) => x.name === p.name);
          if (idx >= 0) mergedProxies[idx] = p;
        } else {
          seen.add(p.name);
          mergedProxies.push(p);
        }
      }
      if (!firstDns && parsed.dns) firstDns = parsed.dns;
      if (!firstHosts && parsed.hosts) firstHosts = parsed.hosts;
      okCount++;
      perUrl.push({ url, count: proxies.length });
    } catch (err) {
      log(`订阅失败（已跳过）：${url} → ${err.message}`);
      perUrl.push({ url, error: err.message });
    }
  }

  if (mergedProxies.length === 0) {
    throw new Error("所有订阅均下载/解析失败，请检查订阅链接是否有效");
  }
  log(
    perUrl.map((p) => `${p.count !== undefined ? `${p.count} 节点` : "失败"}`).join(" / ") +
      ` → 合并 ${mergedProxies.length} 个节点（${okCount}/${urls.length} 条订阅成功）。`,
  );

  // 按「节点归属地标注」给节点名加国旗前缀（如 🇺🇸 美国），让上游脚本按国旗自动归入对应地区策略组；
  // 已含该国旗 / 未标注 / 地区不在脚本地区定义内的节点保持原样
  const flags = getRegionFlags();
  const regionMap = loadNodeRegion();
  const flaggedName = (p) => {
    const region = regionMap[p.name];
    const flag = region && flags[region];
    if (!flag || p.name.startsWith(flag)) return p.name;
    return `${flag} ${p.name}`;
  };
  const flaggedProxies = mergedProxies.map((p) =>
    flaggedName(p) === p.name ? p : { ...p, name: flaggedName(p) },
  );
  const data = {
    proxies: flaggedProxies,
    names: flaggedProxies.map((p) => p.name),
    // 按订阅分组（带国旗后的名字），供页面「节点管理」按订阅折叠展示
    byUrl: perUrlProxies.map((e) => ({ url: e.url, names: e.proxies.map(flaggedName) })),
    urls,
  };
  if (firstDns) data.dns = firstDns;
  if (firstHosts) data.hosts = firstHosts;
  subCache = { time: Date.now(), key: cacheKey, data };
  return data;
}

// ---------- 分流组节点选择持久化（settings.json 顶层 scriptNodeSelection） ----------

const NODE_SELECTION_KEY = "scriptNodeSelection";

function loadNodeSelection() {
  const s = settingsSync.loadSettings();
  const sel = s[NODE_SELECTION_KEY];
  return sel && typeof sel === "object" ? sel : {};
}

function saveNodeSelection(selection) {
  const s = settingsSync.loadSettings();
  s[NODE_SELECTION_KEY] = selection;
  settingsSync.saveSettings(s);
  return selection;
}

/**
 * 常驻健康检查：所有策略组 lazy 关、探测间隔缩到 2 分钟。
 * 上游模板默认 lazy:true（仅流量触发才测），重握手协议（xhttp/Reality/mlkem768）
 * 的节点冷启动开销大，表现为首次访问高延迟/超时；改为常驻后节点延迟持续刷新。
 */
function applyKeepAlive(result) {
  const groups = result["proxy-groups"];
  if (!Array.isArray(groups)) return;
  for (const g of groups) {
    if (!g || typeof g !== "object") continue;
    g.lazy = false;
    if (typeof g.interval === "number" && g.interval > 0) g.interval = 120;
  }
}

/**
 * 按用户勾选（scriptNodeSelection）替换分流策略组的节点列表：
 *  - 勾选节点名与本次订阅实际节点名求交集（订阅更新后失效的名字静默剔除，不报错）
 *  - 交集为空（未勾选或全部失效）→ 保持脚本自动生成的列表不变
 *  - 组不存在（对应开关已关闭）→ 跳过
 *  - default-selected 不在新列表内时改为第一个勾选节点，避免指向失效名字
 * 返回被替换的组名数组。
 */
function applyNodeSelection(result, selection, allNames) {
  const nameSet = new Set(allNames);
  const groups = result["proxy-groups"];
  const replaced = [];
  if (!Array.isArray(groups)) return replaced;
  for (const [groupName, chosen] of Object.entries(selection)) {
    if (!Array.isArray(chosen)) continue;
    const group = groups.find((g) => g && g.name === groupName);
    if (!group || !Array.isArray(group.proxies)) continue;
    const picked = chosen.filter((n) => typeof n === "string" && nameSet.has(n));
    if (picked.length === 0) continue;
    group.proxies = [...picked];
    if (group["default-selected"] !== undefined && !picked.includes(group["default-selected"])) {
      group["default-selected"] = picked[0];
    }
    replaced.push(groupName);
  }
  return replaced;
}

// ---------- 节点归属地持久化（settings.json 顶层 scriptNodeRegion） ----------

const NODE_REGION_KEY = "scriptNodeRegion";

// 快照脚本不可用时的回落地区映射（name → flag）
const FALLBACK_REGIONS = {
  香港: "🇭🇰",
  日本: "🇯🇵",
  美国: "🇺🇸",
  新加坡: "🇸🇬",
  台湾省: "🇹🇼",
};

let regionFlagCache = null;

/** 解析上游脚本里的地区名 → 国旗；快照不可用时回落内置映射 */
function getRegionFlags() {
  if (regionFlagCache) return regionFlagCache;
  const flags = { ...FALLBACK_REGIONS };
  const source = readScriptSource();
  if (source) {
    const re = /name:\s*'([^']+)',\s*\n\s*flag:\s*'([^']+)'/g;
    for (const m of source.matchAll(re)) {
      flags[m[1]] = m[2];
    }
  }
  regionFlagCache = flags;
  return flags;
}

function loadNodeRegion() {
  const s = settingsSync.loadSettings();
  const reg = s[NODE_REGION_KEY];
  return reg && typeof reg === "object" ? reg : {};
}

/**
 * 保存节点归属地映射 { 原名: "美国" }（null/空值条目剔除）。
 * 保存后清空订阅缓存（下次解析按新标注给节点加国旗），并自动同步
 * 「分流组节点选择」里的勾选名：标注改名后勾选跟随新国旗名，取消标注后还原原名，不丢勾选。
 */
function saveNodeRegion(region) {
  const clean = {};
  for (const [name, r] of Object.entries(region || {})) {
    if (name && typeof r === "string" && r.trim()) clean[name] = r.trim();
  }
  // 同步分流组勾选：先去掉勾选名里已加的国旗前缀还原订阅原名，再按新标注重新确定名字
  const selection = loadNodeSelection();
  const flags = getRegionFlags();
  const oldRegions = loadNodeRegion();
  const newSel = {};
  for (const [g, names] of Object.entries(selection)) {
    if (!Array.isArray(names)) continue;
    newSel[g] = names.map((n) => {
      if (typeof n !== "string") return n;
      let base = n;
      for (const flag of Object.values(flags)) {
        if (base.startsWith(flag + " ")) {
          base = base.slice(flag.length + 1);
          break;
        }
      }
      if (clean[base]) {
        const flag = flags[clean[base]];
        return flag ? `${flag} ${base}` : base;
      }
      if (oldRegions[base]) return base; // 取消标注 → 还原原名
      return n;
    });
  }
  if (JSON.stringify(newSel) !== JSON.stringify(selection)) saveNodeSelection(newSel);
  subCache = { time: 0, key: null, data: null };
  const s = settingsSync.loadSettings();
  s[NODE_REGION_KEY] = clean;
  settingsSync.saveSettings(s);
  return clean;
}

// 订阅解析进行中的请求（并发访问时复用，避免页面同时触发多个请求导致订阅重复下载）
let nodesInflight = null;

/** 获取订阅节点名、用户勾选、归属地标注与可选地区（供页面渲染；订阅失败返回 error） */
async function getNodeList() {
  const selection = loadNodeSelection();
  const regions = loadNodeRegion();
  const regionList = Object.entries(getRegionFlags()).map(([name, flag]) => ({ name, flag }));
  const urls = getSubscribeUrls();
  if (!nodesInflight) {
    nodesInflight = fetchAndParseSubscription()
      .then(({ names, byUrl }) => ({ nodes: names, byUrl, selection, regions, regionList, urls }))
      .catch((err) => ({ nodes: [], byUrl: [], selection, regions, regionList, urls, error: err.message }))
      .finally(() => { nodesInflight = null; });
  }
  return nodesInflight;
}

/** 保存订阅 URL 列表；第一个自动同步到 subscribeUrl（YAML 版补丁与补丁设置用）；清订阅缓存 */
function saveSubscriptions(urls) {
  const clean = urls.filter((u) => typeof u === "string" && u.trim());
  const s = settingsSync.loadSettings();
  s.subscribeUrls = clean;
  if (clean.length > 0) s.subscribeUrl = clean[0];
  settingsSync.saveSettings(s);
  clearSubCache();
  return clean;
}

/** 清空订阅解析缓存（客户端「更新」时强制拉取最新订阅，跳过 60s 缓存） */
function clearSubCache() {
  subCache = { time: 0, key: null, data: null };
}

// ---------- 对外操作 ----------

/**
 * 查询上游脚本在 GitHub 上的最近一次提交（作者提交时间与 commit sha，供页面显示，
 * 与快照的「下载时间」区分开）；失败返回 null（不阻塞同步）。
 */
async function fetchScriptCommit() {
  try {
    const res = await fetch(
      "https://api.github.com/repos/AIsouler/MyClash/commits?path=Script/mihomoScript.js&per_page=1",
      { headers: { Accept: "application/vnd.github+json", "User-Agent": "subforge" } },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const list = await res.json();
    const c = list && list[0];
    const date = c && c.commit && c.commit.committer && c.commit.committer.date;
    if (!date || !c.sha) throw new Error("响应中无提交信息");
    const message = (c.commit && c.commit.message || "").trim().split("\n")[0]; // 只取首行标题
    return { sha: c.sha, time: date, message };
  } catch (err) {
    log(`查询上游脚本提交信息失败（已忽略）：${err.message}`);
    return null;
  }
}

/** 下载上游脚本并保存快照；返回 {ok, sha, time, options, upstream?, error?} */
async function syncScript() {
  const source = await download(SCRIPT_URLS);
  if (source === null) {
    return { ok: false, error: "上游脚本下载失败，请检查网络后重试" };
  }
  try {
    const { defaults, labels, groups } = extractOptions(source);
    fs.mkdirSync(SCRIPT_DIR, { recursive: true });
    const now = new Date().toISOString();
    const meta = { time: now, sha: sha1(source) };
    const upstream = await fetchScriptCommit();
    if (upstream) {
      meta.upstreamCommit = upstream.sha; // GitHub 提交哈希（与内容 SHA 不同）
      meta.upstreamTime = upstream.time; // 作者提交时间
      meta.upstreamMessage = upstream.message; // 提交标题（如 feat: 支持添加自定义节点…）
    }
    fs.writeFileSync(SCRIPT_FILE, source, "utf8");
    // 保留上次生成时间（generate 写入的 lastGenTime），不因下载脚本被覆盖
    try {
      const old = JSON.parse(fs.readFileSync(SCRIPT_META, "utf8"));
      if (old.lastGenTime) meta.lastGenTime = old.lastGenTime;
    } catch {}
    fs.writeFileSync(SCRIPT_META, JSON.stringify(meta, null, 2) + "\n", "utf8");
    log("上游脚本已保存到本地快照。");
    const user = loadOptions();
    const options = Object.entries(defaults).map(([key, def]) => ({
      key,
      label: labels[key] || "",
      group: groups[key] || "其他",
      value: typeof user[key] === "boolean" ? user[key] : defaultOf(key, def),
      default: def,
    }));
    return { ok: true, sha: meta.sha, time: meta.time, options, upstream };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** 生成脚本版配置：下载订阅 → 解析节点 → 执行脚本 → 写产物 */
async function generate() {
  lastLog = { time: new Date().toISOString(), lines: [] };
  try {
    if (!yaml) {
      throw new Error("js-yaml 未加载，请先执行 npm install");
    }
    const source = readScriptSource();
    if (source === null) {
      throw new Error("尚未下载上游脚本，请先在页面点击「下载上游脚本」");
    }
    const user = loadOptions();
    const { source: injected } = injectOptions(source, user);
    const { main } = executeScript(injected);

    // 订阅 → 节点
    const { proxies, dns, hosts, names } = await fetchAndParseSubscription();

    const config = { proxies };
    if (dns) config.dns = dns;
    if (hosts) config.hosts = hosts;

    const result = main(config);
    if (!result || !Array.isArray(result.proxies) || !Array.isArray(result["proxy-groups"])) {
      throw new Error("脚本执行结果异常：缺少 proxies 或 proxy-groups");
    }

    // 后处理：按用户勾选替换分流策略组节点列表
    const replacedGroups = applyNodeSelection(result, loadNodeSelection(), names);
    if (replacedGroups.length > 0) {
      log(`已应用节点勾选：${replacedGroups.join("、")}`);
    }

    // 后处理：策略组常驻健康检查（lazy 关 + 2 分钟间隔）
    applyKeepAlive(result);

    const outYaml = yaml.dump(result, { lineWidth: -1, noRefs: true });
    const previous = fs.existsSync(OUTPUT_FILE) ? fs.readFileSync(OUTPUT_FILE, "utf8") : null;
    const changed = previous !== outYaml;
    if (!changed) {
      log("内容与上次一致，跳过写入。");
    } else {
      fs.writeFileSync(OUTPUT_FILE, outYaml, "utf8");
      log(`已写入 ${path.basename(OUTPUT_FILE)}（${outYaml.length} 字符）。`);
    }

    // 记录本次生成时间（无论内容是否变化都更新，供页面显示「上次生成」）
    const genTime = new Date().toISOString();
    try {
      const meta = JSON.parse(fs.readFileSync(SCRIPT_META, "utf8"));
      meta.lastGenTime = genTime;
      fs.writeFileSync(SCRIPT_META, JSON.stringify(meta, null, 2) + "\n", "utf8");
    } catch {}

    // 内容有变化且启用 Gist 推送时，自动推送到 Gist；失败仅记日志，不阻塞生成
    let gist = null;
    if (changed && loadGistConfig().enabled) {
      const r = await pushToGist(outYaml);
      if (r.ok) {
        log(`✓ 已推送到 Gist：${r.url}`);
        gist = { pushed: true, url: r.url };
      } else {
        log(`Gist 推送失败（${r.error || r.reason}），已跳过。`);
        gist = { pushed: false, error: r.error || r.reason };
      }
    }

    log(
      `脚本版生成完成：${result.proxies.length} 节点 / ${result["proxy-groups"].length} 策略组 / ${result.rules.length} 规则。`,
    );
    return {
      ok: true,
      changed,
      proxies: result.proxies.length,
      groups: result["proxy-groups"].length,
      rules: (result.rules || []).length,
      outputLen: outYaml.length,
      time: new Date().toISOString(),
      nodes: names,
      replacedGroups,
      gist,
    };
  } catch (err) {
    log(`错误：${err.message}`);
    return { ok: false, error: err.message };
  }
}

/** 脚本版状态（供页面展示） */
function getStatus() {
  const meta = readScriptMeta();
  const source = readScriptSource();
  let options = null;
  if (source) {
    try {
      const { defaults, labels, groups } = extractOptions(source);
      const user = loadOptions();
      options = Object.entries(defaults).map(([key, def]) => ({
        key,
        label: labels[key] || "",
        group: groups[key] || "其他",
        value: typeof user[key] === "boolean" ? user[key] : defaultOf(key, def),
        default: def,
      }));
    } catch {}
  }
  let output = null;
  try {
    const st = fs.statSync(OUTPUT_FILE);
    output = { exists: st.isFile(), size: st.isFile() ? st.size : null };
  } catch {
    output = { exists: false, size: null };
  }
  return {
    scriptDownloaded: source !== null,
    scriptSha: meta ? meta.sha : null, // 快照内容 SHA（文件哈希）
    scriptTime: meta ? meta.time : null, // 快照下载时间
    upstreamCommit: meta ? meta.upstreamCommit : null, // GitHub 提交哈希
    upstreamTime: meta ? meta.upstreamTime : null, // 作者提交时间
    upstreamMessage: meta ? meta.upstreamMessage : null, // 提交标题
    lastGenTime: meta ? meta.lastGenTime : null, // 最近一次生成配置的时间
    options,
    output,
    // Gist 推送配置状态（token 只回显布尔，不泄露明文；gistId 非机密可回显给用户确认）
    gist: (() => {
      const c = loadGistConfig();
      return {
        enabled: c.enabled,
        gistId: c.gistId,
        hasId: c.gistId.length > 0,
        hasToken: c.token.length > 0,
        filename: c.filename,
        configured: c.token.length > 0 && c.gistId.length > 0,
      };
    })(),
  };
}

// CLI 入口：node scriptGenerator.js sync | generate
if (require.main === module) {
  const cmd = process.argv[2] || "generate";
  const fn = cmd === "sync" ? syncScript() : generate();
  fn.then((r) => {
    if (!r.ok) process.exit(1);
  });
}

module.exports = {
  SCRIPT_URLS,
  DATA_DIR,
  SCRIPT_DIR,
  SCRIPT_FILE,
  SCRIPT_META,
  OUTPUT_FILE,
  NODE_SELECTION_KEY,
  NODE_REGION_KEY,
  extractOptions,
  injectOptions,
  executeScript,
  download,
  fetchAndParseSubscription,
  loadOptions,
  saveOptions,
  loadGistConfig,
  saveGistConfig,
  pushToGist,
  loadNodeSelection,
  saveNodeSelection,
  applyNodeSelection,
  applyKeepAlive,
  getRegionFlags,
  loadNodeRegion,
  saveNodeRegion,
  getSubscribeUrls,
  saveSubscriptions,
  clearSubCache,
  getSubInfo,
  getNodeList,
  syncScript,
  generate,
  getStatus,
  getLastLog: () => lastLog,
  clearLastLog,
};
