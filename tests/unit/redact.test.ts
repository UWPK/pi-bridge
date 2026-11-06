import { test } from "node:test";
import assert from "node:assert/strict";
import { redactText, redactValue, redactEnv } from "../../src/redact.js";

test("redactText removes bearer tokens and api keys", () => {
  const input = 'Authorization: Bearer abcdef1234567890 api_key=sk-ABCDEF1234567890';
  const out = redactText(input);
  assert.equal(out.includes("abcdef1234567890"), false);
  assert.equal(out.includes("sk-ABCDEF1234567890"), false);
  assert.match(out, /<redacted/);
});

test("redactText handles JSON secret fields", () => {
  const out = redactText('{"apiKey":"secretvalue123","other":"keep"}');
  assert.equal(out.includes("secretvalue123"), false);
  assert.match(out, /keep/);
});

test("redactText removes provider key prefixes", () => {
  for (const key of ["sk-ant-api03-abcdefghijklmnop", "ghp_abcdefghijklmnopqrstuvwxyz0123456789", "AIzaSyA1234567890abcdefghijklmnopqrs"]) {
    const out = redactText(`token is ${key}`);
    assert.equal(out.includes(key), false, `should redact ${key}`);
  }
});

test("redactValue recurses into nested structures", () => {
  const out = redactValue({ a: { password: "pw", token: "Bearer xyzxyzxyzxyz" }, list: ["sk-ABCDEF1234567890"] });
  assert.equal(out.a.password, "<redacted>");
  assert.equal(out.a.token.includes("xyzxyzxyzxyz"), false);
  assert.equal(out.list[0].includes("sk-ABCDEF1234567890"), false);
});

test("redactEnv redacts sensitive env keys", () => {
  const out = redactEnv({ API_KEY: "secret", PATH: "/usr/bin", MY_TOKEN: "t" }, ["API_KEY", "PATH", "MY_TOKEN"]);
  assert.equal(out.API_KEY, "<redacted>");
  assert.equal(out.MY_TOKEN, "<redacted>");
  assert.equal(out.PATH, "/usr/bin");
});

test("redactText leaves ordinary text intact", () => {
  assert.equal(redactText("hello world"), "hello world");
});
