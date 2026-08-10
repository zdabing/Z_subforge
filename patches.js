/**
 * 个人补丁配置
 *
 * 每个补丁格式：{ id, desc, find, replace, enabled, vars? }
 *  - id:      唯一标识（页面开关与 settings.json 用它，勿随意改动）
 *  - desc:    说明文字（页面展示、报错提示）
 *  - find:    在上游 mihomoConfig.yaml 中查找的精确字符串（必须唯一且逐字匹配）
 *  - replace: 替换结果；可用 {{变量名}} 占位符引用 vars 中声明的用户输入
 *  - enabled: 默认是否启用（可在页面开关，状态存 settings.json）
 *  - vars:    可选。该补丁需要的用户输入项：[{ key, label, default }]
 *             key 对应 settings.json 中的字段（如 subscribeUrl），页面会渲染输入框供填写
 *
 * 补丁按数组顺序依次执行（仅应用启用的）。任一 find 找不到 → 同步中止，不会写出任何文件。
 * 声明了 vars 但对应值未填写 → 同步中止并提示先去页面填写。
 */

module.exports = [
  {
    id: "subscribe_url",
    desc: "机场订阅链接（在脚本版「订阅管理」维护，第一个订阅自动用于本补丁）",
    find: "url: '' # 此处单引号中间填入机场订阅链接",
    replace: "url: '{{subscribeUrl}}' # 此处单引号中间填入机场订阅链接",
  },
  // 订阅 provider 拉取间隔：1 天 → 1 小时，让节点增删/流量变动最快 1 小时内自动生效
  // （锚点带 provider 上下文，避免误伤 rule_providers 的 interval）
  {
    id: "provider_update_interval",
    desc: "订阅节点自动更新间隔 1 天 → 1 小时（订阅变动更快生效）",
    find: [
      "  &proxy_providers_common {",
      "    type: http,",
      "    interval: 86400,",
    ].join("\n"),
    replace: [
      "  &proxy_providers_common {",
      "    type: http,",
      "    interval: 3600,",
    ].join("\n"),
  },
  // 常驻健康检查：lazy 关 + 间隔缩到 2 分钟，让节点延迟常驻刷新（解决冷连接高延迟/超时）
  {
    id: "provider_health_check",
    desc: "订阅节点健康检查常驻（lazy 关、间隔 2 分钟）",
    find: "health-check: { enable: true, url: https://g.cn/generate_204, interval: 600, lazy: true },",
    replace: "health-check: { enable: true, url: https://g.cn/generate_204, interval: 120, lazy: false },",
  },
  {
    id: "group_health_check_select",
    desc: "手动选择组常驻健康检查（lazy 关、间隔 2 分钟）",
    find: [
      "  group_common_select:",
      "    &group_common_select {",
      "      type: select,",
      "      interval: 600,",
      "      timeout: 3000,",
      "      max-failed-times: 3,",
      "      empty-fallback: REJECT,",
      "      url: 'https://g.cn/generate_204',",
      "      lazy: true,",
      "    }",
    ].join("\n"),
    replace: [
      "  group_common_select:",
      "    &group_common_select {",
      "      type: select,",
      "      interval: 120,",
      "      timeout: 3000,",
      "      max-failed-times: 3,",
      "      empty-fallback: REJECT,",
      "      url: 'https://g.cn/generate_204',",
      "      lazy: false,",
      "    }",
    ].join("\n"),
  },
  {
    id: "group_health_check_auto",
    desc: "自动选择组常驻健康检查（lazy 关、间隔 2 分钟）",
    find: [
      "  group_common_auto:",
      "    &group_common_auto {",
      "      type: url-test,",
      "      interval: 600,",
      "      timeout: 3000,",
      "      max-failed-times: 3,",
      "      empty-fallback: REJECT,",
      "      url: 'https://g.cn/generate_204',",
      "      lazy: true,",
      "      tolerance: 50,",
      "      include-all: true,",
      "      exclude-type: 'DIRECT',",
      "      icon: 'https://fastly.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Auto.png',",
      "      hidden: true,",
      "    }",
    ].join("\n"),
    replace: [
      "  group_common_auto:",
      "    &group_common_auto {",
      "      type: url-test,",
      "      interval: 120,",
      "      timeout: 3000,",
      "      max-failed-times: 3,",
      "      empty-fallback: REJECT,",
      "      url: 'https://g.cn/generate_204',",
      "      lazy: false,",
      "      tolerance: 50,",
      "      include-all: true,",
      "      exclude-type: 'DIRECT',",
      "      icon: 'https://fastly.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Auto.png',",
      "      hidden: true,",
      "    }",
    ].join("\n"),
  },
  {
    id: "group_health_check_load",
    desc: "负载均衡组常驻健康检查（lazy 关、间隔 2 分钟）",
    find: [
      "  group_common_load:",
      "    &group_common_load {",
      "      type: load-balance,",
      "      interval: 600,",
      "      timeout: 3000,",
      "      max-failed-times: 3,",
      "      empty-fallback: REJECT,",
      "      url: 'https://g.cn/generate_204',",
      "      lazy: true,",
      "      strategy: 'sticky-sessions',",
      "      include-all: true,",
      "      exclude-type: 'DIRECT',",
      "      icon: 'https://fastly.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Round_Robin.png',",
      "      hidden: true,",
      "    }",
    ].join("\n"),
    replace: [
      "  group_common_load:",
      "    &group_common_load {",
      "      type: load-balance,",
      "      interval: 120,",
      "      timeout: 3000,",
      "      max-failed-times: 3,",
      "      empty-fallback: REJECT,",
      "      url: 'https://g.cn/generate_204',",
      "      lazy: false,",
      "      strategy: 'sticky-sessions',",
      "      include-all: true,",
      "      exclude-type: 'DIRECT',",
      "      icon: 'https://fastly.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Round_Robin.png',",
      "      hidden: true,",
      "    }",
    ].join("\n"),
  },
];
