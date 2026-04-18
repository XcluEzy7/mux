import { describe, expect, it } from "bun:test";
import { generateTailscaleSshSnippet } from "./tailscaleSshSnippet";

const tailscaleInfo = {
  available: true,
  hostname: "my-machine.tailnet.ts.net",
  ip: "100.64.0.1",
  sshEnabled: false,
  tailnet: "example.ts.net",
};

describe("generateTailscaleSshSnippet", () => {
  it("uses explicit username when provided", () => {
    const snippet = generateTailscaleSshSnippet(tailscaleInfo, { username: "alice" });

    expect(snippet).toContain("User alice");
  });

  it("falls back to %u when username is blank", () => {
    const snippet = generateTailscaleSshSnippet(tailscaleInfo, { username: "   " });

    expect(snippet).toContain("User %u");
  });
});
