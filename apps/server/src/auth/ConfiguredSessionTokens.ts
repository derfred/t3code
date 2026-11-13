// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Digest is effectful; this resolves configured tokens synchronously at startup.
import * as NodeCrypto from "node:crypto";
import { AuthSessionId, type ServerAuthSessionMethod } from "@t3tools/contracts";
import * as Mac from "effect/crypto/Mac";
import * as DateTime from "effect/DateTime";
import * as Redacted from "effect/Redacted";

import type { ServerConfig } from "../config.ts";

export const REUSABLE_DEV_SESSION_PREFIX = "dev-auth-";
export const CONFIGURED_AUTH_TOKEN_SESSION_PREFIX = "auth-token-";
export const MIN_AUTH_TOKEN_LENGTH = 32;
// The database schema requires an expiry for a configured token with no normal session TTL.
export const CONFIGURED_SESSION_EXPIRES_AT = DateTime.makeUnsafe("9999-12-31T23:59:59.999Z");

export interface ConfiguredSessionToken {
  readonly credential: string;
  readonly sessionId: AuthSessionId;
  readonly sessionIdPrefix: string;
  readonly subject: string;
  readonly method: ServerAuthSessionMethod;
  readonly label: string;
  readonly matches: (credential: string) => boolean;
}

const makeConfiguredSessionToken = (
  token: Redacted.Redacted<string>,
  input: Pick<ConfiguredSessionToken, "sessionIdPrefix" | "subject" | "method" | "label">,
) => {
  const credential = Redacted.value(token);
  if (credential.length === 0) {
    return undefined;
  }
  const hash = NodeCrypto.createHash("sha256").update(credential).digest();
  const tokenId = hash.toString("hex");
  return {
    ...input,
    credential,
    tokenId,
    sessionId: AuthSessionId.make(`${input.sessionIdPrefix}${tokenId}`),
    matches: (candidate: string) =>
      Mac.timingSafeEqual(hash, NodeCrypto.createHash("sha256").update(candidate).digest()),
  };
};

export function resolveReusableDevAuth(
  config: Pick<ServerConfig["Service"], "mode" | "devUrl" | "devAuthToken">,
) {
  if (config.mode !== "web" || config.devUrl === undefined || config.devAuthToken === undefined) {
    return undefined;
  }
  const token = makeConfiguredSessionToken(config.devAuthToken, {
    sessionIdPrefix: REUSABLE_DEV_SESSION_PREFIX,
    subject: "reusable-dev-token",
    method: "browser-session-cookie",
    label: "Reusable dev token",
  });
  return token && { ...token, cookieName: `t3_dev_session_${token.tokenId}` };
}

/** Bearer-only, for headless clients such as a Kubernetes operator. */
export function configuredAuthToken(
  token: Redacted.Redacted<string> | undefined,
): ConfiguredSessionToken | undefined {
  if (token === undefined) {
    return undefined;
  }
  return makeConfiguredSessionToken(token, {
    sessionIdPrefix: CONFIGURED_AUTH_TOKEN_SESSION_PREFIX,
    subject: "configured-auth-token",
    method: "bearer-access-token",
    label: "Configured auth token",
  });
}
