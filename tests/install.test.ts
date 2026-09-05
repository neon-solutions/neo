import { expect, test } from "vitest";
import { serveSetup } from "../install/api/index";

test("install proxy serves setup.sh from main", async () => {
  const response = await serveSetup(new Request("https://neo.example/", { method: "GET" }));
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/plain");
  const body = await response.text();
  expect(body.startsWith("#!/bin/bash")).toBe(true);
  expect(body).toContain("NEO_INSTALL_DIR");
  expect(body).toContain("neo-darwin-arm64");
});

test("install proxy rejects non-GET methods", async () => {
  const response = await serveSetup(new Request("https://neo.example/", { method: "POST" }));
  expect(response.status).toBe(405);
  expect(await response.text()).toContain("method not allowed");
});
