# Release prerequisites

The `Release Tessel` workflow creates update metadata from the GitHub Release assets.

Before publishing a macOS release, configure these repository secrets:

- `MACOS_CERTIFICATE`: base64-encoded Developer ID Application `.p12` certificate.
- `MACOS_CERTIFICATE_PASSWORD`: password for that certificate, when applicable.

macOS requires a signed application for automatic updates. Configure these additional secrets to notarize the build and avoid Gatekeeper warnings:

- `APPLE_ID`
- `APPLE_APP_SPECIFIC_PASSWORD`
- `APPLE_TEAM_ID`

Windows releases use the NSIS installer and can update without a certificate. Add Windows code-signing configuration separately when a signing certificate is available.

The installer updates the application bundle only. Tessel's PDF sessions, preferences, WebDAV credentials, and Codex workspaces remain under the operating system's Electron `userData` directory and are not included in the release assets.
