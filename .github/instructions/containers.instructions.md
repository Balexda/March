---
applyTo: "docker/**,.github/workflows/**"
excludeAgent: "coding-agent"
---
# Reviewing images, compose files, and workflows

Each March service runs from its own image (`docker/<service>.Dockerfile`,
`docker/<service>.docker-compose.yml`). Several escaped defects were a build
that passed locally and failed in the image.

## Check

- **Every runtime input is copied.** A service that resolves files at runtime
  (`src/templates`, `scripts/`, generated skills) needs a `COPY` for them in
  the runtime stage, not only the build stage.
- **User and home.** Containers run with the host UID/GID and may see a
  read-only or shared `HOME`. Writes go where the image says they may.
- **Service addressing.** Containers reach each other by service hostname on
  the `march` network; host tools use the published `localhost` ports. A
  hard-coded address for the other context is a finding.
- **Secrets stay out of images and logs.** Credentials arrive by mount or
  environment at run time.
- **CI mirrors the staged scripts.** Jobs call the `npm run test:*` layers,
  not `npx vitest` or a different file selection.

## Do not ask for

- Exposing Grafana, OTLP, or service ports on a public interface.
- Diverging the publish workflow from `@balexda/smithy`'s; it mirrors it on
  purpose.
- YAML "fixes" for a list written at the same indent as its parent key. That
  is valid YAML.
