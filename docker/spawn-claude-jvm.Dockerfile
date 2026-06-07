# JVM toolchain layer for the Claude Code spawn worker (issue #287, Phase 1).
#
# Layering, not fattening: this image extends the agent base
# (`march-spawn-claude:latest`, built from docker/spawn-claude.Dockerfile) with a
# JDK so a Kotlin/Gradle or Java/Maven repo can BUILD and self-verify in the
# container. The per-spawn snapshot then `FROM`s this cached layer when the
# profile's toolchain resolves to `jvm` (see src/spawn/toolchain.ts —
# `resolveToolchainImage` derives this tag as `march-spawn-claude-jvm:latest`).
#
# We install only the JDK; the repo's own `./gradlew` wrapper resolves its
# pinned Gradle. See docker/spawn-codex-jvm.Dockerfile for the full rationale.
FROM march-spawn-claude:latest

ARG JAVA_MAJOR=21
USER root

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    gnupg \
  && install -d -m 0755 /etc/apt/keyrings \
  && curl -fsSL https://packages.adoptium.net/artifactory/api/gpg/key/public \
    | gpg --dearmor -o /etc/apt/keyrings/adoptium.gpg \
  && echo "deb [signed-by=/etc/apt/keyrings/adoptium.gpg] https://packages.adoptium.net/artifactory/deb $(. /etc/os-release && echo "$VERSION_CODENAME") main" \
    > /etc/apt/sources.list.d/adoptium.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends "temurin-${JAVA_MAJOR}-jdk" \
  && rm -rf /var/lib/apt/lists/*

ENV JAVA_HOME=/usr/lib/jvm/temurin-${JAVA_MAJOR}-jdk-amd64
ENV PATH=${JAVA_HOME}/bin:${PATH}

ENV GRADLE_USER_HOME=/march/.gradle
RUN mkdir -p /march/.gradle && chown -R march:march /march/.gradle

WORKDIR /march/workspace
USER march

CMD ["java", "-version"]
