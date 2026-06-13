export interface Profile {
  readonly version: 1;
  readonly name: string;
  readonly baseImage: string;
  readonly container: ContainerSecurity;
  readonly resources: ResourceLimits;
  readonly fileMounts: readonly FileMount[];
  readonly snapshot?: SnapshotPolicy;
  readonly network: NetworkPolicy;
  readonly tools?: ToolsPolicy;
}

export interface ContainerSecurity {
  readonly capDrop: readonly string[];
  readonly user: string;
  readonly envWhitelist: readonly string[];
}

export interface ResourceLimits {
  readonly memoryLimit: string;
  readonly cpuLimit: string;
  readonly timeoutSeconds: number;
}

export type FileMount = NamedVolumeMount | SnapshotMount;

export interface NamedVolumeMount {
  readonly kind: "named-volume";
  readonly name: string;
  readonly target: string;
  readonly readOnly: boolean;
}

export interface SnapshotMount {
  readonly kind: "snapshot";
  readonly target: string;
  readonly readOnly: true;
}

export interface SnapshotPolicy {
  readonly include?: readonly string[];
  readonly exclude: readonly string[];
}

export type NetworkPolicy = BridgeNetwork | NoneNetwork | AllowlistNetwork;

export interface BridgeNetwork {
  readonly mode: "bridge";
}

export interface NoneNetwork {
  readonly mode: "none";
}

export interface AllowlistNetwork {
  readonly mode: "allowlist";
  readonly allowlist: readonly NetworkEndpoint[];
}

export interface NetworkEndpoint {
  readonly host: string;
  readonly port: number;
  readonly protocol: "http" | "https" | "tcp";
}

export interface ToolsPolicy {
  readonly allowed?: readonly string[];
  readonly disallowed?: readonly string[];
}

export type ValidationResult =
  | { readonly ok: true; readonly value: Profile }
  | { readonly ok: false; readonly errors: readonly ValidationError[] };

export interface ValidationError {
  readonly code: ValidationErrorCode;
  readonly path: string;
  readonly message: string;
}

export type ValidationErrorCode =
  | "WrongType"
  | "MissingField"
  | "UnknownField"
  | "UnknownDiscriminator"
  | "UnsupportedSchemaVersion"
  | "InvalidName"
  | "InvalidImageReference"
  | "InvalidCapDrop"
  | "InvalidUser"
  | "InvalidMemoryLimit"
  | "InvalidCpuLimit"
  | "InvalidTimeout"
  | "InvalidEnvVarName"
  | "SnapshotMustBeReadOnly"
  | "InvalidMountTarget"
  | "EmptyAllowlist"
  | "InvalidHost"
  | "InvalidPort"
  | "InvalidProtocol"
  | "ToolOverlap";

export function validateProfile(input: unknown): ValidationResult {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return {
      ok: false,
      errors: [
        {
          code: "WrongType",
          path: "",
          message: "Profile must be an object.",
        },
      ],
    };
  }

  return { ok: true, value: input as Profile };
}
