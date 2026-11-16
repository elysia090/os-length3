//! A Prompt: a repo in a box of the root. The root in a box is ricebox's to run and muk's to make (module/ricebox,
//! module/muk); what is here is why's part: what it lends and tells a box (start.rs on this machine; `asked`, for a
//! page that runs muk itself), what a Prompt writes outside its repo and how long each part lives (writes.rs), and
//! the Prompts running here as the host's /proc tells (running.rs).

#[cfg(target_os = "linux")]
pub mod start;
#[cfg(not(target_os = "wasi"))]
pub mod running;
pub mod writes;

use ricebox::bundle::{self, Lent, Run, Shell, Told};

/// What a face asks for a bundle with (api: prompt_bundle), where it starts muk itself (a page, on sods' Linux): the
/// repo, what to run, and what that host lends. The bundle is ricebox's to write.
#[derive(serde::Deserialize, Default, Clone, Debug)]
#[serde(default)]
pub struct Asked {
    pub repo: String,
    /// What to run; none, the root's shell.
    pub argv: Vec<String>,
    pub shell: Shell,
    /// The terminal it is drawn on, the person's clock and language, and what it is told besides.
    pub told: Told,
    pub lang: String,
    pub screen: Option<(u16, u16)>,
    pub lent: Lent,
    /// The bundle's directory, as the one who runs muk names it.
    pub dir: String,
}

/// What a Prompt is told besides what every box of the root runs with: the root's own why sees the open repo where
/// the shell does, and leaves Home, the Remote and the device to the app; it speaks the person's language (Home's).
/// Then what a task says (`more`), never over these.
pub fn told(repo: &str, lang: &str, more: &[(String, String)]) -> Vec<(String, String)> {
    let lang = if lang == "ja" { "ja" } else { "en" };
    let mut all: Vec<(String, String)> = [("WHY_REPOS", "/root"), ("WHY_PROMPT", "1"), ("WHY_REPO", repo), ("WHY_LANG", lang),
        // The same four by the names the root released as 0.6.4 reads them by (its l3 and its shell's settings):
        // they go when the pin is of a root made after it.
        ("LENGTH3_REPOS", "/root"), ("L3_PROMPT", "1"), ("LENGTH3_REPO", repo), ("LENGTH3_LANG", lang)]
        .into_iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
    let fixed = all.len();
    for (k, v) in more { if !all[..fixed].iter().any(|(name, _)| name == k) { all.push((k.clone(), v.clone())); } }
    all
}

/// The bundle a face asked for: config.json, and muk's words.
pub fn asked(a: &Asked) -> (String, Vec<String>) {
    let argv = if a.argv.is_empty() { bundle::shell(a.shell) } else { a.argv.clone() };
    let env = bundle::environment(&argv, &Told { more: told(&a.repo, &a.lang, &a.told.more), ..a.told.clone() });
    let cwd = if a.repo.is_empty() { "/root".to_string() } else { format!("/root/{}", a.repo) };
    let b = bundle::bundle(&Run { argv: &argv, env: &env, cwd: &cwd, hostname: "why", screen: a.screen }, &a.lent);
    (b.config.clone(), b.words(&a.dir, None, "box"))
}

#[cfg(test)]
#[path = "mod.test.rs"]
mod tests;
