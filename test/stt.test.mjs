import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { enrichTextWithTranscript, STT_MAX_FILE_BYTES, SUPPORTED_FORMATS } from "../dist/stt.js";

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
