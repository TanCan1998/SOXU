/**
 * Issue #36 的 DOM 观测脚本（配合 tests/harness/long-session.html 使用）。
 *
 * 用法（在 apps/desktop 下，先 pnpm dev）：
 *   moli fetch --layout --wait-selector ".virtual-row" \
 *     --eval-file tests/harness/measure-dom.js \
 *     "http://127.0.0.1:1420/tests/harness/long-session.html?count=50000"
 *
 * 加 `&scroll=end` 会先滚到底部再采样。输出是一行 JSON：
 * 渲染行数、整页 DOM 节点数、行索引范围、滚动高度。
 */
(async () => {
  const scroll = document.querySelector(".message-scroll");
  if (new URLSearchParams(location.search).get("scroll") === "end" && scroll) {
    scroll.scrollTop = scroll.scrollHeight;
    // 某些无头环境不会为程序化滚动派发 scroll 事件，显式派发一次让虚拟列表重新取窗口。
    scroll.dispatchEvent(new Event("scroll"));
    await new Promise((resolve) => setTimeout(resolve, 700));
  } else {
    await new Promise((resolve) => setTimeout(resolve, 900));
  }
  const rows = Array.from(document.querySelectorAll(".virtual-row"));
  const indexes = rows.map((row) => Number(row.dataset.index));
  const heights = rows.map((row) => Math.round(row.getBoundingClientRect().height));
  return JSON.stringify({
    requested: new URLSearchParams(location.search).get("count"),
    renderedRows: rows.length,
    domNodes: document.querySelectorAll("*").length,
    firstIndex: indexes.length > 0 ? Math.min.apply(null, indexes) : null,
    lastIndex: indexes.length > 0 ? Math.max.apply(null, indexes) : null,
    rowHeights: heights.slice(0, 3),
    canvasHeight: document.querySelector(".virtual-canvas")?.style.height ?? null,
    scrollTop: scroll ? Math.round(scroll.scrollTop) : null,
    scrollHeight: scroll ? scroll.scrollHeight : null,
    clientHeight: scroll ? scroll.clientHeight : null,
    overflowY: scroll ? getComputedStyle(scroll).overflowY : null,
  });
})()
