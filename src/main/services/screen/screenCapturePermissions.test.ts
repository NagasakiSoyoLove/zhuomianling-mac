// TIMED DIAGNOSTICS TEST MODULE: screen capture permission tests.
import { describe, expect, it } from "vitest";
import { decideScreenPermission } from "./screenCapturePermissions";

describe("screen capture permission decisions", () => {
  it("allows the Electron 43 untyped media preflight for a pet window", () => {
    expect(decideScreenPermission("media", [], true)).toEqual({
      allowDisplayCapture: true,
      allowAudioOnly: false,
      allowed: true
    });
  });

  it("allows the explicit display-capture permission only for a pet window", () => {
    expect(decideScreenPermission("display-capture", [], true).allowed).toBe(true);
    expect(decideScreenPermission("display-capture", [], false).allowed).toBe(false);
  });

  it("keeps ordinary media permission restricted to audio-only requests", () => {
    expect(decideScreenPermission("media", ["audio"], true)).toEqual({
      allowDisplayCapture: false,
      allowAudioOnly: true,
      allowed: true
    });
    expect(decideScreenPermission("media", ["video"], true).allowed).toBe(false);
    expect(decideScreenPermission("media", ["audio", "video"], true).allowed).toBe(false);
  });

  it("never grants either media path to a non-pet window", () => {
    expect(decideScreenPermission("media", [], false).allowed).toBe(false);
    expect(decideScreenPermission("media", ["audio"], false).allowed).toBe(false);
  });
});
