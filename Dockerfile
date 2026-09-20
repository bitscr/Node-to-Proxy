# Node-to-Proxy 可选容器镜像（推荐直接使用 systemd 原生部署，见 README）
FROM node:20-alpine

WORKDIR /app

# 项目无第三方运行时依赖，直接拷贝源码
COPY package.json server.js ./
COPY src ./src
COPY public ./public

ENV NODE_ENV=production \
    BIND_HOST=0.0.0.0 \
    DATA_DIR=/data \
    WEB_PORT=8080 \
    HTTP_PROXY_PORT=18999 \
    SOCKS5_PROXY_PORT=18998

EXPOSE 8080 18999 18998

VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/health >/dev/null 2>&1 || exit 1

CMD ["node", "server.js"]