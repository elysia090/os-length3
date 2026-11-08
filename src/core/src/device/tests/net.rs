//! The tests of device/net.rs.

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
    let ureq::tls::RootCerts::Specific(roots) = tls().root_certs().clone() else { panic!("not our roots") };
    assert!(roots.len() >= webpki_root_certs::TLS_SERVER_ROOT_CERTS.len());
}

#[test]
fn where_a_request_went_is_its_host_and_the_port_it_says() {
    assert_eq!(authority("https://user:pw@os.length3.com/v1?x"), "os.length3.com");
    assert_eq!(authority("http://127.0.0.1:8787/v1"), "127.0.0.1:8787");
    assert_eq!(authority("http://[::1]:8787"), "[::1]:8787");
}

mod live {
    /// Run by hand (`cargo test -p length3-core -- --ignored live`) behind a proxy whose certificate only the host trusts.
    #[test]
    #[ignore]
    fn reaches_out_through_the_hosts_proxy_and_trust() {
        let url = "https://cdimage.ubuntu.com/ubuntu-base/releases/";
        let r = super::agent(url, std::time::Duration::from_secs(30)).head(url).call();
        assert!(r.as_ref().is_ok_and(|r| r.status().is_success()), "{r:?}");
    }
}
