const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./tests/browser",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:4187",
    browserName: "chromium",
    trace: "off",
    screenshot: "off",
  },
  webServer: {
    command: "python -m http.server 4187 --bind 127.0.0.1 --directory docs",
    url: "http://127.0.0.1:4187",
    reuseExistingServer: false,
  },
});
