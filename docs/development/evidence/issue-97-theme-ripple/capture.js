/**
 * Issue #97 实机截图脚本（moli fetch --eval-file 使用）。
 *
 * 用 URL 查询参数选择场景：?shot=to-light-t200 / to-light-ripple / to-light-settled
 *                              to-dark-t200  / to-dark-ripple  / to-dark-settled
 *
 * 为什么要"暂停动画"而不是靠真实计时截图：
 * - 截图发生在脚本返回之后，真实计时会叠加跳转 + 截图延迟，t≈200ms 变成不可控的 200–600ms；
 * - document.getAnimations() 能拿到 view transition 伪元素动画和水波动画，
 *   暂停后把 currentTime 定在目标时刻，得到可复现的确定帧（证据文档里注明该做法）。
 */
(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const shot = new URLSearchParams(location.search).get("shot") || "to-light-t200";
  const target = shot.startsWith("to-light") ? "light" : "dark";
  const startFrom = shot.startsWith("baseline")
    ? shot.endsWith("light")
      ? "light"
      : "dark"
    : target === "light"
      ? "dark"
      : "light";

  const themeNow = () => document.documentElement.dataset.theme ?? null;
  const findToggle = () => {
    const button = [...document.querySelectorAll("button")].find((node) =>
      (node.getAttribute("aria-label") || "").includes("主题"),
    );
    if (!button) throw new Error("找不到主题切换按钮");
    return button;
  };
  /** 在按钮中心派发真实 MouseEvent，让扩散圆心落在按钮上（不是视口中心）。 */
  const clickToggle = () => {
    const button = findToggle();
    const rect = button.getBoundingClientRect();
    const clientX = Math.round(rect.left + rect.width / 2);
    const clientY = Math.round(rect.top + rect.height / 2);
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, clientX, clientY }));
    return { clientX, clientY };
  };
  /**
   * 等一整轮涟漪走完：节点在 transition.ready 之后才挂载，
   * 所以必须先看到它出现、再等到它被移除，不能只看"当前没有节点"。
   */
  const waitRippleCycle = async (budgetMs = 5000) => {
    const deadline = performance.now() + budgetMs;
    let seen = false;
    while (performance.now() < deadline) {
      const count = document.querySelectorAll(".soxu-theme-glow").length;
      if (count > 0) seen = true;
      else if (seen) return true;
      await sleep(25);
    }
    return false;
  };
  const readLayers = () => {
    const layer = document.querySelector(".soxu-theme-glow");
    if (!layer) return { layers: [], rect: null };
    return {
      layers: [...layer.children].map((child) => child.className),
      rect: layer.getBoundingClientRect().toJSON(),
      popoverOpen: layer.matches(":popover-open"),
    };
  };
  /** 暂停当前所有动画；ms 不为 null 时把播放位置定到该毫秒数。 */
  const freezeAnimations = (ms) => {
    const animations = document.getAnimations();
    for (const animation of animations) {
      try {
        animation.pause();
        if (typeof ms === "number") animation.currentTime = ms;
      } catch {
        // 单个动画不支持暂停时忽略：其余动画仍然会被冻结
      }
    }
    return animations.length;
  };

  /** 等 SPA 挂载完成（导航后立刻执行脚本时 #app 可能还是空的）。 */
  const waitForToggle = async (budgetMs = 15000) => {
    const deadline = performance.now() + budgetMs;
    while (performance.now() < deadline) {
      if (document.querySelector(".app-shell") && findToggleOrNull()) return;
      await sleep(50);
    }
    throw new Error("等待 .app-shell / 主题按钮超时");
  };
  const findToggleOrNull = () =>
    [...document.querySelectorAll("button")].find((node) =>
      (node.getAttribute("aria-label") || "").includes("主题"),
    ) ?? null;

  await waitForToggle();

  const boot = {
    theme: themeNow(),
    reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
    hasViewTransition: typeof document.startViewTransition === "function",
    hasGetAnimations: typeof document.getAnimations === "function",
    userAgent: navigator.userAgent,
  };

  // 降级场景：观察点击后是否出现发光涟漪节点 / 过渡类名
  const watchLayerCount = () => {
    window.__soxuLayerSeen = 0;
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node instanceof Element && node.matches?.(".soxu-theme-glow")) window.__soxuLayerSeen += 1;
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  };

  if (shot === "reduced-motion" || shot === "unsupported") {
    const stop = watchLayerCount();
    if (shot === "unsupported") document.startViewTransition = undefined;
    const from = themeNow();
    clickToggle();
    await sleep(500);
    stop();
    return JSON.stringify({
      shot,
      boot,
      from,
      theme: themeNow(),
      changed: themeNow() !== from,
      layerSeen: window.__soxuLayerSeen,
      residualLayers: document.querySelectorAll(".soxu-theme-glow").length,
      htmlClass: document.documentElement.className,
      hasViewTransition: typeof document.startViewTransition === "function",
    });
  }

  // 先把起点主题准备好（第二次切换才是待观测的那一次）
  if (themeNow() !== startFrom) {
    clickToggle();
    if (!(await waitRippleCycle())) throw new Error("准备阶段的水波没有清理干净");
    await sleep(150);
  }
  if (themeNow() !== startFrom) throw new Error(`起点主题不是 ${startFrom}，实际 ${themeNow()}`);

  if (shot.startsWith("baseline")) {
    // 基线帧：只把主题摆好，不触发任何过渡，用来证明"稳定帧 == 没有涟漪的正常画面"
    return JSON.stringify({ shot, boot, theme: themeNow(), residualLayers: 0 });
  }

  const origin = clickToggle();

  if (shot.includes("-t200")) {
    // 等 view transition 伪元素动画出现后冻结在 200ms；
    // -t200-noglow 是对照组：同一时刻摘掉发光层，用来单独量化"光晕贡献了多少像素"
    let frozen = 0;
    for (let i = 0; i < 200 && frozen === 0; i += 1) {
      frozen = freezeAnimations(200);
      if (frozen === 0) await sleep(5);
    }
    if (frozen === 0) throw new Error("没有抓到 View Transition 动画，扩散可能未启动");
    const before = readLayers();
    if (shot.endsWith("-t200-noglow")) {
      for (const node of document.querySelectorAll(".soxu-theme-glow")) node.remove();
    }
    return JSON.stringify({ shot, boot, origin, theme: themeNow(), frozen, before, ...readLayers() });
  }

  if (shot.endsWith("-ripple")) {
    // 等扩散结束、水波跑到中段再冻结：此时伪元素已销毁，水波完整可见
    await sleep(620);
    const frozen = freezeAnimations(null);
    return JSON.stringify({
      shot,
      boot,
      origin,
      theme: themeNow(),
      frozen,
      htmlClass: document.documentElement.className,
      ...readLayers(),
    });
  }

  // 完成态：等整个生命周期结束，断言没有残留 DOM
  const cleared = await waitRippleCycle();
  await sleep(120);
  return JSON.stringify({
    shot,
    boot,
    origin,
    theme: themeNow(),
    cleared,
    residualLayers: document.querySelectorAll(".soxu-theme-glow").length,
    htmlClass: document.documentElement.className,
    bodyTheme: document.querySelector(".app-shell")?.dataset.theme ?? null,
  });
})()
