# @khudgins/synology

Read-only [Synology DSM](https://www.synology.com/) inventory for
[swamp](https://github.com/swamp-club/swamp).

This provides a storage model for Synology devices. Right now, it doesn't do much. You can enumerate volumes and shared folders and the capacity of them. The plan is to expand on this to provide a legitimately useful Swamp extension that gives Swamp users a lever against their Synology boxes.

Most of the below was written by Claude. It got a little rambly at the end, but the details are accurate. - Keith

| Type                         | What it records                                          | Needs admin? |
| ---------------------------- | -------------------------------------------------------- | ------------ |
| `@khudgins/synology/storage` | Shared folders and the capacity of their backing volumes | **No**       |

`discover` writes a resource per share, a resource per backing volume, and a
summary.

## Why FileStation for capacity

The obvious call for volume capacity is `SYNO.Storage.CGI.Storage`, and on DSM
7.2+ it requires an administrator account. Granting a monitoring integration DSM
admin to read a percentage is a poor trade.

`@khudgins/synology/storage` instead uses `SYNO.FileStation.List` with
`method=list_share` and `additional=["real_path","size","volume_status"]`. Each
shared folder the account can see comes back with `totalspace`/`freespace` for
the volume behind it, and `real_path` is what identifies _which_ volume — the
`path` DSM returns is the share path (`/Videos`) and names no volume at all. An
ordinary DSM account with read access to the shares you care about is enough.

Because capacity is a property of the volume, shares are collapsed onto their
backing volume and emitted as `volume` resources as well, so a utilisation
contract fires once per real condition. The results are paginated to completion
and the summary carries a `truncated` flag, so an incomplete read is visible
rather than silently understating utilisation.

This type does not enumerate disks, storage pools, or SMART state — none of that
is reachable without admin.

## Version discovery, not hardcoded paths

Synology publishes official API documentation only for FileStation,
DownloadStation, SurveillanceStation and Virtual Machine Manager. The Core APIs
are reverse-engineered, and paths and versions move between DSM releases.

Rather than hardcode them, this extension calls `SYNO.API.Info` first and
resolves every subsequent call through the returned catalogue, negotiating a
protocol version inside the range the appliance actually advertises. An API this
appliance does not expose produces a named error rather than a confusing 404,
and a DSM upgrade that shifts a version range is absorbed rather than fatal.

## TLS

DSM ships a **factory self-signed certificate whose SAN is the bare hostname**
(`DNS:synology`), issued by a per-device "Synology Inc. CA". Two consequences:

1. You must supply `caCert` with the PEM of that CA. `skipTlsVerify` is honoured
   only by a runtime started with `--unsafely-ignore-certificate-errors` and is
   a no-op otherwise.
2. Verification fails against an FQDN, because the SAN does not include one.

The durable fix is to install a certificate matching the name you connect to
(Control Panel → Security → Certificate). Then drop `caCert` entirely and the
public trust store suffices.

This extension **refuses a plain-http `baseUrl` by default**, because DSM
session auth sends the account password on every run. Override deliberately with
`allowInsecureHttp: true` if you understand the exposure.

Ideally, the Synology device in question is provided a proper, signed cert, but
most of us aren't going to go that far with our Synology boxes. In order to
guarantee the rug hasn't been pulled from underneath, providing the cert to Swamp
reduces that risk.

## Setup

Store the credentials in a vault — never inline them in the model definition.
`vault put` takes the value as an argument or on stdin; read the password into a
shell variable first so it never reaches your shell history:

```bash
swamp vault put my-vault synology_username swamp-ro

printf 'DSM password: '; read -rs DSM_PW; echo
printf '%s' "$DSM_PW" | swamp vault put my-vault synology_password
unset DSM_PW
```

The CA is not secret, but putting it in the vault too keeps the definition free
of multi-line YAML — block-scalar indentation is a reliable source of silent
misconfiguration:

```bash
cat syno-ca-cert.pem | swamp vault put my-vault synology_ca_cert
```

```yaml
# models/@khudgins/synology/storage/<id>-my-nas.yaml
globalArguments:
  name: my-nas
  transport:
    baseUrl: https://synology:5001
    account: ${{ vault.get('my-vault', 'synology_username') }}
    password: ${{ vault.get('my-vault', 'synology_password') }}
    caCert: ${{ vault.get('my-vault', 'synology_ca_cert') }}
```

`caCertPath: /absolute/path/to/ca.pem` is accepted as an alternative to
`caCert`, read at call time.

```bash
swamp model method run my-nas discover
```

## Contracts

`discover` writes one resource per share, **one per backing volume**, and a
summary. Assert against volumes, not shares — capacity is a property of the
volume, so eight shares on one volume are one condition, not eight:

```bash
# Volumes over 85% full — fires once per real problem
swamp data query 'specName == "volume" && attributes.usedPct > 85'

# Shares whose capacity DSM declined to report — unknown, not zero
swamp data query 'specName == "share" && attributes.capacityReported == false'
```

`capacityReported` exists so that a share DSM returned no `volume_status` for
records as unknown rather than "0 bytes, 0% used", which would let a capacity
contract silently pass.

## Gotchas this extension handles for you

**`sessionName` is not a free-form label.** DSM treats it as an _application
name_ and permission-checks it, failing login with **error 402 "permission
denied"** for values it does not recognise — which reads exactly like an account
permissions problem and sends you hunting through Control Panel. The default is
`FileStation`; if you override it, use a real DSM application (`DSM`,
`DownloadStation`, `AudioStation`).

**The factory certificate's SAN is the bare hostname.** `DNS:synology`, with no
FQDN, so `https://nas.example.com:5001` fails hostname verification even once
its CA is trusted. Connect by the short name, or install a certificate matching
the name you use.

**`caCert` must be the issuing CA, not the server certificate.** DSM's export
gives you `cert.pem` (the leaf, no `basicConstraints CA:TRUE`) and its private
key; the trust anchor you need is `chain.pem` / `syno-ca-cert.pem`. If your
export contains only two files, the CA is on the appliance at
`/usr/syno/etc/certificate/system/default/`.

**Credentials are never sent over an unvalidated connection.** TLS is
established during unauthenticated API discovery, before login, so a certificate
failure aborts before the password leaves the machine.

## Requirements

- DSM 7.x, verified against DSM 7.2
- FileStation installed
- A non-admin account with read access to the shares you want reported, and
  FileStation allowed under its Application permissions

## Known limitations

- No disks, pools, or SMART — admin-only on DSM 7.2+.
- Volume capacity is inferred from the shares on it. A volume with no share this
  account can see is invisible, and a share whose `real_path` DSM does not
  return is recorded but excluded from the volume roll-up (logged as a warning).
- 2-step verification requires supplying `otpCode`, which is impractical for
  scheduled runs. Prefer a dedicated service account without 2FA.

## Scope

v1 is deliberately one type. System identity, thermals and the API catalogue
need an admin account, so they could not be verified against a real appliance
without handing this integration admin — and shipping a type that has never made
a successful API call would undercut the rest. That code is complete and parked
in [`future/`](future/README.md) until it can be verified.

## Development

```bash
deno task ci      # fmt --check, lint, type check, tests
deno task test    # tests alone
```

28 unit tests cover the pure logic (volume derivation, share normalisation,
volume roll-up), the client's security invariants (cleartext refusal, schema
default materialisation, version negotiation), and `discover` end to end against
a stubbed DSM — including the multi-page and truncation paths, which a
single-volume appliance cannot reach.

Everything else was exercised against real hardware: DSM 7.2, eight shares, one
volume. Four of the behaviours documented above — the `sessionName` 402, the
bare-hostname SAN, leaf-versus-CA, and `path` not naming a volume — were found
that way, and none of them appear in Synology's documentation.

## Publishing

```bash
swamp extension push manifest.yaml --dry-run
swamp extension push manifest.yaml
```

## Licence

MIT — see [LICENSE](LICENSE).
