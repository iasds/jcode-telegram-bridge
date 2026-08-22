import { describe, it, test } from "node:test";
import assert from "node:assert/strict";
import {
  enrichTextWithTranscript,
  isSupportedAudioExt,
  loadSttConfig,
  resolveLocalModel,
  STT_MAX_FILE_BYTES,
  SUPPORTED_FORMATS,
  VALID_STT_MODELS,
} from "../dist/stt.js";

describe("stt: constants", () => {
  it("supports ogg/opus/m4a", () => {
    assert.equal(SUPPORTED_FORMATS.has(".ogg"), true);
    assert.equal(SUPPORTED_FORMATS.has(".opus"), true);
    assert.equal(SUPPORTED_FORMATS.has(".m4a"), true);
  });
  it("max file is 25MB", () => {
    assert.equal(STT_MAX_FILE_BYTES, 25 * 1024 * 1024);
  });
});

describe("stt: enrichTextWithTranscript (hermes gateway parity)", () => {
  it("quotes successful transcript + appends user text", () => {
    const out = enrichTextWithTranscript("hi", ["你好世界"]);
    assert.equal(out, '"你好世界"\n\nhi');
  });
  it("strips placeholder when transcript exists", () => {
    const out = enrichTextWithTranscript("(The user sent a message with no text content)", ["hello"]);
    assert.equal(out, '"hello"');
  });
  it("empty transcript becomes sentinel", () => {
    const out = enrichTextWithTranscript("hi", ["   "]);
    assert.match(out, /empty or inaudible/);
  });
  it("no transcripts -> unavailable note + caption", () => {
    const out = enrichTextWithTranscript("caption text", [], "/tmp/audio.ogg");
    assert.match(out, /could not be transcribed/);
    assert.match(out, /caption text/);
  });
  it("multiple transcripts joined", () => {
    const out = enrichTextWithTranscript("", ["a", "b"]);
    assert.equal(out, '"a"\n\n"b"');
  });
});

// ── resolveLocalModel (README "config hardening" contract) ─────────────────

test("resolveLocalModel: empty/undefined/whitespace -> small", () => {
  assert.equal(resolveLocalModel(undefined), "small");
  assert.equal(resolveLocalModel(""), "small");
  assert.equal(resolveLocalModel("   "), "small");
});

test("resolveLocalModel: valid models pass through, case-normalized", () => {
  for (const m of VALID_STT_MODELS) {
    assert.equal(resolveLocalModel(m), m);
  }
  assert.equal(resolveLocalModel("SMALL"), "small");
  assert.equal(resolveLocalModel(" Large-V3 "), "large-v3");
});

test("resolveLocalModel: unknown value warns and falls back to small", () => {
  const warnings = [];
  const orig = console.warn;
  console.warn = (...a) => warnings.push(a.join(" "));
  try {
    assert.equal(resolveLocalModel("giant"), "small");
    assert.equal(resolveLocalModel("large"), "small"); // near-miss name
  } finally {
    console.warn = orig;
  }
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /unknown STT_LOCAL_MODEL 'giant'/);
  assert.match(warnings[0], /tiny\/base\/small\/medium\/large-v3/);
});

// ── loadSttConfig defaults + boolean parsing ───────────────────────────────

test("loadSttConfig: defaults enabled+echo, zh, small", () => {
  const c = loadSttConfig({});
  assert.deepEqual(c, {
    enabled: true,
    echoTranscripts: true,
    provider: "",
    language: "zh",
    localModel: "small",
  });
});

test("loadSttConfig: falsey strings disable flags; provider precedence; language fallback", () => {
  const c = loadSttConfig({
    STT_ENABLED: "off",
    STT_ECHO_TRANSCRIPTS: "0",
    STT_PROVIDER: " groq ",
    STT_MODEL_PROVIDER: "ignored",
    STT_LANGUAGE: "",
    STT_LOCAL_MODEL: "MEDIUM",
  });
  assert.equal(c.enabled, false);
  assert.equal(c.echoTranscripts, false);
  assert.equal(c.provider, "groq");
  assert.equal(c.language, "zh");
  assert.equal(c.localModel, "medium");
});

// ── extension gate ────────────────────────────────────────────────────────

test("isSupportedAudioExt: telegram formats yes, junk no, case-insensitive", () => {
  assert.equal(isSupportedAudioExt("/tmp/a.ogg"), true);
  assert.equal(isSupportedAudioExt("/tmp/b.OPUS"), true);
  assert.equal(isSupportedAudioExt("/tmp/c.m4a"), true);
  assert.equal(isSupportedAudioExt("/tmp/d.txt"), false);
  assert.equal(isSupportedAudioExt("/tmp/noext"), false);
});
