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

const ROOT_FIELDS = new Set([
  "version",
  "name",
  "baseImage",
  "container",
  "resources",
  "fileMounts",
  "snapshot",
  "network",
  "tools",
]);

const CONTAINER_FIELDS = new Set(["capDrop", "user", "envWhitelist"]);
const RESOURCE_FIELDS = new Set(["memoryLimit", "cpuLimit", "timeoutSeconds"]);
const TOOLS_FIELDS = new Set(["allowed", "disallowed"]);
const FILE_MOUNT_FIELDS = new Set(["kind", "name", "target", "readOnly"]);
const SNAPSHOT_MOUNT_FIELDS = new Set(["kind", "target", "readOnly"]);
const SNAPSHOT_FIELDS = new Set(["include", "exclude"]);

const USER_PATTERN = /^(?:[a-z_][a-z0-9_-]{0,31}|[0-9]+(?::[0-9]+)?)$/;
const MEMORY_LIMIT_PATTERN = /^[0-9]+[bkmgBKMG]$/;
const CPU_LIMIT_PATTERN = /^[0-9]+(?:\.[0-9]+)?$/;

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

  collectUnknownFields(profile, ROOT_FIELDS, "", errors);
  validateName(profile.name, errors);
  validateBaseImage(profile.baseImage, errors);
  validateContainer(profile.container, errors);
  validateResources(profile.resources, errors);
  validateFileMounts(profile.fileMounts, errors);
  validateSnapshot(profile.snapshot, errors);
  validateTools(profile.tools, errors);

  if (errors.length > 0) {
    return { ok: false, errors: sortErrors(errors) };
  }

  return { ok: true, value: input as Profile };
}

function validateName(value: unknown, errors: ValidationError[]): void {
  if (value === undefined) {
    errors.push({
      code: "MissingField",
      path: "/name",
      message: "Profile name is required.",
    });
    return;
  }

  if (typeof value !== "string") {
    errors.push({
      code: "WrongType",
      path: "/name",
      message: "Profile name must be a string.",
    });
    return;
  }

  if (!PROFILE_NAME_PATTERN.test(value)) {
    errors.push({
      code: "InvalidName",
      path: "/name",
      message:
        "Profile name must start with a lowercase letter and contain only lowercase letters, digits, and hyphens.",
    });
  }
}

function validateBaseImage(value: unknown, errors: ValidationError[]): void {
  if (value === undefined) {
    errors.push({
      code: "MissingField",
      path: "/baseImage",
      message: "Profile baseImage is required.",
    });
    return;
  }

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

function validateContainer(
  container: unknown,
  errors: ValidationError[],
): void {
  if (container === undefined) {
    return;
  }

  if (!isPlainObject(container)) {
    errors.push({
      code: "WrongType",
      path: "/container",
      message: "Profile container must be an object.",
    });
    return;
  }

  collectUnknownFields(container, CONTAINER_FIELDS, "/container", errors);

  const capDrop = container.capDrop;
  if (
    !Array.isArray(capDrop) ||
    !capDrop.every((value) => typeof value === "string") ||
    !capDrop.includes("ALL")
  ) {
    errors.push({
      code: "InvalidCapDrop",
      path: "/container/capDrop",
      message: 'container.capDrop must be a string array containing "ALL".',
    });
  }

  const user = container.user;
  if (typeof user !== "string" || !USER_PATTERN.test(user)) {
    errors.push({
      code: "InvalidUser",
      path: "/container/user",
      message:
        "container.user must be a POSIX username or numeric uid[:gid] value.",
    });
  }
}

function validateResources(
  resources: unknown,
  errors: ValidationError[],
): void {
  if (resources === undefined) {
    return;
  }

  if (!isPlainObject(resources)) {
    errors.push({
      code: "WrongType",
      path: "/resources",
      message: "Profile resources must be an object.",
    });
    return;
  }

  collectUnknownFields(resources, RESOURCE_FIELDS, "/resources", errors);

  const memoryLimit = resources.memoryLimit;
  if (
    typeof memoryLimit !== "string" ||
    !MEMORY_LIMIT_PATTERN.test(memoryLimit)
  ) {
    errors.push({
      code: "InvalidMemoryLimit",
      path: "/resources/memoryLimit",
      message:
        "resources.memoryLimit must match the Docker memory grammar used by SpawnConfig.",
    });
  }

  const cpuLimit = resources.cpuLimit;
  if (
    typeof cpuLimit !== "string" ||
    !CPU_LIMIT_PATTERN.test(cpuLimit) ||
    Number(cpuLimit) <= 0
  ) {
    errors.push({
      code: "InvalidCpuLimit",
      path: "/resources/cpuLimit",
      message:
        "resources.cpuLimit must be a positive number formatted as a string.",
    });
  }

  const timeoutSeconds = resources.timeoutSeconds;
  if (
    typeof timeoutSeconds !== "number" ||
    !Number.isInteger(timeoutSeconds) ||
    timeoutSeconds <= 0
  ) {
    errors.push({
      code: "InvalidTimeout",
      path: "/resources/timeoutSeconds",
      message: "resources.timeoutSeconds must be a positive integer.",
    });
  }
}

function validateFileMounts(
  fileMounts: unknown,
  errors: ValidationError[],
): void {
  if (fileMounts === undefined) {
    return;
  }

  if (!Array.isArray(fileMounts)) {
    errors.push({
      code: "WrongType",
      path: "/fileMounts",
      message: "Profile fileMounts must be an array.",
    });
    return;
  }

  fileMounts.forEach((mount, index) => {
    validateFileMount(mount, `/fileMounts/${index}`, errors);
  });
}

function validateFileMount(
  mount: unknown,
  path: string,
  errors: ValidationError[],
): void {
  if (!isPlainObject(mount)) {
    errors.push({
      code: "WrongType",
      path,
      message: "File mount entries must be objects.",
    });
    return;
  }

  if (mount.kind === undefined) {
    errors.push({
      code: "MissingField",
      path: joinPointer(path, "kind"),
      message: "File mount kind is required.",
    });
    return;
  }

  if (mount.kind === "named-volume") {
    validateNamedVolumeMount(mount, path, errors);
    return;
  }

  if (mount.kind === "snapshot") {
    validateSnapshotMount(mount, path, errors);
    return;
  }

  errors.push({
    code: "UnknownDiscriminator",
    path: joinPointer(path, "kind"),
    message: "File mount kind must be named-volume or snapshot.",
  });
}

function validateNamedVolumeMount(
  mount: Record<string, unknown>,
  path: string,
  errors: ValidationError[],
): void {
  collectUnknownFields(mount, FILE_MOUNT_FIELDS, path, errors);
  validateNonEmptyStringField(mount.name, joinPointer(path, "name"), errors);
  validateMountTarget(mount.target, joinPointer(path, "target"), errors);

  if (mount.readOnly === undefined) {
    errors.push({
      code: "MissingField",
      path: joinPointer(path, "readOnly"),
      message: "Named-volume mount readOnly is required.",
    });
    return;
  }

  if (typeof mount.readOnly !== "boolean") {
    errors.push({
      code: "WrongType",
      path: joinPointer(path, "readOnly"),
      message: "Named-volume mount readOnly must be a boolean.",
    });
  }
}

function validateSnapshotMount(
  mount: Record<string, unknown>,
  path: string,
  errors: ValidationError[],
): void {
  collectUnknownFields(mount, SNAPSHOT_MOUNT_FIELDS, path, errors);
  validateMountTarget(mount.target, joinPointer(path, "target"), errors);

  if (mount.readOnly === undefined) {
    errors.push({
      code: "MissingField",
      path: joinPointer(path, "readOnly"),
      message: "Snapshot mount readOnly is required.",
    });
    return;
  }

  if (typeof mount.readOnly !== "boolean") {
    errors.push({
      code: "WrongType",
      path: joinPointer(path, "readOnly"),
      message: "Snapshot mount readOnly must be a boolean.",
    });
    return;
  }

  if (mount.readOnly !== true) {
    errors.push({
      code: "SnapshotMustBeReadOnly",
      path: joinPointer(path, "readOnly"),
      message: "Snapshot mounts must be read-only.",
    });
  }
}

function validateNonEmptyStringField(
  value: unknown,
  path: string,
  errors: ValidationError[],
): void {
  if (value === undefined) {
    errors.push({
      code: "MissingField",
      path,
      message: "Field is required.",
    });
    return;
  }

  if (typeof value !== "string") {
    errors.push({
      code: "WrongType",
      path,
      message: "Field must be a string.",
    });
    return;
  }

  if (value.length === 0) {
    errors.push({
      code: "InvalidMountTarget",
      path,
      message: "Field must not be empty.",
    });
  }
}

function validateMountTarget(
  value: unknown,
  path: string,
  errors: ValidationError[],
): void {
  if (value === undefined) {
    errors.push({
      code: "MissingField",
      path,
      message: "Mount target is required.",
    });
    return;
  }

  if (typeof value !== "string") {
    errors.push({
      code: "WrongType",
      path,
      message: "Mount target must be a string.",
    });
    return;
  }

  if (!isValidContainerMountTarget(value)) {
    errors.push({
      code: "InvalidMountTarget",
      path,
      message:
        "Mount target must be an absolute non-root POSIX path without traversal segments.",
    });
  }
}

function isValidContainerMountTarget(value: string): boolean {
  return (
    value.length > 0 &&
    value.startsWith("/") &&
    value !== "/" &&
    !value.split("/").includes("..")
  );
}

function validateSnapshot(
  snapshot: unknown,
  errors: ValidationError[],
): void {
  if (snapshot === undefined) {
    return;
  }

  if (!isPlainObject(snapshot)) {
    errors.push({
      code: "WrongType",
      path: "/snapshot",
      message: "Profile snapshot must be an object.",
    });
    return;
  }

  collectUnknownFields(snapshot, SNAPSHOT_FIELDS, "/snapshot", errors);

  if (snapshot.exclude === undefined) {
    errors.push({
      code: "MissingField",
      path: "/snapshot/exclude",
      message: "snapshot.exclude is required when snapshot is present.",
    });
  } else {
    validateSnapshotPatternList(snapshot.exclude, "/snapshot/exclude", errors);
  }

  if (snapshot.include !== undefined) {
    validateSnapshotPatternList(snapshot.include, "/snapshot/include", errors);
  }
}

function validateSnapshotPatternList(
  value: unknown,
  path: string,
  errors: ValidationError[],
): void {
  if (!Array.isArray(value)) {
    errors.push({
      code: "WrongType",
      path,
      message: "Snapshot pattern list must be an array.",
    });
    return;
  }

  value.forEach((entry, index) => {
    const entryPath = `${path}/${index}`;
    if (typeof entry !== "string") {
      errors.push({
        code: "WrongType",
        path: entryPath,
        message: "Snapshot pattern entries must be strings.",
      });
      return;
    }

    if (!isValidSnapshotPattern(entry)) {
      errors.push({
        code: "InvalidMountTarget",
        path: entryPath,
        message:
          "Snapshot patterns must be relative and must not contain traversal segments.",
      });
    }
  });
}

function isValidSnapshotPattern(value: string): boolean {
  return (
    value.length > 0 &&
    !value.startsWith("/") &&
    !value.split("/").includes("..")
  );
}

function validateTools(tools: unknown, errors: ValidationError[]): void {
  if (tools === undefined) {
    return;
  }

  if (!isPlainRecord(tools)) {
    errors.push({
      code: "WrongType",
      path: "/tools",
      message: "Profile tools must be an object.",
    });
    return;
  }

  collectUnknownFields(tools, TOOLS_FIELDS, "/tools", errors);

  const allowed = validateToolList(tools.allowed, "/tools/allowed", errors);
  const disallowed = validateToolList(
    tools.disallowed,
    "/tools/disallowed",
    errors,
  );

  if (allowed === undefined || disallowed === undefined) {
    return;
  }

  const disallowedTools = new Set(disallowed);
  const overlappingTool = allowed.find((tool) => disallowedTools.has(tool));
  if (overlappingTool !== undefined) {
    errors.push({
      code: "ToolOverlap",
      path: "/tools",
      message: `Tool "${overlappingTool}" cannot be both allowed and disallowed.`,
    });
  }
}

function validateToolList(
  value: unknown,
  path: string,
  errors: ValidationError[],
): readonly string[] | undefined {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    errors.push({
      code: "WrongType",
      path,
      message: "Tools policy lists must be arrays of strings.",
    });
    return undefined;
  }

  const strings: string[] = [];
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "string") {
      errors.push({
        code: "WrongType",
        path: joinPointer(path, String(index)),
        message: "Tool policy entries must be strings.",
      });
    } else {
      strings.push(entry);
    }
  }

  return strings;
}

function collectUnknownFields(
  value: Record<string, unknown>,
  knownFields: ReadonlySet<string>,
  parentPath: string,
  errors: ValidationError[],
): void {
  for (const key of Object.keys(value)) {
    if (!knownFields.has(key)) {
      errors.push({
        code: "UnknownField",
        path: joinPointer(parentPath, key),
        message: `Unknown profile field "${key}".`,
      });
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Stricter than isPlainObject: also rejects exotic objects (Date, Map, class
// instances) that a YAML parser can produce (e.g. !!timestamp tags). The
// profile contract requires such non-JSON-compatible values to surface as
// WrongType at the offending path rather than being cast to a policy object.
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isPlainObject(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function joinPointer(parentPath: string, key: string): string {
  return `${parentPath}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`;
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
