import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { containerName, MARCH_SERVICES } from "../stack/services.js";

export type KeyVerdict = "accepted" | "rejected" | "missing" | "unverifiable";
type AmbientToken = "GH_TOKEN" | "GITHUB_TOKEN";

export interface TesseraProbes {
  reachable(): Promise<boolean>;
  key(service: string): Promise<KeyVerdict>;
  ambient(service: string): Promise<AmbientToken[] | null>;
}

const TIMEOUT_MS = 2_000;
const exec = promisify(execFile);

async function docker(args: string[]): Promise<string | null> {
  try {
    const { stdout } = await exec("docker", args, {
      timeout: TIMEOUT_MS + 1_000,
      encoding: "utf8",
      maxBuffer: 4096,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

// Run in the consumer's filesystem and network namespace. Only a fixed
// verdict crosses the Docker socket. Match the file precedence and safety
// checks in tessera/config.ts.
const KEY_PROBE = String.raw`
const fs = require("node:fs");
async function probe() {
  const env = process.env;
  const file = env.MARCH_TESSERA_CLIENT_KEY_FILE?.trim();
  let key = env.MARCH_TESSERA_CLIENT_KEY?.trim();
  if (file) {
    let fd;
    try {
      fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600 || stat.size > 4096) {
        return "unverifiable";
      }
      const buffer = Buffer.alloc(4097);
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
      if (bytes > 4096) return "unverifiable";
      key = buffer.toString("utf8", 0, bytes).trim();
    } catch (error) {
      return error.code === "ENOENT" ? "missing" : "unverifiable";
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
  if (!key) return "missing";
  const url = new URL(env.MARCH_TESSERA_URL?.trim());
  if (url.username || url.password || url.search || url.hash) return "unverifiable";
  if (url.protocol !== "https:" &&
      (url.protocol !== "http:" || !/^(?:[a-z0-9-]+|127\.[\d.]+|10\.[\d.]+|192\.168\.[\d.]+|172\.(?:1[6-9]|2\d|3[01])\.[\d.]+|\[::1\])$/i.test(url.hostname))) {
    return "unverifiable";
  }
  const response = await fetch(url.href.replace(/\/+$/, "") + "/v1/client", {
    headers: { authorization: "Bearer " + key },
    redirect: "error",
    signal: AbortSignal.timeout(${TIMEOUT_MS}),
  });
  if (response.status === 401 || response.status === 403) return "rejected";
  if (response.status !== 200) return "unverifiable";
  const body = await response.json();
  if (typeof body?.client !== "string" || !Array.isArray(body.grants)) return "unverifiable";
  return body.client === process.argv[1] ? "accepted" : "rejected";
}
probe().then(console.log, () => console.log("unverifiable"));
`;

const AMBIENT_PROBE = '{{range .Config.Env}}{{if eq (index (split . "=") 0) "GH_TOKEN"}}GH_TOKEN{{println}}{{else if eq (index (split . "=") 0) "GITHUB_TOKEN"}}GITHUB_TOKEN{{println}}{{end}}{{end}}';

export function createTesseraProbes(
  env: NodeJS.ProcessEnv,
  runDocker = docker,
  fetchImpl = fetch,
): TesseraProbes {
  const service = MARCH_SERVICES.find(({ name }) => name === "tessera")!;
  const port = env[service.portEnv!] || service.port;
  return {
    async reachable() {
      try {
        const result = await fetchImpl(`http://127.0.0.1:${port}${service.healthPath}`, {
          redirect: "error",
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        await result.body?.cancel();
        return result.status === 200;
      } catch {
        return false;
      }
    },
    async key(name) {
      const result = await runDocker(["exec", containerName(name), "node", "-e", KEY_PROBE, name]);
      if (result === "accepted" || result === "rejected" || result === "missing") return result;
      return "unverifiable";
    },
    async ambient(name) {
      const result = await runDocker(["inspect", "-f", AMBIENT_PROBE, containerName(name)]);
      if (result === null) return null;
      const names = result.split("\n");
      return (["GH_TOKEN", "GITHUB_TOKEN"] as const).filter(token => names.includes(token));
    },
  };
}
