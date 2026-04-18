import { describe, expect, test } from "bun:test";
import { generateTailscaleSshSnippet } from "./tailscaleSshSnippet";

describe("generateTailscaleSshSnippet", () => {
  const tailscaleInfo = {
    available: true,
    ip: "100.64.0.10",
    hostname: "devbox.tailnet.ts.net",
    username: "ubuntu",
    sshEnabled: true,
    tailnet: "tailnet.ts.net",
  };

  test("uses the configured remote username when available", () => {
    expect(generateTailscaleSshSnippet(tailscaleInfo, { username: "ubuntu" })).toContain(
      "User ubuntu"
    );
  });

  test("uses an explicit placeholder instead of the client username fallback", () => {
    expect(generateTailscaleSshSnippet(tailscaleInfo)).toContain("User <remote-user>");
  });
});
