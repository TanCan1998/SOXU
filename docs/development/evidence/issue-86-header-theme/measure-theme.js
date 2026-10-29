// 读取顶部栏在浅色/深色下的 computed 样式（moli fetch --eval-file 使用）。
(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const read = () => {
    const header = document.querySelector(".app-header");
    const headerStyle = getComputedStyle(header);
    const badge = document.querySelector(".app-header .badge");
    const badgeStyle = badge ? getComputedStyle(badge) : null;
    const icon = document.querySelector(".app-header .icon-button");
    const iconStyle = icon ? getComputedStyle(icon) : null;
    const scope = document.querySelector(".location-scope");
    return {
      htmlTheme: document.documentElement.dataset.theme,
      shellTheme: document.querySelector(".app-shell")?.dataset.theme ?? null,
      colorScheme: headerStyle.colorScheme,
      headerBackground: headerStyle.backgroundColor,
      headerColor: headerStyle.color,
      headerBorderBottom: headerStyle.borderBottomColor,
      locationScopeColor: scope ? getComputedStyle(scope).color : null,
      badgeBackground: badgeStyle?.backgroundColor ?? null,
      badgeColor: badgeStyle?.color ?? null,
      iconButtonColor: iconStyle?.color ?? null,
      hoverToken: getComputedStyle(document.querySelector(".app-shell")).getPropertyValue("--soxu-hover").trim(),
      bodyBackground: getComputedStyle(document.body).backgroundColor,
    };
  };

  const light = read();
  const toggle = document.querySelector('[aria-label="切换到深色主题"]');
  if (!toggle) throw new Error("找不到主题切换按钮");
  toggle.click();
  await sleep(1400);
  const dark = read();
  return JSON.stringify({ light, dark }, null, 2);
})()
