import { readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { pdfJsCMapsPlugin } from "../ui/vite/pdfJsCMapsPlugin.js";
import { thirdPartyNoticesVitePlugin } from "../../scripts/third-party-notices.mjs";
// Vite 配置在 Node 加载期执行，不能导入 @zcode/shared 根入口。
// 根入口包含 NodeNext 风格的源码 re-export，Node 会按真实文件查找 .js 并在 bootstrap 阶段失败。
import {
  resolveRuntimeZCodeEndpointOrigin,
  pickProductEndpointEnv,
  resolveZaiOAuthClientId,
  resolveZaiOAuthOrigin,
} from "@zcode/shared/zcodeEndpoint";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "../..");
const { version } = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf-8"));

// SW 缓存版本与注册参数的构建时注入（见 packages/web/public/sw.js 头部 v3/v8 教训：
// 忘递增 CACHE_VERSION = 部署后刷新无效）。public/ 文件不经 define 转换、被 Vite
// 原样拷贝进 dist，所以用 build 插件在 closeBundle（public 拷贝完成后）对产物做
// 占位符替换；同一值写入 sw.js 与 zcode-boot-probe.js 的 `?v=` 注册参数。
// sw.js 侧占位符写在单引号字符串字面量内（'__SW_CACHE_VERSION__'），probe 侧在
// 注册 URL 模板内——替换值都是裸版本串，语法由字面量保证。
// 值取构建时刻的 UTC 戳：每次构建必变 → 浏览器字节对比必然判定"有更新"。
// dev 模式由 configureServer 中间件按请求替换。注入环节整体缺失时 sw.js 会带着
// 未替换占位符字符串运行（旧 v9 语义），不会静默产生非法 JS。
const SW_CACHE_VERSION_PLACEHOLDER = "__SW_CACHE_VERSION__";
const SW_SHELL_FILES = ["sw.js", "zcode-boot-probe.js"] as const;

function resolveSwCacheVersion(): string {
  return `zcode-shell-${new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "")}Z`;
}

function applySwCacheVersion(source: string, cacheVersion: string): string {
  return source.replaceAll(SW_CACHE_VERSION_PLACEHOLDER, cacheVersion);
}

function swCacheVersionInjectionPlugin(): Plugin {
  const cacheVersion = resolveSwCacheVersion();
  return {
    name: "zcode:sw-cache-version",
    apply: "build",
    async closeBundle() {
      // Vite 的 public 目录拷贝发生在写盘阶段，closeBundle 时 dist 文件已就绪。
      for (const fileName of SW_SHELL_FILES) {
        const filePath = resolve(HERE, "dist", fileName);
        await writeFile(filePath, applySwCacheVersion(await readFile(filePath, "utf-8"), cacheVersion));
      }
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = request.url?.split("?", 1)[0] ?? "";
        if (!SW_SHELL_FILES.some((fileName) => pathname === `/${fileName}`)) {
          next();
          return;
        }
        const filePath = resolve(HERE, "public", pathname.slice(1));
        void readFile(filePath, "utf-8")
          .then((source) => {
            response.setHeader("Content-Type", "text/javascript");
            response.end(applySwCacheVersion(source, cacheVersion));
          })
          .catch(() => next());
      });
    },
  };
}

function resolveZCodeEnv(value: string | undefined): "test" | "production" {
  return value?.trim().toLowerCase() === "production" ? "production" : "test";
}

export default defineConfig(({ mode }) => {
  // `.env*` 只提供链接常量；当前产品环境由启动脚本或 CI 注入 ZCODE_ENV。
  // 启动脚本通过 process.env 显式选择 test/production；它必须优先于 .env 文件，
  // 否则 share:test 可能被 mode 的旧配置误解析到错误 endpoint。
  const env = { ...loadEnv(mode, REPO_ROOT, ""), ...process.env };
  const zcodeEnv = resolveZCodeEnv(env.ZCODE_ENV);
  const endpointEnv = {
    ...env,
    ZCODE_ENV: zcodeEnv,
  };
  const zcodeEndpointOrigin = resolveRuntimeZCodeEndpointOrigin(endpointEnv);
  const zaiOAuthOrigin = resolveZaiOAuthOrigin(endpointEnv);
  // ZAI OAuth client_id 是公开标识，允许注入浏览器包；secret/token 不得走 VITE_。
  const zaiOAuthClientId = resolveZaiOAuthClientId(endpointEnv);

  return {
    plugins: [
      pdfJsCMapsPlugin(),
      react(),
      tailwindcss(),
      thirdPartyNoticesVitePlugin(),
      swCacheVersionInjectionPlugin(),
    ],
    resolve: {
      alias: {
        // 修复 UI 组件库中的 @ 别名解析失败。
        // 问题原因：packages/ui 的源码直接被 web 应用交给 Vite 打包，但 web 自己没声明 @ -> packages/ui/src，
        // 所以像 "@/components/lib/utils" 这类导入会在运行时构建阶段报找不到模块。
        // 这里把别名补到消费方 Vite 配置里，保持现有组件源码不动，影响面最小。
        "@": resolve(__dirname, "../ui/src"),
        // Recharts 依赖 d3-shape@3.x，后者需要 d3-path 的 Path 导出。
        // hoisted node_modules 可能把 d3-shape 旁边的旧 d3-path@1.x 暴露给 Vite 预构建，
        // 导致桌面/Web dev 都在依赖优化阶段失败；显式指向根部 3.x 入口以固定解析边界。
        "d3-path": resolve(__dirname, "../../node_modules/d3-path/src/index.js"),
      },
    },
    server: {
      port: 5173,
      proxy: {
        // Web 登录本地调试时，OAuth token 交换必须先命中线上同源接口。
        // 该专用代理放在 `/api` 通配代理之前，避免被转发到本地 server 导致 404。
        "/api/v1/oauth/token": {
          target: zcodeEndpointOrigin,
          changeOrigin: true,
          secure: true,
        },
        // 将 /ws 和 /api 请求代理到 server（默认 3030 端口）
        "/ws": { target: "ws://localhost:3030", ws: true },
        "/api": { target: "http://localhost:3030" },
      },
    },
    optimizeDeps: {
      // 修复：在依赖预构建阶段显式加入 react 相关入口，避免 rolldown 解析 `react/jsx-runtime`
      // / `react/jsx-dev-runtime` 时返回无后缀路径导致的加载失败（UNLOADABLE_DEPENDENCY）。
      include: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime"],
    },
    worker: {
      rollupOptions: {
        // @pierre/diffs 的 worker 入口依赖 import 后注册 message 监听。
        // 它的 package sideEffects 漏声明会让生产 worker 子构建被摇成 0B；
        // 只关闭 worker 构建的摇树，避免影响主包。
        treeshake: false,
      },
    },
    define: {
      __ZCODE_ENDPOINT_ENV__: JSON.stringify(pickProductEndpointEnv(env)),
      __ZCODE_VERSION__: JSON.stringify(version),
      __ZCODE_COMMIT__: JSON.stringify(env.ZCODE_COMMIT || "unknown"),
      __ZCODE_ENV__: JSON.stringify(zcodeEnv),
      "import.meta.env.VITE_ZCODE_BASE_URL": JSON.stringify(zcodeEndpointOrigin),
      // 兼容旧 Web runtime 读取名；新代码统一读 VITE_ZCODE_BASE_URL。
      "import.meta.env.VITE_ZCODE_ENDPOINT_ORIGIN": JSON.stringify(zcodeEndpointOrigin),
      // 明确注入 OAuth 公开配置，避免 Web 端在不同 mode 下隐式依赖源码 fallback。
      "import.meta.env.VITE_ZAI_OAUTH_CLIENT_ID": JSON.stringify(zaiOAuthClientId),
      "import.meta.env.VITE_ZAI_OAUTH_ORIGIN": JSON.stringify(zaiOAuthOrigin),
    },
    build: {
      // 生产不在浏览器产物暴露 sourceMappingURL，避免客户端侧还原业务源码。
      sourcemap: mode === "production" ? "hidden" : true,
    },
  };
});
