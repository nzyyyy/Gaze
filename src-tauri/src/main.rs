#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if gaze_lib::is_plugin_worker() {
        std::process::exit(i32::from(!gaze_lib::run_plugin_worker()));
    }
    gaze_lib::run()
}
