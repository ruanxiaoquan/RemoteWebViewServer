#!/usr/bin/env bash
# ============================================================
# RemoteWebViewServer — 一键安装 & 启动脚本
# 支持：Ubuntu/Debian · CentOS/RHEL/Fedora · macOS
# 用法：bash install.sh
# ============================================================
set -euo pipefail

# ── 颜色 ────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

info()    { echo -e "${CYAN}[INFO]${NC}  $*"; }
success() { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*"; }
step()    { echo -e "\n${BOLD}${BLUE}▶ $*${NC}"; }

# ── 检测 OS ─────────────────────────────────────────────────
detect_os() {
  if [[ "$OSTYPE" == "darwin"* ]]; then
    OS="macos"
  elif [[ -f /etc/os-release ]]; then
    . /etc/os-release
    case "$ID" in
      ubuntu|debian|raspbian) OS="debian" ;;
      centos|rhel|fedora|rocky|almalinux) OS="rhel" ;;
      *) OS="unknown" ;;
    esac
  else
    OS="unknown"
  fi
  info "检测到系统：$OS"
}

# ── 检查命令是否存在 ─────────────────────────────────────────
need_cmd() { command -v "$1" &>/dev/null; }

# ── 安装 Node.js (>= 18) ────────────────────────────────────
install_node() {
  if need_cmd node; then
    NODE_VER=$(node -e "process.exit(parseInt(process.version.slice(1)) < 18 ? 1 : 0)" 2>/dev/null && echo "ok" || echo "old")
    if [[ "$NODE_VER" == "ok" ]]; then
      success "Node.js $(node -v) 已安装"
      return
    fi
    warn "Node.js 版本过低（$(node -v)），需要 >= 18，将重新安装"
  fi

  info "安装 Node.js 20 LTS..."
  case "$OS" in
    debian)
      curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
      sudo apt-get install -y nodejs
      ;;
    rhel)
      curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
      sudo yum install -y nodejs
      ;;
    macos)
      if need_cmd brew; then
        brew install node@20
        brew link --overwrite --force node@20 || true
      else
        error "请先安装 Homebrew（https://brew.sh）后重新运行"
        exit 1
      fi
      ;;
    *)
      error "未知系统，请手动安装 Node.js 20+：https://nodejs.org"
      exit 1
      ;;
  esac
  success "Node.js $(node -v) 安装完成"
}

# ── 安装 npm（通常随 Node 一起） ────────────────────────────
install_npm() {
  if need_cmd npm; then
    success "npm $(npm -v) 已安装"
  else
    error "npm 未找到，请检查 Node.js 安装"
    exit 1
  fi
}

# ── 安装 pm2 ────────────────────────────────────────────────
install_pm2() {
  if need_cmd pm2; then
    success "pm2 $(pm2 -v) 已安装"
  else
    info "安装 pm2..."
    npm install -g pm2
    success "pm2 安装完成"
  fi
}

# ── 安装 Playwright 浏览器依赖（Linux only） ────────────────
install_playwright_deps() {
  if [[ "$OS" == "macos" ]]; then return; fi

  info "安装 Playwright 系统依赖..."
  # 获取项目中 playwright-core 版本对应的 playwright CLI
  local PW_VER
  PW_VER=$(node -e "try{require('./node_modules/playwright-core/package.json')}catch(e){process.exit(1)}" 2>/dev/null \
    && node -e "const p=require('./node_modules/playwright-core/package.json');console.log(p.version)" 2>/dev/null \
    || echo "")

  if [[ -n "$PW_VER" ]]; then
    info "playwright-core 版本：$PW_VER，安装浏览器系统依赖..."
    # 先尝试 install-deps（不下载浏览器，只装系统依赖）
    npx "playwright@${PW_VER}" install-deps chromium 2>/dev/null || true
  fi

  # 安装 Chromium 可执行文件
  info "安装 Playwright Chromium..."
  if [[ -n "$PW_VER" ]]; then
    npx "playwright@${PW_VER}" install chromium
  else
    warn "无法获取 playwright 版本，尝试默认安装"
    npx playwright install chromium
  fi
  success "Playwright Chromium 安装完成"
}

# ── 安装 npm 依赖 ────────────────────────────────────────────
install_deps() {
  step "安装 npm 依赖"
  if [[ -f package-lock.json ]]; then
    npm ci
  else
    npm install
  fi
  success "依赖安装完成"
}

# ── 构建 ────────────────────────────────────────────────────
build_project() {
  step "构建项目（TypeScript → dist/）"
  npm run build
  success "构建完成，输出目录：dist/"
}

# ── 读取或设置环境变量文件 ──────────────────────────────────
ENV_FILE=".env"

load_env() {
  if [[ -f "$ENV_FILE" ]]; then
    # shellcheck disable=SC2046
    export $(grep -v '^#' "$ENV_FILE" | grep -v '^$' | xargs) 2>/dev/null || true
  fi
}

save_env_var() {
  local key="$1" val="$2"
  if [[ -f "$ENV_FILE" ]] && grep -q "^${key}=" "$ENV_FILE"; then
    # 更新已有行（macOS / GNU sed 兼容）
    if [[ "$OS" == "macos" ]]; then
      sed -i '' "s|^${key}=.*|${key}=${val}|" "$ENV_FILE"
    else
      sed -i "s|^${key}=.*|${key}=${val}|" "$ENV_FILE"
    fi
  else
    echo "${key}=${val}" >> "$ENV_FILE"
  fi
}

# ── 配置 USER_DATA_DIR ──────────────────────────────────────
configure_user_data_dir() {
  step "配置 USER_DATA_DIR（浏览器 Profile 存储路径）"
  load_env

  if [[ -n "${USER_DATA_DIR:-}" ]]; then
    success "USER_DATA_DIR 已设置：$USER_DATA_DIR"
  else
    # 提供默认值
    local DEFAULT_DIR
    if [[ "$OS" == "macos" ]]; then
      DEFAULT_DIR="$HOME/Library/Application Support/RemoteWebView/profile"
    else
      DEFAULT_DIR="/opt/remotewebview/profile"
    fi

    echo ""
    echo -e "${YELLOW}USER_DATA_DIR 未设置。${NC}"
    echo -e "浏览器 Cookie / Session 将存储在此目录（重启后保持登录状态）。"
    echo -e "直接回车使用默认值：${BOLD}${DEFAULT_DIR}${NC}"
    echo ""
    read -r -p "请输入 USER_DATA_DIR 路径: " INPUT_DIR
    USER_DATA_DIR="${INPUT_DIR:-$DEFAULT_DIR}"

    save_env_var "USER_DATA_DIR" "$USER_DATA_DIR"
    success "USER_DATA_DIR 已保存到 $ENV_FILE：$USER_DATA_DIR"
  fi

  # 确保目录存在
  mkdir -p "$USER_DATA_DIR"
  success "目录已就绪：$USER_DATA_DIR"
}

# ── 生成 pm2 ecosystem 配置 ─────────────────────────────────
generate_pm2_config() {
  local PM2_CONFIG="ecosystem.config.cjs"
  step "生成 pm2 配置文件（$PM2_CONFIG）"

  load_env

  cat > "$PM2_CONFIG" <<EOF
module.exports = {
  apps: [
    {
      name: 'remote-webview-server',
      script: 'dist/index.js',
      cwd: '${PWD}',
      interpreter: 'node',
      node_args: '--experimental-vm-modules',

      // 环境变量
      env: {
        NODE_ENV: 'production',
        USER_DATA_DIR: '${USER_DATA_DIR}',
        WS_PORT: '${WS_PORT:-8081}',
        HEALTH_PORT: '${HEALTH_PORT:-18080}',
        DEBUG_PORT: '${DEBUG_PORT:-9221}',
        JPEG_QUALITY: '${JPEG_QUALITY:-85}',
        MAX_BYTES_PER_MESSAGE: '${MAX_BYTES_PER_MESSAGE:-131072}',
        MIN_FRAME_INTERVAL_MS: '${MIN_FRAME_INTERVAL_MS:-0}',
        TILE_SIZE: '${TILE_SIZE:-32}',
        FULL_FRAME_TILE_COUNT: '${FULL_FRAME_TILE_COUNT:-4}',
        FULL_FRAME_EVERY: '${FULL_FRAME_EVERY:-50}',
        BROWSER_LOCALE: '${BROWSER_LOCALE:-zh-CN}',
      },

      // 进程管理
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',

      // 日志
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: 'logs/error.log',
      out_file: 'logs/out.log',
      merge_logs: true,
    },
  ],
};
EOF

  mkdir -p logs
  success "pm2 配置已生成：$PM2_CONFIG"
}

# ── 启动服务 ─────────────────────────────────────────────────
start_with_pm2() {
  step "使用 pm2 启动服务"

  # 如果已在运行，先重载
  if pm2 describe remote-webview-server &>/dev/null; then
    info "服务已存在，执行 reload..."
    pm2 reload ecosystem.config.cjs --update-env
  else
    pm2 start ecosystem.config.cjs
  fi

  # 保存 pm2 进程列表，系统重启后自动恢复
  pm2 save

  # 如果是 Linux，设置 pm2 开机自启
  if [[ "$OS" != "macos" ]]; then
    info "设置 pm2 开机自启..."
    pm2 startup 2>/dev/null || warn "请根据上方提示手动执行 pm2 startup 命令以设置开机自启"
  fi

  # ── 等待服务健康检查通过 ──────────────────────────────────
  local HP="${HEALTH_PORT:-18080}"
  local WP="${WS_PORT:-8081}"
  local DP="${DEBUG_PORT:-9221}"

  echo ""
  info "等待服务启动（健康检查端口 :${HP}）..."
  local WAIT=0
  local MAX=30
  until curl -fsS "http://127.0.0.1:${HP}/health" &>/dev/null; do
    sleep 1
    WAIT=$((WAIT + 1))
    if [[ $WAIT -ge $MAX ]]; then
      warn "健康检查超时（${MAX}s），服务可能仍在启动中，请稍后确认"
      warn "查看日志：pm2 logs remote-webview-server"
      break
    fi
    printf '\r  等待中 %ds / %ds ...' "$WAIT" "$MAX"
  done
  echo ""

  # ── 获取本机 IP（用于展示访问地址） ──────────────────────
  local LOCAL_IP
  if need_cmd ip; then
    LOCAL_IP=$(ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}' | head -1)
  elif need_cmd ifconfig; then
    LOCAL_IP=$(ifconfig | awk '/inet / && !/127.0.0.1/ {print $2; exit}' | sed 's/addr://')
  fi
  LOCAL_IP="${LOCAL_IP:-<your-server-ip>}"

  # ── 启动信息面板 ──────────────────────────────────────────
  echo ""
  echo -e "${BOLD}${GREEN}╔══════════════════════════════════════════════════╗${NC}"
  echo -e "${BOLD}${GREEN}║         ✅  RemoteWebViewServer 已启动           ║${NC}"
  echo -e "${BOLD}${GREEN}╠══════════════════════════════════════════════════╣${NC}"
  echo -e "${BOLD}${GREEN}║${NC}  ${BOLD}WebSocket${NC}       ws://${LOCAL_IP}:${BOLD}${WP}${NC}"
  echo -e "${BOLD}${GREEN}║${NC}  ${BOLD}客户端页面${NC}      http://${LOCAL_IP}:${BOLD}${HP}${NC}/client"
  echo -e "${BOLD}${GREEN}║${NC}  ${BOLD}健康检查${NC}        http://${LOCAL_IP}:${BOLD}${HP}${NC}/health"
  echo -e "${BOLD}${GREEN}║${NC}  ${BOLD}CDP 调试${NC}        ws://${LOCAL_IP}:${BOLD}${DP}${NC}"
  echo -e "${BOLD}${GREEN}╠══════════════════════════════════════════════════╣${NC}"
  echo -e "${BOLD}${GREEN}║${NC}  ${BOLD}用户数据目录${NC}    ${USER_DATA_DIR}"
  echo -e "${BOLD}${GREEN}║${NC}  ${BOLD}环境变量文件${NC}    ${PWD}/${ENV_FILE}"
  echo -e "${BOLD}${GREEN}╠══════════════════════════════════════════════════╣${NC}"
  echo -e "${BOLD}${GREEN}║${NC}  pm2 logs remote-webview-server  ${CYAN}# 实时日志${NC}"
  echo -e "${BOLD}${GREEN}║${NC}  pm2 status                      ${CYAN}# 进程状态${NC}"
  echo -e "${BOLD}${GREEN}║${NC}  pm2 stop remote-webview-server  ${CYAN}# 停止服务${NC}"
  echo -e "${BOLD}${GREEN}╚══════════════════════════════════════════════════╝${NC}"
  echo ""
}

# ── 主流程 ───────────────────────────────────────────────────
main() {
  echo ""
  echo -e "${BOLD}${BLUE}╔══════════════════════════════════════════╗${NC}"
  echo -e "${BOLD}${BLUE}║   RemoteWebViewServer  安装 & 启动       ║${NC}"
  echo -e "${BOLD}${BLUE}╚══════════════════════════════════════════╝${NC}"
  echo ""

  # 切换到脚本所在目录（确保相对路径正确）
  cd "$(dirname "$(realpath "$0" 2>/dev/null || readlink -f "$0" 2>/dev/null || echo "$0")")"

  detect_os

  step "检查 & 安装系统依赖"
  install_node
  install_npm
  install_pm2

  install_deps

  step "安装 Playwright Chromium"
  install_playwright_deps

  build_project

  configure_user_data_dir

  generate_pm2_config

  start_with_pm2
}

main "$@"
