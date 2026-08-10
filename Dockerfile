# MyClash 配置生成服务（订阅 → mihomoScript.js → YAML）
# 多阶段构建：仅安装生产依赖，减小镜像体积
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:20-alpine
WORKDIR /app

# 复制源码与生产依赖
COPY --from=deps /app/node_modules ./node_modules
COPY server.js sync.js scriptGenerator.js patches.js package.json ./
COPY index.html ./

# 容器运行配置：监听所有网卡（供 NAS 端口映射访问）、数据存挂载卷
ENV HOST=0.0.0.0 \
    PORT=8790 \
    DATA_DIR=/data \
    TZ=Asia/Shanghai

# 数据目录：settings.json / 快照 / 上游脚本 / 生成的 YAML 都放这里，挂卷持久化
VOLUME ["/data"]
EXPOSE 8790

CMD ["node", "server.js"]
