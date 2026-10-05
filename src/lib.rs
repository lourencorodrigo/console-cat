use std::{env, fs};

use zed_extension_api::{self as zed, LanguageServerId, LanguageServerInstallationStatus, Result};

/// The server parses JS/TS with the TypeScript compiler API (5.x; 7.x has no JS API).
const TYPESCRIPT_VERSION: &str = "5.9.3";
const SERVER_DIR: &str = "server";
/// The server ships inside the extension and is written to the work directory on start.
const SERVER_FILES: [(&str, &str); 2] = [
    ("console-cat.mjs", include_str!("../server/console-cat.mjs")),
    ("server.mjs", include_str!("../server/server.mjs")),
];

struct ConsoleCat {
    installed: bool,
}

impl ConsoleCat {
    fn install(&mut self, language_server_id: &LanguageServerId) -> Result<()> {
        if self.installed {
            return Ok(());
        }

        if zed::npm_package_installed_version("typescript")?.as_deref() != Some(TYPESCRIPT_VERSION) {
            zed::set_language_server_installation_status(
                language_server_id,
                &LanguageServerInstallationStatus::Downloading,
            );
            if let Err(error) = zed::npm_install_package("typescript", TYPESCRIPT_VERSION) {
                zed::set_language_server_installation_status(
                    language_server_id,
                    &LanguageServerInstallationStatus::Failed(error.clone()),
                );
                return Err(error);
            }
        }

        fs::create_dir_all(SERVER_DIR).map_err(|e| format!("creating {SERVER_DIR}: {e}"))?;
        for (name, contents) in SERVER_FILES {
            fs::write(format!("{SERVER_DIR}/{name}"), contents)
                .map_err(|e| format!("writing {SERVER_DIR}/{name}: {e}"))?;
        }

        zed::set_language_server_installation_status(
            language_server_id,
            &LanguageServerInstallationStatus::None,
        );
        self.installed = true;
        Ok(())
    }
}

impl zed::Extension for ConsoleCat {
    fn new() -> Self {
        Self { installed: false }
    }

    fn language_server_command(
        &mut self,
        language_server_id: &LanguageServerId,
        _worktree: &zed::Worktree,
    ) -> Result<zed::Command> {
        self.install(language_server_id)?;
        let server = env::current_dir()
            .map_err(|e| e.to_string())?
            .join(SERVER_DIR)
            .join("server.mjs");
        Ok(zed::Command {
            command: zed::node_binary_path()?,
            args: vec![server.to_string_lossy().into_owned()],
            env: Default::default(),
        })
    }
}

zed::register_extension!(ConsoleCat);
