# Data Model: Tag Taxonomy & Coverage Lint

## Overview

This model defines the file-level tag tuple and coverage-lint verdicts used by the M1 staged-testing work. The goal is a deterministic, assertable convention that later npm scripts and CI jobs can consume without guessing from paths or test names.

## Entities

### 1) Test File

Purpose: Represents one vitest test module that must declare its taxonomy tuple.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `path` | repo-relative path | Yes | Matches `**/*.test.ts` outside the generated dependency directories defined by spec FR-005 (`node_modules/`, `dist/`, `.git/`). |
| `tagBlock` | leading comment block | Yes | Must appear before imports or executable code. |
| `scopeTag` | enum | Yes | One of `@l0` (unit), `@l1` (subsystem), `@l2` (cross-subsystem), `@l3` (system). |
| `determinismTag` | enum | Yes | One of `@deterministic`, `@stochastic`. |
| `executionChannelTag` | enum | Yes | One of `@ci`, `@scheduled`. |

Validation rules:
- A test file has exactly one scope tag.
- A test file has exactly one determinism tag.
- A test file has exactly one execution-channel tag.
- Tags are read from the leading tag block, not from arbitrary prose, string literals, or comments elsewhere in the file.

### 2) Tag Block

Purpose: Stores the visible taxonomy declaration for a test file.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `rawText` | comment text | Yes | The leading comment block content. |
| `scopeTags` | array | Yes | Parsed scope-axis tags. |
| `determinismTags` | array | Yes | Parsed determinism-axis tags. |
| `executionChannelTags` | array | Yes | Parsed execution-channel-axis tags. |

Validation rules:
- Empty arrays are missing-axis failures.
- An array containing the same tag more than once is a `duplicate` failure for that axis.
- An array containing two or more distinct tags from the same axis is a `conflicting` failure for that axis.
- Unknown tags do not satisfy any axis.

### 3) Coverage Lint Verdict

Purpose: Reports whether the repository's test taxonomy coverage is complete.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `status` | enum | Yes | `pass` or `fail`. |
| `checkedFiles` | array of paths | Yes | All scanned test files. |
| `failures` | array of lint failures | Yes | Empty on pass. |
| `failures[].path` | repo-relative path | Yes | Offending file. |
| `failures[].axis` | enum | Yes | `scope`, `determinism`, or `executionChannel`. |
| `failures[].reason` | enum | Yes | `missing`, `duplicate`, or `conflicting`. |

Validation rules:
- A passing verdict has no failures.
- A failing verdict exits non-zero through the npm script.
- Every failure names the path and axis so a contributor can repair the tag block without log archaeology.

## Relationships

- A Coverage Lint Verdict checks many Test Files.
- A Test File owns exactly one Tag Block.
- A Tag Block yields one parsed value per required axis when valid.

## State Transitions

### Test file taxonomy lifecycle

1. `untagged` -> `tagged`
   - Trigger: A leading tag block is added.
   - Effects: The file can be selected by future layer-specific scripts.

2. `tagged` -> `invalid`
   - Trigger: A tag is removed, duplicated, or conflicts with another tag in the same axis.
   - Effects: The coverage lint fails before CI can silently miscategorize the file.

3. `invalid` -> `tagged`
   - Trigger: The tag block is repaired to exactly one value per axis.
   - Effects: The coverage lint passes again.

## Identity & Uniqueness

- A Test File is uniquely identified by its repo-relative path.
- A Tag Block is uniquely identified by its ownership of a Test File.
- A Coverage Lint Verdict is uniquely identified by the repository snapshot it scanned.
