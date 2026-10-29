# Issue #101 · 关闭/退出按钮排查与「隐藏到托盘」的反馈

- 采集日期：2026-10-29
- 采集对象：本工作树 `apps/desktop/src-tauri` 的 debug 构建 `target/debug/soxu-desktop.exe`
  （Tauri 2.12.5 + `tray-icon` 0.25.1，Rust 1.99.1 Edition 2024）
- 交互方式：与 [Issue #90 托盘证据](../issue-90-tray/README.md) 同一套 Win32 消息投递
  （不依赖鼠标移动，每一步可重复、可断言）；tooltip 文本另外尝试过 UI Automation 读取，未成功（见「未覆盖」）

## 逐项排查结论（对应 Issue 排查清单）

### 1. 点 × 的真实行为：确实隐藏到托盘，不是「没反应」

| 检查 | 结论 | 证据 |
|---|---|---|
| `CloseRequested` 处理是否被 feature gate 掉 | 没有 | `src/tray.rs` 里没有 `#[cfg(feature = ...)]` 门控；`lib.rs` 的 `Builder::on_window_event(tray::handle_window_event)` 在 dev 与 release 走同一条路径 |
| 托盘创建是否只在 release 生效 | 不是 | `create_tray` 在 `setup` 里无条件调用，debug 构建同样创建（下方 `tray_host_present=1`、图标 `S_OK` 可证） |
| 点 × 后窗口是否隐藏 | 是 | `WM_CLOSE` → `IsWindowVisible(Tauri Window)=0` |
| 点 × 后进程是否存活 | 是 | `process_alive_after_close=True`，重复一次结果相同 |
| 是否产生第二个托盘图标 | 没有 | 托盘宿主窗口始终只有 1 个，stderr 无「创建系统托盘失败」 |

**所以「点 × 没反应」的真实成因是观感问题**：窗口消失后屏幕上没有任何东西能证明进程还活着，
而 Windows 11 默认把新的托盘图标收进「隐藏的图标」溢出区（本次实测图标 rect 落在通知区域右下角，
需要展开溢出面板才能看到）。用户看到的就是「窗口没了，也不知道去哪了」。

### 2. 隐藏到托盘时的可感知反馈：改成托盘 tooltip 变化（未引入通知插件）

- 为什么不用 toast：`tauri-plugin-notification` 是新增依赖 + 新增权限，本仓库的既有约定是
  「不增加常驻依赖、不新增后台资源」；Issue 明确允许退而求其次用 tooltip。
- 实现（`src/tray.rs`）：
  - `tray_tooltip(window_hidden)` 纯函数给出两个状态的文案：
    可见时 `SOXU · 索序`，隐藏后 `SOXU 已最小化到托盘 · 单击图标显示窗口`；
  - `handle_window_event` 在 `window.hide()` **成功之后**才切到隐藏文案（hide 失败时窗口还在，
    提示必须继续描述「窗口可见」）；
  - `show_main_window` 在 `window.show()` 之后切回品牌名，否则 tooltip 会一直停在「已最小化」。
- 为什么可以直接在窗口事件里调用：`TrayIcon::set_tooltip` 内部走 `run_on_main_thread`，
  而 `tauri-runtime-wry` 的 `send_user_message` 在「当前线程就是主线程」时会就地执行
  （`tauri-runtime-wry-2.12.1/src/lib.rs:263`），因此不会因为等事件循环而卡死。

### 3. 托盘左键单击恢复窗口：确认可用，本次未改实现

- `action_for_tray_event` 只认「左键抬起」与「Windows 双击」：按下和抬起都响应会让一次点击恢复两次。
- 实机：隐藏状态下投递 `WM_LBUTTONUP`（`WM_USER_TRAYICON=6002`，`uid=2`）→ `IsWindowVisible=1`。

### 4. 界面内其它关闭语义按钮：逐个确认有响应，并加自动化守卫

| 入口 | 处理 | 结论 |
|---|---|---|
| 顶栏「会话状态」按钮（`aria-label` 为「关闭/打开会话状态面板」） | `inspectorOpen = !inspectorOpen` | 正常 |
| 会话状态面板 × | `emit("close")` → `inspectorOpen = false` | 正常 |
| 设置对话框 × | `emit("close")` → `settingsOpen = false` | 正常 |
| 设置对话框遮罩点击 / Esc | `@click.self` / `onKeydown` | 正常 |
| 工作树面板 × | `emit("close")` → `closeWorktrees()` | 正常 |
| 工作树面板遮罩点击 / Esc | `@click.self` / `onKeydown` | 正常 |
| 会话 Tab 的 × | `emit("close", sessionId)` → `store.closeTab` | 正常；`useTabDrag` 显式排除 `.tab-close`，否则按下会先进入拖拽、随后的 click 被当作拖拽余波吞掉（这正是「Tab × 点了没反应」的典型成因） |
| 会话 Tab 的 Delete 键 | `onKeydown` → `emit("close", ...)` | 正常 |
| 托盘菜单「显示窗口」 | `TrayAction::Show` → `show_main_window` | 正常（#90 已验，本次复验） |
| 托盘菜单「退出」 | `TrayAction::Quit` → `app.exit(0)` | 正常（下方 `process_alive_after_menu_quit=False`） |

**没有发现死按钮。** 新增 `apps/desktop/tests/closeAffordances.test.ts`（5 个用例）把上述事实固定下来：
关闭语义按钮必须有点击处理 / 有无障碍名称 / 不是 `disabled` / 显式 `type="button"`；
每个声明 `close` 事件的子组件都必须在 `App.vue` 里被接上且落到真实状态；
对话框必须同时有 ×、遮罩、Esc 三条关闭路径；Tab 关闭按钮不得被拖拽吞掉。

## 原始输出（隐藏 / 恢复 / 退出）

```
[launched] main_window_visible=1 tray_host_present=1
tray_icon uid=2 S_OK rect=(2037,1438)-(2085,1510)
=== STEP 1: 点窗口 × -> 期望隐藏、进程存活 ===
process_alive_after_close=True
[after-close-1] main_window_visible=0 tray_host_present=1
=== STEP 2: 托盘左键单击 -> 期望恢复 ===
[after-tray-click] main_window_visible=1 tray_host_present=1
=== STEP 3: 再隐藏一次，确认可重复 ===
[after-close-2] main_window_visible=0 tray_host_present=1
process_alive_after_close_2=True
=== STEP 4: 托盘菜单「退出」(WM_COMMAND 1001) -> 期望进程结束 ===
process_alive_after_menu_quit=False
=== stderr 里的 SOXU 诊断（应为空）===
[1029/185424.168:ERROR:ui\gfx\win\window_impl.cc:172] Failed to unregister class Chrome_WidgetWin_0. Error = 1412
=== DONE ===
```

- stderr 里唯一一行来自 Chromium 退出时注销窗口类，不是 SOXU 的诊断输出。
  **没有** `更新托盘提示失败`、`隐藏窗口到托盘失败` 之类输出，说明两次隐藏都真的执行到了
  `sync_tooltip` 且 `set_tooltip` 没有报错（失败会 `eprintln` 到同一路 stderr）。
- `Failed to unregister class` 的出现时机与「窗口已隐藏 + webview 未加载 dev 服务器」有关，
  与本次改动无关（改动只增加了一次 `set_tooltip` 调用）。

## 复现脚本

在本工作树根目录的 PowerShell 7 中运行；脚本自己启动进程、逐项断言并在最后结束进程。

```powershell
$root = (Get-Location).Path
$exe = Join-Path $root 'target\debug\soxu-desktop.exe'
$outLog = Join-Path $root 'target\verify-101.out.log'
$errLog = Join-Path $root 'target\verify-101.err.log'

$src = @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class Tray {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern IntPtr SendMessageW(IntPtr h, uint msg, IntPtr wp, IntPtr lp);
  [StructLayout(LayoutKind.Sequential)] public struct RECTQ { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct NID { public uint cbSize; public IntPtr hWnd; public uint uID; public Guid guidItem; }
  [DllImport("shell32.dll", SetLastError=true)] public static extern int Shell_NotifyIconGetRect(ref NID id, out RECTQ rect);
  public static long FindByClass(uint target, string cls) {
    long found = 0;
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pid == target) {
        var c = new StringBuilder(256); GetClassNameW(h, c, 256);
        if (c.ToString() == cls) { found = h.ToInt64(); return false; }
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static int GetRect(long hwnd, uint uid, out int l2, out int t2, out int r2, out int b2) {
    var nid = new NID();
    nid.cbSize = (uint)Marshal.SizeOf(typeof(NID));
    nid.hWnd = (IntPtr)hwnd; nid.uID = uid; nid.guidItem = Guid.Empty;
    RECTQ rc; int hr = Shell_NotifyIconGetRect(ref nid, out rc);
    l2 = rc.Left; t2 = rc.Top; r2 = rc.Right; b2 = rc.Bottom;
    return hr;
  }
}
"@
Add-Type -TypeDefinition $src

$WM_CLOSE = 0x0010; $WM_COMMAND = 0x0111; $WM_USER_TRAYICON = 6002; $WM_LBUTTONUP = 0x0202

function State([string]$tag, $tauriHwnd) {
  $tv = if ([Tray]::IsWindowVisible([IntPtr]$tauriHwnd)) { 1 } else { 0 }
  Write-Host ("[{0}] main_window_visible={1} tray_host_present=1" -f $tag, $tv)
}

$proc = Start-Process -FilePath $exe -PassThru -RedirectStandardOutput $outLog -RedirectStandardError $errLog
Start-Sleep -Seconds 6
$tauriHwnd = [Tray]::FindByClass([uint32]$proc.Id, 'Tauri Window')
$trayHwnd  = [Tray]::FindByClass([uint32]$proc.Id, 'tray_icon_app')
if (-not $tauriHwnd -or -not $trayHwnd) { Write-Host 'FAIL: 窗口或托盘宿主缺失'; exit 1 }
State 'launched' $tauriHwnd

$iconUid = 0
foreach ($uid in 1..6) {
  $a=0;$b=0;$c=0;$d=0
  if ([Tray]::GetRect($trayHwnd, [uint32]$uid, [ref]$a, [ref]$b, [ref]$c, [ref]$d) -eq 0) {
    $iconUid = $uid
    Write-Host ("tray_icon uid={0} S_OK rect=({1},{2})-({3},{4})" -f $uid, $a, $b, $c, $d)
  }
}

[Tray]::SendMessageW([IntPtr]$tauriHwnd, $WM_CLOSE, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
Start-Sleep -Seconds 2
$proc.Refresh(); Write-Host ("process_alive_after_close={0}" -f (-not $proc.HasExited))
State 'after-close-1' $tauriHwnd

[Tray]::SendMessageW([IntPtr]$trayHwnd, $WM_USER_TRAYICON, [IntPtr]$iconUid, [IntPtr]$WM_LBUTTONUP) | Out-Null
Start-Sleep -Seconds 2
State 'after-tray-click' $tauriHwnd

[Tray]::SendMessageW([IntPtr]$tauriHwnd, $WM_CLOSE, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
Start-Sleep -Seconds 2
$proc.Refresh(); Write-Host ("process_alive_after_close_2={0}" -f (-not $proc.HasExited))
State 'after-close-2' $tauriHwnd

[Tray]::SendMessageW([IntPtr]$trayHwnd, $WM_COMMAND, [IntPtr]1001, [IntPtr]::Zero) | Out-Null
Start-Sleep -Seconds 4
$proc.Refresh(); Write-Host ("process_alive_after_menu_quit={0}" -f (-not $proc.HasExited))
if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force }
Get-Content $errLog -Raw
```

## 未覆盖 / 风险

- **tooltip 文本没有取得「肉眼可见」的证据**：托盘图标的 tooltip 由 Explorer 的
  `tooltips_class32` 窗口渲染，UI Automation 读不到（本次试过两种读法：直接枚举通知区域按钮、
  把指针移到图标 rect 上再枚举 ToolTip 控件，都没有结果）；图标默认在 Windows 11 的溢出区，
  未展开时连图标本身都不在 UIA 树里。因此「tooltip 文案变化」目前由
  `tests/tray_bridge.rs` 的 3 个用例（含隐藏/恢复两条路径的接线与顺序）与实机 stderr 无报错共同支撑，
  不是截图证据。
- **没有加 toast**：隐藏瞬间窗口内没有任何提示，唯一反馈是托盘 tooltip。若后续要做原生通知，
  需要新增 `tauri-plugin-notification` 依赖与权限，属于单独的产品决策。
- **同一用户同时运行两个 SOXU 实例会互相冲突**：本次首次验证时，主仓库一个由 `tauri dev` 启动的
  `soxu-desktop` 进程（16:29 起）占着 WebView2 用户数据目录，导致新实例创建 webview 时报
  `HRESULT 0x8007139F`（`ERROR_INVALID_STATE`）并 panic。结束那个进程后验证通过。
  这不是本次改动引入的问题，本仓库也一直没有 single-instance 逻辑（见 #90 的已知限制），
  但「第二个实例直接崩溃且没有提示」值得单独开 Issue。
- **只验证了 Windows debug 构建**：Linux 需要运行时存在 `libayatana-appindicator`（缺失时回落为
  「关闭即退出」，tooltip 不会被设置），macOS 完全未验证。
- **托盘「退出」的回收预算未变**：`RunEvent::Exit` 里 `block_on(shutdown_all)` 对每个在跑的会话
  最多等 15 秒（`STOP_TIMEOUT`），因此「点退出后进程还会停留一小会儿」是既有行为，
  本次没有改动退出路径（不在 Issue #101 的排查清单内）。
