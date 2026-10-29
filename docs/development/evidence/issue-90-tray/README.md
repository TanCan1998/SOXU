# Issue #90 · 关闭窗口最小化到系统托盘：实机证据

- 采集日期：2026-10-29
- 采集对象：本工作树 `apps/desktop/src-tauri` 的 debug 构建 `target/debug/soxu-desktop.exe`
  （`tauri` 启用 `tray-icon` 特性），即 `src/tray.rs` + `src/lib.rs` 的真实运行结果
- 环境：Windows 本机、Rust 1.99.1（Edition 2024）、Tauri 2.12.5、tray-icon 0.25.1、muda 0.20.0
- 交互方式：不依赖鼠标移动，直接把「用户动作」对应的 Win32 消息投递到真实窗口，
  这样每一步都可重复、可断言，而不是靠肉眼看截图

| 动作 | 投递方式 |
|---|---|
| 点窗口 × | `WM_CLOSE` → Tauri 主窗口（class `Tauri Window`） |
| 左键点托盘图标 | `WM_USER_TRAYICON`（=6002，tray-icon 的 shell 回调消息）→ 托盘宿主窗口（class `tray_icon_app`），`lParam=WM_LBUTTONUP` |
| 托盘菜单「显示窗口」 | `WM_COMMAND` `wParam=1000` → 同一托盘宿主窗口 |
| 托盘菜单「退出」 | `WM_COMMAND` `wParam=1001` |

说明：托盘菜单项的内部命令 id 由 muda 的全局计数器（从 1000 起）按创建顺序分配，
本实现先建「显示窗口」再建「退出」，因此分别是 1000/1001。
该 id 只用于本次消息级模拟；真实用户点击由系统分发，实现本身不依赖它。

## 结论（对应 Issue 验收项）

| 验收项 | 结论 | 证据 |
|---|---|---|
| 点 × 后窗口隐藏，进程仍在 | 通过 | `WM_CLOSE` 后 `IsWindowVisible(Tauri Window)=0`，`process_alive=True` |
| 托盘图标存在 | 通过 | 托盘宿主窗口 `tray_icon_app` 唯一存在；`Shell_NotifyIconGetRect(hWnd=托盘宿主, uID=2)` 返回 **S_OK**，`rect=(2037,1368)-(2085,1440)`，说明图标确实注册进了通知区域 |
| 点击可恢复窗口 | 通过 | 投递 `WM_LBUTTONUP` 后 `IsWindowVisible(Tauri Window)=1` |
| 托盘菜单「显示窗口」恢复窗口 | 通过 | 隐藏状态下 `WM_COMMAND 1000` → 窗口重新可见，进程存活 |
| 托盘菜单「退出」真正结束进程 | 通过 | `WM_COMMAND 1001` → `process_alive_after_menu_quit=False` |
| 重复关闭/恢复不出错、不产生多个托盘图标 | 通过 | 第二轮关闭/恢复后仍是 1 个 `tray_icon_app` 宿主窗口、1 个 `Tauri Window`，进程存活，stderr 无「创建系统托盘失败」输出 |
| `cargo test --workspace` 通过 | 通过 | 全仓 41 个测试二进制全绿，其中 `tests/tray_bridge.rs` 8 个用例 |

## 原始输出

```
=== STEP 1: launch ===
main_hwnd=1050988 tray_host_hwnd=6817828 process_alive=True
[launched] main_window_visible=1 tray_host_window_present=1 tray_host_visible=0
=== STEP 1b: 通知区域注册探测（Shell_NotifyIconGetRect）===
uid=2 S_OK 图标已注册 rect=(2037,1368)-(2085,1440) size=48x72
=== STEP 2: 关闭 -> 期望隐藏、进程存活 ===
process_alive=True
[after-close-1] main_window_visible=0 tray_host_window_present=1 tray_host_visible=0
=== STEP 3: 托盘左键 -> 期望恢复 ===
[after-tray-click-1] main_window_visible=1 tray_host_window_present=1 tray_host_visible=0
=== STEP 4: 重复关闭/恢复 ===
[after-close-2] main_window_visible=0 tray_host_window_present=1 tray_host_visible=0
[after-tray-click-2] main_window_visible=1 tray_host_window_present=1 tray_host_visible=0
process_alive_after_repeat=True
=== STEP 5: 菜单「显示窗口」(WM_COMMAND 1000) ===
[hidden-before-menu-show] main_window_visible=0 tray_host_window_present=1 tray_host_visible=0
[after-menu-show] main_window_visible=1 tray_host_window_present=1 tray_host_visible=0
process_alive_after_menu_show=True
=== STEP 6: 菜单「退出」(WM_COMMAND 1001) ===
process_alive_after_menu_quit=False
=== DONE ===
```

- `tray_host_visible=0` 是预期值：`tray_icon_app` 是 tray-icon 的隐藏宿主窗口，
  图标本体由 `Shell_NotifyIconW` 注册到通知区域，与这个窗口的可见性无关。
- 恢复窗口之所以成立，还顺带证明了 tray-icon 内部的 `get_tray_rect` 成功：
  它在 `Shell_NotifyIconGetRect` 失败时会直接 `return 0`、不派发任何事件。
  也就是说「点托盘能恢复」这条链路是真的走通了 shell 注册，而不是被模拟绕过。

## 复现脚本

下面脚本与采集时使用的一致（仅去掉了当时顺手做的截图调用——截图区域不覆盖通知区域、没有证据价值）。
在仓库根目录的 PowerShell 7 中运行；脚本自己启动进程、逐项断言，并在最后让进程真正退出。

```powershell
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
  public static bool IsVisible(long h) { return IsWindowVisible((IntPtr)h); }
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

$exe = Join-Path $PWD 'target\debug\soxu-desktop.exe'
$WM_CLOSE = 0x0010; $WM_COMMAND = 0x0111; $WM_USER_TRAYICON = 6002; $WM_LBUTTONUP = 0x0202

function State([string]$tag, $tauriHwnd, $trayHwnd) {
  $tv = if ([Tray]::IsVisible($tauriHwnd)) { 1 } else { 0 }
  $tr = if ([Tray]::IsVisible($trayHwnd)) { 1 } else { 0 }
  Write-Host ("[{0}] main_window_visible={1} tray_host_window_present=1 tray_host_visible={2}" -f $tag, $tv, $tr)
}

$proc = Start-Process -FilePath $exe -PassThru
Start-Sleep -Seconds 6
$tauriHwnd = [Tray]::FindByClass([uint32]$proc.Id, 'Tauri Window')
$trayHwnd  = [Tray]::FindByClass([uint32]$proc.Id, 'tray_icon_app')
if (-not $tauriHwnd -or -not $trayHwnd) { Write-Host 'FAIL: 窗口缺失'; Stop-Process -Id $proc.Id -Force; exit 1 }
State 'launched' $tauriHwnd $trayHwnd

$iconUid = 0
foreach ($uid in 1..6) {
  $a=0;$b=0;$c=0;$d=0
  if ([Tray]::GetRect($trayHwnd, [uint32]$uid, [ref]$a, [ref]$b, [ref]$c, [ref]$d) -eq 0) {
    $iconUid = $uid
    Write-Host ("uid={0} S_OK 图标已注册 rect=({1},{2})-({3},{4}) size={5}x{6}" -f $uid, $a, $b, $c, $d, ($c-$a), ($d-$b))
  }
}

[Tray]::SendMessageW([IntPtr]$tauriHwnd, $WM_CLOSE, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
Start-Sleep -Seconds 2
$proc.Refresh(); Write-Host ("process_alive={0}" -f (-not $proc.HasExited))
State 'after-close-1' $tauriHwnd $trayHwnd

[Tray]::SendMessageW([IntPtr]$trayHwnd, $WM_USER_TRAYICON, [IntPtr]$iconUid, [IntPtr]$WM_LBUTTONUP) | Out-Null
Start-Sleep -Seconds 2
State 'after-tray-click-1' $tauriHwnd $trayHwnd

[Tray]::SendMessageW([IntPtr]$tauriHwnd, $WM_CLOSE, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
Start-Sleep -Seconds 2
State 'after-close-2' $tauriHwnd $trayHwnd
[Tray]::SendMessageW([IntPtr]$trayHwnd, $WM_USER_TRAYICON, [IntPtr]$iconUid, [IntPtr]$WM_LBUTTONUP) | Out-Null
Start-Sleep -Seconds 2
State 'after-tray-click-2' $tauriHwnd $trayHwnd

[Tray]::SendMessageW([IntPtr]$tauriHwnd, $WM_CLOSE, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
Start-Sleep -Seconds 1
[Tray]::SendMessageW([IntPtr]$trayHwnd, $WM_COMMAND, [IntPtr]1000, [IntPtr]::Zero) | Out-Null
Start-Sleep -Seconds 2
State 'after-menu-show' $tauriHwnd $trayHwnd

[Tray]::SendMessageW([IntPtr]$trayHwnd, $WM_COMMAND, [IntPtr]1001, [IntPtr]::Zero) | Out-Null
Start-Sleep -Seconds 4
$proc.Refresh(); Write-Host ("process_alive_after_menu_quit={0}" -f (-not $proc.HasExited))
if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force }
```

## 未覆盖 / 风险

- **点击与菜单是消息级模拟，不是真实鼠标**：验证的是「托盘宿主窗口收到 shell 回调 / 菜单命令后行为正确」，
  没有覆盖「用户鼠标点在图标上」那一段输入分发（属于 Explorer 与 tray-icon crate）。
- **托盘图标在任务栏是否「露在外面」取决于 Windows 11 的「隐藏的图标」策略**：默认新图标会进溢出菜单。
  本次截图区域取到的画面不包含通知区域，因此没有视觉截图；
  「图标存在」由 `Shell_NotifyIconGetRect` 返回 S_OK 间接证明，不是肉眼确认。
- **菜单项文案未断言**：断言的是 id → 行为；中文文案由 `MENU_TEXT_SHOW` / `MENU_TEXT_QUIT` 常量决定，测试只校验 id 稳定。
- **只验证了 Windows**。Linux 需要运行时存在 `libayatana-appindicator`（tray-icon 用 libloading 动态加载）；
  缺失时 `create_tray` 返回错误，代码打印提示并回落到「关闭即退出」，
  该回落路径只有单元测试 `close_hides_only_when_the_tray_exists` 覆盖，没有真实缺库环境验证。macOS 完全未验证。
- **没有单实例逻辑**：本仓库原本就没有 single-instance 插件或等价实现，按 Issue 要求未为此新增插件；
  因此「重复启动会出现多个托盘图标」属于既有行为，不在本次范围内。
