import { CastraClient } from "../castra/client.js";
import { BroodClient, BroodClientError } from "./service/client.js";

async function readSpawns() {
  const views = await new BroodClient().listViews({ kind: "spawn" });
  return views.map(({ record }) => {
    if (typeof record?.id !== "string" || !record.id || typeof record.status !== "string") {
      throw new BroodClientError("Brood returned an invalid spawn read view.");
    }
    return record;
  });
}

/** Print a read-only inventory and return whether both sources were available. */
export async function showSessions(): Promise<boolean> {
  const [interactive, spawns] = await Promise.allSettled([
    (async () => new CastraClient().listInteractiveSessions())(),
    readSpawns(),
  ]);
  const complete = interactive.status === "fulfilled" && spawns.status === "fulfilled";
  const partial = complete ? "" : " (partial)";
  if (interactive.status === "fulfilled") {
    console.log(`Interactive sessions${partial}:`);
    if (!interactive.value.length) console.log("  No live march/ sessions.");
    const spawnIds = spawns.status === "fulfilled"
      ? new Set(spawns.value.map(({ id }) => id))
      : undefined;
    for (const name of interactive.value) {
      const availability = !spawnIds
        ? "availability unknown: spawn ID check unavailable"
        : spawnIds.has(name)
          ? "unavailable: spawn ID collision"
          : "attachable";
      console.log(`  ${name} (${availability})`);
    }
  } else {
    process.stderr.write(`Castra interactive sessions unavailable: ${interactive.reason}\n`);
  }

  if (spawns.status === "fulfilled") {
    console.log(`Tracked spawns${partial}:`);
    if (!spawns.value.length) console.log("  No tracked spawns.");
    for (const { id, status } of spawns.value) console.log(`  ${id} (${status})`);
  } else {
    process.stderr.write(`Brood tracked spawns unavailable: ${spawns.reason}\n`);
  }
  return complete;
}
