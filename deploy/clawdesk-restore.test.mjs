// Keep the safe restore regression tests in the existing deploy/*.test.mjs CI gate.
// The official CLI roundtrip is opt-in and runs in a network-disabled Linux fixture.
import './scripts/restore-safe.test.mjs';
