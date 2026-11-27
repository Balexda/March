import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { startBroodSpan } from "../../observability/brood-trace.js";
import { IntegrationStateConflictError, type IntegrationRegistry } from "./integration-registry.js";
import { parseIntegrationAttempt, parseIntegrationOutcome } from "./integration.js";
import type { IntegrationFailureReason } from "./types.js";

function mutate<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  action: string,
  attemptId: string,
  operation: () => T,
  failureReason?: IntegrationFailureReason,
): T | FastifyReply {
  const traceparent = request.headers.traceparent;
  const span = startBroodSpan({
    name: `brood.integration.${action}`,
    key: attemptId,
    traceparent: typeof traceparent === "string" ? traceparent : undefined,
    attributes: failureReason && { "march.integration.failure_reason": failureReason },
  });
  let error = true;
  try {
    const result = operation();
    error = failureReason !== undefined;
    return result;
  } catch (cause) {
    if (cause instanceof IntegrationStateConflictError) {
      return reply.code(409).send({ error: cause.message });
    }
    throw cause;
  } finally {
    span.end({ error });
  }
}

export function registerIntegrationRoutes(app: FastifyInstance, registry: IntegrationRegistry): void {
  app.post("/integration-attempts", async (request, reply) => {
    const input = parseIntegrationAttempt(request.body);
    if (!input) return reply.code(400).send({ error: "Invalid integration attempt binding" });
    return mutate(request, reply, "register", input.attemptId, () => registry.registerIntegrationAttempt(input));
  });

  app.get<{ Params: { attemptId: string } }>("/integration-attempts/:attemptId", async (request) => {
    return registry.readIntegrationAttempt(request.params.attemptId);
  });

  app.put<{ Params: { attemptId: string } }>("/integration-attempts/:attemptId/outcome", async (request, reply) => {
    const outcome = parseIntegrationOutcome(request.body);
    if (!outcome) return reply.code(400).send({ error: "Invalid terminal integration outcome" });
    const { attemptId } = request.params;
    return mutate(request, reply, "write", attemptId, () => registry.writeIntegrationOutcome(attemptId, outcome),
      outcome.status === "failed" ? outcome.failureReason : undefined);
  });

  app.post<{ Params: { attemptId: string } }>("/integration-attempts/:attemptId/confirm-failure", async (request, reply) => {
    const { attemptId } = request.params;
    return mutate(request, reply, "confirm_failure", attemptId, () => registry.confirmIntegrationFailure(attemptId));
  });

  app.get<{ Params: { id: string } }>("/sessions/:id/integration-outcome", async (request) => {
    return { outcome: registry.readIntegrationOutcome(request.params.id) };
  });
}
