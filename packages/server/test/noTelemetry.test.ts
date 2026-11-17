// 门禁：本部署是服务端自托管（`zcode --web` + agent），不得引入任何遥测上报出口。
//
// 断言思路移植自 ZCodium-project/ZCodium 的 no-telemetry 测试（独立去遥测审计 fork），
// 按本部署的实际形态裁剪：ZCodium 是物理删除遥测，本 fork 保留上游代码但要求「服务端侧不出现
// 上报机制」、且 web 平台的两个上报钩子必须保持空实现。
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

/** 上报机制的特征串：一旦这些出现在服务端/web 源码里，说明遥测被接进了自托管链路。 */
const REPORTING_MACHINERY =
  /createTelemetryCore|@arms\/|OTEL_EXPORTER_OTLP|ZCODE_TELEMETRY_REPORT_ENDPOINT|ZCODE_ARMS_RUM_ENDPOINT/;

async function sources(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory()
        ? sources(`${dir}/${entry.name}`)
        : /\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".d.ts")
          ? [`${dir}/${entry.name}`]
          : [],
    ),
  );
  return nested.flat();
}

test("服务端包不包含遥测上报机制", async () => {
  for (const dir of ["packages/server/src", "packages/zcode-server-cli/src"]) {
    for (const file of await sources(repoRoot + dir)) {
      assert.doesNotMatch(await readFile(file, "utf8"), REPORTING_MACHINERY, file);
    }
  }
});

test("web 包不包含遥测上报机制", async () => {
  for (const file of await sources(repoRoot + "packages/web/src")) {
    assert.doesNotMatch(await readFile(file, "utf8"), REPORTING_MACHINERY, file);
  }
});

test("web 平台的上报钩子保持空实现", async () => {
  const main = await readFile(repoRoot + "packages/web/src/main.tsx", "utf8");
  // 钩子可以存在（上游 UI 会调用），但必须是 no-op——接上真实上报即视为回归。
  assert.match(main, /reportTelemetryEvent:\s*async\s*\(\)\s*=>\s*\{\s*\}/, "reportTelemetryEvent 必须是空实现");
  assert.match(main, /reportArmsCustomEvent:\s*\(\)\s*=>\s*Promise\.resolve\(\)/, "reportArmsCustomEvent 必须是空实现");
});
