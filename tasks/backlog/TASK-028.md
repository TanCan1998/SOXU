---
id: TASK-028
milestone: M1
priority: P1
dependencies: [TASK-009]
---

# 文件抽屉：目录树与文件操作

## 描述

右侧抽屉的文件面板。需要新增文件系统 command 族，按命令层占位块规范追加。

## 范围

- 新增 commands/files.rs：list_dir / read_file / write_file / create_file / rename_path / delete_path / search_files
- 在 lib.rs 的「files」占位块内注册，不得插入其他领域块
- 目录树懒加载（展开才读子目录），支持排序（名称/时间/大小）与树形/平铺切换
- 点击文件读取内容并显示（只读预览，语法高亮复用 S1 的 shiki 管线）
- 新建文件、重命名、删除（删除需二次确认）
- 路径必须限制在项目根目录内，拒绝 .. 穿越与绝对路径逃逸

## 验收标准

- [ ] cargo clippy 无新增 warning
- [ ] 路径穿越测试（../、绝对路径、符号链接）全部被拒
- [ ] 目录树懒加载不一次性读全盘
- [ ] 新增 Rust 测试覆盖路径校验
