// 切到深色并等待主题过渡结束，再让 moli 截图（--dump screenshot 会丢弃返回值）。
(async () => {
  const toggle = document.querySelector('[aria-label="切换到深色主题"]');
  if (!toggle) throw new Error("找不到主题切换按钮");
  toggle.click();
  await new Promise((resolve) => setTimeout(resolve, 1400));
  return document.documentElement.dataset.theme;
})()
