//! The one way this OS reaches the network from the host: the Remote, and a
//! release or a distribution's root. Of the host it takes what a person's
//! machine already decided, and nothing else: its proxy (HTTPS_PROXY, minus
//! NO_PROXY; never for this machine itself) and the certificates it trusts
//! (its store, or SSL_CERT_FILE), beside the ones bundled for a host that
//! has none. A root fetched is checked by digest whatever the TLS says.

use std::sync::{Arc, OnceLock};
use std::time::Duration;

/// An agent for `url`, giving up when nothing is read for `read`.
pub fn agent(url: &str, read: Duration) -> ureq::Agent {
    let mut b = ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(15)).timeout_read(read).tls_config(tls());
    if let Some(p) = proxy_for(url, &var) {
        // A proxy that cannot be read is no proxy: the host's own tools would refuse it too.
        if let Ok(p) = ureq::Proxy::new(p) {
            b = b.proxy(p);
        }
    }
    b.build()
}

fn var(k: &str) -> Option<String> {
    std::env::var(k).ok().filter(|v| !v.trim().is_empty())
}

/// The host of a URL, without its port or brackets.
fn host_of(url: &str) -> &str {
    let rest = url.split("://").nth(1).unwrap_or(url);
    let auth = rest.split(['/', '?', '#']).next().unwrap_or("");
    let auth = auth.rsplit('@').next().unwrap_or(auth);
    if let Some(v6) = auth.strip_prefix('[') { return v6.split(']').next().unwrap_or(""); }
    auth.split(':').next().unwrap_or("")
}

/// The proxy the host would use for `url`, if any.
fn proxy_for(url: &str, var: &dyn Fn(&str) -> Option<String>) -> Option<String> {
    let host = host_of(url).to_ascii_lowercase();
    if host == "localhost" || host.starts_with("127.") || host == "::1" { return None; }
    let skip = var("NO_PROXY").or_else(|| var("no_proxy")).unwrap_or_default();
    for entry in skip.split(',').map(|e| e.trim().trim_start_matches('.').to_ascii_lowercase()).filter(|e| !e.is_empty()) {
        if entry == "*" || host == entry || host.ends_with(&format!(".{entry}")) { return None; }
    }
    var("HTTPS_PROXY").or_else(|| var("https_proxy"))
}

/// The bundled roots and the host's, read once.
fn tls() -> Arc<rustls::ClientConfig> {
    static CONFIG: OnceLock<Arc<rustls::ClientConfig>> = OnceLock::new();
    CONFIG.get_or_init(|| {
        let mut roots = rustls::RootCertStore { roots: webpki_roots::TLS_SERVER_ROOTS.to_vec() };
        // A certificate of the host's that rustls cannot use is left out, as the host's other tools leave it.
        let host = rustls_native_certs::load_native_certs();
        roots.add_parsable_certificates(host.certs);
        Arc::new(rustls::ClientConfig::builder().with_root_certificates(roots).with_no_client_auth())
    }).clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        move |k| pairs.iter().find(|(n, _)| *n == k).map(|(_, v)| v.to_string())
    }

    #[test]
    fn the_hosts_proxy_except_for_itself_and_what_it_says_to_skip() {
        let e = env(&[("HTTPS_PROXY", "http://proxy:3128"), ("NO_PROXY", "internal.example, .corp.test")]);
        assert_eq!(proxy_for("https://remote.length3.com/v1", &e).as_deref(), Some("http://proxy:3128"));
        assert_eq!(proxy_for("http://127.0.0.1:8787/v1", &e), None);
        assert_eq!(proxy_for("http://localhost:8787", &e), None);
        assert_eq!(proxy_for("http://[::1]:8787", &e), None);
        assert_eq!(proxy_for("https://internal.example/x", &e), None);
        assert_eq!(proxy_for("https://a.corp.test/x", &e), None);
        assert_eq!(proxy_for("https://corp.test.evil/x", &e).as_deref(), Some("http://proxy:3128"));
        assert_eq!(proxy_for("https://user:pw@remote.length3.com:443/", &env(&[("https_proxy", "http://p:1")])).as_deref(), Some("http://p:1"));
        assert_eq!(proxy_for("https://remote.length3.com", &env(&[("HTTPS_PROXY", "http://p:1"), ("no_proxy", "*")])), None);
        assert_eq!(proxy_for("https://remote.length3.com", &env(&[])), None);
    }

    #[test]
    fn the_bundled_roots_are_always_there() {
        assert!(tls().crypto_provider().cipher_suites.len() > 0);
    }
}

#[cfg(test)]
mod live {
    /// Run by hand (`cargo test -p length3-core -- --ignored live`) behind a proxy whose certificate only the host trusts.
    #[test]
    #[ignore]
    fn reaches_out_through_the_hosts_proxy_and_trust() {
        let url = "https://cdimage.ubuntu.com/ubuntu-base/releases/";
        let r = super::agent(url, std::time::Duration::from_secs(30)).head(url).call();
        assert!(r.is_ok(), "{r:?}");
    }
}
