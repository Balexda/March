export interface SpawnBackend {
  readonly name: string;
  readonly baseImage: string;
  readonly requiredEnvVars: readonly string[];
  buildEntrypoint(promptFilePath: string): readonly string[];
}

export const defaultBackendName = "claude-code";

export interface BackendRegistry {
  readonly defaultBackendName: typeof defaultBackendName;
  getBackend(name: string): SpawnBackend | undefined;
  listBackends(): readonly string[];
}

export function createBackendRegistry(
  backends: readonly SpawnBackend[],
): BackendRegistry {
  const registry = new Map<string, SpawnBackend>();

  for (const backend of backends) {
    if (registry.has(backend.name)) {
      throw new Error(`Duplicate spawn backend name: ${backend.name}`);
    }
    registry.set(backend.name, backend);
  }

  return {
    defaultBackendName,
    getBackend(name: string): SpawnBackend | undefined {
      return registry.get(name);
    },
    listBackends(): readonly string[] {
      return Array.from(registry.keys());
    },
  };
}
