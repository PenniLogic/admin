/**
 * Placeholder authorization boundary of the administrative console.
 *
 * No administrative identity provider is configured, so no administrative identity can be
 * established and every request is denied. The `Decision` union deliberately has no allowed
 * member: introducing one belongs to the administrative identity work (E13), together with the
 * separate identity domain, per-route policy evaluation and audit events. Customer credentials
 * and customer state are never inputs to this boundary.
 */
export const NO_ADMINISTRATIVE_IDENTITY_PROVIDER = "no-administrative-identity-provider";

export type DenialReason = typeof NO_ADMINISTRATIVE_IDENTITY_PROVIDER;

export interface Denied {
  readonly outcome: "denied";
  readonly reason: DenialReason;
}

export type Decision = Denied;

const DENIED: Denied = Object.freeze({
  outcome: "denied",
  reason: NO_ADMINISTRATIVE_IDENTITY_PROVIDER,
});

/** Deterministic default deny; it consults no request data because there is nothing to consult. */
export function authorize(): Decision {
  return DENIED;
}
