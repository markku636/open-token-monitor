// Release build 不要跳出 console 視窗。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    token_monitor_lib::run()
}
