//! 手动证据工具（Issue #147）：把本机 Pi 配置目录的扫描结果打成 JSON。
//!
//! 用法（仓库根目录）：
//!   cargo run -q -p soxu-desktop --example scan-agent-dir > scan.json
//!
//! 为什么做成 example 而不是测试：它要读的是**真实**的 ~/.pi/agent，结果依赖机器；
//! 测试里只能用临时目录构造夹具。这里只调用同一个只读扫描函数，不写任何配置。
//!
//! 想扫别的目录：设置 PI_CODING_AGENT_DIR（Pi 官方变量）或 SOXU_PI_AGENT_DIR。

fn main() {
    match soxu_desktop_lib::extension_catalog::list() {
        Ok(catalog) => match serde_json::to_string_pretty(&catalog) {
            Ok(json) => println!("{json}"),
            Err(error) => {
                eprintln!("无法序列化扫描结果：{error}");
                std::process::exit(1);
            }
        },
        Err(error) => {
            eprintln!("扫描失败：{error}");
            std::process::exit(1);
        }
    }
}
