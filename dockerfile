FROM mcr.microsoft.com/playwright:v1.55.0-jammy AS deps
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NODE_OPTIONS="--unhandled-rejections=strict"
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM build AS prod-deps
RUN npm prune --omit=dev

FROM mcr.microsoft.com/playwright:v1.55.0-jammy AS runner
WORKDIR /app
# 安装中文字体，避免 headless Chrome 渲染中文为方框
RUN apt-get update && apt-get install -y --no-install-recommends \
    fonts-noto-cjk \
    fonts-noto-cjk-extra \
    fontconfig \
    && fc-cache -f -v \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY self-test ./self-test
EXPOSE 8080 8081 9221
CMD ["node", "dist/index.js"]
