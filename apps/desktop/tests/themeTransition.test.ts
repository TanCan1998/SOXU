/**
 * 回归测试：主题切换的圆形扩散与发光涟漪。
 *
 * 覆盖 Issue #88 / #97 的验收点里能在 Node 里确定验证的部分：
 * 圆心/半径计算、不支持 View Transitions 的降级、prefers-reduced-motion 降级、
 * 发光涟漪的两层结构、扩散结束后的水波淡出窗口、生命周期（最终必须移除）、
 * 连续切换时的代际守卫，以及 CSS 侧"淡出跟在扩散之后、颜色只引用 token"。
 *
 * 真实视觉（无闪白、光晕贴合边缘、水波可见）需要实机截图，这里只守住可断言的行为与清理。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

import {
  THEME_GLOW_CLASS,
  THEME_GLOW_EDGE_CLASS,
  THEME_GLOW_LAG_MS,
  THEME_RIPPLE_CLASS,
  THEME_RIPPLE_FADE_MS,
  THEME_RIPPLE_SETTLE_MS,
  THEME_RIPPLE_TOTAL_MS,
  THEME_TRANSITION_CLASS,
  THEME_TRANSITION_DURATION_MS,
  coverRadius,
  resolveOrigin,
  runThemeTransition,
  type ThemeDocumentLike,
  type ThemeTransitionEnv,
} from "../src/theme/themeTransition.ts";

class FakeStyle {
  readonly props = new Map<string, string>();

  setProperty(name: string, value: string): void {
    this.props.set(name, value);
  }
}

class FakeClassList {
  readonly tokens = new Set<string>();

  add(token: string): void {
    this.tokens.add(token);
  }

  remove(token: string): void {
    this.tokens.delete(token);
  }

  contains(token: string): boolean {
    return this.tokens.has(token);
  }
}

class FakeGlowElement {
  className = "";
  readonly style = new FakeStyle();
  readonly attributes = new Map<string, string>();
  /** 容器里的子层（edge / ripple）；只有容器会用到。 */
  readonly children: FakeGlowElement[] = [];
  removed = false;
  popoverOpen = false;
  showPopover?: () => void = () => {
    // 与浏览器一致：没有 popover 属性时 showPopover() 抛错
    if (!this.attributes.has("popover")) throw new Error("NotSupportedError: 缺少 popover 属性");
    this.popoverOpen = true;
  };

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  appendChild(child: FakeGlowElement): FakeGlowElement {
    this.children.push(child);
    return child;
  }

  remove(): void {
    this.removed = true;
    this.children.length = 0;
  }
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (reason?: unknown) => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // 被跳过的过渡会以拒绝收尾，测试里不关心拒绝原因
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

class FakeTransition {
  readonly ready = deferred();
  readonly finished = deferred();
  readonly update: () => void | Promise<void>;

  constructor(update: () => void | Promise<void>) {
    this.update = update;
  }
}

interface FakeDocument {
  doc: ThemeDocumentLike;
  style: FakeStyle;
  classList: FakeClassList;
  children: FakeGlowElement[];
  transitions: FakeTransition[];
}

function createFakeDocument(
  options: { viewTransition?: boolean; popover?: boolean; throwOnStart?: boolean } = {},
): FakeDocument {
  const style = new FakeStyle();
  const classList = new FakeClassList();
  const children: FakeGlowElement[] = [];
  const transitions: FakeTransition[] = [];

  const doc: ThemeDocumentLike = {
    documentElement: { classList, style },
    body: {
      appendChild: (child: never) => {
        children.push(child as unknown as FakeGlowElement);
        return child;
      },
    },
    createElement: () => {
      const element = new FakeGlowElement();
      if (options.popover === false) element.showPopover = undefined;
      return element;
    },
  };

  if (options.throwOnStart) {
    doc.startViewTransition = () => {
      throw new Error("NotAllowedError: 浏览器拒绝了这次过渡");
    };
  } else if (options.viewTransition !== false) {
    doc.startViewTransition = (update) => {
      const transition = new FakeTransition(update);
      transitions.push(transition);
      // 浏览器在拍完快照后调用 update 回调，这里同步触发即可
      void Promise.resolve(transition.update()).catch(() => undefined);
      return { ready: transition.ready.promise, finished: transition.finished.promise };
    };
  }

  return { doc, style, classList, children, transitions };
}

const VIEWPORT = { width: 1200, height: 800 };

/**
 * 真实过渡用的 env：默认把"等涟漪淡出"替换成立即返回，
 * 否则每个用例都要真的等 THEME_RIPPLE_TOTAL_MS，整套测试会拖到秒级。
 */
function animatedEnv(fake: FakeDocument, overrides: Partial<ThemeTransitionEnv> = {}): ThemeTransitionEnv {
  return {
    document: fake.doc,
    viewport: VIEWPORT,
    reducedMotion: false,
    flush: async () => undefined,
    waitForRipple: async () => undefined,
    ...overrides,
  };
}

/** 读取仓库内文件；路径相对本测试文件，避免依赖工作目录。 */
async function readSource(relative: string): Promise<string> {
  return readFile(new URL(relative, import.meta.url), "utf8");
}

function stripCssComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * 取出某条选择器的声明块；找不到直接失败，避免正则静默失效后测试假绿。
 * 组合选择器（`a,\n b {`）会先被匹配到共享块，所以取**最后**一个匹配，与层叠优先级一致。
 */
function cssRule(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`, "g");
  const matches = [...source.matchAll(pattern)];
  assert.ok(matches.length > 0, `没有找到 ${selector} 的样式块`);
  return matches[matches.length - 1]?.[1] ?? "";
}

function keyframesBlock(source: string, name: string): string {
  const match = new RegExp(`@keyframes ${name} \\{([\\s\\S]*?)\\n\\}`).exec(source);
  assert.ok(match, `没有找到 @keyframes ${name}`);
  return match[1] ?? "";
}

test("圆心取点击坐标，越界夹到视口内，缺省用视口中心", () => {
  assert.deepEqual(resolveOrigin({ clientX: 120, clientY: 240 }, VIEWPORT), { x: 120, y: 240 });
  assert.deepEqual(resolveOrigin({ clientX: 9999, clientY: -50 }, VIEWPORT), { x: 1200, y: 0 });
  assert.deepEqual(resolveOrigin(null, VIEWPORT), { x: 600, y: 400 });
  assert.deepEqual(resolveOrigin({ clientX: Number.NaN }, VIEWPORT), { x: 600, y: 400 });
});

test("覆盖半径取到最远角，保证整屏都被扩散覆盖", () => {
  assert.equal(coverRadius({ x: 0, y: 0 }, { width: 300, height: 400 }), 500);
  assert.equal(coverRadius({ x: 300, y: 400 }, { width: 300, height: 400 }), 500);
  // 圆心贴右上角时，最远角是左下角
  assert.equal(coverRadius({ x: 300, y: 0 }, { width: 300, height: 400 }), 500);
  // 角落与中心都要能覆盖整个视口
  const radius = coverRadius({ x: 600, y: 400 }, VIEWPORT);
  assert.ok(radius >= Math.hypot(600, 400));
});

test("不支持 View Transitions 时直接切换，不报错也不留样式", async () => {
  const fake = createFakeDocument({ viewTransition: false });
  let committed = 0;
  const result = await runThemeTransition({
    origin: { clientX: 10, clientY: 10 },
    commit: () => {
      committed += 1;
    },
    env: { document: fake.doc, viewport: VIEWPORT, reducedMotion: false },
  });

  assert.equal(result.mode, "instant");
  assert.equal(result.reason, "unsupported");
  assert.equal(committed, 1);
  assert.equal(fake.classList.contains(THEME_TRANSITION_CLASS), false);
  assert.equal(fake.children.length, 0);
});

test("prefers-reduced-motion 下直接切换，完全不启动过渡", async () => {
  const fake = createFakeDocument();
  let committed = 0;
  const result = await runThemeTransition({
    commit: () => {
      committed += 1;
    },
    env: { document: fake.doc, viewport: VIEWPORT, reducedMotion: true },
  });

  assert.equal(result.mode, "instant");
  assert.equal(result.reason, "reduced-motion");
  assert.equal(committed, 1);
  assert.equal(fake.transitions.length, 0, "减弱动效时不应该调用 startViewTransition");
  assert.equal(fake.classList.contains(THEME_TRANSITION_CLASS), false);
  assert.equal(fake.children.length, 0, "减弱动效时不得插入发光涟漪节点");
});

test("圆形扩散：先提交并刷新 DOM，再拍快照，ready 之后才插入发光涟漪", async () => {
  const fake = createFakeDocument();
  const order: string[] = [];
  const running = runThemeTransition({
    origin: { clientX: 30, clientY: 40 },
    commit: () => {
      order.push("commit");
    },
    env: animatedEnv(fake, {
      flush: async () => {
        order.push("flush");
      },
    }),
  });

  await delay(0);
  assert.deepEqual(order, ["commit", "flush"], "必须等新主题刷进 DOM 后再拍快照，否则会拍到旧画面");
  assert.equal(fake.transitions.length, 1);
  assert.equal(fake.classList.contains(THEME_TRANSITION_CLASS), true);
  assert.equal(fake.style.props.get("--soxu-theme-x"), "30px");
  assert.equal(fake.style.props.get("--soxu-theme-y"), "40px");
  assert.equal(fake.style.props.get("--soxu-theme-r"), `${coverRadius({ x: 30, y: 40 }, VIEWPORT)}px`);
  assert.equal(fake.style.props.get("--soxu-theme-duration"), `${THEME_TRANSITION_DURATION_MS}ms`);
  // 光晕必须比扩散边缘晚起步、与扩散同时结束，否则会跑到边缘外面被旧快照盖住（见证据文档）
  assert.ok(
    THEME_GLOW_LAG_MS > 0 && THEME_GLOW_LAG_MS < THEME_TRANSITION_DURATION_MS,
    "光晕滞后量必须落在 (0, 扩散时长) 区间内",
  );
  assert.equal(fake.style.props.get("--soxu-theme-glow-delay"), `${THEME_GLOW_LAG_MS}ms`);
  assert.equal(
    fake.style.props.get("--soxu-theme-glow-duration"),
    `${THEME_TRANSITION_DURATION_MS - THEME_GLOW_LAG_MS}ms`,
    "光晕与扩散必须同一时刻结束，避免结束瞬间被移除造成跳变",
  );
  // 水波必须等扩散抵达边界才起跑：起跑时刻 = 扩散时长，时长 = 淡出窗口
  assert.equal(
    fake.style.props.get("--soxu-theme-ripple-delay"),
    `${THEME_TRANSITION_DURATION_MS}ms`,
    "水波早于扩散结束起跑会被旧快照盖住，等于看不见",
  );
  assert.equal(fake.style.props.get("--soxu-theme-ripple-duration"), `${THEME_RIPPLE_FADE_MS}ms`);
  assert.equal(fake.children.length, 0, "快照拍完前插入的元素会被拍进旧画面");

  fake.transitions[0].ready.resolve();
  await delay(0);
  assert.equal(fake.children.length, 1);
  const glow = fake.children[0];
  assert.equal(glow.className, THEME_GLOW_CLASS);
  assert.equal(glow.attributes.get("aria-hidden"), "true");
  assert.equal(
    glow.attributes.get("popover"),
    "manual",
    "缺少 popover 属性时 showPopover() 会抛错，光晕会退回普通层并被快照盖住",
  );
  assert.equal(glow.popoverOpen, true, "发光涟漪容器必须进入 top layer，否则会被快照盖住");
  // 容器里两层：追边缘的光晕 + 扩散结束后淡出的水波
  assert.deepEqual(
    glow.children.map((child) => child.className),
    [THEME_GLOW_EDGE_CLASS, THEME_RIPPLE_CLASS],
    "缺少任意一层，要么扩散途中没有光晕，要么抵达边界后没有水波",
  );
  assert.equal(glow.style.props.get("--soxu-theme-r"), `${coverRadius({ x: 30, y: 40 }, VIEWPORT)}px`);

  fake.transitions[0].finished.resolve();
  const result = await running;
  assert.equal(result.mode, "animated");
  assert.equal(glow.removed, true, "动画结束后不得残留节点");
  assert.equal(fake.classList.contains(THEME_TRANSITION_CLASS), false);
});

test("浏览器不支持 popover 时保留扩散，发光涟漪仍然会被清理", async () => {
  const fake = createFakeDocument({ popover: false });
  const running = runThemeTransition({
    commit: () => undefined,
    env: animatedEnv(fake),
  });

  await delay(0);
  fake.transitions[0].ready.resolve();
  await delay(0);
  assert.equal(fake.children.length, 1);
  assert.equal(fake.children[0].popoverOpen, false);

  fake.transitions[0].finished.resolve();
  await running;
  assert.equal(fake.children[0].removed, true);
});

test("连续切换：旧过渡被跳过时不能拆掉新过渡的类名，旧发光涟漪先被摘掉", async () => {
  const fake = createFakeDocument();
  const waits: number[] = [];
  const env = animatedEnv(fake, {
    waitForRipple: async (ms) => {
      waits.push(ms);
    },
  });

  const first = runThemeTransition({ origin: { clientX: 5, clientY: 5 }, commit: () => undefined, env });
  await delay(0);
  fake.transitions[0].ready.resolve();
  await delay(0);
  const firstGlow = fake.children[0];
  assert.equal(firstGlow.removed, false);

  const second = runThemeTransition({ origin: { clientX: 900, clientY: 700 }, commit: () => undefined, env });
  await delay(0);
  assert.equal(fake.transitions.length, 2);
  assert.equal(firstGlow.removed, true, "新过渡开始时要摘掉上一次的发光涟漪（哪怕它正在淡出）");
  assert.equal(fake.classList.contains(THEME_TRANSITION_CLASS), true);

  fake.transitions[0].finished.reject(new Error("skipped"));
  await first;
  assert.equal(
    fake.classList.contains(THEME_TRANSITION_CLASS),
    true,
    "旧过渡的清理不能拆掉新过渡正在用的类名",
  );

  fake.transitions[1].ready.resolve();
  await delay(0);
  fake.transitions[1].finished.resolve();
  await second;
  assert.equal(fake.classList.contains(THEME_TRANSITION_CLASS), false);
});

test("startViewTransition 同步抛错时仍然提交主题并清理，不静默失败", async () => {
  const fake = createFakeDocument({ throwOnStart: true });
  let committed = 0;
  const result = await runThemeTransition({
    origin: { clientX: 20, clientY: 30 },
    commit: () => {
      committed += 1;
    },
    env: { document: fake.doc, viewport: VIEWPORT, reducedMotion: false, flush: async () => undefined },
  });

  assert.equal(result.mode, "instant");
  assert.equal(result.reason, "start-failed");
  assert.equal(committed, 1, "回调不会被执行，必须由降级路径提交主题");
  assert.equal(fake.classList.contains(THEME_TRANSITION_CLASS), false, "同步抛错后不得留下过渡类名");
  assert.equal(fake.children.length, 0);
});

test("过渡被浏览器中断时仍然完成清理，不抛出异常", async () => {
  const fake = createFakeDocument();
  const waits: number[] = [];
  const running = runThemeTransition({
    commit: () => undefined,
    env: animatedEnv(fake, {
      waitForRipple: async (ms) => {
        waits.push(ms);
      },
    }),
  });

  await delay(0);
  fake.transitions[0].ready.reject(new Error("aborted"));
  const result = await running;

  assert.equal(result.mode, "animated");
  assert.equal(fake.children.length, 0);
  assert.equal(fake.classList.contains(THEME_TRANSITION_CLASS), false);
  assert.deepEqual(waits, [], "被中断的过渡没有水波可看，不应再等淡出计时");
});

test("水波淡出：扩散结束后节点保留一个淡出窗口再移除，不留残留 DOM", async () => {
  const fake = createFakeDocument();
  const waits: number[] = [];
  const gate = deferred();
  const running = runThemeTransition({
    origin: { clientX: 10, clientY: 10 },
    commit: () => undefined,
    env: animatedEnv(fake, {
      waitForRipple: (ms) => {
        waits.push(ms);
        return gate.promise;
      },
    }),
  });

  await delay(0);
  fake.transitions[0].ready.resolve();
  await delay(0);
  const glow = fake.children[0] as FakeGlowElement;
  assert.equal(glow.removed, false);

  fake.transitions[0].finished.resolve();
  await delay(0);
  assert.equal(glow.removed, false, "扩散结束只是水波淡出的起点，节点必须活到淡出结束");
  assert.equal(fake.classList.contains(THEME_TRANSITION_CLASS), false, "过渡类名在 finished 就该撤掉");
  assert.deepEqual(
    waits,
    [THEME_RIPPLE_TOTAL_MS],
    "等待时长必须是淡出窗口（淡出时长 + 收尾余量）",
  );

  gate.resolve();
  await running;
  assert.equal(glow.removed, true, "淡出结束后必须移除节点，不能留残留 DOM");
});

test("水波淡出时长落在 300–600ms，并且真的以透明收尾", async () => {
  assert.ok(
    THEME_RIPPLE_FADE_MS >= 300 && THEME_RIPPLE_FADE_MS <= 600,
    `淡出时长 ${THEME_RIPPLE_FADE_MS}ms 不在 Issue 要求的 300–600ms 区间`,
  );
  assert.ok(THEME_RIPPLE_SETTLE_MS >= 0 && THEME_RIPPLE_SETTLE_MS < THEME_RIPPLE_FADE_MS);
  assert.equal(THEME_RIPPLE_TOTAL_MS, THEME_RIPPLE_FADE_MS + THEME_RIPPLE_SETTLE_MS);

  const css = stripCssComments(await readSource("../src/styles/base.css"));
  const ripple = cssRule(css, ".soxu-theme-glow__ripple");
  assert.match(ripple, /var\(--soxu-theme-ripple-duration\)/, "淡出时长必须由 JS 写入的变量驱动");
  assert.match(ripple, /var\(--soxu-theme-ripple-delay\)/, "淡出必须等扩散结束才起跑");
  assert.match(ripple, /var\(--soxu-accent\)/, "水波颜色必须引用强调色 token，深浅主题才自动跟随");
  assert.match(
    ripple,
    /radial-gradient\(\s*circle closest-side/,
    "径向渐变必须用 closest-side：默认 farthest-corner 会把光环推到 1.41R 之外，整条落在视口外不可见",
  );
  for (const forbidden of [/#[0-9a-fA-F]{3,8}\b/, /\brgba?\(/, /\bhsla?\(/]) {
    assert.doesNotMatch(ripple, forbidden, `水波样式里出现了硬编码色值：${forbidden}`);
  }

  const wave = keyframesBlock(css, "soxu-theme-ripple-wave");
  assert.match(wave, /100%\s*\{[^}]*opacity:\s*0/, "水波必须以透明收尾，否则移除节点会看到跳变");
  assert.match(wave, /scale\(1\.0[0-9]\)/, "水波要向外散开一点，才有水面涟漪的观感");

  // 默认值：单独引用 CSS 时水波也不能早于扩散起跑
  assert.match(css, /--soxu-theme-ripple-delay:\s*420ms/);
  assert.match(css, /--soxu-theme-ripple-duration:\s*480ms/);
});

test("光晕与扩散分处两层，容器不能裁掉子层（popover 的 UA overflow）", async () => {
  const css = stripCssComments(await readSource("../src/styles/base.css"));
  const container = cssRule(css, ".soxu-theme-glow");
  assert.match(container, /overflow:\s*visible/, "popover 默认 overflow: auto，不放开会把两层圆圈裁成 0×0");
  assert.doesNotMatch(container, /animation:/, "光晕动画必须挂在 __edge 层上，容器只负责定位");

  const edge = cssRule(css, ".soxu-theme-glow__edge");
  assert.match(edge, /animation:\s*soxu-theme-glow-expand/);
  assert.match(edge, /var\(--soxu-accent\)/, "边缘光晕同样只能引用 token 颜色");
});
