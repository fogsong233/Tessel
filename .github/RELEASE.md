# Release prerequisites

The `Release Tessel` workflow creates update metadata from the GitHub Release assets and does not require signing credentials. macOS releases include an unsigned `.dmg` and `.zip`; users can mount the DMG, drag Tessel into Applications, and approve the first launch in macOS Privacy & Security when Gatekeeper prompts. Treat unsigned macOS releases as manual installs: macOS automatic updates require a signed application.

Windows releases use the NSIS installer and can update without a certificate. Add platform code-signing configuration separately when a signing certificate is available.

The installer updates the application bundle only. Tessel's PDF sessions, preferences, WebDAV credentials, and Codex workspaces remain under the operating system's Electron `userData` directory and are not included in the release assets.
