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

const PROFILE_NAME_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
const IMAGE_NAME_COMPONENT = "[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*";
const IMAGE_DOMAIN_COMPONENT = "[a-z0-9]+(?:[.-][a-z0-9]+)*";
const IMAGE_NAME_PATTERN = new RegExp(
  `^(?:${IMAGE_DOMAIN_COMPONENT}(?::[0-9]+)?/)?${IMAGE_NAME_COMPONENT}(?:/${IMAGE_NAME_COMPONENT})*$`,
);
const IMAGE_TAG_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const IMAGE_DIGEST_PATTERN =
  /^[A-Za-z][A-Za-z0-9]*(?:[+._-][A-Za-z][A-Za-z0-9]*)*:[A-Fa-f0-9]{8,}$/;

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

  const profile = input as Record<string, unknown>;

  if (profile.version !== 1) {
    return {
      ok: false,
      errors: [
        {
          code: "UnsupportedSchemaVersion",
          path: "/version",
          message: "Profile version must be the supported schema version 1.",
        },
      ],
    };
  }

  const errors: ValidationError[] = [];

  validateName(profile.name, errors);
  validateBaseImage(profile.baseImage, errors);

  if (errors.length > 0) {
    return { ok: false, errors: sortErrors(errors) };
  }

  return { ok: true, value: input as Profile };
}

function validateName(value: unknown, errors: ValidationError[]): void {
  if (typeof value !== "string" || !PROFILE_NAME_PATTERN.test(value)) {
    errors.push({
      code: "InvalidName",
      path: "/name",
      message:
        "Profile name must start with a lowercase letter and contain only lowercase letters, digits, and hyphens.",
    });
  }
}

function validateBaseImage(value: unknown, errors: ValidationError[]): void {
  if (typeof value !== "string") {
    errors.push({
      code: "WrongType",
      path: "/baseImage",
      message: "Profile baseImage must be a string.",
    });
    return;
  }

  if (!isValidImageReference(value)) {
    errors.push({
      code: "InvalidImageReference",
      path: "/baseImage",
      message: "Profile baseImage must be a valid Docker image reference.",
    });
  }
}

function isValidImageReference(value: string): boolean {
  if (value.length === 0 || /\s/.test(value)) {
    return false;
  }

  const atIndex = value.indexOf("@");
  const reference = atIndex === -1 ? value : value.slice(0, atIndex);
  const digest = atIndex === -1 ? undefined : value.slice(atIndex + 1);

  if (
    reference.length === 0 ||
    (digest !== undefined && !IMAGE_DIGEST_PATTERN.test(digest))
  ) {
    return false;
  }

  const lastSlashIndex = reference.lastIndexOf("/");
  const lastColonIndex = reference.lastIndexOf(":");
  const tag =
    lastColonIndex > lastSlashIndex
      ? reference.slice(lastColonIndex + 1)
      : undefined;
  const name =
    lastColonIndex > lastSlashIndex
      ? reference.slice(0, lastColonIndex)
      : reference;

  return (
    name.length > 0 &&
    IMAGE_NAME_PATTERN.test(name) &&
    (tag === undefined || IMAGE_TAG_PATTERN.test(tag))
  );
}

function sortErrors(errors: ValidationError[]): readonly ValidationError[] {
  return [...errors].sort(
    (left, right) =>
      compareStrings(left.path, right.path) ||
      compareStrings(left.code, right.code),
  );
}

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
}
