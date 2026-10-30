//! 启动哪个 shell：白名单 + 结构化 argv。
//!
//! 架构规则第 4 条：不通过运行时 shell 拼接文本命令。这里同样不放行任意程序——
//! 「向 WebView 暴露任意 shell」是明确禁止的能力，所以 `program` 必须是白名单里的
//! 已知交互式 shell（允许带绝对路径与 `.exe` 后缀），参数只接受调用方给出的 argv 数组。

use std::path::{Path, PathBuf};

use crate::error::{PtyError, PtyErrorCode, Result};

/// 允许作为终端启动的程序名（小写、不含扩展名）。
pub const ALLOWED_SHELLS: [&str; 9] = [
    "pwsh",
    "powershell",
    "cmd",
    "bash",
    "zsh",
    "sh",
    "dash",
    "fish",
    "nu",
];

/// 一条可执行的 shell 启动命令：程序 + 参数数组（不经过任何 shell 解析）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShellSpec {
    program: String,
    args: Vec<String>,
}

impl ShellSpec {
    /// 显式构造。`program` 可以是裸名或绝对路径，但基名必须在白名单内。
    pub fn new(program: &str, args: Vec<String>) -> Result<Self> {
        let name = normalize_name(program)?;
        Ok(Self {
            program: name,
            args,
        })
    }

    /// 解析调用方请求：`None` 用平台默认 shell。
    pub fn resolve(requested: Option<&str>) -> Result<Self> {
        match requested {
            Some(raw) if !raw.trim().is_empty() => Self::with_default_args(raw.trim()),
            _ => {
                let program = default_program()?;
                Self::with_default_args(&program)
            }
        }
    }

    pub fn program(&self) -> &str {
        &self.program
    }

    pub fn args(&self) -> &[String] {
        &self.args
    }

    fn with_default_args(program: &str) -> Result<Self> {
        let name = normalize_name(program)?;
        // PowerShell 家族默认会打印登录横幅；-NoLogo 只是少几行噪声，不改变交互能力。
        let stem = stem_of(&name);
        let args = if stem == "pwsh" || stem == "powershell" {
            vec!["-NoLogo".to_owned()]
        } else {
            Vec::new()
        };
        Ok(Self {
            program: name,
            args,
        })
    }
}

/// 平台默认 shell：Windows 优先 PowerShell 7，其次 Windows PowerShell，最后 cmd。
pub fn default_program() -> Result<String> {
    let candidates: &[&str] = if cfg!(windows) {
        &["pwsh", "powershell", "cmd"]
    } else {
        &["bash", "zsh", "sh"]
    };
    // Unix 尊重用户的 $SHELL（只要它在白名单里），否则按上面的顺序找。
    if !cfg!(windows)
        && let Some(shell) = std::env::var_os("SHELL")
        && let Some(found) = locate(&shell.to_string_lossy())
    {
        return Ok(found);
    }
    for candidate in candidates {
        if let Some(found) = locate(candidate) {
            return Ok(found);
        }
    }
    Err(PtyError::new(
        PtyErrorCode::InvalidShell,
        "找不到可用的 shell：请显式指定 pwsh / powershell / cmd / bash / zsh / sh",
    ))
}

/// 校验并规范化程序名：白名单之外一律拒绝。
fn normalize_name(program: &str) -> Result<String> {
    let trimmed = program.trim();
    if trimmed.is_empty() {
        return Err(PtyError::new(PtyErrorCode::InvalidShell, "shell 不能为空"));
    }
    // 拒绝把参数塞进程序名的写法（"pwsh -c x"）：参数只走 argv 数组。
    // 但绝对路径里的空格是合法的：Windows 的 PowerShell 7 就装在
    // "C:\Program Files\PowerShell\7\pwsh.exe"，用它当默认 shell 时曾整个终端起不来。
    let forbidden: &[char] = if looks_like_path(trimmed) {
        &['"', '\'', ';', '|', '&', '>', '<', '`']
    } else {
        &[' ', '\t', '"', '\'', ';', '|', '&', '>', '<', '`']
    };
    if trimmed.contains(forbidden) {
        return Err(PtyError::new(
            PtyErrorCode::InvalidShell,
            format!("shell 只能是程序名或绝对路径，不能包含参数：{trimmed}"),
        ));
    }
    if !ALLOWED_SHELLS.contains(&stem_of(trimmed).as_str()) {
        return Err(PtyError::new(
            PtyErrorCode::InvalidShell,
            format!(
                "不支持的 shell「{trimmed}」；允许的取值：{}",
                ALLOWED_SHELLS.join(", ")
            ),
        ));
    }
    // 裸名要尽量解析成绝对路径：子进程的 PATH 可能与 SOXU 不同，绝对路径更确定。
    Ok(locate(trimmed).unwrap_or_else(|| trimmed.to_owned()))
}

/// 绝对路径或带目录分隔符的写法按路径处理；裸名（可能夹带参数）按程序名校验。
fn looks_like_path(program: &str) -> bool {
    let path = Path::new(program);
    path.is_absolute() || path.components().count() > 1
}

/// 规范化基名：去目录、转小写、去 `.exe`。测试与白名单比较都用它。
fn stem_of(program: &str) -> String {
    let name = basename(program).to_ascii_lowercase();
    name.strip_suffix(".exe").unwrap_or(&name).to_owned()
}

fn basename(program: &str) -> String {
    Path::new(program)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| program.to_owned())
}

/// 在 PATH 中查找可执行文件；带路径分隔符的输入按路径处理。
fn locate(program: &str) -> Option<String> {
    let candidate = Path::new(program);
    if candidate.components().count() > 1 {
        return candidate.is_file().then(|| program.to_owned());
    }
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        for name in executable_names(program) {
            let full = dir.join(name);
            if full.is_file() {
                return Some(full.to_string_lossy().into_owned());
            }
        }
    }
    None
}

fn executable_names(program: &str) -> Vec<PathBuf> {
    let mut names = vec![PathBuf::from(program)];
    if cfg!(windows) && Path::new(program).extension().is_none() {
        names.push(PathBuf::from(format!("{program}.exe")));
    }
    names
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_allowed_shell_passes_validation() {
        for name in ALLOWED_SHELLS {
            let spec = ShellSpec::new(name, Vec::new())
                .unwrap_or_else(|error| panic!("白名单里的 {name} 必须能通过校验：{error}"));
            // 裸名会被解析成绝对路径（可能带 .exe）：只比较规范化后的基名。
            assert_eq!(stem_of(spec.program()), name);
        }
    }

    #[test]
    fn exe_suffix_and_case_are_normalized() {
        let spec = ShellSpec::new("PowerShell.EXE", Vec::new()).expect("大小写与后缀应被容忍");
        assert_eq!(stem_of(spec.program()), "powershell");
    }

    #[test]
    fn non_whitelisted_programs_are_rejected() {
        for program in ["curl", "node", "/bin/rm", "rm", "shutdown"] {
            let error = ShellSpec::new(program, Vec::new()).expect_err("白名单之外必须拒绝");
            assert_eq!(error.code(), PtyErrorCode::InvalidShell, "{program}");
        }
    }

    #[test]
    fn arguments_smuggled_into_the_program_name_are_rejected() {
        for program in ["pwsh -c whoami", "bash; rm -rf /", "sh | cat", "\"pwsh\""] {
            let error = ShellSpec::new(program, Vec::new()).expect_err("程序名不能夹带参数");
            assert_eq!(error.code(), PtyErrorCode::InvalidShell, "{program}");
        }
    }

    #[test]
    fn absolute_paths_with_spaces_are_accepted() {
        // Windows 的 PowerShell 7 装在 "C:\Program Files\PowerShell\7\pwsh.exe"：
        // 空格属于路径的一部分，不能被当成「夹带参数」。
        let program = if cfg!(windows) {
            r"C:\Program Files\PowerShell\7\pwsh.exe"
        } else {
            "/opt/pwsh dir/pwsh"
        };
        let spec = ShellSpec::resolve(Some(program)).expect("绝对路径里的空格不应被拒绝");
        assert_eq!(spec.program(), program);
        assert_eq!(spec.args(), ["-NoLogo"]);
    }

    #[test]
    fn powershell_families_get_nologo_and_others_get_no_extra_args() {
        let pwsh = ShellSpec::resolve(Some("pwsh")).expect("解析 pwsh");
        assert_eq!(pwsh.args(), ["-NoLogo"]);
        let cmd = ShellSpec::resolve(Some("cmd")).expect("解析 cmd");
        assert!(cmd.args().is_empty());
    }

    #[test]
    fn empty_request_falls_back_to_the_platform_default() {
        // 本机必然至少有一个 shell（Windows 有 cmd，Unix 有 sh），解析失败即环境异常。
        let spec = ShellSpec::resolve(Some("   ")).expect("空白请求回落到默认 shell");
        let stem = stem_of(spec.program());
        assert!(
            ALLOWED_SHELLS.contains(&stem.as_str()),
            "默认 shell 也必须在白名单内：{}",
            spec.program()
        );
    }
}
