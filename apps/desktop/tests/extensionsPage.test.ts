/**
 * 回归测试：扩展页真数据（Issue #147）。
 *
 * 能在 Node 里确定验证的部分：
 * - composable 的三态（读取中 / 就绪 / 失败）与失败原因原样透传；
 * - 技能详情按需展开、结果缓存、失败后重试；
 * - 后端扫描模块是纯读的（源码层面没有写调用），命令层没有写 Pi 配置的入口。
 *
 * 真实窗口里的渲染、与本机 ~/.pi/agent 的逐条比对属于实机验收，
 * 见 docs/development/evidence/issue-147-extensions-page/README.md。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { useExtensionCatalog } from "../src/composables/useExtensionCatalog.ts";
import type {
  ExtensionCatalog,
  ExtensionDetail,
  ExtensionsBridge,
} from "../src/services/extensions.ts";

const CATALOG_ROOT = fileURLToPath(new URL("../src-tauri/src/", import.meta.url));

function catalogFixture(): ExtensionCatalog {
  return {
    agentDir: "/home/user/.pi/agent",
    extensions: [
      {
        id: "builtin:mcp",
        name: "mcp",
        source: "builtin",
        enabled: true,
        description: null,
        path: null,
      },
      {
        id: "extension:rtk",
        name: "rtk",
        source: "user",
        enabled: true,
        description: null,
        path: "/home/user/.pi/agent/extensions/rtk.ts",
      },
    ],
    skills: [
      {
        id: "skill:pdf-craft",
        name: "pdf-craft",
        description: "PDF 合并与拆分",
        enabled: false,
        path: "/home/user/.pi/agent/skills/pdf-craft",
      },
    ],
    mcpServers: [
      {
        id: "mcp:github",
        name: "github",
        transport: "http",
        description: null,
        status: "unknown",
      },
    ],
  };
}

class FakeExtensions implements ExtensionsBridge {
  readonly detailCalls: string[] = [];
  failList: string | null = null;
  failDetail: string | null = null;
  catalog: ExtensionCatalog = catalogFixture();

  async list(): Promise<ExtensionCatalog> {
    if (this.failList) throw new Error(this.failList);
    return this.catalog;
  }

  async detail(id: string): Promise<ExtensionDetail> {
    this.detailCalls.push(id);
    if (this.failDetail) throw new Error(this.failDetail);
    return {
      id,
      name: "pdf-craft",
      path: "/home/user/.pi/agent/skills/pdf-craft",
      fileCount: 7,
      fileCountTruncated: false,
      description: "PDF 合并与拆分",
    };
  }
}

test("扩展页三态：初始读取中，成功后带目录，失败保留后端原因", async () => {
  const bridge = new FakeExtensions();
  const view = useExtensionCatalog(bridge);
  // 初始即 loading：不会先闪一帧空列表。
  assert.equal(view.status.value, "loading");

  await view.refresh();
  assert.equal(view.status.value, "ready");
  assert.equal(view.catalog.value?.agentDir, "/home/user/.pi/agent");
  assert.equal(view.error.value, null);

  bridge.failList = "读不到 Pi 的配置目录 /home/user/.pi/agent（系统找不到指定的路径）";
  await view.refresh();
  assert.equal(view.status.value, "error");
  assert.equal(view.catalog.value, null, "失败时不能留下上一份清单冒充当前状态");
  assert.match(view.error.value ?? "", /配置目录/u, "失败原因要原样交给界面");
});

test("扩展页空清单是「就绪 + 空」，不是失败", async () => {
  const bridge = new FakeExtensions();
  bridge.catalog = { agentDir: "/tmp/empty-agent", extensions: [], skills: [], mcpServers: [] };
  const view = useExtensionCatalog(bridge);
  await view.refresh();
  assert.equal(view.status.value, "ready");
  assert.deepEqual(view.catalog.value?.skills, []);
});

test("技能详情：按需展开、只取一次、失败可重试", async () => {
  const bridge = new FakeExtensions();
  const view = useExtensionCatalog(bridge);
  await view.refresh();

  // 没有展开就不请求详情。
  assert.deepEqual(bridge.detailCalls, []);

  await view.toggleDetail("skill:pdf-craft");
  assert.deepEqual(bridge.detailCalls, ["skill:pdf-craft"]);
  assert.equal(view.isExpanded("skill:pdf-craft"), true);
  assert.equal(view.detailOf("skill:pdf-craft")?.detail?.fileCount, 7);

  // 收起再展开：命中缓存，不重复扫描目录。
  await view.toggleDetail("skill:pdf-craft");
  assert.equal(view.isExpanded("skill:pdf-craft"), false);
  await view.toggleDetail("skill:pdf-craft");
  assert.deepEqual(bridge.detailCalls, ["skill:pdf-craft"]);

  // 刷新后旧详情失效（技能可能被删或改名），需要重新取。
  await view.refresh();
  assert.equal(view.detailOf("skill:pdf-craft"), null);
  assert.equal(view.isExpanded("skill:pdf-craft"), false);
});

test("技能详情失败：错误留在该条上，不牵连整个清单", async () => {
  const bridge = new FakeExtensions();
  bridge.failDetail = "无法读取 /home/user/.pi/agent/skills/pdf-craft：权限不足";
  const view = useExtensionCatalog(bridge);
  await view.refresh();

  await view.toggleDetail("skill:pdf-craft");
  const state = view.detailOf("skill:pdf-craft");
  assert.equal(state?.loading, false);
  assert.equal(state?.detail, null);
  assert.match(state?.error ?? "", /权限不足/u);
  assert.equal(view.status.value, "ready", "一条详情失败不该把整页打成失败态");

  // 修好之后再展开会重试，并把错误清掉。
  bridge.failDetail = null;
  await view.toggleDetail("skill:pdf-craft");
  await view.toggleDetail("skill:pdf-craft");
  assert.equal(view.detailOf("skill:pdf-craft")?.error, null);
  assert.equal(view.detailOf("skill:pdf-craft")?.detail?.fileCount, 7);
});

test("后端扫描模块是纯读的：没有写 Pi 配置的调用", async () => {
  const sources = await Promise.all(
    ["mod.rs", "entry.rs", "resources.rs", "mcp.rs"].map((name) =>
      readFile(CATALOG_ROOT + "extension_catalog/" + name, "utf8"),
    ),
  );
  const text = sources.join("\n");
  for (const forbidden of [
    "fs::write",
    "fs::remove",
    "fs::create_dir",
    "OpenOptions",
    "File::create",
    "fs::rename",
  ]) {
    assert.ok(!text.includes(forbidden), "扫描模块里出现了写入调用：" + forbidden);
  }

  // 命令层也不许出现写 Pi 配置的入口（set_ / save_ 只能属于语言包，与 Pi 无关）。
  const commands = await readFile(CATALOG_ROOT + "commands/extension.rs", "utf8");
  const piWrites = commands.match(/pub async fn (set|save|toggle|enable|disable)_[a-z_]*/gu) ?? [];
  assert.deepEqual(
    piWrites.filter((name) => !name.includes("locale")),
    [],
    "扩展领域不得注册写 Pi 配置的命令",
  );
  assert.ok(commands.includes("pub async fn list_extensions"), "只读入口必须存在");
  assert.ok(commands.includes("pub async fn read_extension_detail"), "详情入口必须存在");
});
