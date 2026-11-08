//! The one way this OS reaches the network from the host: the Remote, and a
//! release or a distribution's root. Of the host it takes what a person's
//! machine already decided, and nothing else: its proxy (HTTPS_PROXY, minus
//! NO_PROXY; never for this machine itself) and the certificates it trusts
//! (its store, or SSL_CERT_FILE), beside the ones bundled for a host that
//! has none. A root fetched is checked by digest whatever the TLS says.

use std::io::Read;
#[cfg(not(target_os = "wasi"))]
use std::sync::{Arc, OnceLock};
use std::time::Duration;

/// The headers of an answer a reader goes by (what kind it is, its tag, how long to wait), lower-cased.
#[cfg(not(target_os = "wasi"))]
const HEARD: [&str; 4] = ["content-type", "etag", "retry-after", "x-retry-after"];

/// What a request came to: an answer (any status: a refusal is an answer too), or no answer at all, and why.
pub enum Sent {
    /// Its status, the headers of `HEARD` it gave (natively; a browser's core reads none), and its body.
    Answer { status: u16, heard: Vec<(String, String)>, body: Box<dyn Read + Send> },
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
    let agent = agent(url, read);
    let mut req = ureq::http::Request::builder().method(method).uri(url);
    for (k, v) in headers { req = req.header(*k, *v); }
    let r = match body {
        Some(b) => req.body(b).map(|q| agent.run(q)),
        None => req.body(()).map(|q| agent.run(q)),
    };
    match r.map_err(ureq::Error::Http).and_then(|r| r) {
        Ok(r) => {
            let heard = HEARD.iter().filter_map(|k| r.headers().get(*k).and_then(|v| v.to_str().ok()).map(|v| (k.to_string(), v.to_string()))).collect();
            Sent::Answer { status: r.status().as_u16(), heard, body: Box::new(r.into_body().into_reader()) }
        }
        Err(e) => Sent::Unreachable {
            host: authority(url).to_string(),
            why: match e {
                ureq::Error::HostNotFound => crate::tr!("its name is not found", "名前が見つかりません"),
                ureq::Error::ConnectionFailed => crate::tr!("no connection", "接続できません"),
                ureq::Error::TooManyRedirects | ureq::Error::RedirectFailed => crate::tr!("too many redirects", "リダイレクトが多すぎます"),
                ureq::Error::Io(_) | ureq::Error::Timeout(_) | ureq::Error::BodyStalled => crate::tr!("the connection broke or timed out", "接続が切れたか、時間切れです"),
                ureq::Error::ConnectProxyFailed(_) | ureq::Error::InvalidProxyUrl => crate::tr!("the proxy refused", "プロキシが通しません"),
                ureq::Error::BadUri(_) | ureq::Error::Http(_) => crate::tr!("not an address", "アドレスではありません"),
                e => e.to_string(),
            },
        },
    }
}

/// How a browser's core has a request sent: `head` (JSON {method, url, headers, timeout}) and its body in, the answer's
/// status (0: not reached) and its body (or why it was not reached) out, whole.
#[cfg(target_os = "wasi")]
pub type Page = fn(head: &str, body: &[u8]) -> (u32, Vec<u8>);

#[cfg(target_os = "wasi")]
static PAGE: std::sync::OnceLock<Page> = std::sync::OnceLock::new();

/// The page's way of sending, given once by core/web as the core starts (its `length3.http` import, app/core/abi.ts):
/// the call out of the module is core/web's, so this crate holds no unsafe code for it.
#[cfg(target_os = "wasi")]
pub fn through_page(page: Page) {
    let _ = PAGE.set(page);
}

/// In a browser the page sends it, from the Worker the core runs in, synchronously: the answer's status and body are
/// copied in once it is whole.
#[cfg(target_os = "wasi")]
mod web {
    use super::{authority, Sent, PAGE};
    use std::time::Duration;

    pub fn send(method: &str, url: &str, headers: &[(&str, &str)], body: Option<&[u8]>, read: Duration) -> Sent {
        let host = authority(url).to_string();
        let Some(page) = PAGE.get() else {
            return Sent::Unreachable { host, why: crate::tr!("this core has no page to send through", "この core には送り出すページがありません") };
        };
        let head = serde_json::json!({"method": method, "url": url, "headers": headers, "timeout": read.as_millis() as u64}).to_string();
        let (status, bytes) = page(&head, body.unwrap_or_default());
        if status == 0 {
            return Sent::Unreachable { host, why: String::from_utf8_lossy(&bytes).into_owned() };
        }
        Sent::Answer { status: status as u16, heard: Vec::new(), body: Box::new(std::io::Cursor::new(bytes)) }
    }
}

/// An agent for `url`, giving up when nothing is read for `read`. Any status is an answer, a refusal too.
#[cfg(not(target_os = "wasi"))]
pub fn agent(url: &str, read: Duration) -> ureq::Agent {
    // A proxy that cannot be read is no proxy: the host's own tools would refuse it too.
    let proxy = proxy_for(url, &var).and_then(|p| ureq::Proxy::new(&p).ok());
    ureq::Agent::new_with_config(ureq::Agent::config_builder()
        .timeout_connect(Some(Duration::from_secs(15))).timeout_per_read(Some(read))
        .http_status_as_error(false).proxy(proxy).tls_config(tls()).build())
}

#[cfg(not(target_os = "wasi"))]
fn var(k: &str) -> Option<String> {
    std::env::var(k).ok().filter(|v| !v.trim().is_empty())
}

/// The host of a URL, and its port if it says one: what a person reads as where it went.
fn authority(url: &str) -> &str {
    let rest = url.split("://").nth(1).unwrap_or(url);
    let auth = rest.split(['/', '?', '#']).next().unwrap_or("");
    auth.rsplit('@').next().unwrap_or(auth)
}

/// The host of a URL, without its port or brackets.
#[cfg(not(target_os = "wasi"))]
fn host_of(url: &str) -> &str {
    let auth = authority(url);
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

/// The bundled roots and the host's, read once, with ring's cryptography (the one the core builds with).
#[cfg(not(target_os = "wasi"))]
fn tls() -> ureq::tls::TlsConfig {
    static CONFIG: OnceLock<ureq::tls::TlsConfig> = OnceLock::new();
    CONFIG.get_or_init(|| {
        let bundled = webpki_root_certs::TLS_SERVER_ROOT_CERTS.iter().map(|c| ureq::tls::Certificate::from_der(c).to_owned());
        // A certificate of the host's that rustls cannot use is left out, as the host's other tools leave it.
        let host = rustls_native_certs::load_native_certs().certs.into_iter().map(|c| ureq::tls::Certificate::from_der(&c).to_owned());
        ureq::tls::TlsConfig::builder()
            .root_certs(ureq::tls::RootCerts::Specific(Arc::new(bundled.chain(host).collect())))
            .unversioned_rustls_crypto_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .build()
    }).clone()
}

#[cfg(test)]
#[path = "tests/net.rs"]
mod tests;
