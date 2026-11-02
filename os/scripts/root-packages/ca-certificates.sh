# The CA certificates curl's makers take from Mozilla's, as one bundle at /etc/ssl/certs, and /etc/ssl/cert.pem, the
# name OpenSSL looks for.
pins="CA_CERTIFICATES"
build() {
  install -D -m 0644 "$(basename "$CA_CERTIFICATES_URL")" "$dest/etc/ssl/certs/ca-certificates.crt"
  ln -s certs/ca-certificates.crt "$dest/etc/ssl/cert.pem"
}
check() {
  [ "$(grep -c 'BEGIN CERTIFICATE' "$dest/etc/ssl/cert.pem")" -gt 100 ]
}
