//! The one way this OS reaches the network from the host: the Remote, and a
//! release or a distribution's root. Of the host it takes what a person's
//! machine already decided, and nothing else: its proxy (HTTPS_PROXY, minus
//! NO_PROXY; never for this machine itself) and the certificates it trusts
//! (its store, or SSL_CERT_FILE), beside the ones bundled for a host that
//! has none. A root fetched is checked by digest whatever the TLS says.

// Unsafe code only in `web`: the two calls to the page that sends a request for the core in a browser.

use std::io::Read;
#[cfg(not(target_os = "wasi"))]
use std::sync::{Arc, OnceLock};
use std::time::Duration;

/// What a request came to: an answer (any status: a refusal is an answer too), or no answer at all, and why.
pub enum Sent {
    Answer { status: u16, body: Box<dyn Read + Send> },
    /// Not reached: where (its host, and port if any) and why, in a person's words.
    Unreachable { host: String, why: String },
}

/// Send one request: `method` to `url` with these headers and body, giving up when nothing is read for `read`.
/// The one way the core reaches the network: through the host's proxy and trust here, through the page's own
/// fetch in a browser (the same request, as the browser sends it).
pub fn send(method: &str, url: &str, headers: &[(&str, &str)], body: Option<&[u8]>, read: Duration) -> Sent {
    #[cfg(not(target_os = "wasi"))]
    return native(method, url, headers, body, read);
    #[cfg(target_os = "wasi")]
    return web::send(method, url, headers, body, read);
}

#[cfg(not(target_os = "wasi"))]
fn native(method: &str, url: &str, headers: &[(&str, &str)], body: Option<&[u8]>, read: Duration) -> Sent {
    let mut req = agent(url, read).request(method, url);
    for (k, v) in headers { req = req.set(k, v); }
    let r = match body { Some(b) => req.send_bytes(b), None => req.call() };
    match r {
        Ok(r) | Err(ureq::Error::Status(_, r)) => Sent::Answer { status: r.status(), body: Box::new(r.into_reader()) },
        Err(ureq::Error::Transport(t)) => Sent::Unreachable {
            host: t.url().map(|u| u.host_str().unwrap_or_default().to_string() + &u.port().map(|p| format!(":{p}")).unwrap_or_default()).unwrap_or_default(),
            why: match t.kind() {
                ureq::ErrorKind::Dns => crate::tr!("its name is not found", "名前が見つかりません"),
                ureq::ErrorKind::ConnectionFailed => crate::tr!("no connection", "接続できません"),
                ureq::ErrorKind::TooManyRedirects => crate::tr!("too many redirects", "リダイレクトが多すぎます"),
                ureq::ErrorKind::Io => crate::tr!("the connection broke or timed out", "接続が切れたか、時間切れです"),
                ureq::ErrorKind::ProxyConnect | ureq::ErrorKind::ProxyUnauthorized | ureq::ErrorKind::InvalidProxyUrl => crate::tr!("the proxy refused", "プロキシが通しません"),
                ureq::ErrorKind::InvalidUrl | ureq::ErrorKind::UnknownScheme => crate::tr!("not an address", "アドレスではありません"),
                k => k.to_string(),
            },
        },
    }
}

/// In a browser the page sends it (web/core.js, `length3.http`), from the Worker the core runs in, synchronously:
/// the answer's status and body are copied in once it is whole.
#[cfg(target_os = "wasi")]
mod web {
    use super::Sent;
    use std::time::Duration;

    #[link(wasm_import_module = "length3")]
    extern "C" {
        /// Send a request (`head`: JSON {method, url, headers, timeout}); the answer's status (0: not reached) and
        /// its body's length are written back, the body (or why it was not reached) kept as `handle`.
        fn http(head: *const u8, head_len: usize, body: *const u8, body_len: usize, status: *mut u32, len: *mut u32) -> u32;
        /// Copy the body kept as `handle` (its length as said) and let it go.
        fn http_body(handle: u32, out: *mut u8);
    }

    pub fn send(method: &str, url: &str, headers: &[(&str, &str)], body: Option<&[u8]>, read: Duration) -> Sent {
        let head = serde_json::json!({"method": method, "url": url, "headers": headers, "timeout": read.as_millis() as u64}).to_string();
        let body = body.unwrap_or_default();
        let (mut status, mut len) = (0u32, 0u32);
        // SAFETY: the pointers are to this function's own buffers, valid for the lengths given; the host writes
        // only `status` and `len`, then copies `len` bytes into a buffer of exactly that length.
        let handle = unsafe { http(head.as_ptr(), head.len(), body.as_ptr(), body.len(), &mut status, &mut len) };
        let mut bytes = vec![0u8; len as usize];
        unsafe { http_body(handle, bytes.as_mut_ptr()) };
        if status == 0 {
            return Sent::Unreachable { host: String::new(), why: String::from_utf8_lossy(&bytes).into_owned() };
        }
        Sent::Answer { status: status as u16, body: Box::new(std::io::Cursor::new(bytes)) }
    }
}

/// An agent for `url`, giving up when nothing is read for `read`.
#[cfg(not(target_os = "wasi"))]
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

#[cfg(not(target_os = "wasi"))]
fn var(k: &str) -> Option<String> {
    std::env::var(k).ok().filter(|v| !v.trim().is_empty())
}

/// The host of a URL, without its port or brackets.
#[cfg(not(target_os = "wasi"))]
fn host_of(url: &str) -> &str {
    let rest = url.split("://").nth(1).unwrap_or(url);
    let auth = rest.split(['/', '?', '#']).next().unwrap_or("");
    let auth = auth.rsplit('@').next().unwrap_or(auth);
    if let Some(v6) = auth.strip_prefix('[') { return v6.split(']').next().unwrap_or(""); }
    auth.split(':').next().unwrap_or("")
}

/// The proxy the host would use for `url`, if any.
#[cfg(not(target_os = "wasi"))]
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
#[cfg(not(target_os = "wasi"))]
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
        assert_eq!(proxy_for("https://os.length3.com/v1", &e).as_deref(), Some("http://proxy:3128"));
        assert_eq!(proxy_for("http://127.0.0.1:8787/v1", &e), None);
        assert_eq!(proxy_for("http://localhost:8787", &e), None);
        assert_eq!(proxy_for("http://[::1]:8787", &e), None);
        assert_eq!(proxy_for("https://internal.example/x", &e), None);
        assert_eq!(proxy_for("https://a.corp.test/x", &e), None);
        assert_eq!(proxy_for("https://corp.test.evil/x", &e).as_deref(), Some("http://proxy:3128"));
        assert_eq!(proxy_for("https://user:pw@os.length3.com:443/", &env(&[("https_proxy", "http://p:1")])).as_deref(), Some("http://p:1"));
        assert_eq!(proxy_for("https://os.length3.com", &env(&[("HTTPS_PROXY", "http://p:1"), ("no_proxy", "*")])), None);
        assert_eq!(proxy_for("https://os.length3.com", &env(&[])), None);
    }

    #[test]
    fn the_bundled_roots_are_always_there() {
        assert!(!tls().crypto_provider().cipher_suites.is_empty());
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
