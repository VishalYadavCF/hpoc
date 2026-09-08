# Extra CA certificates for the Postgres image build

Any `*.crt` (PEM) file dropped here is installed into the image's trust store
before `apt-get` runs.

This exists because the build fetches TimescaleDB from packagecloud.io over
HTTPS, and a network doing TLS interception (Netskope, Zscaler, a corporate
proxy) presents a certificate the stock Debian trust store rejects:

    curl: (60) SSL certificate problem: self-signed certificate in certificate chain

To populate it on such a network:

```bash
echo | openssl s_client -connect packagecloud.io:443 -showcerts 2>/dev/null \
  | awk '/BEGIN CERTIFICATE/{n++} n>1' \
  | awk '/BEGIN CERTIFICATE/,/END CERTIFICATE/' \
  > db/postgres/ca-certificates/corporate-proxy.crt
```

`*.crt` here is gitignored on purpose — the certificate is specific to one
network, and a committed one would be both useless elsewhere and misleading.
On a network without interception, leave this directory empty; the build works
as-is.
