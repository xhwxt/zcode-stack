#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { networkInterfaces } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const serverEntry = join(root, "server", "entry-http.js");
const webRoot = join(root, "web");
const agentEntry = join(root, "agent", "zcode.cjs");

function usage() {
  return `Usage:
  zcode --web [--host <host>] [--port <port>] [--workspace <path>] [--open|--no-open]
  zcode --version

鉴权为设备凭据模型（恒开）：管理密钥缺省 <配置目录>/zcode-admin.secret，
可用环境变量 ZCODE_ADMIN_SECRET_FILE 覆盖路径。--token/--no-token 已废弃（值被忽略）。
`;
}

function readArgValue(argv, arg, index) {
  if (arg.includes("=")) {
    return { nextIndex: index, value: arg.slice(arg.indexOf("=") + 1) };
  }
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${arg}`);
  }
  return { nextIndex: index + 1, value };
}

function parseArgs(argv) {
  const options = {
    command: "serve",
    host: "127.0.0.1",
    open: undefined,
    port: undefined,
    workspace: process.cwd(),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.command = "help";
      continue;
    }
    if (arg === "--version" || arg === "-v") {
      options.command = "version";
      continue;
    }
    if (arg === "--host" || arg.startsWith("--host=")) {
      const parsed = readArgValue(argv, arg, index);
      options.host = parsed.value;
      index = parsed.nextIndex;
      continue;
    }
    if (arg === "--port" || arg.startsWith("--port=")) {
      const parsed = readArgValue(argv, arg, index);
      options.port = Number(parsed.value);
      if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
        throw new Error("--port must be an integer between 0 and 65535");
      }
      index = parsed.nextIndex;
      continue;
    }
    if (arg === "--workspace" || arg.startsWith("--workspace=")) {
      const parsed = readArgValue(argv, arg, index);
      options.workspace = resolve(parsed.value);
      index = parsed.nextIndex;
      continue;
    }
    if (arg === "--open") {
      options.open = true;
      continue;
    }
    if (arg === "--no-open") {
      options.open = false;
      continue;
    }
    if (arg === "--token" || arg.startsWith("--token=") || arg === "--no-token") {
      // 设备凭据模型下 token 不是客户端凭据；参数保留仅为
      // 兼容既有启动脚本/文档不被 Unknown option 打断，值被忽略。
      if (arg.startsWith("--token=")) {
        index = readArgValue(argv, arg, index).nextIndex;
      }
      continue;
    }
    throw new Error(`Unknown option "${arg}".\n${usage()}`);
  }

  return options;
}

function isLocalHost(host) {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function pickPort(host) {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolvePort(port);
      });
    });
  });
}

function formatUrl(host, port) {
  const displayHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  return `http://${displayHost}:${port}/`;
}

function networkUrls(port) {
  const urls = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal || entry.family !== "IPv4") {
        continue;
      }
      urls.push(`http://${entry.address}:${port}/`);
    }
  }
  return urls;
}

function openBrowser(url) {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

async function assertRuntimeFiles() {
  for (const file of [serverEntry, agentEntry, webRoot]) {
    await access(file).catch((cause) => {
      throw new Error(`Missing runtime file: ${file}`, { cause });
    });
  }
}

async function serve(options) {
  await assertRuntimeFiles();
  // ---- 设备凭据模型（spec: packages/server/specs/device-credential-auth.md）----
  // 旧单 token 模式已从服务端删除（不再读 ZCODE_SERVER_AUTH_TOKEN，任何 --token 值被忽略）。
  // 鉴权恒开为「设备凭据 + 短期会话」；部署引导的职责收敛为一件事：确保管理密钥文件
  // 存在（缺省 <配置目录>/zcode-admin.secret，600 root:root，可用 ZCODE_ADMIN_SECRET_FILE
  // 覆盖路径）。密钥缺失时服务端启动即失败（不允许裸奔），这里提前给出明确错误。
  const adminSecretPath =
    process.env.ZCODE_ADMIN_SECRET_FILE?.trim() || "<配置目录>/zcode-admin.secret";
  if (!existsSync(adminSecretPath)) {
    console.error(
      `[zcode] 管理密钥文件不存在: ${adminSecretPath}\n` +
        `  设备凭据鉴权需要它来签发配对码。以 root 执行:\n` +
        `    openssl rand -hex 32 > ${adminSecretPath} && chmod 600 ${adminSecretPath}\n` +
        `  然后重启本服务。`,
    );
    process.exit(1);
  }
  const port = options.port && options.port > 0 ? options.port : await pickPort(options.host);
  const open = options.open ?? isLocalHost(options.host);
  const localUrl = formatUrl(options.host, port);

  const child = spawn(process.execPath, [serverEntry], {
    cwd: options.workspace,
    env: {
      ...process.env,
      PORT: String(port),
      ZCODE_AGENT_SERVER_ARGS_JSON: JSON.stringify([agentEntry, "app-server", "--stdio"]),
      ZCODE_AGENT_SERVER_COMMAND: process.execPath,
      ZCODE_SERVER_HOST: options.host,
      ZCODE_SERVER_WORKSPACE: options.workspace,
      ZCODE_WEB_STATIC_ROOT: webRoot,
      // 设备凭据模型下服务端不再读取 ZCODE_SERVER_AUTH_TOKEN；不注入任何 token。
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let shuttingDown = false;
  child.on("error", (error) => {
    console.error(`Unable to start Web server: ${error.message}`);
    process.exit(1);
  });

  child.stdout.on("data", (chunk) => process.stdout.write(chunk));
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  child.on("exit", (code, signal) => {
    if (shuttingDown) {
      process.exit(0);
    }
    if (signal) {
      process.exit(1);
    }
    process.exit(code ?? 0);
  });

  console.log("");
  console.log("ZCode Web is running");
  console.log(`Local:   ${localUrl}`);
  if (options.host === "0.0.0.0" || options.host === "::") {
    for (const url of networkUrls(port)) {
      console.log(`Network: ${url}`);
    }
  }
  console.log("Press Ctrl+C to stop.");
  console.log("");

  if (open) {
    setTimeout(() => openBrowser(localUrl), 500);
  }

  const shutdown = () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    child.kill("SIGTERM");
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.on("data", (chunk) => {
      if (chunk.includes(3)) {
        shutdown();
      }
    });
    process.stdin.on("error", () => {
      if (!shuttingDown) {
        shutdown();
      }
    });
  }
}

try {
  const argv = process.argv.slice(2);
  if (argv.length === 1 && ["--version", "-v"].includes(argv[0])) {
    console.log(version);
  } else if (argv[0] === "--web") {
    const options = parseArgs(argv.slice(1));
    if (options.command === "help") console.log(usage());
    else if (options.command === "version") console.log(version);
    else await serve(options);
  } else {
    if (argv.length === 1 && ["--help", "-h"].includes(argv[0])) {
      console.log("Web mode: zcode --web [options] (zcode --web --help for details)\n");
    }
    // CLI 自启动子进程依赖 argv[1]；统一指向真正的 Agent 入口，保留 TTY 与所有原始参数。
    process.argv[1] = agentEntry;
    await import(pathToFileURL(agentEntry).href);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
