/**
 * @l1 @deterministic @ci
 */
import { describe, expect, it } from "vitest";
import {
  ContainerObserverUnavailableError,
  DOCKER_OBSERVE_TIMEOUT_MS,
  dockerContainerObserver,
  type DockerRunner,
} from "./container-observer.js";

describe("dockerContainerObserver", () => {
  it("maps the docker listing to per-id present/running observations", async () => {
    const calls: { args: readonly string[]; timeoutMs: number }[] = [];
    const runDocker: DockerRunner = async (args, { timeoutMs }) => {
      calls.push({ args, timeoutMs });
      return "aaa\trunning\nbbb\texited\n";
    };
    const observed = await dockerContainerObserver({ runDocker }).observe([
      "aaa",
      "bbb",
      "ccc",
    ]);
    expect(observed.get("aaa")).toEqual({ present: true, running: true });
    expect(observed.get("bbb")).toEqual({ present: true, running: false });
    expect(observed.get("ccc")).toEqual({ present: false, running: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.timeoutMs).toBe(DOCKER_OBSERVE_TIMEOUT_MS);
  });

  it("does not shell out when there is nothing to observe", async () => {
    let called = false;
    const runDocker: DockerRunner = async () => {
      called = true;
      return "";
    };
    const observed = await dockerContainerObserver({ runDocker }).observe([]);
    expect(observed.size).toBe(0);
    expect(called).toBe(false);
  });

  it("surfaces a timed-out (killed) docker call as unavailable", async () => {
    const runDocker: DockerRunner = async () => {
      throw Object.assign(new Error("Command failed"), { killed: true });
    };
    await expect(
      dockerContainerObserver({ runDocker, timeoutMs: 25 }).observe(["aaa"]),
    ).rejects.toThrow(
      new ContainerObserverUnavailableError(
        "docker liveness observation timed out after 25ms",
      ),
    );
  });

  it("surfaces a failing docker call as unavailable with its stderr", async () => {
    const runDocker: DockerRunner = async () => {
      throw Object.assign(new Error("Command failed"), {
        stderr: "Cannot connect to the Docker daemon",
      });
    };
    const err = await dockerContainerObserver({ runDocker })
      .observe(["aaa"])
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ContainerObserverUnavailableError);
    expect((err as Error).message).toContain("Cannot connect to the Docker daemon");
  });

  it("does not block the event loop while docker is pending", async () => {
    let release: (value: string) => void = () => {};
    const runDocker: DockerRunner = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    const pending = dockerContainerObserver({ runDocker }).observe(["aaa"]);
    // Another task gets to run while the observation is outstanding.
    const ticked = await new Promise<boolean>((resolve) =>
      setImmediate(() => resolve(true)),
    );
    expect(ticked).toBe(true);
    release("aaa\trunning\n");
    expect((await pending).get("aaa")).toEqual({ present: true, running: true });
  });
});
