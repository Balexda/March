/**
 * @l0 @deterministic @ci
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertTokenTransport, legatePost } from "./legate-client.js";

afterEach(() => vi.unstubAllGlobals());

function stubFetch(status: number, body: string) {
  const fetch = vi.fn(async () => new Response(body, { status }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("assertTokenTransport (#593)", () => {
  it.each(["http://127.0.0.1:8787", "http://localhost:8787", "http://[::1]:8787", "https://legate.example.com"])(
    "allows %s",
    (base) => expect(() => assertTokenTransport(base)).not.toThrow(),
  );

  it("refuses plain http to a non-loopback host", () => {
    expect(() => assertTokenTransport("http://legate.example.com")).toThrow(/https/);
  });
});

describe("legatePost (#593)", () => {
  it("does not send the token over plaintext to a remote host", async () => {
    const fetch = stubFetch(202, '{"ok":true}');
    await expect(
      legatePost("/tick", {}, { MARCH_LEGATE_URL: "http://legate.example.com", MARCH_LEGATE_OPERATOR_TOKEN: "s3cret" }),
    ).rejects.toThrow(/Refusing to send/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sends the bearer to loopback and returns the parsed acknowledgement", async () => {
    const fetch = stubFetch(202, '{"ok":true,"started":true}');
    const res = await legatePost("/tick", {}, { MARCH_LEGATE_OPERATOR_TOKEN: "s3cret" });
    expect(res).toMatchObject({ status: 202, ok: true, body: { started: true } });
    expect((fetch.mock.calls[0] as any)[1].headers.authorization).toBe("Bearer s3cret");
  });

  it("fails a 2xx whose body is not a JSON acknowledgement instead of reporting success", async () => {
    stubFetch(200, "<html>proxy</html>");
    await expect(legatePost("/dispatch/pause", {}, {})).rejects.toThrow(/without a JSON acknowledgement/);
  });

  it.each(["{}", '{"ok":"yes"}', '{"ok":false}'])("treats a 2xx without ok:true (%s) as a failure", async (body) => {
    stubFetch(200, body);
    const res = await legatePost("/dispatch/pause", {}, {});
    expect(res.ok).toBe(false);
    expect(res.body.error).toBeTruthy();
  });

  it("keeps a non-JSON refusal as a failed response with its status", async () => {
    stubFetch(502, "Bad Gateway");
    const res = await legatePost("/dispatch/pause", {}, {});
    expect(res).toMatchObject({ status: 502, ok: false, body: { error: "HTTP 502: Bad Gateway" } });
  });
});
