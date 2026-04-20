import { describe, expect, test } from "bun:test";
import {
  isValidUrl,
  parseMultilineValues,
  parseQuotedArgInput,
  stringifyArgsForInput,
} from "./ToolsSettingsSection";

describe("parseQuotedArgInput", () => {
  test("parses unquoted and quoted args in order", () => {
    expect(parseQuotedArgInput('server.py --mode "safe sandbox"')).toEqual({
      args: ["server.py", "--mode", "safe sandbox"],
      error: null,
    });
  });

  test("supports escaping spaces outside quotes", () => {
    expect(parseQuotedArgInput("--target s3://my\\ bucket/path")).toEqual({
      args: ["--target", "s3://my bucket/path"],
      error: null,
    });
  });

  test("supports escaped quotes inside double quotes", () => {
    expect(parseQuotedArgInput('say "hello \\"mux\\""')).toEqual({
      args: ["say", 'hello "mux"'],
      error: null,
    });
  });

  test("preserves intentionally empty quoted args", () => {
    expect(parseQuotedArgInput('python "" --stdio')).toEqual({
      args: ["python", "", "--stdio"],
      error: null,
    });
  });

  test("returns an error for unclosed quotes", () => {
    expect(parseQuotedArgInput('python "unterminated')).toEqual({
      args: ["python"],
      error: "Close all quoted arguments before saving.",
    });
  });

  test("returns an error for trailing escape", () => {
    expect(parseQuotedArgInput("python --path " + "\\")).toEqual({
      args: ["python", "--path"],
      error: "Arguments cannot end with a trailing backslash.",
    });
  });
});

describe("isValidUrl", () => {
  test("allows only http and https URLs", () => {
    expect(isValidUrl("https://example.com/docs")).toBe(true);
    expect(isValidUrl("http://localhost:8080/health")).toBe(true);
    expect(isValidUrl("javascript:alert(1)")).toBe(false);
    expect(isValidUrl("data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==")).toBe(false);
  });
});

describe("parseMultilineValues", () => {
  test("splits newline-delimited links and trims each line", () => {
    expect(
      parseMultilineValues("  https://example.com/docs?a=1,2  \n\n https://example.com/guide ")
    ).toEqual(["https://example.com/docs?a=1,2", "https://example.com/guide"]);
  });
});

describe("stringifyArgsForInput", () => {
  test("quotes args with spaces and escapes embedded quotes", () => {
    const expected = 'server.py "safe sandbox" "say ' + '\\"hello\\"' + '"';
    expect(stringifyArgsForInput(["server.py", "safe sandbox", 'say "hello"'])).toBe(expected);
  });

  test("round-trips parser output", () => {
    const initial = ["python", "", "--path", "s3://my bucket", 'say "hello"'];
    const serialized = stringifyArgsForInput(initial);
    expect(parseQuotedArgInput(serialized)).toEqual({ args: initial, error: null });
  });
});
