# Release validation

Version: 0.4.2

This release adds initial-install/reinstall guidance and a backend/provider/model selection step to the skill. Already confirmed choices are reused, credentials stay local, and Bridge-specific Pi model selection preserves daily Pi/PiDeck defaults. Runtime behavior is unchanged from 0.4.1 apart from version metadata.

Version 0.4.1 validation: 62 unit tests, 46 integration tests and 6 portable interface tests passed (114 total). A real Pi 1.4.0 minimal-profile RPC handshake passed without a model request; all 6 portable tests also passed against its installed release archive. The supplied macOS repair report validates its own 0.3.0 CLI tasks. Current-release macOS/Linux full-model acceptance remains outstanding.

Version 0.4.2 packaging, interface checks and the Windows clean-install live result are recorded during release/install verification. The local installation record is kept outside this repository. Live model requests remain opt-in; dependency discovery, RPC health and verified task completion are separate observations.
