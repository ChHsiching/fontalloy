// FontAlloy desktop entry. The window content is the shared frontend
// (gui/src) served by Vite in dev and built to gui/dist for release; the
// merge capability arrives with the core sidecar ticket.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    fontalloy_gui_lib::run()
}
