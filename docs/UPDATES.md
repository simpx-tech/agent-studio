# Automatic updates

Installed desktop apps update themselves from this repository's
[GitHub Releases](https://github.com/simpx-tech/agent-studio/releases). The app uses the
official [Tauri updater](https://v2.tauri.app/plugin/updater/): it reads
`https://github.com/simpx-tech/agent-studio/releases/latest/download/latest.json`, downloads the
package for its platform, and installs it only after verifying its signature. The repository is
public, so no GitHub token is involved.

## In the app

- **Which copies update.** Release installations from the Windows NSIS or MSI installer, the Linux
  AppImage, and the macOS app. Development builds, unbundled executables, and `.deb`/`.rpm`
  installations show that updates are unavailable; install the next release manually or switch
  to the AppImage. MSI installations are per-machine, so Windows asks for administrator approval
  while installing. Copies older than 0.2.0 have no updater: install 0.2.0 once by hand.
- **Checking and downloading.** The first check runs 30 seconds after startup, then every six
  hours, or an hour after a failed check. **Settings → App updates** shows the current version and
  status and has **Check for updates**. A newer release downloads in the background and waits in
  memory; nothing is installed yet.
- **Restart to update.** When an update is ready, the sidebar footer and Settings offer
  **Restart to update**. It is disabled while a reply runs on this computer, and the native side
  refuses it too. The app saves the workspace, stops background work, and releases parked CLI
  processes (as the close button does), then starts the installer. On Windows, the installer
  closes the app, shows a progress bar without questions, and reopens it. macOS and Linux replace
  the app in place and relaunch it.
- **Idle close.** Closing an idle app with a downloaded update installs it without reopening the
  app. Closing while a reply runs keeps the ordinary close; the next launch downloads the update
  again.
- **Other Agent Studio windows.** The Windows installer closes every running process named
  `agent-studio.exe` for your user, including development and QA builds that use that name.
- **Data.** Updates keep the identifier `com.vinicius.agentstudio`, so the workspace, accounts,
  profiles, and settings stay in place. Update status is transient and never synced; the web
  viewer has no update controls. Release notes appear as plain text.

## Security

- Every package is signed with the project's updater key (minisign/Ed25519). The app embeds only
  the public key (`plugins.updater.pubkey` in `src-tauri/tauri.conf.json`) and discards any
  download whose signature does not match.
- `requireSignedVersion` binds each signature to its release version. The manifest itself is not
  signed; this stops a tampered manifest from announcing a newer version with an older, validly
  signed package. The Tauri CLI records the version when signing from 2.11.5 on.
- The endpoint is HTTPS. Windows installers are still not Authenticode-signed, and macOS builds
  are ad-hoc signed without notarization. The updater's own signature check is what authenticates
  an update. Packages the app downloads itself carry no Mark of the Web, so SmartScreen does not
  prompt during updates; the first manual install still does.
- The release job verifies every signature and its signed version against the configured public
  key before publishing (`node scripts/release.ts assets`), so a mismatched secret fails the job
  instead of publishing a release no installation would accept.

## Signing key

The key was generated with `npm run tauri signer generate` and lives outside the repository:

- Private key: `%USERPROFILE%\.tauri\agent-studio-updater.key`
- Password: `%USERPROFILE%\.tauri\agent-studio-updater.password.txt`

Add both as repository secrets under **Settings → Secrets and variables → Actions**:
`TAURI_SIGNING_PRIVATE_KEY` (the key file's contents) and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
The build job fails with an explanation while either is missing. Keep a private backup, such as
a password manager entry. Never commit, print, or copy the key elsewhere.

If the key is lost, installed copies cannot accept any new update: publish a release with a new
key and reinstall every copy by hand. The VPS refuses that release too until its trusted key is
replaced with `update.ts trust <tauri.conf.json> --replace` (see
[automatic VPS updates](DEPLOYMENT.md#automatic-updates)). To rotate a key deliberately, publish one release signed
with the old key that contains the new public key, and switch the secret afterwards.

## Publishing a release

1. On `development`, bump the version: `npm run release:version -- patch` (or `minor`, `major`,
   or an explicit `x.y.z`). This updates `package.json`, `package-lock.json`,
   `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, and `src-tauri/tauri.conf.json` together.
   `npm run release:version` prints the current version and fails if the files disagree. Versions
   are plain `x.y.z` (at most 255.255.65535) because MSI packages require it.
2. Run the local pipeline, commit, and merge to `main`.
3. The [Desktop builds workflow](../.github/workflows/desktop-build.yml) verifies the app, builds
   and signs every platform, then the **Publish release** job checks signatures and versions and
   creates the release `v<version>` with the installers, their `.sig` files, and `latest.json`.
   Release notes list the commit subjects since the previous release tag. `gh` keeps the release
   a draft until every asset is uploaded.
4. The production VPS installs the published release by itself and replaces its public Windows
   download. It deploys only releases whose NSIS installer carries this key's signature for their
   version. See [automatic VPS updates](DEPLOYMENT.md#automatic-updates).

A push to `main` whose version already has a release publishes nothing and shows a warning;
published releases are never replaced. Running the workflow manually on `main` retries a failed
release for an unreleased version.

The manifest maps `windows-x86_64` and `windows-x86_64-nsis` to the NSIS installer,
`windows-x86_64-msi` to the MSI, `linux-x86_64-appimage` to the AppImage, and both macOS
architectures to the universal `.app.tar.gz`. There is deliberately no generic Linux entry, so a
distribution package never receives an AppImage.

## Local builds

`tauri build` signs update packages and needs the key. For local installers, skip signing:

```powershell
npm run tauri build -- --bundles nsis --no-sign
```

Such an installer is not a release package, but the installed app still receives signed updates.
To sign locally, set `TAURI_SIGNING_PRIVATE_KEY` to the key file path and
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` to its password for that command only.

## Verification

- `src-tauri/src/updates.rs` tests cover which builds can update, the install gate, bounded
  error messages, release-note sanitizing, and the status format.
- `src/lib/app-updates.test.ts` and `tests/app-updates.spec.ts` cover status parsing, the sidebar
  and Settings controls, saving before installation, refused restarts, and the absence of update
  controls in the web viewer.
- `src/lib/release.test.ts` covers version bumps across every manifest, verification of real
  Tauri CLI signatures (including tampered data and trusted comments), and release staging.
- `node scripts/updates-native-smoke.mjs` (after `npm run build`) is the Windows end-to-end check.
  It builds three signed NSIS releases of **Agent Studio Update QA** with a throwaway key, serves
  their manifest on `127.0.0.1:1471`, and installs through an unpackaged scheduled task. It then
  verifies the background download, **Restart to update** and relaunch, rejection of a manifest
  that pairs a newer version with an older signed package, and installation on an idle close
  without relaunching, then uninstalls the QA app and removes its data. The QA app has its own
  identifier, product name, and executable name (`agent-studio-update-qa.exe`), so its installers
  never close or replace the regular app. Results are written to `artifacts/updates-qa/`.
