// Pi Desktop shell (§3): native window + pi-host sidecar supervision.
// Speaks ONLY the neutral wire protocol — and even that only indirectly:
// the webview's JS connects to the host's WebSocket itself. No pi concepts here.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::env;
use std::path::PathBuf;
use std::process::Command as StdCommand;
use std::sync::{Arc, Mutex};

use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

const DEFAULT_HOST_PORT: &str = "43117";

/// A running pi-host process, however it was started.
///
/// Production path: the host is compiled (via `bun build --compile`, see
/// apps/pi-host/scripts/build-exe.mjs) into a standalone binary shipped as a
/// Tauri `externalBin` sidecar (declared in tauri.conf.json as
/// `binaries/pi-host`). This has no dependency on Node being installed on the
/// end user's machine — it's just an .exe next to the shell's own binary,
/// which is what makes it work once the app is actually installed via the
/// MSI, instead of only in this dev tree.
///
/// Dev escape hatch: set `PI_HOST_ENTRY` to a `dist/server.js` path to run
/// the host straight from `tsc` output via system `node`, so iterating on
/// pi-host doesn't require recompiling the sidecar binary every time.
enum HostProcess {
    Sidecar(CommandChild),
    Dev(std::process::Child),
}

type HostState = Arc<Mutex<Option<HostProcess>>>;

impl HostProcess {
    fn kill(self) {
        match self {
            HostProcess::Sidecar(child) => {
                let _ = child.kill();
            }
            HostProcess::Dev(mut child) => {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

fn host_entry_override() -> Option<PathBuf> {
    let explicit = env::var("PI_HOST_ENTRY").ok()?;
    let path = PathBuf::from(explicit);
    if path.exists() {
        Some(path)
    } else {
        eprintln!("[shell] PI_HOST_ENTRY set but not found: {}", path.display());
        None
    }
}

fn spawn_host_dev(entry: PathBuf, port: &str) -> Option<HostProcess> {
    let node = env::var("PI_HOST_NODE").unwrap_or_else(|_| "node".into());
    match StdCommand::new(&node)
        .arg(&entry)
        .env("PI_DESKTOP_PORT", port)
        .spawn()
    {
        Ok(child) => {
            println!(
                "[shell] pi-host started in dev mode (pid {}) from {} on port {port}",
                child.id(),
                entry.display()
            );
            Some(HostProcess::Dev(child))
        }
        Err(err) => {
            eprintln!("[shell] failed to start pi-host with `{node}`: {err} (is Node on PATH?)");
            None
        }
    }
}

fn spawn_host_sidecar(app: &AppHandle, port: &str) -> Option<HostProcess> {
    let sidecar = match app.shell().sidecar("pi-host") {
        Ok(cmd) => cmd,
        Err(err) => {
            eprintln!("[shell] failed to resolve pi-host sidecar binary: {err}");
            return None;
        }
    };
    match sidecar.env("PI_DESKTOP_PORT", port).spawn() {
        Ok((mut rx, child)) => {
            let pid = child.pid();
            println!("[shell] pi-host sidecar started (pid {pid}) on port {port}");
            tauri::async_runtime::spawn(async move {
                while let Some(event) = rx.recv().await {
                    match event {
                        CommandEvent::Stdout(line) => {
                            print!("[pi-host] {}", String::from_utf8_lossy(&line));
                        }
                        CommandEvent::Stderr(line) => {
                            eprint!("[pi-host] {}", String::from_utf8_lossy(&line));
                        }
                        CommandEvent::Error(err) => {
                            eprintln!("[pi-host] error: {err}");
                        }
                        CommandEvent::Terminated(payload) => {
                            eprintln!("[pi-host] exited: {payload:?}");
                        }
                        _ => {}
                    }
                }
            });
            Some(HostProcess::Sidecar(child))
        }
        Err(err) => {
            eprintln!("[shell] failed to start pi-host sidecar: {err}");
            None
        }
    }
}

fn spawn_host(app: &AppHandle) -> Option<HostProcess> {
    let port = env::var("PI_DESKTOP_PORT").unwrap_or_else(|_| DEFAULT_HOST_PORT.into());
    if let Some(entry) = host_entry_override() {
        return spawn_host_dev(entry, &port);
    }
    spawn_host_sidecar(app, &port)
}

fn kill_host(host: &HostState) {
    if let Some(child) = host.lock().unwrap().take() {
        child.kill();
    }
}

#[tauri::command]
fn close_app(app: AppHandle, host: tauri::State<'_, HostState>) {
    kill_host(host.inner());
    app.exit(0);
}

fn main() {
    let host: HostState = Arc::new(Mutex::new(None));
    let host_for_setup = Arc::clone(&host);
    let host_for_exit = Arc::clone(&host);

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_shell::init())
        .manage(Arc::clone(&host))
        .invoke_handler(tauri::generate_handler![close_app])
        .setup(move |app| {
            let handle = app.handle().clone();
            let process = spawn_host(&handle);
            if process.is_none() {
                // Without this, the webview just sits forever trying to open
                // a WebSocket to a host that never started — "stuck
                // connecting" with zero indication why. Release builds also
                // hide the console (windows_subsystem = "windows"), so a
                // dialog is the only way the user ever sees this.
                handle
                    .dialog()
                    .message(
                        "Pi Desktop's background service (pi-host) failed to start, \
                         so the app can't connect. Try reinstalling Pi Desktop; if \
                         the problem persists, please report it.",
                    )
                    .kind(MessageDialogKind::Error)
                    .title("Pi Desktop — startup error")
                    .blocking_show();
            }
            *host_for_setup.lock().unwrap() = process;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Pi Desktop shell")
        .run(move |_app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                kill_host(&host_for_exit);
            }
        });
}
