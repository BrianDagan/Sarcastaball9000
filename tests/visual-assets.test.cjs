const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const docs = path.resolve(__dirname, "..", "docs");

test("the baseball has centered circular geometry inside a square, inset viewBox", () => {
  const dom = new JSDOM(fs.readFileSync(path.join(docs, "assets", "baseball.svg"), "utf8"), { contentType: "image/svg+xml" });
  try {
    const svg = dom.window.document.documentElement;
    assert.equal(svg.localName, "svg");
    const [x, y, width, height] = svg.getAttribute("viewBox").trim().split(/[,\s]+/).map(Number);
    assert.ok([x, y, width, height].every(Number.isFinite));
    assert.ok(width > 0);
    assert.equal(width, height);
    const centered = [...svg.querySelectorAll("circle")].find(circle =>
      Number(circle.getAttribute("cx")) === x + width / 2 &&
      Number(circle.getAttribute("cy")) === y + height / 2);
    assert.ok(centered, "The visible baseball needs a centered circular body");
    const radius = Number(centered.getAttribute("r"));
    const stroke = Number(centered.getAttribute("stroke-width") || 0);
    assert.ok(radius > 0);
    assert.ok(radius + stroke / 2 < width / 2, "The outline must not reach the viewBox edge");
    assert.equal(svg.querySelector("text, image, script, foreignObject, animate, animateTransform"), null);
    for (const element of [svg, ...svg.querySelectorAll("*")]) {
      for (const attribute of element.attributes) {
        assert.doesNotMatch(attribute.name, /^on/i, "The shared artwork must have no event handlers");
        if (attribute.localName === "href") assert.match(attribute.value, /^#/, "Only internal SVG references are allowed");
        if (attribute.name !== "xmlns") {
          assert.doesNotMatch(attribute.value, /https?:|data:|@import/i, "Artwork must not load external resources");
        }
      }
    }
  } finally { dom.window.close(); }
});

test("favicon, header and playhead share the local SVG instead of font glyphs", () => {
  const dom = new JSDOM(fs.readFileSync(path.join(docs, "index.html"), "utf8"), { url: "http://127.0.0.1:4187/" });
  try {
    const document = dom.window.document;
    const favicon = document.querySelector('link[rel~="icon"]');
    const logo = document.querySelector("#logo-ball[src], #logo-ball img");
    const playhead = document.querySelector("#np-bar-dot .np-ball[src], #np-bar-dot .np-ball img");
    assert.ok(favicon && logo && playhead, "All three baseball surfaces must reference the shared image");
    for (const [element, attribute] of [[favicon, "href"], [logo, "src"], [playhead, "src"]]) {
      const url = new URL(element.getAttribute(attribute), document.baseURI);
      assert.equal(url.origin, "http://127.0.0.1:4187");
      assert.equal(url.pathname, "/assets/baseball.svg");
    }
    assert.equal(logo.getAttribute("alt"), "");
    assert.equal(playhead.getAttribute("alt"), "");
    assert.equal(document.getElementById("np-bar-dot").getAttribute("role"), "slider");
    assert.equal(document.getElementById("np-bar-dot").getAttribute("tabindex"), "0");
  } finally { dom.window.close(); }
});
