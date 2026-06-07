# JVM toolchain layer for the Codex spawn worker (issue #287, Phase 1).
#
# Layering, not fattening: this image extends the agent base
# (`march-spawn-codex:latest`, built from docker/spawn-codex.Dockerfile) with a
# JDK so a Kotlin/Gradle or Java/Maven repo can BUILD and self-verify in the
# container. The per-spawn snapshot then `FROM`s this cached layer when the
# profile's toolchain resolves to `jvm` (see src/spawn/toolchain.ts —
# `resolveToolchainImage` derives this tag as `march-spawn-codex-jvm:latest`).
#
# We install the JDK plus Maven (so a `pom.xml` repo, which the toolchain
# auto-detect classifies as `jvm`, actually has an `mvn` binary to build with).
# We do NOT bake a Gradle version: the repo's own `./gradlew` wrapper resolves
# and downloads its pinned Gradle — repo-faithful resolution, per the issue. A
# Maven project's pinned version likewise comes from its own `mvnw` wrapper when
# present; the system `mvn` is the fallback for repos without one. Dependency +
# wrapper downloads work because spawns currently run on the open `bridge`
# network; the bounded two-phase egress posture is a later phase of #287.
FROM march-spawn-codex:latest

# Adoptium Temurin 21 (LTS) — a current, widely-targeted JDK for Kotlin/Gradle.
# Installed from Adoptium's apt repo for a maintained, headless build. Done as
# root, then control returns to the unprivileged `march` user the base set.
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
  && apt-get install -y --no-install-recommends \
    "temurin-${JAVA_MAJOR}-jdk" \
    maven \
  && rm -rf /var/lib/apt/lists/*

# The Temurin deb installs to an arch-suffixed path (…-jdk-amd64 / …-jdk-arm64).
# Symlink it to a stable, arch-independent location so JAVA_HOME is correct on
# any build/run architecture (the base image is multi-arch).
RUN ln -sfn "/usr/lib/jvm/temurin-${JAVA_MAJOR}-jdk-$(dpkg --print-architecture)" \
    /usr/lib/jvm/temurin-current
ENV JAVA_HOME=/usr/lib/jvm/temurin-current
ENV PATH=${JAVA_HOME}/bin:${PATH}

# Gradle writes its caches/wrapper here; make it writable for the unprivileged
# user so `./gradlew` works without HOME surprises.
ENV GRADLE_USER_HOME=/march/.gradle
RUN mkdir -p /march/.gradle && chown -R march:march /march/.gradle

WORKDIR /march/workspace
USER march

CMD ["java", "-version"]
