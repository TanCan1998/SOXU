//! 诊断文本的脱敏与截断。stderr 来自不可信的子进程，不能原样进日志。

/// 单行保留的最大字符数。
const MAX_LINE_CHARS: usize = 512;
/// 可能是密钥的最小连续长度。
const SUSPICIOUS_RUN: usize = 24;

const SECRET_PREFIXES: [&str; 6] = ["sk-", "ghp_", "gho_", "ghs_", "github_pat_", "xoxb-"];

/// stderr 行只保留一段有界、脱敏的文本。
pub(crate) fn sanitize_stderr_line(line: &str) -> String {
    truncate_chars(&redact_secrets(line), MAX_LINE_CHARS)
}

pub(crate) fn truncate_chars(value: &str, max: usize) -> String {
    if value.chars().count() <= max {
        return value.to_owned();
    }
    value.chars().take(max).collect()
}

/// 尽力脱敏：把长 token 形状的连续串与已知密钥前缀替换成占位符。
///
/// 这不是密码学保证，而是避免把工作区里常见的密钥形态写进日志。
pub(crate) fn redact_secrets(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut run = String::new();

    let flush = |run: &mut String, output: &mut String| {
        if run.is_empty() {
            return;
        }
        if is_secret_shaped(run) {
            output.push_str("<redacted>");
        } else {
            output.push_str(run);
        }
        run.clear();
    };

    for character in value.chars() {
        if is_token_char(character) {
            run.push(character);
        } else {
            flush(&mut run, &mut output);
            output.push(character);
        }
    }
    flush(&mut run, &mut output);
    output
}

fn is_token_char(character: char) -> bool {
    character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.' | '+' | '/' | '=')
}

fn is_secret_shaped(run: &str) -> bool {
    if SECRET_PREFIXES.iter().any(|prefix| run.starts_with(prefix)) {
        return true;
    }
    run.chars().count() >= SUSPICIOUS_RUN
        && run.chars().any(|character| character.is_ascii_digit())
        && run.chars().any(|character| character.is_ascii_alphabetic())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_prefixes_are_redacted() {
        let line = concat!("error: ghp_", "ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 invalid");
        let sanitized = redact_secrets(line);
        assert!(!sanitized.contains("ABCDEFGHIJ"));
        assert!(sanitized.contains("<redacted>"));
        assert!(sanitized.ends_with(" invalid"), "非密钥部分必须保留");
    }

    #[test]
    fn long_digit_runs_are_redacted() {
        let line = "authorization: abc123ABC456def789GHI000jkl777";
        let sanitized = redact_secrets(line);
        assert!(sanitized.contains("<redacted>"));
        assert!(!sanitized.contains("abc123ABC456def789GHI000jkl777"));
    }

    #[test]
    fn ordinary_words_and_paths_survive() {
        let line = "cannot open C:/work/soxu/src-tauri/lib.rs: not found";
        assert_eq!(redact_secrets(line), line);
    }

    #[test]
    fn sanitize_truncates_long_lines() {
        let line = "x".repeat(2000);
        assert_eq!(sanitize_stderr_line(&line).chars().count(), MAX_LINE_CHARS);
    }
}
